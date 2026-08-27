import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSelection } from "../src/selection.js";
import {
  appendQueuedQuestion,
  appendConversationTurn,
  appendConversationTurns,
  completeHostQuestionResponse,
  completeQuestionResponse,
  createSession,
  loadSession,
  loadQuestionResponseContext,
  markQuestionResponseFailed,
  markQuestionResponseRunning,
  oldestUnansweredQuestion,
  oldestUnansweredQuestionAcrossSessions,
  pendingQuestionResponseJobs,
  rebindQueuedHostQuestionResponse,
  retryQuestionResponse,
  sessionFilePath,
  updateSession,
} from "../src/session-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function dataPackage() {
  return {
    schemaVersion: 1,
    kind: "attend-data-package",
    id: "data_0123456789abcdef",
    question: { text: "Which phrases recur?", target: "fixture notes" },
    hashes: {
      corpus: "corpus-hash",
      config: "config-hash",
      data: "data-hash",
    },
    config: {
      minWords: 2,
      maxWords: 4,
      minCount: 2,
      minSources: 2,
      limit: 50,
      maxFileBytes: 1_000_000,
      ranking: [
        { field: "distinctSourceCount", direction: "desc" },
        { field: "occurrenceCount", direction: "desc" },
        { field: "phrase", direction: "asc" },
      ],
    },
    sources: [
      {
        id: "source_alpha",
        displayPath: "notes/alpha.md",
        sha256: "alpha-hash",
        kind: "markdown",
      },
      {
        id: "source_beta",
        displayPath: "notes/beta.md",
        sha256: "beta-hash",
        kind: "markdown",
      },
    ],
    rows: [
      {
        id: "phrase_attention",
        phrase: "attention map",
        wordCount: 2,
        occurrenceCount: 3,
        distinctSourceCount: 2,
        occurrences: [
          { sourceId: "source_alpha", line: 4, excerpt: "An attention map helps." },
          { sourceId: "source_beta", line: 7, excerpt: "The attention map changed." },
        ],
      },
      {
        id: "phrase_local",
        phrase: "local record",
        wordCount: 2,
        occurrenceCount: 2,
        distinctSourceCount: 1,
        occurrences: [
          { sourceId: "source_alpha", line: 10, excerpt: "Keep a local record." },
        ],
      },
    ],
    map: {
      id: "phrase-list",
      version: 1,
      labelField: "phrase",
      valueField: "occurrenceCount",
    },
    transformations: ["NFKC normalization", "deterministic n-grams"],
    knownOmissions: [],
  };
}

test("createSession writes a phrase-list v1 session at revision zero", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();

  const session = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_fixture",
  });

  assert.equal(session.id, "session_fixture");
  assert.equal(session.analysisId, packageValue.id);
  assert.equal(session.dataPackageId, packageValue.id);
  assert.deepEqual(session.view, { id: "phrase-list", version: 1 });
  assert.deepEqual(session.state, {
    revision: 0,
    selectedIds: [],
    query: "",
    minCount: 2,
    sort: { by: "distinctSourceCount", direction: "desc" },
    sourceScope: {
      mode: "all",
      sourceIds: [],
    },
  });
  assert.deepEqual(session.conversation, { turns: [] });
  assert.deepEqual(session.dataPackage, packageValue);
  assert.match(session.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(session.updatedAt, session.createdAt);

  assert.deepEqual(
    await loadSession({ root, sessionId: session.id }),
    session,
  );
  assert.match(
    sessionFilePath({ root, sessionId: session.id }),
    /\.attend\/local\/sessions\/session_fixture\.json$/,
  );
});

test("exploration render sessions keep validated immutable provenance", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    id: "session_exploration_preview",
    dataPackage: packageValue,
    exploration: {
      explorationId: "exploration_0123456789abcdef01234567",
      experimentId: "experiment_fedcba9876543210fedcba98",
    },
  });

  assert.deepEqual(created.exploration, {
    explorationId: "exploration_0123456789abcdef01234567",
    experimentId: "experiment_fedcba9876543210fedcba98",
  });
  assert.deepEqual(
    (await loadSession({ root, sessionId: created.id })).exploration,
    created.exploration,
  );
  await assert.rejects(
    () => createSession({
      root,
      id: "session_invalid_exploration_preview",
      dataPackage: packageValue,
      exploration: {
        explorationId: "not-an-exploration",
        experimentId: "experiment_fedcba9876543210fedcba98",
      },
    }),
    /valid explorationId and experimentId/u,
  );
  await assert.rejects(
    () => createSession({
      root,
      id: "session_legacy_length_provenance",
      dataPackage: packageValue,
      exploration: {
        explorationId: "exploration_0123456789abcdef",
        experimentId: "experiment_fedcba9876543210",
      },
    }),
    /valid explorationId and experimentId/u,
  );
});

test("updateSession applies a typed partial patch and rejects stale revisions", async (t) => {
  const root = await fixture(t);
  const created = await createSession({
    root,
    dataPackage: dataPackage(),
    id: "session_update",
  });

  const updated = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: {
      selectedIds: ["phrase_attention", "phrase_attention"],
      query: "attention",
      minCount: 3,
      sort: { by: "distinctSourceCount", direction: "desc" },
      sourceScope: { mode: "include", sourceIds: ["source_beta"] },
    },
  });

  assert.equal(updated.state.revision, 1);
  assert.deepEqual(updated.state.selectedIds, ["phrase_attention"]);
  assert.equal(updated.state.query, "attention");
  assert.equal(updated.state.minCount, 3);
  assert.deepEqual(updated.state.sort, {
    by: "distinctSourceCount",
    direction: "desc",
  });
  assert.deepEqual(updated.state.sourceScope, {
    mode: "include",
    sourceIds: ["source_beta"],
  });
  assert.equal(created.state.revision, 0, "the returned create snapshot is immutable");

  await assert.rejects(
    updateSession({
      root,
      sessionId: created.id,
      expectedRevision: 0,
      patch: { query: "stale write" },
    }),
    (error) =>
      error.code === "CONFLICT" &&
      error.expectedRevision === 0 &&
      error.actualRevision === 1 &&
      error.sessionId === created.id,
  );
  assert.equal(
    (await loadSession({ root, sessionId: created.id })).state.query,
    "attention",
  );
});

