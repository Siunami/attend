import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  endHostAnswerLease,
  hostListenerPresence,
  hostListenerStatus,
  refreshHostListener,
  registerHostAttachment,
  safeChatCapability,
} from "../src/chat-route.js";
import {
  completeHostQuestion,
  rebindHostQuestion,
  waitForHostQuestion,
} from "../src/host-bridge.js";
import { buildSelection } from "../src/selection.js";
import {
  appendQueuedQuestion,
  createSession,
  loadSession,
  updateSession,
} from "../src/session-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-host-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function dataPackage() {
  return {
    schemaVersion: 1,
    kind: "attend-data-package",
    id: "data_0123456789abcdef",
    question: { text: "Which phrases recur?", target: "fixture notes" },
    hashes: { corpus: "corpus", config: "config", data: "data-hash" },
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
        excerpt: "Bug book begins with observations.",
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

test("wait reads only the matching queued attachment and never claims it", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    id: "session_owner",
    dataPackage: packageValue,
  });
  const owner = await registerHostAttachment({
    root,
    sessionId: "session_owner",
  });
  const other = await registerHostAttachment({
    root,
    sessionId: "session_other",
  });
  await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    route: owner.route,
    turn: {
      id: "turn_owner",
      role: "user",
      content: "Owner question",
      selection: buildSelection(packageValue, created.state),
    },
  });
  let builds = 0;
  const listJobs = async () => [
    {
      sessionId: "session_other",
      questionId: "turn_other",
      status: "queued",
      route: other.route,
    },
    {
      sessionId: "session_owner",
      questionId: "turn_owner",
      status: "queued",
      route: owner.route,
    },
  ];
  const packetBuilder = async ({ sessionId, questionId, route }) => {
    builds += 1;
    return {
      schema: "attend-host-question/1",
      route,
      replyGuard: {
        sessionId,
        questionId,
        expectedRevision: 2,
        selectionId: "selection_owner",
      },
      question: { id: questionId, content: "Owner question" },
      selection: { id: "selection_owner" },
      contextBinding: { mode: "attached", selectionTurnId: questionId },
      evidence: { kind: "attend-evidence-packet" },
      conversation: [],
    };
  };

  const first = await waitForHostQuestion({
    root,
    ticket: owner.ticket,
    timeoutMs: 0,
    listJobs,
    packetBuilder,
  });
  const second = await waitForHostQuestion({
    root,
    ticket: owner.ticket,
    timeoutMs: 0,
    listJobs,
    packetBuilder,
  });
  assert.equal(first.replyGuard.questionId, "turn_owner");
  assert.deepEqual(second, first);
  assert.equal(builds, 2);

  const none = await waitForHostQuestion({
    root,
    ticket: other.ticket,
    timeoutMs: 0,
    listJobs: async () => [{
      sessionId: "session_owner",
      questionId: "turn_owner",
      status: "queued",
      route: owner.route,
    }],
    packetBuilder,
  });
  assert.equal(none, null);
});

test("bounded wait advertises listener presence and clears it on timeout", async (t) => {
  const root = await fixture(t);
  const owner = await registerHostAttachment({
    root,
    sessionId: "session_presence",
  });
  const waiting = waitForHostQuestion({
    root,
    ticket: owner.ticket,
    timeoutMs: 120,
    pollIntervalMs: 10,
    listJobs: async () => [],
  });

  let presence = { present: false };
  for (let attempt = 0; attempt < 20 && !presence.present; attempt += 1) {
    await delay(5);
    presence = await hostListenerPresence({ root, route: owner.route });
  }
  assert.deepEqual(presence, { present: true });
  assert.equal(await waiting, null);
  assert.deepEqual(
    await hostListenerPresence({ root, route: owner.route }),
    { present: false },
  );
});

