import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  boundedConversation,
  createQuestionWorker,
  QUESTION_WORKER_LIMITS,
  questionResponseErrorCode,
} from "../src/question-worker.js";
import { buildSelection } from "../src/selection.js";
import {
  appendQueuedQuestion,
  completeQuestionResponse,
  createSession,
  loadSession,
  markQuestionResponseFailed,
  markQuestionResponseRunning,
  pendingQuestionResponseJobs,
  retryQuestionResponse,
  updateSession,
} from "../src/session-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function dataPackage(id) {
  return {
    schemaVersion: 1,
    kind: "attend-data-package",
    id,
    question: { text: "Which phrases recur?", target: "fixture notes" },
    hashes: { corpus: "corpus", config: "config", data: `${id}-hash` },
    config: {
      minWords: 2,
      maxWords: 4,
      minCount: 2,
      minSources: 1,
      limit: 50,
      maxFileBytes: 1_000_000,
      ranking: [{ field: "occurrenceCount", direction: "desc" }],
    },
    sources: [{
      id: "source_alpha",
      displayPath: "notes/alpha.md",
      sha256: "alpha-hash",
      kind: "markdown",
    }],
    rows: [{
      id: "phrase_bug_book",
      phrase: "bug book",
      wordCount: 2,
      occurrenceCount: 2,
      distinctSourceCount: 1,
      occurrences: [{
        sourceId: "source_alpha",
        line: 1,
        excerpt: "Bug book — August 22",
      }],
    }],
    map: {
      id: "phrase-list",
      version: 1,
      labelField: "phrase",
      valueField: "occurrenceCount",
    },
    transformations: ["deterministic n-grams"],
    knownOmissions: [],
  };
}

async function queuedQuestion(root, suffix, {
  createdAt,
  route = { kind: "detached", adapter: "codex-cli" },
} = {}) {
  const packageValue = dataPackage(`data_${suffix}`);
  const sessionId = `session_${suffix}`;
  const questionId = `turn_${suffix}`;
  const created = await createSession({ root, id: sessionId, dataPackage: packageValue });
  const selected = await updateSession({
    root,
    sessionId,
    expectedRevision: created.state.revision,
    patch: { selectedIds: ["phrase_bug_book"] },
  });
  const selection = buildSelection(packageValue, selected.state);
  await appendQueuedQuestion({
    root,
    sessionId,
    expectedRevision: selected.state.revision,
    route,
    turn: {
      id: questionId,
      role: "user",
      content: `Summarize bug book ${suffix}`,
      ...(createdAt ? { createdAt } : {}),
      selection,
    },
  });
  return { sessionId, questionId, selection, packageValue };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function fixtureEvidenceForSelection({ dataPackage, selection }) {
  const sourceIds = [
    ...new Set((selection?.sourceRefs ?? []).map((reference) => reference.sourceId)),
  ];
  return {
    schemaVersion: 1,
    kind: "attend-evidence-packet",
    dataPackageId: dataPackage.id,
    dataHash: dataPackage.hashes.data,
    selectionId: selection?.id ?? null,
    coverage: {
      selectedSourceCount: sourceIds.length,
      includedSourceCount: sourceIds.length,
      complete: true,
      truncatedSourceCount: 0,
    },
    sources: sourceIds.map((sourceId) => ({
      sourceId,
      content: "Bug Book begins with observations and develops into fixes.",
    })),
  };
}

test("conversation history is bounded and excludes the separately supplied current question", () => {
  const conversation = Array.from({ length: 20 }, (_, index) => ({
    id: `turn_history_${index}`,
    role: index % 2 ? "assistant" : "user",
    content: `${index}:${"x".repeat(6_000)}`,
    selection: { id: `selection_${index}`, privateEvidence: "not copied" },
  }));
  conversation.push({
    id: "turn_current",
    role: "user",
    content: "current question",
    selection: { id: "selection_current" },
  });
  conversation.push({ id: "turn_future", role: "assistant", content: "future" });

  const bounded = boundedConversation(conversation, "turn_current");
  assert.ok(bounded.length > 0 && bounded.length <= QUESTION_WORKER_LIMITS.historyTurns);
  assert.equal(bounded.some((turn) => turn.id === "turn_current"), false);
  assert.equal(bounded.some((turn) => turn.id === "turn_future"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= QUESTION_WORKER_LIMITS.historyBytes);
  assert.deepEqual(bounded.at(-1).selection, { id: "selection_19" });
  assert.equal(Object.hasOwn(bounded.at(-1).selection, "privateEvidence"), false);
});

test("worker consumes an explicit durable job with its exact historical selection", async (t) => {
  const root = await fixture(t);
  const job = await queuedQuestion(root, "exact");
  let request;
  const worker = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    capability: { adapter: "codex-cli", available: true, authenticated: true },
    runner: {
      async respond(value) {
        request = value;
        return { answer: "It is a recurring dated note series." };
      },
    },
  });
  t.after(() => worker.close());

  assert.deepEqual(await worker.recover(), { recovered: 1, interrupted: 0 });
  await worker.whenIdle();

  assert.equal(request.question.id, job.questionId);
  assert.equal(request.question.content, "Summarize bug book exact");
  const beforeAnswer = request.question.selection;
  assert.deepEqual(request.selection, beforeAnswer);
  assert.equal(request.selection.id, job.selection.id);
  assert.deepEqual(request.contextBinding, {
    mode: "attached",
    selectionTurnId: job.questionId,
  });
  assert.equal(request.evidence.selectionId, job.selection.id);
  assert.equal(request.evidence.coverage.complete, true);
  assert.deepEqual(request.conversation, []);
  assert.equal(
    request.dataPackagePath,
    join(root, ".attend", "local", "analyses", `${job.packageValue.id}.json`),
  );
  assert.equal(request.signal.aborted, false);

  const stored = await loadSession({ root, sessionId: job.sessionId });
  const question = stored.conversation.turns.find((turn) => turn.id === job.questionId);
  const answer = stored.conversation.turns.find((turn) => turn.replyToTurnId === job.questionId);
  assert.equal(question.response.status, "completed");
  assert.equal(answer.content, "It is a recurring dated note series.");
  assert.deepEqual(answer.selection, question.selection);
});