test("legacy materialized all scopes load compactly and migrate on the next mutation", async (t) => {
  const root = await fixture(t);
  const created = await createSession({
    root,
    dataPackage: dataPackage(),
    id: "session_legacy_all_scope",
  });
  const path = sessionFilePath({ root, sessionId: created.id });
  const legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.state.sourceScope = {
    mode: "all",
    sourceIds: ["source_alpha", "source_beta"],
  };
  const sourceRefs = [
    {
      sourceId: "source_alpha",
      line: 4,
      excerpt: "An attention map helps.",
    },
  ];
  legacy.conversation.turns.push({
    id: "turn_legacy_scope",
    role: "user",
    content: "What does this phrase mean?",
    createdAt: "2026-08-22T00:00:00.000Z",
    selection: {
      id: "selection_legacy_scope",
      filters: {
        sourceScope: {
          mode: "all",
          sourceIds: ["source_alpha", "source_beta"],
        },
      },
      sourceRefs,
    },
  });
  await writeFile(path, `${JSON.stringify(legacy)}\n`);

  const loaded = await loadSession({ root, sessionId: created.id });
  assert.deepEqual(loaded.state.sourceScope, { mode: "all", sourceIds: [] });
  assert.deepEqual(
    loaded.conversation.turns[0].selection.filters.sourceScope,
    { mode: "all", sourceIds: [] },
  );
  assert.equal(
    loaded.conversation.turns[0].selection.id,
    "selection_legacy_scope",
    "the historical opaque selection identity stays stable",
  );
  assert.deepEqual(loaded.conversation.turns[0].selection.sourceRefs, sourceRefs);
  assert.deepEqual(
    JSON.parse(await readFile(path, "utf8")).state.sourceScope.sourceIds,
    ["source_alpha", "source_beta"],
    "loading projects a compact state without an eager disk rewrite",
  );

  const updated = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: { query: "attention" },
  });
  assert.deepEqual(updated.state.sourceScope, { mode: "all", sourceIds: [] });
  assert.deepEqual(
    JSON.parse(await readFile(path, "utf8")).state.sourceScope,
    { mode: "all", sourceIds: [] },
  );
  assert.deepEqual(
    JSON.parse(await readFile(path, "utf8")).conversation.turns[0].selection
      .filters.sourceScope,
    { mode: "all", sourceIds: [] },
  );
});

test("a large all-source context projection does not enumerate the corpus", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const sourceIds = Array.from(
    { length: 2_547 },
    (_, index) => `source_${String(index).padStart(4, "0")}`,
  );
  packageValue.sources = sourceIds.map((id) => ({
    id,
    displayPath: `notes/${id}.md`,
    sha256: `${id}-hash`,
    kind: "markdown",
  }));
  packageValue.rows[0].occurrences = [
    {
      sourceId: sourceIds[0],
      line: 4,
      excerpt: "An attention map helps.",
    },
    {
      sourceId: sourceIds.at(-1),
      line: 7,
      excerpt: "The attention map changed.",
    },
  ];
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_large_all_scope",
    state: { selectedIds: ["phrase_attention"] },
  });

  const contextProjection = {
    selection: buildSelection(created.dataPackage, created.state),
    viewState: created.state,
  };
  assert.deepEqual(contextProjection.viewState.sourceScope, {
    mode: "all",
    sourceIds: [],
  });
  assert.deepEqual(contextProjection.selection.filters.sourceScope, {
    mode: "all",
    sourceIds: [],
  });
  assert.equal(contextProjection.selection.sourceRefCount, 2);
  assert.deepEqual(
    contextProjection.selection.sourceRefs.map((reference) => reference.sourceId),
    [sourceIds[0], sourceIds.at(-1)],
    "selected evidence remains exact even though the all-scope predicate is compact",
  );
  assert.ok(JSON.stringify(contextProjection).length < 3_000);
});

test("an atomic conversation exchange snapshots exact analytic state", async (t) => {
  const root = await fixture(t);
  const created = await createSession({
    root,
    dataPackage: dataPackage(),
    id: "session_chat",
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: {
      selectedIds: ["phrase_attention"],
      query: "attention",
      sourceScope: { mode: "include", sourceIds: ["source_alpha"] },
    },
  });

  const chatted = await appendConversationTurns({
    root,
    sessionId: created.id,
    expectedRevision: 1,
    turns: [
      {
        id: "turn_user",
        role: "user",
        content: "Where did this phrase appear?",
        createdAt: "2026-08-22T00:00:00.000Z",
      },
      {
        id: "turn_assistant",
        role: "assistant",
        content: "It appears in two source notes.",
        createdAt: "2026-08-22T00:00:01.000Z",
      },
    ],
  });

  assert.equal(chatted.state.revision, 2, "the exchange increments once");
  assert.equal(chatted.conversation.turns.length, 2);
  for (const turn of chatted.conversation.turns) {
    assert.deepEqual(turn.selection, {
      analysisId: "data_0123456789abcdef",
      dataPackageId: "data_0123456789abcdef",
      dataPackageHash: "data-hash",
      dataHash: "data-hash",
      map: { id: "phrase-list", version: 1 },
      stateRevision: 1,
      selectedMarkIds: ["phrase_attention"],
      predicate: {
        field: "id",
        operator: "in",
        values: ["phrase_attention"],
      },
      filters: {
        query: "attention",
        minCount: 2,
        minSources: 2,
        sourceScope: { mode: "include", sourceIds: ["source_alpha"] },
      },
      aggregation: {
        labelField: "phrase",
        valueField: "occurrenceCount",
      },
      sort: { by: "distinctSourceCount", direction: "desc" },
      sourceRefCount: 2,
      sourceRefsTruncated: false,
      sourceRefs: [
        {
          rowId: "phrase_attention",
          phrase: "attention map",
          sourceId: "source_alpha",
          line: 4,
          excerpt: "An attention map helps.",
        },
        {
          rowId: "phrase_attention",
          phrase: "attention map",
          sourceId: "source_beta",
          line: 7,
          excerpt: "The attention map changed.",
        },
      ],
    });
  }
  assert.equal(selected.state.revision, 1);
});