test("listener heartbeat continues while a question packet is being built", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    id: "session_slow_packet",
    dataPackage: packageValue,
  });
  const owner = await registerHostAttachment({
    root,
    sessionId: "session_slow_packet",
  });
  await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    route: owner.route,
    turn: {
      id: "turn_slow_packet",
      role: "user",
      content: "Build this packet slowly.",
      selection: buildSelection(packageValue, created.state),
    },
  });
  let refreshes = 0;
  const packet = await waitForHostQuestion({
    root,
    ticket: owner.ticket,
    timeoutMs: 1_000,
    pollIntervalMs: 5,
    listenerRefreshIntervalMs: 10,
    listJobs: async () => [{
      sessionId: "session_slow_packet",
      questionId: "turn_slow_packet",
      status: "queued",
      route: owner.route,
    }],
    async refreshListener(options) {
      refreshes += 1;
      return refreshHostListener(options);
    },
    async packetBuilder() {
      await delay(55);
      return {
        schema: "attend-host-question/1",
        route: owner.route,
        replyGuard: {
          sessionId: "session_slow_packet",
          questionId: "turn_slow_packet",
          expectedRevision: 1,
          selectionId: "selection_slow_packet",
        },
        question: { id: "turn_slow_packet" },
        selection: null,
        contextBinding: {},
        evidence: {},
        conversation: [],
      };
    },
  });
  assert.equal(packet.replyGuard.questionId, "turn_slow_packet");
  assert.ok(refreshes >= 1, `expected a concurrent heartbeat refresh, received ${refreshes}`);
  assert.deepEqual(
    await hostListenerPresence({ root, route: owner.route }),
    { present: true },
  );
  await endHostAnswerLease({
    root,
    ticket: owner.ticket,
    questionId: "turn_slow_packet",
  });
});

test("a packet that finishes after the wait deadline is not delivered", async (t) => {
  const root = await fixture(t);
  const owner = await registerHostAttachment({
    root,
    sessionId: "session_expired_packet",
  });
  const result = await waitForHostQuestion({
    root,
    ticket: owner.ticket,
    timeoutMs: 25,
    pollIntervalMs: 5,
    listenerRefreshIntervalMs: 5,
    listJobs: async () => [{
      sessionId: "session_expired_packet",
      questionId: "turn_expired_packet",
      status: "queued",
      route: owner.route,
    }],
    async packetBuilder() {
      await delay(60);
      return {
        route: owner.route,
        replyGuard: { sessionId: "session_expired_packet" },
      };
    },
  });
  assert.equal(result, null);
  assert.deepEqual(
    await hostListenerPresence({ root, route: owner.route }),
    { present: false },
  );
});

test("cancellation during packet construction suppresses delivery and clears presence", async (t) => {
  const root = await fixture(t);
  const owner = await registerHostAttachment({
    root,
    sessionId: "session_cancelled_packet",
  });
  const controller = new AbortController();
  let releasePacket;
  let markStarted;
  const started = new Promise((resolveStarted) => {
    markStarted = resolveStarted;
  });
  const waiting = waitForHostQuestion({
    root,
    ticket: owner.ticket,
    timeoutMs: 1_000,
    pollIntervalMs: 5,
    listenerRefreshIntervalMs: 10,
    signal: controller.signal,
    listJobs: async () => [{
      sessionId: "session_cancelled_packet",
      questionId: "turn_cancelled_packet",
      status: "queued",
      route: owner.route,
    }],
    async packetBuilder() {
      markStarted();
      await new Promise((resolvePacket) => {
        releasePacket = resolvePacket;
      });
      return {
        route: owner.route,
        replyGuard: { sessionId: "session_cancelled_packet" },
      };
    },
  });
  await started;
  controller.abort();
  releasePacket();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.deepEqual(
    await hostListenerPresence({ root, route: owner.route }),
    { present: false },
  );
});

test("takeover cannot rebind a question while its original host is listening", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    id: "session_live_owner",
    dataPackage: packageValue,
  });
  const selection = buildSelection(packageValue, created.state);
  const original = await registerHostAttachment({
    root,
    sessionId: created.id,
  });
  const replacement = await registerHostAttachment({
    root,
    sessionId: created.id,
  });
  const queued = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    route: original.route,
    turn: {
      id: "turn_live_owner",
      role: "user",
      content: "Who owns this queued question?",
      selection,
    },
  });
  const controller = new AbortController();
  const waiting = waitForHostQuestion({
    root,
    ticket: original.ticket,
    timeoutMs: 5_000,
    pollIntervalMs: 10,
    signal: controller.signal,
    listJobs: async () => [],
  });
  t.after(() => controller.abort());

  let presence = { present: false };
  for (let attempt = 0; attempt < 20 && !presence.present; attempt += 1) {
    await delay(5);
    presence = await hostListenerPresence({ root, route: original.route });
  }
  assert.deepEqual(presence, { present: true });

  await assert.rejects(
    rebindHostQuestion({
      root,
      ticket: replacement.ticket,
      questionId: "turn_live_owner",
      expectedRevision: queued.state.revision,
      confirmTakeover: true,
    }),
    (error) => error.code === "HOST_OWNER_LISTENING",
  );

  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  const unchanged = await loadSession({ root, sessionId: created.id });
  assert.deepEqual(
    unchanged.conversation.turns[0].response.route,
    original.route,
  );
});

