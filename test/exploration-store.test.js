import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendExperimentEvent,
  createExperiment,
  createExploration,
  explorationPaths,
  listExperimentEvents,
  listExperiments,
  loadExperiment,
  publicExploration,
} from "../src/exploration-store.js";
import { compileCatalogMapRequest } from "../src/map/index.js";
import { createSession } from "../src/session-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-exploration-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "data.md"), "Alpha: 8\nBeta: 5\nGamma: 3\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const explorationId = "exploration_000000000000000000000001";
const firstId = "experiment_000000000000000000000001";
const secondId = "experiment_000000000000000000000002";
const sourceScope = [{ path: "notes/data.md", textProjection: "utf8" }];

function clock(value) {
  return () => new Date(value);
}

function plan(key, overrides = {}) {
  return {
    key,
    hypothesis: `Hypothesis ${key}`,
    whyUseful: `Reason ${key}`,
    representation: { family: "rank", member: "bar-list" },
    sourceScope,
    baseline: { name: "uniform", description: "Compare with equal values." },
    comparisonCount: 2,
    origin: "agent",
    analysisMode: "exploratory",
    timing: "pre-result",
    ...overrides,
  };
}

async function createResultSession(root, experimentId) {
  const { dataPackage } = await compileCatalogMapRequest({
    root,
    request: {
      version: 1,
      question: "How do Alpha and Beta compare?",
      family: "rank",
      member: "bar-list",
      sources: sourceScope,
      records: [
        { key: "alpha", label: "Alpha", value: 8 },
        { key: "beta", label: "Beta", value: 5 },
        { key: "gamma", label: "Gamma", value: 3 },
      ],
      evidence: [
        { source: sourceScope[0], quote: "Alpha: 8", recordKey: "alpha", field: "label" },
        { source: sourceScope[0], quote: "Alpha: 8", recordKey: "alpha", field: "value" },
        { source: sourceScope[0], quote: "Beta: 5", recordKey: "beta", field: "label" },
        { source: sourceScope[0], quote: "Beta: 5", recordKey: "beta", field: "value" },
        { source: sourceScope[0], quote: "Gamma: 3", recordKey: "gamma", field: "label" },
        { source: sourceScope[0], quote: "Gamma: 3", recordKey: "gamma", field: "value" },
      ],
    },
  });
  await createSession({
    root,
    id: experimentId,
    dataPackage,
    exploration: { explorationId, experimentId },
  });
  return dataPackage;
}

test("plans stay immutable while all outcomes and signals append to one experiment", async (t) => {
  const root = await fixture(t);
  await createExploration({
    root,
    id: explorationId,
    now: clock("2026-08-25T12:00:00.000Z"),
    plan: {
      goal: "Find useful structure",
      analyticIntent: "Test restrained visual hypotheses.",
      sourceScope,
      limits: { maxExperiments: 4, maxComparisons: 12 },
    },
  });
  await createExperiment({
    root,
    explorationId,
    id: firstId,
    now: clock("2026-08-25T12:01:00.000Z"),
    plan: plan("cohort"),
  });
  await createExperiment({
    root,
    explorationId,
    id: secondId,
    now: clock("2026-08-25T12:02:00.000Z"),
    plan: plan("follow-up", { parentExperimentId: firstId }),
  });

  await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "execution-started",
    payload: {},
    id: "event_00000001",
    at: "2026-08-25T12:03:00.000Z",
  });
  const dataPackage = await createResultSession(root, firstId);
  await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "execution-completed",
    payload: {
      analysisId: dataPackage.id,
      sessionId: firstId,
      packageHash: dataPackage.hashes.data,
      comparisonCount: 2,
    },
    id: "event_00000002",
    at: "2026-08-25T12:04:00.000Z",
  });
  await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "assessment-recorded",
    payload: {
      outcome: "interesting",
      summary: "One cohort is visibly larger.",
      rationale: "The difference is relevant and evidence-backed.",
      evidenceStrength: "moderate",
      interestingness: {
        taskRelevance: 0.9,
        evidenceSufficiency: 0.8,
        surprise: 0.7,
        novelty: 0.6,
        actionability: 0.5,
        representationalDiversity: 0.4,
        uncertainty: 0.3,
        interruptionCost: 0.1,
      },
      transformations: ["Grouped by founding year."],
      omissions: [],
      limitations: ["Small sample."],
    },
    id: "event_00000003",
    at: "2026-08-25T12:05:00.000Z",
  });
  await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "agent-promoted",
    payload: { rationale: "Worth attention because the cohort break is large." },
    id: "event_00000004",
    at: "2026-08-25T12:06:00.000Z",
  });
  await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "human-star-changed",
    payload: { starred: true },
    actor: "human",
    id: "event_00000005",
    at: "2026-08-25T12:07:00.000Z",
  });
  await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "feedback-recorded",
    payload: { kind: "useful" },
    actor: "human",
    id: "event_00000006",
    at: "2026-08-25T12:08:00.000Z",
  });
  await appendExperimentEvent({
    root,
    experimentId: secondId,
    kind: "execution-failed",
    payload: { code: "INVALID_REQUEST", message: "Evidence did not cover value." },
    id: "event_00000007",
    at: "2026-08-25T12:09:00.000Z",
  });

  const workspace = await publicExploration({ root, explorationId });
  assert.equal(workspace.experiments.length, 2);
  assert.deepEqual(workspace.counts, {
    total: 2,
    queued: 0,
    running: 0,
    completed: 1,
    failed: 1,
    attempted: 2,
    comparisonsDeclared: 4,
    comparisonsAttempted: 4,
    promoted: 1,
    starred: 1,
  });
  const first = workspace.experiments.find((experiment) => experiment.id === firstId);
  assert.equal(first.execution, "completed");
  assert.equal(first.outcome, "interesting");
  assert.equal(first.agentPromoted, true);
  assert.equal(first.humanStarred, true);
  assert.equal(first.humanDisposition, "starred");
  assert.equal(first.feedback[0].kind, "useful");
  assert.equal(first.events.length, 6);
  assert.equal(workspace.experiments.find((experiment) => experiment.id === secondId).execution, "failed");
  assert.equal((await listExperiments({ root, explorationId }))[1].parentExperimentId, firstId);

  await assert.rejects(
    createExperiment({ root, explorationId, id: firstId, plan: plan("replacement") }),
    (error) => error?.code === "EXPERIMENT_EXISTS",
  );
  await assert.rejects(
    appendExperimentEvent({
      root,
      experimentId: firstId,
      kind: "feedback-recorded",
      payload: { kind: "useful" },
      actor: "human",
      id: "event_00000006",
      at: "2026-08-25T12:10:00.000Z",
    }),
    (error) => error?.code === "EXPERIMENT_EVENT_EXISTS",
  );
});

