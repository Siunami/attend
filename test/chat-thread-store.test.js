import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createChatThread,
  legacyChatThreadId,
  loadChatThread,
} from "../src/chat-thread-store.js";
import {
  listProjectChatThreads,
  projectChatThread,
} from "../src/chat-thread-projection.js";
import { appendThreadQuestion } from "../src/chat-thread-service.js";
import { buildSelection } from "../src/selection.js";
import {
  appendConversationTurn,
  completeQuestionResponse,
  createSession,
  markQuestionResponseRunning,
  updateSession,
} from "../src/session-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-chat-thread-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function dataPackage(id, question) {
  return {
    schemaVersion: 1,
    kind: "attend-data-package",
    id,
    question: { text: question, target: "thread fixture" },
    hashes: {
      corpus: `${id}-corpus`,
      config: `${id}-config`,
      data: `${id}-data`,
    },
    config: {
      minWords: 2,
      maxWords: 3,
      minCount: 2,
      minSources: 1,
      limit: 10,
      maxFileBytes: 100_000,
      ranking: [
        { field: "distinctSourceCount", direction: "desc" },
        { field: "occurrenceCount", direction: "desc" },
        { field: "phrase", direction: "asc" },
      ],
    },
    sources: [{
      id: `source_${id}`,
      displayPath: `${id}.md`,
      sha256: `${id}-source`,
      kind: "markdown",
    }],
    rows: [{
      id: `phrase_${id}`,
      phrase: "thread fixture",
      wordCount: 2,
      occurrenceCount: 2,
      distinctSourceCount: 1,
      occurrences: [{
        sourceId: `source_${id}`,
        line: 1,
        excerpt: "thread fixture",
      }],
    }],
    map: {
      id: "phrase-list",
      version: 1,
      labelField: "phrase",
      valueField: "occurrenceCount",
    },
    transformations: ["thread fixture"],
    knownOmissions: [],
  };
}

async function appendQuestion({ root, sessionId, revision, thread, sequence, content }) {
  return appendConversationTurn({
    root,
    sessionId,
    expectedRevision: revision,
    turn: {
      id: `turn_${sessionId}_${sequence}`,
      role: "user",
      content,
      createdAt: `2026-08-27T12:00:0${sequence}.000Z`,
      selection: {},
      threadId: thread.id,
      threadSequence: sequence,
      page: {
        sessionId,
        label: sessionId === "session_a" ? "Page A" : "Page B",
      },
      context: { selectionTurnId: null },
    },
  });
}

test("chat thread records are immutable identity plus an initial page", async (t) => {
  const root = await fixture(t);
  const session = await createSession({
    root,
    id: "session_a",
    dataPackage: dataPackage("data_thread_a", "Page A"),
  });

  const thread = await createChatThread({ root, session });

  assert.match(thread.id, /^thread_[a-f0-9]{24}$/u);
  assert.deepEqual(thread.initialPage, {
    sessionId: "session_a",
    label: "Page A",
  });
  assert.deepEqual(await loadChatThread({ root, threadId: thread.id }), thread);
  assert.equal(Object.hasOwn(thread, "turns"), false);
  assert.equal(Object.hasOwn(thread, "updatedAt"), false);
  assert.match(legacyChatThreadId("session_a"), /^legacy_[a-f0-9]{24}$/u);
});

test("thread projection derives only send-time page changes across sessions", async (t) => {
  const root = await fixture(t);
  const sessionA = await createSession({
    root,
    id: "session_a",
    dataPackage: dataPackage("data_thread_a", "Page A"),
  });
  await createSession({
    root,
    id: "session_b",
    dataPackage: dataPackage("data_thread_b", "Page B"),
  });
  const thread = await createChatThread({ root, session: sessionA });

  await appendQuestion({
    root,
    sessionId: "session_a",
    revision: 0,
    thread,
    sequence: 0,
    content: "First on A",
  });

  const beforeSendingOnB = await projectChatThread({ root, threadId: thread.id });
  assert.deepEqual(
    beforeSendingOnB.events.map((event) => [event.type, event.page?.sessionId ?? event.turnId]),
    [
      ["page-context", "session_a"],
      ["message", "turn_session_a_0"],
    ],
    "loading another page alone must not create a page event",
  );

  await appendQuestion({
    root,
    sessionId: "session_b",
    revision: 0,
    thread,
    sequence: 1,
    content: "First on B",
  });
  await appendQuestion({
    root,
    sessionId: "session_b",
    revision: 1,
    thread,
    sequence: 2,
    content: "Still on B",
  });
  await appendQuestion({
    root,
    sessionId: "session_a",
    revision: 1,
    thread,
    sequence: 3,
    content: "Back on A",
  });

  const projected = await projectChatThread({ root, threadId: thread.id });
  assert.deepEqual(
    projected.events.map((event) => [event.type, event.page?.sessionId ?? event.turnId]),
    [
      ["page-context", "session_a"],
      ["message", "turn_session_a_0"],
      ["page-context", "session_b"],
      ["message", "turn_session_b_1"],
      ["message", "turn_session_b_2"],
      ["page-context", "session_a"],
      ["message", "turn_session_a_3"],
    ],
  );
  assert.equal(projected.title, "First on A");
  assert.match(projected.revision, /^[a-f0-9]{64}$/u);

  const history = await listProjectChatThreads({ root });
  assert.deepEqual(history.map(({ id, title }) => ({ id, title })), [{
    id: thread.id,
    title: "First on A",
  }]);
});