test("an instant wait protects packet construction from concurrent takeover", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    id: "session_instant_takeover",
    dataPackage: packageValue,
  });
  const selection = buildSelection(packageValue, created.state);
  const original = await registerHostAttachment({ root, sessionId: created.id });
  const replacement = await registerHostAttachment({ root, sessionId: created.id });
  const queued = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    route: original.route,
    turn: {
      id: "turn_instant_takeover",
      role: "user",
      content: "Can takeover interleave with packet construction?",
      selection,
    },
  });
  let releaseBuild;
  let markStarted;
  const buildStarted = new Promise((resolveStarted) => {
    markStarted = resolveStarted;
  });
  const buildGate = new Promise((resolveBuild) => {
    releaseBuild = resolveBuild;
  });
  const waiting = waitForHostQuestion({
    root,
    ticket: original.ticket,
    timeoutMs: 0,
    async packetBuilder({ route }) {
      markStarted();
      await buildGate;
      return {
        schema: "attend-host-question/1",
        route,
        replyGuard: {
          sessionId: created.id,
          questionId: "turn_instant_takeover",
          expectedRevision: queued.state.revision,
          selectionId: selection.id,
        },
        question: { id: "turn_instant_takeover" },
        selection,
        contextBinding: {},
        evidence: {},
        conversation: [],
      };
    },
  });
  await buildStarted;

  await assert.rejects(
    rebindHostQuestion({
      root,
      ticket: replacement.ticket,
      questionId: "turn_instant_takeover",
      expectedRevision: queued.state.revision,
      confirmTakeover: true,
    }),
    (error) => error.code === "HOST_OWNER_LISTENING",
  );
  releaseBuild();
  const packet = await waiting;
  assert.equal(packet.replyGuard.questionId, "turn_instant_takeover");

  const rebound = await rebindHostQuestion({
    root,
    ticket: replacement.ticket,
    questionId: "turn_instant_takeover",
    expectedRevision: queued.state.revision,
    confirmTakeover: true,
  });
  assert.deepEqual(rebound.question.response.route, replacement.route);
});

test("a live wait outranks an older delivered reservation for takeover", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    id: "session_wait_priority",
    dataPackage: packageValue,
  });
  const selection = buildSelection(packageValue, created.state);
  const original = await registerHostAttachment({ root, sessionId: created.id });
  const replacement = await registerHostAttachment({ root, sessionId: created.id });
  const queued = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    route: original.route,
    turn: {
      id: "turn_wait_priority",
      role: "user",
      content: "Which listener state controls takeover?",
      selection,
    },
  });
  const delivered = await waitForHostQuestion({
    root,
    ticket: original.ticket,
    timeoutMs: 0,
    async packetBuilder({ route }) {
      return {
        schema: "attend-host-question/1",
        route,
        replyGuard: {
          sessionId: created.id,
          questionId: "turn_wait_priority",
          expectedRevision: queued.state.revision,
          selectionId: selection.id,
        },
        question: { id: "turn_wait_priority" },
        selection,
        contextBinding: {},
        evidence: {},
        conversation: [],
      };
    },
  });
  assert.equal(delivered.replyGuard.questionId, "turn_wait_priority");

  const controller = new AbortController();
  const waiting = waitForHostQuestion({
    root,
    ticket: original.ticket,
    timeoutMs: 5_000,
    pollIntervalMs: 10,
    signal: controller.signal,
    listJobs: async () => [],
  });
  t.after(() => controller.abort());
  let status = { present: false, phase: null };
  for (let attempt = 0; attempt < 30 && status.phase !== "waiting"; attempt += 1) {
    await delay(5);
    status = await hostListenerStatus({ root, route: original.route });
  }
  assert.deepEqual(status, { present: true, phase: "waiting" });
  await assert.rejects(
    rebindHostQuestion({
      root,
      ticket: replacement.ticket,
      questionId: "turn_wait_priority",
      expectedRevision: queued.state.revision,
      confirmTakeover: true,
    }),
    (error) => error.code === "HOST_OWNER_LISTENING",
  );
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("a delivered lease never labels a later question as delivered", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    id: "session_delivered_question_scope",
    dataPackage: packageValue,
  });
  const selection = buildSelection(packageValue, created.state);
  const owner = await registerHostAttachment({ root, sessionId: created.id });
  const queued = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    route: owner.route,
    turn: {
      id: "turn_delivered_first",
      role: "user",
      content: "Which question owns the delivery lease?",
      selection,
    },
  });
  await waitForHostQuestion({
    root,
    ticket: owner.ticket,
    timeoutMs: 0,
    async packetBuilder({ route }) {
      return {
        schema: "attend-host-question/1",
        route,
        replyGuard: {
          sessionId: created.id,
          questionId: "turn_delivered_first",
          expectedRevision: queued.state.revision,
          selectionId: selection.id,
        },
        question: { id: "turn_delivered_first" },
        selection,
        contextBinding: {},
        evidence: {},
        conversation: [],
      };
    },
  });

  const first = await safeChatCapability({
    root,
    route: owner.route,
    questionId: "turn_delivered_first",
  });
  assert.equal(first.listenerState, "delivered");

  const later = await safeChatCapability({
    root,
    route: owner.route,
    questionId: "turn_delivered_later",
  });
  assert.equal(later.listenerPresent, false);
  assert.equal(later.listenerState, null);
});