test("an experiment cannot branch across exploration boundaries", async (t) => {
  const root = await fixture(t);
  for (const [id, suffix] of [
    [explorationId, "one"],
    ["exploration_000000000000000000000002", "two"],
  ]) {
    await createExploration({
      root,
      id,
      plan: { goal: suffix, analyticIntent: suffix, sourceScope },
    });
  }
  await createExperiment({ root, explorationId, id: firstId, plan: plan("parent") });
  await assert.rejects(
    createExperiment({
      root,
      explorationId: "exploration_000000000000000000000002",
      id: secondId,
      plan: plan("child", { parentExperimentId: firstId }),
    }),
    (error) => error?.code === "INVALID_EXPERIMENT_PARENT",
  );
});

test("concurrent admissions preserve key uniqueness and exploration limits", async (t) => {
  const root = await fixture(t);
  await createExploration({
    root,
    id: explorationId,
    plan: {
      goal: "Bound concurrent admission",
      analyticIntent: "Keep one canonical plan per key.",
      sourceScope,
      limits: { maxExperiments: 1, maxComparisons: 2 },
    },
  });
  const duplicate = await Promise.allSettled([
    createExperiment({ root, explorationId, id: firstId, plan: plan("same") }),
    createExperiment({ root, explorationId, id: secondId, plan: plan("same") }),
  ]);
  assert.equal(duplicate.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(duplicate.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await listExperiments({ root, explorationId })).length, 1);
  assert.equal(duplicate.find((result) => result.status === "rejected").reason.code, "EXPERIMENT_KEY_EXISTS");

  await assert.rejects(
    createExperiment({
      root,
      explorationId,
      id: "experiment_000000000000000000000003",
      plan: plan("different"),
    }),
    (error) => error?.code === "EXPLORATION_LIMIT",
  );
});

test("completed results require matching staged-session provenance", async (t) => {
  const root = await fixture(t);
  await createExploration({
    root,
    id: explorationId,
    plan: { goal: "Verify provenance", analyticIntent: "Reject forged results.", sourceScope },
  });
  await createExperiment({ root, explorationId, id: firstId, plan: plan("bound") });
  await assert.rejects(
    appendExperimentEvent({
      root,
      experimentId: firstId,
      kind: "execution-completed",
      payload: {
        analysisId: "data_not_real",
        sessionId: "not-a-session",
        packageHash: "a".repeat(64),
        comparisonCount: 2,
      },
    }),
    (error) => error?.code === "INVALID_EXPERIMENT_RESULT",
  );
});