test("a supplied semantic selection is retained exactly on one turn", async (t) => {
  const root = await fixture(t);
  await createSession({
    root,
    dataPackage: dataPackage(),
    id: "session_semantic",
  });

  const result = await appendConversationTurn({
    root,
    sessionId: "session_semantic",
    expectedRevision: 0,
    turn: {
      id: "turn_filtered",
      role: "user",
      content: "Explain this exact hit.",
      selection: {
        predicate: { field: "line", operator: "equals", value: 7 },
        filters: { query: "local", minCount: 2, visibleIds: ["phrase_local"] },
        aggregation: { operation: "occurrence-count", groupBy: "phrase" },
        sourceRefs: [
          {
            sourceId: "source_alpha",
            line: 10,
            excerpt: "Keep a local record.",
          },
        ],
      },
    },
  });

  const snapshot = result.conversation.turns[0].selection;
  assert.equal(snapshot.stateRevision, 0);
  assert.deepEqual(snapshot.predicate, {
    field: "line",
    operator: "equals",
    value: 7,
  });
  assert.deepEqual(snapshot.filters, {
    query: "local",
    minCount: 2,
    visibleIds: ["phrase_local"],
  });
  assert.deepEqual(snapshot.aggregation, {
    operation: "occurrence-count",
    groupBy: "phrase",
  });
  assert.deepEqual(snapshot.sourceRefs, [
    {
      sourceId: "source_alpha",
      line: 10,
      excerpt: "Keep a local record.",
    },
  ]);
});

test("a user question atomically consumes its live selection attachment", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_consumed_attachment",
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: {
      selectedIds: ["phrase_attention"],
      query: "attention",
      minCount: 3,
      sort: { by: "phrase", direction: "asc" },
      sourceScope: { mode: "include", sourceIds: ["source_alpha"] },
    },
  });
  const attachedSelection = buildSelection(packageValue, selected.state);

  const asked = await appendConversationTurn({
    root,
    sessionId: created.id,
    expectedRevision: 1,
    consumeSelectedIds: true,
    turn: {
      id: "turn_consumes_attachment",
      role: "user",
      content: "Summarize this exact phrase.",
      selection: attachedSelection,
    },
  });

  assert.equal(asked.state.revision, 2, "append and detach are one revision");
  assert.deepEqual(asked.state.selectedIds, []);
  assert.equal(
    buildSelection(packageValue, asked.state).predicate,
    null,
    "consuming the attachment leaves neutral live view context",
  );
  assert.equal(asked.state.query, "attention");
  assert.equal(asked.state.minCount, 3);
  assert.deepEqual(asked.state.sort, { by: "phrase", direction: "asc" });
  assert.deepEqual(asked.state.sourceScope, {
    mode: "include",
    sourceIds: ["source_alpha"],
  });
  assert.deepEqual(
    asked.conversation.turns[0].selection,
    {
      ...attachedSelection,
      analysisId: packageValue.id,
      dataPackageHash: packageValue.hashes.data,
    },
    "the user turn keeps the exact pre-send attachment snapshot",
  );

  const pending = oldestUnansweredQuestion(asked);
  assert.equal(pending.id, "turn_consumes_attachment");
  assert.equal(pending.selection.id, attachedSelection.id);
  assert.equal(pending.selection.stateRevision, 1);

  const answered = await appendConversationTurn({
    root,
    sessionId: created.id,
    expectedRevision: 2,
    turn: {
      id: "turn_answers_consumed_attachment",
      role: "assistant",
      content: "This answer uses the attached historical phrase.",
      replyToTurnId: pending.id,
      selection: pending.selection,
    },
  });
  assert.equal(answered.state.revision, 3);
  assert.deepEqual(answered.state.selectedIds, []);
  assert.deepEqual(
    answered.conversation.turns.at(-1).selection,
    asked.conversation.turns[0].selection,
  );
});

test("follow-up questions inherit the latest immutable visual context without showing a new attachment", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_conversation_context",
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: { selectedIds: ["phrase_attention"] },
  });
  const attachedSelection = buildSelection(packageValue, selected.state);
  const firstQuestion = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: 1,
    turn: {
      id: "turn_context_origin",
      role: "user",
      content: "What does this phrase show?",
      selection: attachedSelection,
    },
  });
  assert.deepEqual(firstQuestion.conversation.turns[0].context, {
    selectionTurnId: "turn_context_origin",
  });
  await markQuestionResponseRunning({
    root,
    sessionId: created.id,
    questionId: "turn_context_origin",
  });
  const firstAnswer = await completeQuestionResponse({
    root,
    sessionId: created.id,
    questionId: "turn_context_origin",
    content: "It recurs across both fixture notes.",
  });

  const emptyAttachment = buildSelection(packageValue, firstAnswer.session.state);
  assert.deepEqual(emptyAttachment.selectedMarkIds, []);
  const followUp = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: firstAnswer.session.state.revision,
    turn: {
      id: "turn_context_follow_up",
      role: "user",
      content: "Tell me about the contents.",
      selection: emptyAttachment,
    },
  });
  const storedFollowUp = followUp.conversation.turns.find(
    (turn) => turn.id === "turn_context_follow_up",
  );
  assert.deepEqual(
    storedFollowUp.selection.selectedMarkIds,
    [],
    "the visible user turn keeps its one-shot composer attachment empty",
  );
  assert.deepEqual(storedFollowUp.context, {
    selectionTurnId: "turn_context_origin",
  });

  let context = await loadQuestionResponseContext({
    root,
    sessionId: created.id,
    questionId: "turn_context_follow_up",
  });
  assert.deepEqual(context.visualContext, firstQuestion.conversation.turns[0].selection);
  assert.deepEqual(context.visualContextBinding, {
    mode: "inherited",
    selectionTurnId: "turn_context_origin",
  });
  assert.equal(
    oldestUnansweredQuestion(followUp).selection.id,
    attachedSelection.id,
    "manual recovery receives the effective context rather than the empty composer attachment",
  );

  await markQuestionResponseRunning({
    root,
    sessionId: created.id,
    questionId: "turn_context_follow_up",
  });
  const failed = await markQuestionResponseFailed({
    root,
    sessionId: created.id,
    questionId: "turn_context_follow_up",
    errorCode: "runner_failed",
  });
  await retryQuestionResponse({
    root,
    sessionId: created.id,
    questionId: "turn_context_follow_up",
  });
  context = await loadQuestionResponseContext({
    root,
    sessionId: created.id,
    questionId: "turn_context_follow_up",
  });
  assert.equal(context.visualContext.id, attachedSelection.id);
  assert.equal(context.visualContextBinding.selectionTurnId, "turn_context_origin");
  assert.equal(failed.question.context.selectionTurnId, "turn_context_origin");

  await markQuestionResponseRunning({
    root,
    sessionId: created.id,
    questionId: "turn_context_follow_up",
  });
  const completedFollowUp = await completeQuestionResponse({
    root,
    sessionId: created.id,
    questionId: "turn_context_follow_up",
    content: "The follow-up still uses the original phrase evidence.",
  });
  assert.equal(completedFollowUp.answer.selection.id, attachedSelection.id);

  const selectedReplacement = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: completedFollowUp.session.state.revision,
    patch: { selectedIds: ["phrase_local"] },
  });
  const replacementSelection = buildSelection(packageValue, selectedReplacement.state);
  const replacement = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: selectedReplacement.state.revision,
    turn: {
      id: "turn_context_replacement",
      role: "user",
      content: "What about this phrase instead?",
      selection: replacementSelection,
    },
  });
  const replacementQuestion = replacement.conversation.turns.at(-1);
  assert.deepEqual(replacementQuestion.context, {
    selectionTurnId: "turn_context_replacement",
  });
  context = await loadQuestionResponseContext({
    root,
    sessionId: created.id,
    questionId: "turn_context_replacement",
  });
  assert.equal(context.visualContext.id, replacementSelection.id);
  assert.equal(context.visualContextBinding.mode, "attached");
});

