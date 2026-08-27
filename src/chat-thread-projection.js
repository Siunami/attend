import { createHash } from "node:crypto";

import {
  legacyChatThreadId,
  listChatThreadRecords,
  pageDescriptorForSession,
  validateChatThreadId,
} from "./chat-thread-store.js";
import { loadSession, storedSessionIds } from "./session-store.js";

function cloneJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (encoded === undefined) throw new TypeError(`${label} must be JSON-serializable`);
  return JSON.parse(encoded);
}

function conversationTurns(session) {
  if (Array.isArray(session?.conversation)) return session.conversation;
  return Array.isArray(session?.conversation?.turns) ? session.conversation.turns : [];
}

function validPage(value, session) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.sessionId === session.id &&
    typeof value.label === "string" &&
    value.label.length > 0
  ) {
    return { sessionId: value.sessionId, label: value.label };
  }
  return pageDescriptorForSession(session);
}

export async function loadProjectChatIndex({ root } = {}) {
  const sessions = [];
  for (const sessionId of await storedSessionIds(root)) {
    try {
      sessions.push(await loadSession({ root, sessionId }));
    } catch {
      // One unavailable session must not hide healthy project chat history.
    }
  }
  return {
    root,
    records: await listChatThreadRecords({ root }),
    sessions,
  };
}

function turnMembership(session) {
  const turns = conversationTurns(session);
  const questions = new Map(
    turns
      .filter((turn) => turn?.role === "user" && typeof turn.id === "string")
      .map((turn, index) => [turn.id, { turn, index }]),
  );
  return turns.map((turn, index) => {
    if (turn?.role === "user") {
      return {
        turn,
        index,
        threadId: turn.threadId ?? legacyChatThreadId(session.id),
        question: turn,
      };
    }
    if (turn?.role === "assistant" && typeof turn.replyToTurnId === "string") {
      const target = questions.get(turn.replyToTurnId)?.turn;
      if (target) {
        return {
          turn,
          index,
          threadId: target.threadId ?? legacyChatThreadId(session.id),
          question: target,
        };
      }
    }
    if (turn?.role === "assistant" && turn.threadId) {
      return { turn, index, threadId: turn.threadId, question: null };
    }
    return {
      turn,
      index,
      threadId: legacyChatThreadId(session.id),
      question: null,
    };
  });
}

function legacyRecord(index, threadId) {
  for (const session of index.sessions) {
    if (legacyChatThreadId(session.id) !== threadId) continue;
    const hasLegacyTurns = conversationTurns(session).some(
      (turn) => turn?.threadId === undefined,
    );
    if (!hasLegacyTurns) return null;
    return {
      schemaVersion: 1,
      id: threadId,
      createdAt: session.createdAt,
      initialPage: pageDescriptorForSession(session),
      legacy: true,
    };
  }
  return null;
}

function recordFromIndex(index, threadId) {
  return index.records.find((record) => record.id === threadId) ?? legacyRecord(index, threadId);
}

function timestamp(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : 0;
}

function questionOrder(left, right) {
  const leftSequence = left.turn.threadSequence;
  const rightSequence = right.turn.threadSequence;
  if (Number.isSafeInteger(leftSequence) && Number.isSafeInteger(rightSequence)) {
    const sequence = leftSequence - rightSequence;
    if (sequence) return sequence;
  }
  const time = timestamp(left.turn.createdAt) - timestamp(right.turn.createdAt);
  if (time) return time;
  const session = left.session.id.localeCompare(right.session.id);
  if (session) return session;
  const position = left.index - right.index;
  if (position) return position;
  return String(left.turn.id).localeCompare(String(right.turn.id));
}

function memberGroups(index, threadId) {
  const questions = [];
  const answers = new Map();
  const standalone = [];
  for (const session of index.sessions) {
    for (const member of turnMembership(session)) {
      if (member.threadId !== threadId) continue;
      const value = { ...member, session };
      if (member.turn?.role === "user") {
        questions.push(value);
      } else if (member.question) {
        const list = answers.get(member.question.id) ?? [];
        list.push(value);
        answers.set(member.question.id, list);
      } else {
        standalone.push(value);
      }
    }
  }
  questions.sort(questionOrder);
  const groups = questions.map((question) => ({
    question,
    answers: (answers.get(question.turn.id) ?? []).sort((left, right) => (
      timestamp(left.turn.createdAt) - timestamp(right.turn.createdAt) ||
      left.index - right.index
    )),
  }));
  return { groups, standalone };
}

function oneLineTitle(content) {
  const value = String(content ?? "").replace(/\s+/gu, " ").trim();
  if (!value) return "New chat";
  return value.length > 70 ? `${value.slice(0, 67)}…` : value;
}