test("an idempotency key creates one immutable event under concurrent retries", async (t) => {
  const root = await fixture(t);
  await createExploration({
    root,
    id: explorationId,
    plan: { goal: "Retry safely", analyticIntent: "Deduplicate one promotion.", sourceScope },
  });
  await createExperiment({ root, explorationId, id: firstId, plan: plan("promotion") });
  const events = await Promise.all([
    appendExperimentEvent({
      root,
      experimentId: firstId,
      kind: "agent-promoted",
      payload: { rationale: "Worth attention." },
      idempotencyKey: "promotion-v1",
    }),
    appendExperimentEvent({
      root,
      experimentId: firstId,
      kind: "agent-promoted",
      payload: { rationale: "Worth attention." },
      idempotencyKey: "promotion-v1",
    }),
  ]);
  assert.equal(events[0].id, events[1].id);
  assert.equal((await listExperimentEvents({ root, experimentId: firstId })).length, 1);
  await assert.rejects(
    appendExperimentEvent({
      root,
      experimentId: firstId,
      kind: "agent-promoted",
      payload: { rationale: "A different meaning." },
      idempotencyKey: "promotion-v1",
    }),
    (error) => error?.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("event revisions reject stale human signals while exact retries and star no-ops converge", async (t) => {
  const root = await fixture(t);
  await createExploration({
    root,
    id: explorationId,
    plan: { goal: "Serialize feedback", analyticIntent: "Preserve signal order.", sourceScope },
  });
  await createExperiment({ root, explorationId, id: firstId, plan: plan("signals") });

  const feedback = await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "feedback-recorded",
    payload: { kind: "useful" },
    actor: "human",
    idempotencyKey: "human-feedback-1",
    expectedRevision: 0,
  });
  const retry = await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "feedback-recorded",
    payload: { kind: "useful" },
    actor: "human",
    idempotencyKey: "human-feedback-1",
    expectedRevision: 0,
  });
  assert.equal(retry.id, feedback.id);
  assert.equal((await listExperimentEvents({ root, experimentId: firstId })).length, 1);

  await assert.rejects(
    appendExperimentEvent({
      root,
      experimentId: firstId,
      kind: "human-star-changed",
      payload: { starred: true },
      actor: "human",
      idempotencyKey: "human-star-stale",
      expectedRevision: 0,
      dedupeConsecutive: true,
    }),
    (error) => error?.code === "EXPERIMENT_REVISION_CONFLICT",
  );

  const star = await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "human-star-changed",
    payload: { starred: true },
    actor: "human",
    idempotencyKey: "human-star-1",
    expectedRevision: 1,
    dedupeConsecutive: true,
  });
  const noOp = await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "human-star-changed",
    payload: { starred: true },
    actor: "human",
    idempotencyKey: "human-star-2",
    expectedRevision: 2,
    dedupeConsecutive: true,
  });
  assert.equal(noOp.id, star.id);
  assert.equal((await listExperimentEvents({ root, experimentId: firstId })).length, 2);
});

test("stored experiment and event records are revalidated before use", async (t) => {
  const root = await fixture(t);
  await createExploration({
    root,
    id: explorationId,
    plan: {
      goal: "Reject poisoned records",
      analyticIntent: "Revalidate the immutable ledger at its read boundary.",
      sourceScope,
    },
  });
  await createExperiment({
    root,
    explorationId,
    id: firstId,
    plan: plan("strict-load"),
  });
  await appendExperimentEvent({
    root,
    experimentId: firstId,
    kind: "execution-started",
    payload: {},
    id: "event_00000008",
    at: "2026-08-25T12:10:00.000Z",
  });

  const paths = explorationPaths(root, explorationId, firstId);
  const experiment = JSON.parse(await readFile(paths.experiment, "utf8"));
  await writeFile(
    paths.experiment,
    `${JSON.stringify({ ...experiment, prompt: "untrusted content" }, null, 2)}\n`,
  );
  await assert.rejects(
    loadExperiment({ root, explorationId, experimentId: firstId }),
    /unknown field prompt/u,
  );

  await writeFile(
    paths.experiment,
    `${JSON.stringify({
      ...experiment,
      sourceScope: [{ path: "outside.md", textProjection: "utf8" }],
    }, null, 2)}\n`,
  );
  await assert.rejects(
    loadExperiment({ root, explorationId, experimentId: firstId }),
    (error) => error?.code === "SOURCE_SCOPE_NOT_AUTHORIZED",
  );
  await writeFile(paths.experiment, `${JSON.stringify(experiment, null, 2)}\n`);

  const eventPath = join(paths.eventsDirectory, "event_00000008.json");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  await writeFile(
    eventPath,
    `${JSON.stringify({
      ...event,
      payload: { transcript: "untrusted content" },
    }, null, 2)}\n`,
  );
  await assert.rejects(
    listExperimentEvents({ root, experimentId: firstId }),
    /unknown field transcript/u,
  );

  await writeFile(
    eventPath,
    `${JSON.stringify({ ...event, id: "event_00000009" }, null, 2)}\n`,
  );
  await assert.rejects(
    listExperimentEvents({ root, experimentId: firstId }),
    /does not match its filename/u,
  );
});