test("response jobs preserve historical selection and newer view state through completion", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_response_lifecycle",
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: {
      selectedIds: ["phrase_attention"],
      query: "attention",
    },
  });
  const historicalSelection = buildSelection(packageValue, selected.state);
  const queued = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: 1,
    turn: {
      id: "turn_response_question",
      role: "user",
      content: "Summarize this attached phrase.",
      selection: historicalSelection,
      createdAt: "2026-08-22T12:00:00.000Z",
    },
  });
  assert.equal(queued.state.revision, 2);
  assert.deepEqual(queued.state.selectedIds, []);
  assert.equal(queued.conversation.turns[0].response.status, "queued");
  const storedHistoricalSelection = queued.conversation.turns[0].selection;
  assert.deepEqual(
    storedHistoricalSelection,
    {
      ...historicalSelection,
      analysisId: packageValue.id,
      dataPackageHash: packageValue.hashes.data,
    },
  );

  const moved = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 2,
    patch: {
      selectedIds: ["phrase_local"],
      query: "local",
      minCount: 7,
    },
  });
  const liveState = {
    selectedIds: moved.state.selectedIds,
    query: moved.state.query,
    minCount: moved.state.minCount,
    sort: moved.state.sort,
    sourceScope: moved.state.sourceScope,
  };

  const running = await markQuestionResponseRunning({
    root,
    sessionId: created.id,
    questionId: "turn_response_question",
  });
  assert.equal(running.changed, true);
  assert.equal(running.session.state.revision, 4);
  assert.equal(running.question.response.status, "running");
  assert.deepEqual(
    {
      selectedIds: running.session.state.selectedIds,
      query: running.session.state.query,
      minCount: running.session.state.minCount,
      sort: running.session.state.sort,
      sourceScope: running.session.state.sourceScope,
    },
    liveState,
  );
  const runningAgain = await markQuestionResponseRunning({
    root,
    sessionId: created.id,
    questionId: "turn_response_question",
  });
  assert.equal(runningAgain.changed, false);
  assert.equal(runningAgain.session.state.revision, 4);

  const context = await loadQuestionResponseContext({
    root,
    sessionId: created.id,
    questionId: "turn_response_question",
  });
  assert.equal(context.question.id, "turn_response_question");
  assert.deepEqual(context.question.selection, storedHistoricalSelection);
  assert.equal(context.conversation.length, 1);

  const completed = await completeQuestionResponse({
    root,
    sessionId: created.id,
    questionId: "turn_response_question",
    answerId: "turn_response_answer",
    content: "The phrase recurs in the two selected evidence references.",
    createdAt: "2026-08-22T12:00:01.000Z",
  });
  assert.equal(completed.changed, true);
  assert.equal(completed.session.state.revision, 5);
  assert.equal(completed.question.response.status, "completed");
  assert.equal(completed.answer.replyToTurnId, "turn_response_question");
  assert.deepEqual(completed.answer.selection, storedHistoricalSelection);
  assert.deepEqual(
    {
      selectedIds: completed.session.state.selectedIds,
      query: completed.session.state.query,
      minCount: completed.session.state.minCount,
      sort: completed.session.state.sort,
      sourceScope: completed.session.state.sourceScope,
    },
    liveState,
    "asynchronous completion does not restore the historical view",
  );

  const duplicate = await completeQuestionResponse({
    root,
    sessionId: created.id,
    questionId: "turn_response_question",
    content: "A retry must not append another answer.",
  });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.session.state.revision, 5);
  assert.equal(duplicate.session.conversation.turns.length, 2);
  assert.equal(duplicate.answer.id, "turn_response_answer");

  const lateFailure = await markQuestionResponseFailed({
    root,
    sessionId: created.id,
    questionId: "turn_response_question",
    errorCode: "runner_failed",
  });
  assert.equal(lateFailure.changed, false);
  assert.equal(lateFailure.question.response.status, "completed");
  await assert.rejects(
    loadQuestionResponseContext({
      root,
      sessionId: created.id,
      questionId: "turn_response_question",
    }),
    (error) => error.code === "QUESTION_ALREADY_ANSWERED",
  );
});