test("host packet and guarded completion form an idempotent end-to-end bridge", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    id: "session_bridge",
    dataPackage: packageValue,
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    patch: { selectedIds: ["phrase_bug_book"] },
  });
  const selection = buildSelection(packageValue, selected.state);
  const owner = await registerHostAttachment({
    root,
    sessionId: created.id,
  });
  await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: selected.state.revision,
    route: owner.route,
    turn: {
      id: "turn_bridge",
      role: "user",
      content: "What does this phrase show?",
      selection,
    },
  });

  const packet = await waitForHostQuestion({
    root,
    ticket: owner.ticket,
    timeoutMs: 0,
    async evidenceForSelection({ selection: exactSelection }) {
      return {
        kind: "attend-evidence-packet",
        selectionId: exactSelection.id,
        coverage: { complete: true },
        sources: [{
          id: "source_alpha",
          content: "Bug book begins with observations.",
        }],
      };
    },
  });
  assert.equal(packet.schema, "attend-host-question/1");
  assert.equal(packet.question.content, "What does this phrase show?");
  assert.equal(packet.selection.id, selection.id);
  assert.equal(packet.evidence.selectionId, selection.id);
  assert.equal(
    (await loadSession({ root, sessionId: created.id }))
      .conversation.turns[0].response.status,
    "queued",
  );
  assert.deepEqual(
    await hostListenerPresence({ root, route: owner.route }),
    { present: true },
    "delivery keeps a bounded host lease while the opening agent answers",
  );

  const completed = await completeHostQuestion({
    root,
    ticket: owner.ticket,
    replyGuard: packet.replyGuard,
    message: "It is a recurring observation record.",
  });
  assert.equal(completed.repeated, false);
  assert.equal(completed.answer.replyToTurnId, "turn_bridge");
  assert.equal(completed.answer.content, "It is a recurring observation record.");
  assert.deepEqual(
    await hostListenerPresence({ root, route: owner.route }),
    { present: false },
  );

  const replay = await completeHostQuestion({
    root,
    ticket: owner.ticket,
    replyGuard: packet.replyGuard,
    message: "It is a recurring observation record.",
  });
  assert.equal(replay.repeated, true);
  assert.equal(replay.answer.id, completed.answer.id);

  await assert.rejects(
    completeHostQuestion({
      root,
      ticket: owner.ticket,
      replyGuard: packet.replyGuard,
      message: "A different replay.",
    }),
    { code: "QUESTION_ALREADY_ANSWERED" },
  );
});

test("one host attachment delivers and completes a question from another page", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const openedPage = await createSession({
    root,
    id: "session_bridge_page_a",
    dataPackage: packageValue,
  });
  const currentPage = await createSession({
    root,
    id: "session_bridge_page_b",
    dataPackage: packageValue,
  });
  const selectedCurrentPage = await updateSession({
    root,
    sessionId: currentPage.id,
    expectedRevision: currentPage.state.revision,
    patch: { selectedIds: ["phrase_bug_book"] },
  });
  const owner = await registerHostAttachment({
    root,
    sessionId: openedPage.id,
  });
  const selection = buildSelection(packageValue, selectedCurrentPage.state);
  await appendQueuedQuestion({
    root,
    sessionId: currentPage.id,
    expectedRevision: selectedCurrentPage.state.revision,
    route: owner.route,
    turn: {
      id: "turn_bridge_page_b",
      role: "user",
      content: "What changed on this page?",
      selection,
    },
  });

  const packet = await waitForHostQuestion({
    root,
    ticket: owner.ticket,
    timeoutMs: 0,
    async evidenceForSelection({ selection: exactSelection }) {
      return {
        kind: "attend-evidence-packet",
        selectionId: exactSelection.id,
        coverage: { complete: true },
        sources: [{
          id: "source_alpha",
          content: "Bug book begins with observations.",
        }],
      };
    },
  });
  assert.equal(packet.replyGuard.sessionId, currentPage.id);
  assert.equal(packet.replyGuard.questionId, "turn_bridge_page_b");

  const completed = await completeHostQuestion({
    root,
    ticket: owner.ticket,
    replyGuard: packet.replyGuard,
    message: "The current page has its own exact reply guard.",
  });
  assert.equal(completed.answer.replyToTurnId, "turn_bridge_page_b");
  assert.equal(
    (await loadSession({ root, sessionId: openedPage.id })).conversation.turns.length,
    0,
  );
  assert.equal(
    (await loadSession({ root, sessionId: currentPage.id })).conversation.turns.at(-1).content,
    "The current page has its own exact reply guard.",
  );
});