test("visual context follows consecutive messages on one page but resets after a page change", async (t) => {
  const root = await fixture(t);
  const packageA = dataPackage("data_context_a", "Page A");
  const packageB = dataPackage("data_context_b", "Page B");
  const sessionA = await createSession({
    root,
    id: "session_a",
    dataPackage: packageA,
  });
  const sessionB = await createSession({
    root,
    id: "session_b",
    dataPackage: packageB,
  });
  const selectedA = await updateSession({
    root,
    sessionId: sessionA.id,
    expectedRevision: sessionA.state.revision,
    patch: { selectedIds: ["phrase_data_context_a"] },
  });
  const thread = await createChatThread({ root, session: selectedA });
  const route = { kind: "local", model: "gpt-oss-20b" };

  const first = await appendThreadQuestion({
    root,
    threadId: thread.id,
    sessionId: sessionA.id,
    expectedRevision: selectedA.state.revision,
    selection: buildSelection(packageA, selectedA.state),
    message: "Start with evidence on A",
    route,
  });
  assert.deepEqual(first.persistedQuestion.context, {
    selectionTurnId: first.persistedQuestion.id,
  });
  await markQuestionResponseRunning({
    root,
    sessionId: sessionA.id,
    questionId: first.persistedQuestion.id,
    route,
  });
  const firstAnswer = await completeQuestionResponse({
    root,
    sessionId: sessionA.id,
    questionId: first.persistedQuestion.id,
    content: "First answer",
    route,
  });

  const followUp = await appendThreadQuestion({
    root,
    threadId: thread.id,
    sessionId: sessionA.id,
    expectedRevision: firstAnswer.session.state.revision,
    selection: buildSelection(packageA, firstAnswer.session.state),
    message: "Follow up on A",
    route,
  });
  assert.deepEqual(followUp.persistedQuestion.context, {
    selectionTurnId: first.persistedQuestion.id,
  });
  await markQuestionResponseRunning({
    root,
    sessionId: sessionA.id,
    questionId: followUp.persistedQuestion.id,
    route,
  });
  const followUpAnswer = await completeQuestionResponse({
    root,
    sessionId: sessionA.id,
    questionId: followUp.persistedQuestion.id,
    content: "Follow-up answer",
    route,
  });

  const onB = await appendThreadQuestion({
    root,
    threadId: thread.id,
    sessionId: sessionB.id,
    expectedRevision: sessionB.state.revision,
    selection: buildSelection(packageB, sessionB.state),
    message: "Move to B",
    route,
  });
  assert.deepEqual(onB.persistedQuestion.context, { selectionTurnId: null });
  await markQuestionResponseRunning({
    root,
    sessionId: sessionB.id,
    questionId: onB.persistedQuestion.id,
    route,
  });
  await completeQuestionResponse({
    root,
    sessionId: sessionB.id,
    questionId: onB.persistedQuestion.id,
    content: "B answer",
    route,
  });

  const backOnA = await appendThreadQuestion({
    root,
    threadId: thread.id,
    sessionId: sessionA.id,
    expectedRevision: followUpAnswer.session.state.revision,
    selection: buildSelection(packageA, followUpAnswer.session.state),
    message: "Return to A without reattaching evidence",
    route,
  });
  assert.deepEqual(backOnA.persistedQuestion.context, { selectionTurnId: null });
});

test("unthreaded conversations remain visible as deterministic legacy chats", async (t) => {
  const root = await fixture(t);
  await createSession({
    root,
    id: "session_legacy",
    dataPackage: dataPackage("data_thread_legacy", "Legacy page"),
  });
  await appendConversationTurn({
    root,
    sessionId: "session_legacy",
    expectedRevision: 0,
    turn: {
      id: "turn_legacy",
      role: "user",
      content: "Existing question",
      createdAt: "2026-08-27T11:00:00.000Z",
      selection: {},
    },
  });

  const threadId = legacyChatThreadId("session_legacy");
  const projected = await projectChatThread({ root, threadId });
  assert.equal(projected.id, threadId);
  assert.equal(projected.title, "Existing question");
  assert.deepEqual(projected.events.map((event) => event.type), [
    "page-context",
    "message",
  ]);
});