function responseActive(turn, answeredQuestionIds) {
  return (
    turn?.role === "user" &&
    !answeredQuestionIds.has(turn.id) &&
    (turn.response?.status === "queued" || turn.response?.status === "running")
  );
}

function projectionFromIndex(index, threadId) {
  const record = recordFromIndex(index, threadId);
  if (!record) {
    const missing = new Error(`Chat thread not found: ${threadId}`);
    missing.code = "CHAT_THREAD_NOT_FOUND";
    throw missing;
  }
  const { groups, standalone } = memberGroups(index, threadId);
  const turns = [];
  for (const group of groups) {
    const questionPage = validPage(group.question.turn.page, group.question.session);
    turns.push({
      ...cloneJson(group.question.turn, "chat question"),
      originSessionId: group.question.session.id,
      page: questionPage,
    });
    for (const answer of group.answers) {
      turns.push({
        ...cloneJson(answer.turn, "chat answer"),
        originSessionId: answer.session.id,
      });
    }
  }
  for (const member of standalone.sort(questionOrder)) {
    turns.push({
      ...cloneJson(member.turn, "standalone chat turn"),
      originSessionId: member.session.id,
    });
  }

  const events = [{
    type: "page-context",
    id: `page:${threadId}:initial`,
    page: cloneJson(record.initialPage, "initial page"),
    createdAt: record.createdAt,
  }];
  let lastPageId = record.initialPage.sessionId;
  for (const turn of turns) {
    if (turn.role === "user" && turn.page?.sessionId !== lastPageId) {
      events.push({
        type: "page-context",
        id: `page:${turn.id}`,
        page: cloneJson(turn.page, "turn page"),
        createdAt: turn.createdAt,
      });
      lastPageId = turn.page.sessionId;
    }
    events.push({
      type: "message",
      id: `message:${turn.id}`,
      turnId: turn.id,
      createdAt: turn.createdAt,
    });
  }

  const answeredQuestionIds = new Set(
    turns
      .filter((turn) => turn.role === "assistant" && turn.replyToTurnId)
      .map((turn) => turn.replyToTurnId),
  );
  const activeTurn = turns.find((turn) => responseActive(turn, answeredQuestionIds));
  const updatedAt = turns.reduce(
    (latest, turn) => timestamp(turn.createdAt) > timestamp(latest) ? turn.createdAt : latest,
    record.createdAt,
  );
  const revision = createHash("sha256").update(JSON.stringify({
    record,
    turns: turns.map((turn) => ({
      id: turn.id,
      role: turn.role,
      content: turn.content,
      createdAt: turn.createdAt,
      replyToTurnId: turn.replyToTurnId,
      originSessionId: turn.originSessionId,
      threadSequence: turn.threadSequence,
      page: turn.page,
      response: turn.response,
    })),
  })).digest("hex");
  return {
    id: threadId,
    createdAt: record.createdAt,
    updatedAt,
    initialPage: cloneJson(record.initialPage, "initial page"),
    title: oneLineTitle(turns.find((turn) => turn.role === "user")?.content),
    revision,
    turns,
    events,
    activeResponse: activeTurn
      ? {
          questionId: activeTurn.id,
          originSessionId: activeTurn.originSessionId,
          route: cloneJson(activeTurn.response.route, "active response route"),
        }
      : null,
  };
}

export async function projectChatThread({ root, threadId, index } = {}) {
  const safeThreadId = validateChatThreadId(threadId);
  const loaded = index ?? await loadProjectChatIndex({ root });
  return projectionFromIndex(loaded, safeThreadId);
}

export async function listProjectChatThreads({ root, index } = {}) {
  const loaded = index ?? await loadProjectChatIndex({ root });
  const ids = new Set(loaded.records.map((record) => record.id));
  for (const session of loaded.sessions) {
    if (conversationTurns(session).some((turn) => turn?.threadId === undefined)) {
      ids.add(legacyChatThreadId(session.id));
    }
  }
  return [...ids]
    .map((threadId) => projectionFromIndex(loaded, threadId))
    .map(({ id, title, createdAt, updatedAt, initialPage, turns, revision }) => ({
      id,
      title,
      createdAt,
      updatedAt,
      initialPage,
      messageCount: turns.length,
      revision,
    }))
    .sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
    ));
}

export async function chatThreadQuestionOwner({ root, threadId, questionId, index } = {}) {
  const thread = await projectChatThread({ root, threadId, index });
  const question = thread.turns.find(
    (turn) => turn.role === "user" && turn.id === questionId,
  );
  if (!question) {
    const missing = new Error(`Question not found in chat thread: ${questionId}`);
    missing.code = "QUESTION_NOT_FOUND";
    throw missing;
  }
  return { thread, sessionId: question.originSessionId, question };
}