test("host responses stay queued until an attachment-bound guarded reply commits", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_host_response",
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: { selectedIds: ["phrase_attention"] },
  });
  const selection = buildSelection(packageValue, selected.state);
  const route = {
    kind: "host",
    attachmentId: "host_0123456789abcdef",
    generation: 1,
  };
  const queued = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: selected.state.revision,
    route,
    turn: {
      id: "turn_host_response",
      role: "user",
      content: "What does the selected phrase show?",
      selection,
    },
  });
  assert.equal(queued.conversation.turns[0].response.status, "queued");
  assert.deepEqual(queued.conversation.turns[0].response.route, route);

  await assert.rejects(
    completeHostQuestionResponse({
      root,
      sessionId: created.id,
      questionId: "turn_host_response",
      expectedRevision: queued.state.revision,
      expectedSelectionId: selection.id,
      route: { ...route, attachmentId: "host_ffffffffffffffff" },
      content: "It recurs across both notes.",
    }),
    (error) => error.code === "QUESTION_RESPONSE_ROUTE_MISMATCH",
  );

  const completed = await completeHostQuestionResponse({
    root,
    sessionId: created.id,
    questionId: "turn_host_response",
    expectedRevision: queued.state.revision,
    expectedSelectionId: selection.id,
    route,
    content: "It recurs across both notes.",
  });
  assert.equal(completed.repeated, false);
  assert.equal(completed.question.response.status, "completed");
  assert.equal(completed.answer.content, "It recurs across both notes.");

  const repeated = await completeHostQuestionResponse({
    root,
    sessionId: created.id,
    questionId: "turn_host_response",
    expectedRevision: queued.state.revision,
    expectedSelectionId: selection.id,
    route,
    content: "It recurs across both notes.",
  });
  assert.equal(repeated.repeated, true);
  assert.equal(repeated.session.state.revision, completed.session.state.revision);

  await assert.rejects(
    completeHostQuestionResponse({
      root,
      sessionId: created.id,
      questionId: "turn_host_response",
      expectedRevision: queued.state.revision,
      expectedSelectionId: selection.id,
      route,
      content: "A different answer must not replace it.",
    }),
    (error) => error.code === "QUESTION_ALREADY_ANSWERED",
  );
});

test("a queued host question rebinds once under revision control and preserves its selection", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_host_rebind",
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    patch: { selectedIds: ["phrase_attention"] },
  });
  const selection = buildSelection(packageValue, selected.state);
  const originalRoute = {
    kind: "host",
    attachmentId: "host_0123456789abcdef",
    generation: 1,
  };
  const queued = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: selected.state.revision,
    route: originalRoute,
    turn: {
      id: "turn_host_rebind",
      role: "user",
      content: "Recover this question without changing its evidence.",
      selection,
    },
  });
  const frozenSelection = queued.conversation.turns[0].selection;
  const targetRoutes = [
    {
      kind: "host",
      attachmentId: "host_1111111111111111",
      generation: 1,
    },
    {
      kind: "host",
      attachmentId: "host_2222222222222222",
      generation: 1,
    },
  ];

  const attempts = await Promise.allSettled(targetRoutes.map((route) =>
    rebindQueuedHostQuestionResponse({
      root,
      sessionId: created.id,
      questionId: "turn_host_rebind",
      expectedRevision: queued.state.revision,
      route,
    })));
  const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "CONFLICT");

  const winner = fulfilled[0].value;
  const reboundRoute = winner.question.response.route;
  assert.equal(winner.repeated, false);
  assert.equal(winner.question.response.status, "queued");
  assert.equal(winner.question.response.rebindCount, 1);
  assert.match(winner.question.response.reboundAt, /^\d{4}-\d\d-\d\dT/u);
  assert.deepEqual(winner.question.selection, frozenSelection);
  assert.equal(winner.session.state.revision, queued.state.revision + 1);

  const replay = await rebindQueuedHostQuestionResponse({
    root,
    sessionId: created.id,
    questionId: "turn_host_rebind",
    expectedRevision: queued.state.revision,
    route: reboundRoute,
  });
  assert.equal(replay.repeated, true);
  assert.equal(replay.changed, false);
  assert.equal(replay.session.state.revision, winner.session.state.revision);
  assert.deepEqual(replay.question.selection, frozenSelection);
});

test("host rebind never captures detached work or bypasses a stale session revision", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_host_rebind_guards",
  });
  const selection = buildSelection(packageValue, created.state);
  const detached = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: created.state.revision,
    route: { kind: "detached", adapter: "codex-cli" },
    turn: {
      id: "turn_detached_rebind",
      role: "user",
      content: "Keep this with its selected detached adapter.",
      selection,
    },
  });
  const nextRoute = {
    kind: "host",
    attachmentId: "host_3333333333333333",
    generation: 1,
  };

  await assert.rejects(
    rebindQueuedHostQuestionResponse({
      root,
      sessionId: created.id,
      questionId: "turn_detached_rebind",
      expectedRevision: detached.state.revision,
      route: nextRoute,
    }),
    (error) => error.code === "QUESTION_RESPONSE_ROUTE_MISMATCH",
  );

  const hostSession = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_host_rebind_stale",
  });
  const hostRoute = {
    kind: "host",
    attachmentId: "host_4444444444444444",
    generation: 1,
  };
  const hostQueued = await appendQueuedQuestion({
    root,
    sessionId: hostSession.id,
    expectedRevision: hostSession.state.revision,
    route: hostRoute,
    turn: {
      id: "turn_stale_rebind",
      role: "user",
      content: "Do not rebind from a stale session read.",
      selection: buildSelection(packageValue, hostSession.state),
    },
  });
  await updateSession({
    root,
    sessionId: hostSession.id,
    expectedRevision: hostQueued.state.revision,
    patch: { query: "attention" },
  });
  await assert.rejects(
    rebindQueuedHostQuestionResponse({
      root,
      sessionId: hostSession.id,
      questionId: "turn_stale_rebind",
      expectedRevision: hostQueued.state.revision,
      route: nextRoute,
    }),
    (error) => error.code === "CONFLICT",
  );
  const stored = await loadSession({ root, sessionId: created.id });
  assert.deepEqual(
    stored.conversation.turns[0].response.route,
    { kind: "detached", adapter: "codex-cli" },
  );
  const staleStored = await loadSession({ root, sessionId: hostSession.id });
  assert.deepEqual(staleStored.conversation.turns[0].response.route, hostRoute);
});