test("worker resolves an unattached follow-up through the persisted conversation context chain", async (t) => {
  const root = await fixture(t);
  const origin = await queuedQuestion(root, "follow_up_origin");
  await markQuestionResponseRunning({ root, ...origin });
  const completedOrigin = await completeQuestionResponse({
    root,
    ...origin,
    content: "The phrase identifies a recurring dated series.",
  });
  const emptyAttachment = buildSelection(
    origin.packageValue,
    completedOrigin.session.state,
  );
  assert.deepEqual(emptyAttachment.selectedMarkIds, []);
  const questionId = "turn_follow_up_question";
  await appendQueuedQuestion({
    root,
    sessionId: origin.sessionId,
    expectedRevision: completedOrigin.session.state.revision,
    route: { kind: "detached", adapter: "codex-cli" },
    turn: {
      id: questionId,
      role: "user",
      content: "Tell me about the contents.",
      selection: emptyAttachment,
    },
  });

  let request;
  const worker = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    runner: {
      async respond(value) {
        request = value;
        return { answer: "The contents develop from observation into proposed fixes." };
      },
    },
  });
  t.after(() => worker.close());
  assert.deepEqual(await worker.recover(), { recovered: 1, interrupted: 0 });
  await worker.whenIdle();

  assert.deepEqual(request.question.selection.selectedMarkIds, []);
  assert.equal(request.selection.id, origin.selection.id);
  assert.deepEqual(request.contextBinding, {
    mode: "inherited",
    selectionTurnId: origin.questionId,
  });
  assert.equal(request.evidence.selectionId, origin.selection.id);
  assert.match(request.evidence.sources[0].content, /develops into fixes/u);
  assert.deepEqual(
    request.conversation.map((turn) => [turn.role, turn.content]),
    [
      ["user", "Summarize bug book follow_up_origin"],
      ["assistant", "The phrase identifies a recurring dated series."],
    ],
  );
  assert.deepEqual(request.conversation[0].context, {
    selectionTurnId: origin.questionId,
  });

  const stored = await loadSession({ root, sessionId: origin.sessionId });
  const followUp = stored.conversation.turns.find((turn) => turn.id === questionId);
  const answer = stored.conversation.turns.find(
    (turn) => turn.replyToTurnId === questionId,
  );
  assert.deepEqual(followUp.selection.selectedMarkIds, []);
  assert.equal(answer.selection.id, origin.selection.id);
});

