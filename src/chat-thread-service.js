import { randomUUID } from "node:crypto";

import {
  chatThreadQuestionOwner,
  loadProjectChatIndex,
  projectChatThread,
} from "./chat-thread-projection.js";
import {
  pageDescriptorForSession,
  withChatThreadLock,
} from "./chat-thread-store.js";
import {
  appendQueuedQuestion,
  loadSession,
  retryQuestionResponse,
} from "./session-store.js";

function activeResponseError() {
  const error = new Error("This chat already has an active response job");
  error.code = "ACTIVE_RESPONSE_EXISTS";
  return error;
}

function nextThreadSequence(thread) {
  const questions = thread.turns.filter((turn) => turn.role === "user");
  const explicit = questions
    .map((turn) => turn.threadSequence)
    .filter(Number.isSafeInteger);
  return Math.max(questions.length - 1, ...explicit, -1) + 1;
}

function previousContextTurnId(thread, page) {
  const previous = thread.turns.filter((turn) => turn.role === "user").at(-1);
  if (
    !previous ||
    previous.originSessionId !== page.sessionId ||
    previous.page?.sessionId !== page.sessionId ||
    typeof previous.context?.selectionTurnId !== "string"
  ) {
    return null;
  }
  return previous.id;
}

export async function appendThreadQuestion({
  root,
  threadId,
  sessionId,
  expectedRevision,
  selection,
  message,
  route,
} = {}) {
  return withChatThreadLock({
    root,
    threadId,
    async operation() {
      const index = await loadProjectChatIndex({ root });
      const thread = await projectChatThread({ root, threadId, index });
      if (thread.activeResponse) throw activeResponseError();
      const session = index.sessions.find((entry) => entry.id === sessionId)
        ?? await loadSession({ root, sessionId });
      const page = pageDescriptorForSession(session);
      const id = `turn_${randomUUID()}`;
      const updated = await appendQueuedQuestion({
        root,
        sessionId,
        expectedRevision,
        consumeSelectedIds: true,
        route,
        turn: {
          id,
          role: "user",
          content: message,
          createdAt: new Date().toISOString(),
          selection,
          threadId,
          threadSequence: nextThreadSequence(thread),
          page,
          context: { selectionTurnId: previousContextTurnId(thread, page) },
        },
      });
      const persistedQuestion = updated.conversation.turns.find((turn) => turn.id === id);
      return { session: updated, persistedQuestion };
    },
  });
}

export async function retryThreadQuestion({
  root,
  threadId,
  questionId,
  routeForSession,
} = {}) {
  return withChatThreadLock({
    root,
    threadId,
    async operation() {
      const index = await loadProjectChatIndex({ root });
      const owner = await chatThreadQuestionOwner({
        root,
        threadId,
        questionId,
        index,
      });
      if (
        owner.thread.activeResponse &&
        owner.thread.activeResponse.questionId !== questionId
      ) {
        throw activeResponseError();
      }
      if (typeof routeForSession !== "function") {
        throw new TypeError("routeForSession must be a function");
      }
      const expectedRoute = await routeForSession(owner.sessionId);
      if (!expectedRoute) {
        const unavailable = new Error("No response route is available for this chat question");
        unavailable.code = "CHAT_ROUTE_UNAVAILABLE";
        throw unavailable;
      }
      const retried = await retryQuestionResponse({
        root,
        sessionId: owner.sessionId,
        questionId,
        expectedRoute,
      });
      return { ...retried, ownerSessionId: owner.sessionId };
    },
  });
}