test("failed response jobs retry explicitly and active jobs bound session concurrency", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_response_retry",
  });
  const first = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    turn: {
      id: "turn_retry_question",
      role: "user",
      content: "Answer this question.",
      selection: buildSelection(packageValue, created.state),
    },
  });

  await assert.rejects(
    appendQueuedQuestion({
      root,
      sessionId: created.id,
      expectedRevision: 1,
      turn: {
        id: "turn_blocked_question",
        role: "user",
        content: "Do not create unbounded work.",
        selection: buildSelection(packageValue, first.state),
      },
    }),
    (error) => error.code === "ACTIVE_RESPONSE_EXISTS",
  );
  assert.equal(
    (await loadSession({ root, sessionId: created.id })).conversation.turns.length,
    1,
  );

  const failed = await markQuestionResponseFailed({
    root,
    sessionId: created.id,
    questionId: "turn_retry_question",
    errorCode: "codex_exit",
  });
  assert.equal(failed.changed, true);
  assert.equal(failed.question.response.status, "failed");
  assert.equal(failed.question.response.errorCode, "codex_exit");
  const failedAgain = await markQuestionResponseFailed({
    root,
    sessionId: created.id,
    questionId: "turn_retry_question",
    errorCode: "different_failure",
  });
  assert.equal(failedAgain.changed, false);
  assert.equal(failedAgain.question.response.errorCode, "codex_exit");
  await assert.rejects(
    completeQuestionResponse({
      root,
      sessionId: created.id,
      questionId: "turn_retry_question",
      content: "A timed-out attempt must not complete after failure.",
    }),
    (error) => error.code === "QUESTION_RESPONSE_NOT_RUNNING",
  );

  await assert.rejects(
    retryQuestionResponse({
      root,
      sessionId: created.id,
      questionId: "turn_retry_question",
      expectedRoute: { kind: "detached", adapter: "claude-cli" },
    }),
    (error) => error.code === "QUESTION_RESPONSE_ROUTE_MISMATCH",
  );
  assert.equal(
    (await loadSession({ root, sessionId: created.id }))
      .conversation.turns[0].response.status,
    "failed",
  );

  const retried = await retryQuestionResponse({
    root,
    sessionId: created.id,
    questionId: "turn_retry_question",
    expectedRoute: { kind: "detached", adapter: "codex-cli" },
  });
  assert.equal(retried.changed, true);
  assert.equal(retried.question.response.status, "queued");
  assert.equal(Object.hasOwn(retried.question.response, "errorCode"), false);
  await assert.rejects(
    completeQuestionResponse({
      root,
      sessionId: created.id,
      questionId: "turn_retry_question",
      content: "A queued retry must be claimed before completion.",
    }),
    (error) => error.code === "QUESTION_RESPONSE_NOT_RUNNING",
  );
  await assert.rejects(
    retryQuestionResponse({
      root,
      sessionId: created.id,
      questionId: "turn_retry_question",
    }),
    (error) => error.code === "QUESTION_RESPONSE_NOT_RETRYABLE",
  );
});

test("retry preserves a failed response while a different response is active", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();

  for (const activeStatus of ["queued", "running"]) {
    const created = await createSession({
      root,
      dataPackage: packageValue,
      id: `session_retry_with_${activeStatus}`,
    });
    const first = await appendQueuedQuestion({
      root,
      sessionId: created.id,
      expectedRevision: created.state.revision,
      turn: {
        id: `turn_failed_before_${activeStatus}`,
        role: "user",
        content: "This response failed first.",
        selection: buildSelection(packageValue, created.state),
      },
    });
    const failed = await markQuestionResponseFailed({
      root,
      sessionId: created.id,
      questionId: first.conversation.turns[0].id,
      errorCode: "runner_failed",
    });
    await appendQueuedQuestion({
      root,
      sessionId: created.id,
      expectedRevision: failed.session.state.revision,
      turn: {
        id: `turn_active_${activeStatus}`,
        role: "user",
        content: "This response now owns the active slot.",
        selection: buildSelection(packageValue, failed.session.state),
      },
    });
    if (activeStatus === "running") {
      await markQuestionResponseRunning({
        root,
        sessionId: created.id,
        questionId: `turn_active_${activeStatus}`,
      });
    }
    const beforeRetry = await loadSession({ root, sessionId: created.id });

    await assert.rejects(
      retryQuestionResponse({
        root,
        sessionId: created.id,
        questionId: `turn_failed_before_${activeStatus}`,
      }),
      (error) => error.code === "ACTIVE_RESPONSE_EXISTS",
    );

    const afterRetry = await loadSession({ root, sessionId: created.id });
    assert.deepEqual(afterRetry, beforeRetry);
    assert.equal(afterRetry.conversation.turns[0].response.status, "failed");
    assert.equal(
      afterRetry.conversation.turns[1].response.status,
      activeStatus,
    );
  }
});

test("restart recovery enumerates every queued or running explicit job", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  for (const sessionId of ["session_jobs_b", "session_jobs_a"]) {
    const session = await createSession({
      root,
      dataPackage: packageValue,
      id: sessionId,
    });
    await appendQueuedQuestion({
      root,
      sessionId,
      expectedRevision: 0,
      turn: {
        id: `turn_${sessionId}`,
        role: "user",
        content: `Question for ${sessionId}`,
        createdAt:
          sessionId.endsWith("a")
            ? "2026-08-22T12:00:00.000Z"
            : "2026-08-22T12:00:01.000Z",
        selection: buildSelection(packageValue, session.state),
      },
    });
  }
  await markQuestionResponseRunning({
    root,
    sessionId: "session_jobs_b",
    questionId: "turn_session_jobs_b",
  });
  assert.deepEqual(await pendingQuestionResponseJobs({ root }), [
    {
      sessionId: "session_jobs_a",
      questionId: "turn_session_jobs_a",
      status: "queued",
      route: { kind: "detached", adapter: "codex-cli" },
    },
    {
      sessionId: "session_jobs_b",
      questionId: "turn_session_jobs_b",
      status: "running",
      route: { kind: "detached", adapter: "codex-cli" },
    },
  ]);

  await markQuestionResponseRunning({
    root,
    sessionId: "session_jobs_a",
    questionId: "turn_session_jobs_a",
  });
  await completeQuestionResponse({
    root,
    sessionId: "session_jobs_a",
    questionId: "turn_session_jobs_a",
    content: "Finished one job.",
  });
  assert.deepEqual(await pendingQuestionResponseJobs({ root }), [
    {
      sessionId: "session_jobs_b",
      questionId: "turn_session_jobs_b",
      status: "running",
      route: { kind: "detached", adapter: "codex-cli" },
    },
  ]);
});