test("recovery deduplicates jobs and lets two visualizations answer concurrently", async (t) => {
  const root = await fixture(t);
  const first = await queuedQuestion(root, "alpha", { createdAt: "2026-08-22T00:00:00.000Z" });
  const second = await queuedQuestion(root, "beta", { createdAt: "2026-08-22T00:00:01.000Z" });
  const gates = [deferred(), deferred()];
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const worker = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    runner: {
      async respond(request) {
        const index = calls.length;
        calls.push(request.question.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gates[index].promise;
        active -= 1;
        return { answer: `answer ${index + 1}` };
      },
    },
  });
  t.after(() => worker.close());

  assert.deepEqual(await worker.recover(), { recovered: 2, interrupted: 0 });
  assert.deepEqual(
    await worker.enqueueQuestion({ root, sessionId: first.sessionId, questionId: first.questionId }),
    { accepted: false, reason: "duplicate" },
  );
  await waitFor(() => calls.length === 2, "concurrent responses did not start");
  assert.deepEqual(new Set(calls), new Set([first.questionId, second.questionId]));
  assert.equal(maxActive, 2);
  gates[0].resolve();
  gates[1].resolve();
  await worker.whenIdle();
  assert.equal(QUESTION_WORKER_LIMITS.concurrency, 2);
});

test("an interrupted running job becomes retryable without a duplicate provider call", async (t) => {
  const root = await fixture(t);
  const job = await queuedQuestion(root, "restart");
  let runnerStarted = false;
  let observedAbort = false;
  const firstWorker = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    runner: {
      respond({ signal }) {
        runnerStarted = true;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            const error = new Error("cancelled");
            error.name = "AbortError";
            error.code = "AGENT_RUN_CANCELLED";
            reject(error);
          }, { once: true });
        });
      },
    },
  });

  await firstWorker.recover();
  await waitFor(() => runnerStarted, "response runner did not start");
  await firstWorker.close();
  assert.equal(observedAbort, true);
  assert.deepEqual(await pendingQuestionResponseJobs({ root }), [{
    sessionId: job.sessionId,
    questionId: job.questionId,
    status: "running",
    route: { kind: "detached", adapter: "codex-cli" },
  }]);

  let restartedCalls = 0;
  const restarted = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    runner: {
      async respond() {
        restartedCalls += 1;
        return { answer: "Recovered answer" };
      },
    },
  });
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.recover(), { recovered: 0, interrupted: 1 });
  await restarted.whenIdle();
  let stored = await loadSession({ root, sessionId: job.sessionId });
  assert.equal(stored.conversation.turns[0].response.status, "failed");
  assert.equal(stored.conversation.turns[0].response.errorCode, "interrupted");
  assert.equal(stored.conversation.turns.length, 1);
  assert.equal(restartedCalls, 0);

  await retryQuestionResponse({ root, ...job });
  assert.deepEqual(await restarted.enqueueQuestion({ root, ...job }), { accepted: true });
  await restarted.whenIdle();
  stored = await loadSession({ root, sessionId: job.sessionId });
  assert.equal(stored.conversation.turns[0].response.status, "completed");
  assert.equal(stored.conversation.turns[1].content, "Recovered answer");
  assert.equal(restartedCalls, 1);
});

test("cold-start recovery never repeats a provider call already marked running", async (t) => {
  const root = await fixture(t);
  const job = await queuedQuestion(root, "cold");
  await markQuestionResponseRunning({ root, ...job });
  let called = false;
  const worker = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    runner: {
      async respond() {
        called = true;
        return { answer: "Cold-start answer" };
      },
    },
  });
  t.after(() => worker.close());

  assert.deepEqual(await worker.recover(), { recovered: 0, interrupted: 1 });
  await worker.whenIdle();
  const stored = await loadSession({ root, sessionId: job.sessionId });
  assert.equal(stored.conversation.turns[0].response.status, "failed");
  assert.equal(stored.conversation.turns[0].response.errorCode, "interrupted");
  assert.equal(called, false);
});