test("a new same-session ticket explicitly rebinds a stranded queued question", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    id: "session_bridge_rebind",
    dataPackage: packageValue,
  });
  const selection = buildSelection(packageValue, created.state);
  const original = await registerHostAttachment({
    root,
    sessionId: created.id,
  });
  const replacement = await registerHostAttachment({
    root,
    sessionId: created.id,
  });
  const queued = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    route: original.route,
    turn: {
      id: "turn_bridge_rebind",
      role: "user",
      content: "Can the replacement host recover this?",
      selection,
    },
  });
  const evidenceForSelection = async ({ selection: exactSelection }) => ({
    kind: "attend-evidence-packet",
    selectionId: exactSelection?.id ?? null,
    coverage: { complete: true },
    sources: [{
      id: "source_alpha",
      content: "Bug book begins with observations.",
    }],
  });
  const originalPacket = await waitForHostQuestion({
    root,
    ticket: original.ticket,
    timeoutMs: 0,
    evidenceForSelection,
  });
  assert.equal(
    await waitForHostQuestion({
      root,
      ticket: replacement.ticket,
      timeoutMs: 0,
    }),
    null,
  );

  await assert.rejects(
    rebindHostQuestion({
      root,
      ticket: replacement.ticket,
      questionId: "turn_bridge_rebind",
      expectedRevision: queued.state.revision,
    }),
    (error) => error.code === "HOST_REBIND_CONFIRMATION_REQUIRED",
  );

  const rebound = await rebindHostQuestion({
    root,
    ticket: replacement.ticket,
    questionId: "turn_bridge_rebind",
    expectedRevision: queued.state.revision,
    confirmTakeover: true,
  });
  assert.equal(rebound.repeated, false);
  assert.equal(rebound.session.id, created.id);
  assert.deepEqual(rebound.question.response.route, replacement.route);

  const recoveredPacket = await waitForHostQuestion({
    root,
    ticket: replacement.ticket,
    timeoutMs: 0,
    evidenceForSelection,
  });
  assert.equal(recoveredPacket.replyGuard.questionId, "turn_bridge_rebind");
  assert.equal(recoveredPacket.replyGuard.expectedRevision, queued.state.revision + 1);
  assert.equal(recoveredPacket.replyGuard.selectionId, selection.id);
  await assert.rejects(
    completeHostQuestion({
      root,
      ticket: original.ticket,
      replyGuard: originalPacket.replyGuard,
      message: "The old host must lose the commit race.",
    }),
    (error) => error.code === "QUESTION_RESPONSE_ROUTE_MISMATCH",
  );

  const otherSession = await createSession({
    root,
    id: "session_bridge_rebind_other",
    dataPackage: packageValue,
  });
  const otherTicket = await registerHostAttachment({
    root,
    sessionId: otherSession.id,
  });
  await assert.rejects(
    rebindHostQuestion({
      root,
      ticket: otherTicket.ticket,
      questionId: "turn_bridge_rebind",
      expectedRevision: rebound.session.state.revision,
      confirmTakeover: true,
    }),
    (error) => error.code === "QUESTION_NOT_FOUND",
  );

  const expired = await registerHostAttachment({
    root,
    sessionId: created.id,
    ttlMs: 1_000,
    now: new Date(0),
  });
  await assert.rejects(
    rebindHostQuestion({
      root,
      ticket: expired.ticket,
      questionId: "turn_bridge_rebind",
      expectedRevision: rebound.session.state.revision,
      confirmTakeover: true,
    }),
    (error) => error.code === "HOST_ATTACHMENT_EXPIRED",
  );
  const unchanged = await loadSession({ root, sessionId: created.id });
  assert.deepEqual(
    unchanged.conversation.turns[0].response.route,
    replacement.route,
  );
});