test("restart recovery leaves a route-less legacy job unbound", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const session = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_legacy_unbound_job",
  });
  await appendQueuedQuestion({
    root,
    sessionId: session.id,
    expectedRevision: 0,
    turn: {
      id: "turn_legacy_unbound_job",
      role: "user",
      content: "Do not guess which detached agent should answer this.",
      selection: buildSelection(packageValue, session.state),
    },
  });
  const path = sessionFilePath({ root, sessionId: session.id });
  const stored = JSON.parse(await readFile(path, "utf8"));
  delete stored.conversation.turns[0].response.route;
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);

  assert.deepEqual(await pendingQuestionResponseJobs({ root }), [{
    sessionId: session.id,
    questionId: "turn_legacy_unbound_job",
    status: "queued",
    route: null,
    legacyRouteMissing: true,
  }]);
  assert.equal(
    Object.hasOwn(
      (await loadSession({ root, sessionId: session.id }))
        .conversation.turns[0].response,
      "route",
    ),
    false,
  );
});

test("a stale attached-question mutation writes and clears nothing", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_stale_attachment",
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: { selectedIds: ["phrase_attention"] },
  });
  const attachedSelection = buildSelection(packageValue, selected.state);

  await assert.rejects(
    appendConversationTurn({
      root,
      sessionId: created.id,
      expectedRevision: 0,
      consumeSelectedIds: true,
      turn: {
        role: "user",
        content: "This is stale and must not be stored.",
        selection: attachedSelection,
      },
    }),
    (error) => error.code === "CONFLICT",
  );

  const stored = await loadSession({ root, sessionId: created.id });
  assert.equal(stored.state.revision, 1);
  assert.deepEqual(stored.state.selectedIds, ["phrase_attention"]);
  assert.deepEqual(stored.conversation.turns, []);
});

test("consuming a selection derives the exact snapshot under the session lock", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_exact_consumed_attachment",
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: { selectedIds: ["phrase_attention"] },
  });
  const exactSelection = buildSelection(packageValue, selected.state);

  const asked = await appendConversationTurn({
    root,
    sessionId: created.id,
    expectedRevision: 1,
    consumeSelectedIds: true,
    turn: {
      id: "turn_exact_consumed_attachment",
      role: "user",
      content: "Use the authoritative attachment.",
      selection: {
        ...exactSelection,
        predicate: { field: "tampered", operator: "equals", value: true },
        sourceRefs: [],
      },
    },
  });
  const storedSelection = asked.conversation.turns[0].selection;
  assert.deepEqual(storedSelection.predicate, exactSelection.predicate);
  assert.deepEqual(storedSelection.sourceRefs, exactSelection.sourceRefs);

  await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 2,
    patch: { selectedIds: ["phrase_local"] },
  });
  await assert.rejects(
    appendConversationTurn({
      root,
      sessionId: created.id,
      expectedRevision: 3,
      consumeSelectedIds: true,
      turn: {
        role: "user",
        content: "This id belongs to the prior selection.",
        selection: exactSelection,
      },
    }),
    (error) => error.code === "SELECTION_MISMATCH",
  );
  const afterMismatch = await loadSession({ root, sessionId: created.id });
  assert.equal(afterMismatch.state.revision, 3);
  assert.deepEqual(afterMismatch.state.selectedIds, ["phrase_local"]);
  assert.equal(afterMismatch.conversation.turns.length, 1);
});

test("oldest unanswered question stays linked to its historical selection", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_pending_question",
  });
  const selectedA = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: { selectedIds: ["phrase_attention"] },
  });
  const selectionA = buildSelection(packageValue, selectedA.state);
  const asked = await appendConversationTurn({
    root,
    sessionId: created.id,
    expectedRevision: 1,
    turn: {
      id: "turn_question_a",
      role: "user",
      content: "How is this phrase used?",
      selection: selectionA,
    },
  });
  const selectedB = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 2,
    patch: { selectedIds: ["phrase_local"] },
  });

  const pending = oldestUnansweredQuestion(selectedB);
  assert.equal(pending.id, "turn_question_a");
  assert.equal(pending.selection.id, selectionA.id);
  assert.equal(pending.selection.stateRevision, 1);
  assert.deepEqual(pending.selection.selectedMarkIds, ["phrase_attention"]);
  assert.deepEqual(selectedB.state.selectedIds, ["phrase_local"]);

  const answered = await appendConversationTurn({
    root,
    sessionId: created.id,
    expectedRevision: 3,
    turn: {
      id: "turn_answer_a",
      role: "assistant",
      content: "It is used as a name for the recurring visual structure.",
      replyToTurnId: pending.id,
      selection: pending.selection,
    },
  });
  const reply = answered.conversation.turns.at(-1);
  assert.equal(reply.replyToTurnId, "turn_question_a");
  assert.deepEqual(reply.selection, pending.selection);
  assert.deepEqual(answered.state.selectedIds, ["phrase_local"]);
  assert.equal(oldestUnansweredQuestion(answered), null);

  await assert.rejects(
    appendConversationTurn({
      root,
      sessionId: created.id,
      expectedRevision: 4,
      turn: {
        role: "assistant",
        content: "A duplicate answer must not commit.",
        replyToTurnId: "turn_question_a",
        selection: selectionA,
      },
    }),
    (error) => error.code === "QUESTION_ALREADY_ANSWERED",
  );
  assert.equal(
    (await loadSession({ root, sessionId: created.id })).state.revision,
    4,
  );
  assert.equal(asked.state.revision, 2);
});

test("a legacy context receipt does not masquerade as an answer", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const created = await createSession({
    root,
    dataPackage: packageValue,
    id: "session_legacy_receipt",
  });
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: { selectedIds: ["phrase_attention"] },
  });
  const selection = buildSelection(packageValue, selected.state);
  const exchanged = await appendConversationTurns({
    root,
    sessionId: created.id,
    expectedRevision: 1,
    turns: [
      {
        id: "turn_legacy_question",
        role: "user",
        content: "Tell me about the usage.",
        selection,
      },
      {
        id: "turn_legacy_receipt",
        role: "assistant",
        content: "Context saved from the selected phrase.",
        selection,
      },
    ],
  });

  const pending = oldestUnansweredQuestion(exchanged);
  assert.equal(pending.id, "turn_legacy_question");
  assert.equal(pending.selection.id, selection.id);
});