test("cold-start recovery automatically replays interrupted local inference", async (t) => {
  const root = await fixture(t);
  const route = { kind: "local", model: "gpt-oss-20b" };
  const job = await queuedQuestion(root, "local_restart", { route });
  await markQuestionResponseRunning({ root, ...job, route });
  let calls = 0;
  const worker = createQuestionWorker({
    root,
    route,
    capability: {
      adapter: "gpt-oss-20b",
      available: true,
      authenticated: true,
    },
    evidenceForSelection: fixtureEvidenceForSelection,
    runner: {
      adapter: "gpt-oss-20b",
      async respond() {
        calls += 1;
        return { answer: "Recovered privately on this Mac." };
      },
    },
  });
  t.after(() => worker.close());

  assert.deepEqual(await worker.recover(), { recovered: 1, interrupted: 1 });
  await worker.whenIdle();
  const stored = await loadSession({ root, sessionId: job.sessionId });
  assert.equal(calls, 1);
  assert.equal(stored.conversation.turns[0].response.status, "completed");
  assert.equal(stored.conversation.turns[1].content, "Recovered privately on this Mac.");
});

test("a question queued for another route is skipped rather than failed", async (t) => {
  const root = await fixture(t);
  const job = await queuedQuestion(root, "foreign_route", {
    route: { kind: "local", model: "gpt-oss-20b" },
  });
  let called = false;
  const worker = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    capability: { adapter: "codex-cli", available: true, authenticated: true },
    runner: {
      async respond() {
        called = true;
        return { answer: "This worker does not own the question." };
      },
    },
  });
  t.after(() => worker.close());

  assert.deepEqual(
    await worker.enqueueQuestion({
      root,
      sessionId: job.sessionId,
      questionId: job.questionId,
    }),
    { accepted: true },
  );
  await worker.whenIdle();

  assert.equal(called, false);
  const stored = await loadSession({ root, sessionId: job.sessionId });
  const response = stored.conversation.turns[0].response;
  assert.equal(response.status, "queued");
  assert.equal(Object.hasOwn(response, "errorCode"), false);
});

test("a response that is no longer queued keeps its recorded failure", async (t) => {
  const root = await fixture(t);
  const job = await queuedQuestion(root, "not_runnable");
  await markQuestionResponseFailed({ root, ...job, errorCode: "timeout" });
  let called = false;
  const worker = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    capability: { adapter: "codex-cli", available: true, authenticated: true },
    runner: {
      async respond() {
        called = true;
        return { answer: "The recorded failure must survive." };
      },
    },
  });
  t.after(() => worker.close());

  assert.deepEqual(
    await worker.enqueueQuestion({
      root,
      sessionId: job.sessionId,
      questionId: job.questionId,
    }),
    { accepted: true },
  );
  await worker.whenIdle();

  assert.equal(called, false);
  const stored = await loadSession({ root, sessionId: job.sessionId });
  const response = stored.conversation.turns[0].response;
  assert.equal(response.status, "failed");
  assert.equal(response.errorCode, "timeout");
});

test("runner failures persist only the bounded public error vocabulary", async (t) => {
  assert.equal(questionResponseErrorCode({ code: "AGENT_RUN_UNAVAILABLE" }), "runner_unavailable");
  assert.equal(questionResponseErrorCode({ code: "AGENT_RUN_TIMEOUT" }), "timeout");
  assert.equal(questionResponseErrorCode({ code: "AGENT_RUN_OUTPUT_LIMIT" }), "invalid_output");
  assert.equal(questionResponseErrorCode({ code: "AGENT_RUN_INVALID_OUTPUT" }), "invalid_output");
  assert.equal(questionResponseErrorCode({ code: "private-provider-detail" }), "runner_failed");

  const root = await fixture(t);
  const job = await queuedQuestion(root, "unavailable");
  let called = false;
  const worker = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    capability: {
      adapter: "codex-cli",
      available: true,
      authenticated: false,
      reason: "not_authenticated",
    },
    runner: {
      async respond() {
        called = true;
        throw new Error("raw output must not escape");
      },
    },
  });
  t.after(() => worker.close());
  await worker.recover();
  await worker.whenIdle();

  assert.equal(called, false, "an unavailable adapter is rejected before a slow run");
  const stored = await loadSession({ root, sessionId: job.sessionId });
  const response = stored.conversation.turns[0].response;
  assert.equal(response.status, "failed");
  assert.equal(response.errorCode, "runner_unavailable");
  assert.equal(JSON.stringify(response).includes("raw output"), false);
});

