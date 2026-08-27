import { join, resolve } from "node:path";

import { sameChatRoute, normalizeBoundChatRoute } from "./chat-route.js";
import { projectChatThread } from "./chat-thread-projection.js";
import { evidencePacketForSelection } from "./evidence.js";
import { loadQuestionResponseContext } from "./session-store.js";

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CONTENT_CHARS = 4_000;
const MAX_HISTORY_BYTES = 48 * 1024;

function contextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateIdentifier(name, value) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new TypeError(`${name} must be a safe non-empty identifier`);
  }
  return value;
}

function cloneJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (encoded === undefined) {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  return JSON.parse(encoded);
}

function truncateContent(content) {
  if (typeof content !== "string") return "";
  if (content.length <= MAX_HISTORY_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_HISTORY_CONTENT_CHARS)}\n[Earlier message truncated by Attend]`;
}

function historyTurn(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  if (turn.role !== "user" && turn.role !== "assistant") return null;
  const value = {
    role: turn.role,
    content: truncateContent(turn.content),
  };
  for (const field of ["id", "createdAt", "replyToTurnId"]) {
    if (typeof turn[field] === "string" && turn[field].length <= 512) {
      value[field] = turn[field];
    }
  }
  if (typeof turn.selection?.id === "string" && turn.selection.id.length <= 512) {
    value.selection = { id: turn.selection.id };
  }
  if (
    typeof turn.context?.selectionTurnId === "string" &&
    turn.context.selectionTurnId.length <= 512
  ) {
    value.context = { selectionTurnId: turn.context.selectionTurnId };
  }
  return value;
}

/**
 * Keep only prior turns. The current question and its evidence are supplied
 * separately, and selection bodies in history are reduced to their ids.
 */
export function boundedConversation(conversation, questionId) {
  if (!Array.isArray(conversation)) return [];
  const questionIndex = conversation.findIndex((turn) => turn?.id === questionId);
  const candidates = conversation.slice(
    0,
    questionIndex < 0 ? conversation.length : questionIndex,
  );
  const selected = [];
  let bytes = 2;
  for (
    let index = candidates.length - 1;
    index >= 0 && selected.length < MAX_HISTORY_TURNS;
    index -= 1
  ) {
    const turn = historyTurn(candidates[index]);
    if (!turn) continue;
    const turnBytes = Buffer.byteLength(JSON.stringify(turn), "utf8") + 1;
    if (bytes + turnBytes > MAX_HISTORY_BYTES) break;
    selected.unshift(turn);
    bytes += turnBytes;
  }
  return selected;
}

function dataPackagePath(root, session) {
  const dataPackageId = validateIdentifier(
    "dataPackageId",
    session?.dataPackageId ?? session?.dataPackage?.id,
  );
  return join(resolve(root), ".attend", "local", "analyses", `${dataPackageId}.json`);
}

/**
 * Build the route-neutral, verified context used by both a live host and a
 * detached adapter. No browser-supplied evidence enters this boundary.
 */
export async function buildQuestionContext({
  root,
  sessionId,
  questionId,
  signal,
  loadContext = loadQuestionResponseContext,
  loadThreadConversation,
  evidenceForSelection = evidencePacketForSelection,
} = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("root must be a non-empty path");
  }
  const safeSessionId = validateIdentifier("sessionId", sessionId);
  const safeQuestionId = validateIdentifier("questionId", questionId);
  if (typeof loadContext !== "function") {
    throw new TypeError("loadContext must be a function");
  }
  if (typeof evidenceForSelection !== "function") {
    throw new TypeError("evidenceForSelection must be a function");
  }
  if (loadThreadConversation !== undefined && typeof loadThreadConversation !== "function") {
    throw new TypeError("loadThreadConversation must be a function when supplied");
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
  signal?.throwIfAborted();

  const context = await loadContext({
    root: resolve(root),
    sessionId: safeSessionId,
    questionId: safeQuestionId,
    signal,
  });
  signal?.throwIfAborted();
  if (
    context?.session?.id !== safeSessionId ||
    context?.question?.id !== safeQuestionId ||
    !Number.isSafeInteger(context?.session?.state?.revision) ||
    context.session.state.revision < 0 ||
    !context?.session?.dataPackage
  ) {
    throw contextError(
      "QUESTION_CONTEXT_INVALID",
      "The stored response context does not match the requested question",
    );
  }

  const evidenceSelection = context.visualContext === null
    ? null
    : cloneJson(context.visualContext, "visual context");
  const selection = evidenceSelection ?? (
    context.question.selection === null || context.question.selection === undefined
      ? null
      : cloneJson(context.question.selection, "question selection")
  );
  const evidence = await evidenceForSelection({
    root: resolve(root),
    dataPackage: context.session.dataPackage,
    selection: evidenceSelection,
    signal,
  });
  signal?.throwIfAborted();

  let conversation = context.conversation;
  if (typeof context.question.threadId === "string") {
    conversation = loadThreadConversation
      ? await loadThreadConversation({
          root: resolve(root),
          threadId: context.question.threadId,
          questionId: safeQuestionId,
          signal,
        })
      : (await projectChatThread({
          root: resolve(root),
          threadId: context.question.threadId,
        })).turns;
    signal?.throwIfAborted();
  }

  return {
    sessionId: safeSessionId,
    sessionRevision: context.session.state.revision,
    question: cloneJson(context.question, "stored question"),
    selection,
    contextBinding: cloneJson(
      context.visualContextBinding ?? { mode: "none", selectionTurnId: null },
      "visual context binding",
    ),
    evidence: cloneJson(evidence, "evidence packet"),
    conversation: boundedConversation(conversation, safeQuestionId),
    dataPackagePath: dataPackagePath(root, context.session),
  };
}

/** Add only the host route and guarded reply fields to the shared context. */
export async function buildHostQuestionPacket({
  root,
  sessionId,
  questionId,
  route,
  signal,
  loadContext,
  loadThreadConversation,
  evidenceForSelection,
} = {}) {
  const normalizedRoute = normalizeBoundChatRoute(route);
  if (normalizedRoute.kind !== "host") {
    throw new TypeError("A host question packet requires a bound host route");
  }
  const context = await buildQuestionContext({
    root,
    sessionId,
    questionId,
    signal,
    ...(loadContext === undefined ? {} : { loadContext }),
    ...(loadThreadConversation === undefined ? {} : { loadThreadConversation }),
    ...(evidenceForSelection === undefined ? {} : { evidenceForSelection }),
  });
  if (!sameChatRoute(context.question.response?.route, normalizedRoute)) {
    throw contextError(
      "QUESTION_RESPONSE_ROUTE_MISMATCH",
      "The stored question is not bound to this host attachment",
    );
  }
  if (context.question.response?.status !== "queued") {
    throw contextError(
      "HOST_QUESTION_NOT_QUEUED",
      "The host question is no longer queued",
    );
  }
  if (typeof context.selection?.id !== "string" || context.selection.id.length === 0) {
    throw contextError(
      "QUESTION_CONTEXT_INVALID",
      "The stored question has no immutable selection id",
    );
  }

  return {
    schema: "attend-host-question/1",
    route: normalizedRoute,
    replyGuard: {
      sessionId: context.sessionId,
      questionId: context.question.id,
      expectedRevision: context.sessionRevision,
      selectionId: context.selection.id,
    },
    question: context.question,
    selection: context.selection,
    contextBinding: context.contextBinding,
    evidence: context.evidence,
    conversation: context.conversation,
  };
}

export const QUESTION_CONTEXT_LIMITS = Object.freeze({
  historyTurns: MAX_HISTORY_TURNS,
  historyContentChars: MAX_HISTORY_CONTENT_CHARS,
  historyBytes: MAX_HISTORY_BYTES,
});