test("project pending questions use createdAt with stable cross-session ties", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const sessions = new Map();
  for (const sessionId of ["session_zeta", "session_later", "session_alpha"]) {
    sessions.set(
      sessionId,
      await createSession({ root, dataPackage: packageValue, id: sessionId }),
    );
  }

  const questions = [
    {
      sessionId: "session_zeta",
      id: "turn_zeta",
      createdAt: "2026-08-22T10:00:00.000Z",
    },
    {
      sessionId: "session_later",
      id: "turn_later",
      createdAt: "2026-08-22T10:00:01.000Z",
    },
    {
      sessionId: "session_alpha",
      id: "turn_alpha",
      createdAt: "2026-08-22T10:00:00.000Z",
    },
  ];
  for (const question of questions) {
    await appendConversationTurn({
      root,
      sessionId: question.sessionId,
      expectedRevision: 0,
      turn: {
        id: question.id,
        role: "user",
        content: `Question from ${question.sessionId}`,
        createdAt: question.createdAt,
        selection: buildSelection(
          packageValue,
          sessions.get(question.sessionId).state,
        ),
      },
    });
  }

  const first = await oldestUnansweredQuestionAcrossSessions({ root });
  assert.equal(first.sessionId, "session_alpha");
  assert.equal(first.question.id, "turn_alpha");

  await appendConversationTurn({
    root,
    sessionId: first.sessionId,
    expectedRevision: first.session.state.revision,
    turn: {
      role: "assistant",
      content: "Answered the stable tie-break winner.",
      replyToTurnId: first.question.id,
      selection: first.question.selection,
    },
  });

  const second = await oldestUnansweredQuestionAcrossSessions({ root });
  assert.equal(second.sessionId, "session_zeta");
  assert.equal(second.question.id, "turn_zeta");
});

test("linked replies require the question's exact stored selection id", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  await createSession({
    root,
    dataPackage: packageValue,
    id: "session_reply_selection",
  });
  const selection = buildSelection(packageValue, {
    revision: 0,
    selectedIds: [],
    query: "",
    minCount: 2,
    sort: { by: "distinctSourceCount", direction: "desc" },
    sourceScope: {
      mode: "all",
      sourceIds: ["source_alpha", "source_beta"],
    },
  });
  await appendConversationTurn({
    root,
    sessionId: "session_reply_selection",
    expectedRevision: 0,
    turn: {
      id: "turn_exact_question",
      role: "user",
      content: "What does this view show?",
      selection,
    },
  });

  await assert.rejects(
    appendConversationTurn({
      root,
      sessionId: "session_reply_selection",
      expectedRevision: 1,
      turn: {
        role: "assistant",
        content: "This uses the wrong context.",
        replyToTurnId: "turn_exact_question",
        selection: { ...selection, id: "selection_wrong" },
      },
    }),
    (error) => error.code === "QUESTION_SELECTION_MISMATCH",
  );
  const stored = await loadSession({
    root,
    sessionId: "session_reply_selection",
  });
  assert.equal(stored.state.revision, 1);
  assert.equal(stored.conversation.turns.length, 1);
});

test("concurrent writes from one revision cannot both commit", async (t) => {
  const root = await fixture(t);
  await createSession({
    root,
    dataPackage: dataPackage(),
    id: "session_race",
  });

  const results = await Promise.allSettled([
    updateSession({
      root,
      sessionId: "session_race",
      expectedRevision: 0,
      patch: { query: "first" },
    }),
    updateSession({
      root,
      sessionId: "session_race",
      expectedRevision: 0,
      patch: { query: "second" },
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.equal(rejection.reason.code, "CONFLICT");
  const session = await loadSession({ root, sessionId: "session_race" });
  assert.equal(session.state.revision, 1);
  assert.ok(session.state.query === "first" || session.state.query === "second");

  const files = await readdir(join(root, ".attend", "local", "sessions"));
  assert.deepEqual(files, ["session_race.json"]);
});

test("invalid state cannot escape into a persisted session", async (t) => {
  const root = await fixture(t);
  await createSession({
    root,
    dataPackage: dataPackage(),
    id: "session_validation",
  });

  await assert.rejects(
    updateSession({
      root,
      sessionId: "session_validation",
      expectedRevision: 0,
      patch: { revision: 99 },
    }),
    /Unknown session state field: revision/,
  );
  await assert.rejects(
    updateSession({
      root,
      sessionId: "session_validation",
      expectedRevision: 0,
      patch: {
        sourceScope: { mode: "include", sourceIds: ["source_missing"] },
      },
    }),
    /Unknown source id/,
  );
  assert.equal(
    (await loadSession({ root, sessionId: "session_validation" })).state.revision,
    0,
  );
});

test("concurrent creation waits and reports the completed identical session", async (t) => {
  const root = await fixture(t);
  const packageValue = dataPackage();
  const results = await Promise.allSettled([
    createSession({ root, id: "session_create_race", dataPackage: packageValue }),
    createSession({ root, id: "session_create_race", dataPackage: packageValue }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.equal(rejection.reason.code, "SESSION_EXISTS");
  assert.equal((await loadSession({ root, sessionId: "session_create_race" })).state.revision, 0);
});

test("a dead lock owner is reclaimed without losing the session", async (t) => {
  const root = await fixture(t);
  await createSession({ root, id: "session_dead_lock", dataPackage: dataPackage() });
  const path = sessionFilePath({ root, sessionId: "session_dead_lock" });
  await writeFile(`${path}.lock`, `${JSON.stringify({ pid: 99_999_999, owner: "dead" })}\n`);

  const updated = await updateSession({
    root,
    sessionId: "session_dead_lock",
    expectedRevision: 0,
    patch: { query: "recovered" },
  });

  assert.equal(updated.state.revision, 1);
  assert.equal(updated.state.query, "recovered");
});

test("session creation refuses a symlinked local-state directory", async (t) => {
  const root = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(join(root, ".attend"));
  await mkdir(outside);
  await symlink(outside, join(root, ".attend", "local"));

  await assert.rejects(
    createSession({ root, id: "session_symlink", dataPackage: dataPackage() }),
    (error) => error.code === "UNSAFE_SYMLINK",
  );
  assert.deepEqual(await readdir(outside), []);
});