test("a previously unavailable Codex capability is re-probed without restarting", async (t) => {
  const root = await fixture(t);
  const job = await queuedQuestion(root, "reprobe");
  let probes = 0;
  let responses = 0;
  const worker = createQuestionWorker({
    root,
    evidenceForSelection: fixtureEvidenceForSelection,
    capability: {
      adapter: "codex-cli",
      available: true,
      authenticated: false,
      reason: "not_authenticated",
    },
    runner: {
      async capability() {
        probes += 1;
        return { adapter: "codex-cli", available: true, authenticated: true };
      },
      async respond() {
        responses += 1;
        return { answer: "Signed in without restarting." };
      },
    },
  });
  t.after(() => worker.close());

  assert.deepEqual(await worker.recover(), { recovered: 1, interrupted: 0 });
  await worker.whenIdle();
  assert.equal(probes, 1);
  assert.equal(responses, 1);
  const stored = await loadSession({ root, sessionId: job.sessionId });
  assert.equal(stored.conversation.turns[0].response.status, "completed");
});

test("a streamed run publishes the running status, every delta, and the answer turn", async (t) => {
  const root = await fixture(t);
  const job = await queuedQuestion(root, "streamed");
  const captured = [];
  const streamRelay = {
    publish(sessionId, event) {
      captured.push([sessionId, event]);
    },
  };
  const worker = createQuestionWorker({
    root,
    streamRelay,
    evidenceForSelection: fixtureEvidenceForSelection,
    capability: { adapter: "codex-cli", available: true, authenticated: true },
    runner: {
      async respond(request) {
        request.onDelta("Part one. ");
        request.onDelta("Part two.");
        return { answer: "Part one. Part two." };
      },
    },
  });
  t.after(() => worker.close());

  assert.deepEqual(await worker.recover(), { recovered: 1, interrupted: 0 });
  await worker.whenIdle();

  const events = captured.map(([, event]) => event);
  assert.deepEqual(
    new Set(captured.map(([sessionId]) => sessionId)),
    new Set([job.sessionId]),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["status", "delta", "delta", "answer"],
  );
  assert.deepEqual(
    new Set(events.map((event) => event.questionId)),
    new Set([job.questionId]),
  );
  assert.equal(events[0].status, "running");
  assert.deepEqual(
    events.slice(1, 3).map((event) => event.text),
    ["Part one. ", "Part two."],
  );

  const stored = await loadSession({ root, sessionId: job.sessionId });
  const answer = stored.conversation.turns.find(
    (turn) => turn.replyToTurnId === job.questionId,
  );
  assert.equal(events[3].answerTurnId, answer.id);
});

test("a streamed failure publishes the same error code the session records", async (t) => {
  const root = await fixture(t);
  const job = await queuedQuestion(root, "streamed_failure");
  const captured = [];
  const worker = createQuestionWorker({
    root,
    streamRelay: {
      publish(sessionId, event) {
        captured.push([sessionId, event]);
      },
    },
    evidenceForSelection: fixtureEvidenceForSelection,
    capability: { adapter: "codex-cli", available: true, authenticated: true },
    runner: {
      async respond() {
        const error = new Error("raw provider timeout must not escape");
        error.code = "AGENT_RUN_TIMEOUT";
        throw error;
      },
    },
  });
  t.after(() => worker.close());

  assert.deepEqual(await worker.recover(), { recovered: 1, interrupted: 0 });
  await worker.whenIdle();

  const stored = await loadSession({ root, sessionId: job.sessionId });
  const response = stored.conversation.turns[0].response;
  assert.equal(response.status, "failed");
  assert.equal(response.errorCode, "timeout");
  assert.deepEqual(captured.at(-1), [job.sessionId, {
    type: "failed",
    questionId: job.questionId,
    errorCode: response.errorCode,
  }]);
});
