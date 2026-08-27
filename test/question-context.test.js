import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  boundedConversation,
  buildHostQuestionPacket,
  buildQuestionContext,
  QUESTION_CONTEXT_LIMITS,
} from "../src/question-context.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-question-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function storedContext(route) {
  const selection = { id: "selection_exact", selectedMarkIds: ["mark_one"] };
  const question = {
    id: "turn_current",
    role: "user",
    content: "What changed?",
    createdAt: "2026-08-24T18:00:00.000Z",
    selection,
    response: {
      status: "queued",
      route,
      queuedAt: "2026-08-24T18:00:00.000Z",
      updatedAt: "2026-08-24T18:00:00.000Z",
      attempt: 0,
    },
  };
  return {
    session: {
      id: "session_exact",
      dataPackageId: "data_0123456789abcdef",
      dataPackage: {
        id: "data_0123456789abcdef",
        hashes: { data: "hash" },
      },
      state: { revision: 7 },
    },
    question,
    visualContext: selection,
    visualContextBinding: {
      mode: "attached",
      selectionTurnId: "turn_current",
    },
    conversation: [
      {
        id: "turn_prior",
        role: "assistant",
        content: "Earlier answer",
        selection: { id: "selection_prior", private: "not copied" },
      },
      question,
    ],
  };
}

test("bounded history excludes the current question and private selection bodies", () => {
  const conversation = Array.from({ length: 20 }, (_, index) => ({
    id: `turn_${index}`,
    role: index % 2 ? "assistant" : "user",
    content: `${index}:${"x".repeat(6_000)}`,
    selection: { id: `selection_${index}`, privateEvidence: "do not copy" },
  }));
  conversation.push({
    id: "turn_current",
    role: "user",
    content: "current",
    selection: { id: "selection_current" },
  });
  const bounded = boundedConversation(conversation, "turn_current");
  assert.ok(bounded.length > 0 && bounded.length <= QUESTION_CONTEXT_LIMITS.historyTurns);
  assert.equal(bounded.some((turn) => turn.id === "turn_current"), false);
  assert.ok(
    Buffer.byteLength(JSON.stringify(bounded), "utf8") <=
      QUESTION_CONTEXT_LIMITS.historyBytes,
  );
  assert.equal(Object.hasOwn(bounded.at(-1).selection, "privateEvidence"), false);
});

test("the shared builder derives evidence only from stored immutable context", async (t) => {
  const root = await fixture(t);
  const route = {
    kind: "host",
    attachmentId: "host_0123456789abcdef",
    generation: 1,
  };
  const source = storedContext(route);
  let evidenceInput;
  const context = await buildQuestionContext({
    root,
    sessionId: "session_exact",
    questionId: "turn_current",
    async loadContext() {
      return source;
    },
    async evidenceForSelection(input) {
      evidenceInput = input;
      return {
        kind: "attend-evidence-packet",
        selectionId: input.selection.id,
        sources: [{ id: "source_one", content: "Verified evidence" }],
      };
    },
  });

  assert.equal(evidenceInput.dataPackage, source.session.dataPackage);
  assert.deepEqual(evidenceInput.selection, source.visualContext);
  assert.equal(context.sessionRevision, 7);
  assert.equal(context.question.id, "turn_current");
  assert.equal(context.selection.id, "selection_exact");
  assert.deepEqual(context.conversation, [{
    id: "turn_prior",
    role: "assistant",
    content: "Earlier answer",
    selection: { id: "selection_prior" },
  }]);
});

test("threaded questions use cross-page thread history without page events", async (t) => {
  const root = await fixture(t);
  const source = storedContext({ kind: "detached", adapter: "codex-cli" });
  source.question.threadId = "thread_0123456789abcdef01234567";
  source.conversation = [{
    id: "turn_wrong_chat",
    role: "assistant",
    content: "Same page, wrong chat",
  }, source.question];
  const threadConversation = [{
    id: "turn_other_page",
    role: "assistant",
    content: "Prior answer from another page",
    originSessionId: "session_other_page",
  }, source.question];
  let requestedThread;

  const context = await buildQuestionContext({
    root,
    sessionId: "session_exact",
    questionId: "turn_current",
    async loadContext() {
      return source;
    },
    async loadThreadConversation({ threadId }) {
      requestedThread = threadId;
      return threadConversation;
    },
    async evidenceForSelection() {
      return { kind: "attend-evidence-packet", sources: [] };
    },
  });

  assert.equal(requestedThread, source.question.threadId);
  assert.deepEqual(context.conversation, [{
    id: "turn_other_page",
    role: "assistant",
    content: "Prior answer from another page",
  }]);
  assert.equal(JSON.stringify(context.conversation).includes("page-context"), false);
});

test("a host packet carries exact reply guards and rejects another route", async (t) => {
  const root = await fixture(t);
  const route = {
    kind: "host",
    attachmentId: "host_0123456789abcdef",
    generation: 2,
  };
  const source = storedContext(route);
  const packet = await buildHostQuestionPacket({
    root,
    sessionId: "session_exact",
    questionId: "turn_current",
    route,
    async loadContext() {
      return source;
    },
    async evidenceForSelection({ selection }) {
      return { kind: "attend-evidence-packet", selectionId: selection.id };
    },
  });
  assert.equal(packet.schema, "attend-host-question/1");
  assert.deepEqual(packet.route, route);
  assert.deepEqual(packet.replyGuard, {
    sessionId: "session_exact",
    questionId: "turn_current",
    expectedRevision: 7,
    selectionId: "selection_exact",
  });
  assert.equal(packet.question.content, "What changed?");
  assert.equal(packet.selection.id, "selection_exact");
  assert.equal(packet.evidence.selectionId, "selection_exact");

  await assert.rejects(
    buildHostQuestionPacket({
      root,
      sessionId: "session_exact",
      questionId: "turn_current",
      route: { ...route, generation: 3 },
      async loadContext() {
        return source;
      },
      async evidenceForSelection() {
        return { kind: "attend-evidence-packet" };
      },
    }),
    { code: "QUESTION_RESPONSE_ROUTE_MISMATCH" },
  );
});

test("a question without selected marks keeps its frozen reply selection", async (t) => {
  const root = await fixture(t);
  const route = {
    kind: "host",
    attachmentId: "host_fedcba9876543210",
    generation: 1,
  };
  const source = storedContext(route);
  source.question.selection = {
    id: "selection_empty",
    selectedMarkIds: [],
  };
  source.visualContext = null;
  source.visualContextBinding = { mode: "none", selectionTurnId: null };
  let evidenceSelection = "not-called";
  const packet = await buildHostQuestionPacket({
    root,
    sessionId: "session_exact",
    questionId: "turn_current",
    route,
    async loadContext() {
      return source;
    },
    async evidenceForSelection({ selection }) {
      evidenceSelection = selection;
      return { kind: "attend-evidence-packet", sources: [] };
    },
  });

  assert.equal(evidenceSelection, null);
  assert.deepEqual(packet.selection, {
    id: "selection_empty",
    selectedMarkIds: [],
  });
  assert.equal(packet.replyGuard.selectionId, "selection_empty");
  assert.deepEqual(packet.contextBinding, { mode: "none", selectionTurnId: null });
});
