import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateOpportunityRuns,
  validateFixtureCorpus,
  validateRunSummary,
} from "../eval/run-opportunity-eval.mjs";

const FIXTURE_URL = new URL("../eval/opportunity-fixtures.json", import.meta.url);

async function fixtureCorpus() {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function run(fixtureId, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "attend-opportunity-eval-run",
    fixtureId,
    tools: ["attend-checkpoint"],
    resultClasses: ["task-completed", "checkpoint-abstain", "abstention-text-suffices"],
    counters: {
      sourceCount: 1,
      resultCount: 3,
      checkpointCount: 1,
      explorationCount: 0,
      experimentCount: 0,
      promotedCount: 0,
      evidenceValidCount: 0,
      evidenceInvalidCount: 0,
    },
    timingsMs: {
      total: 100,
      checkpoint: 10,
      exploration: 0,
    },
    finalAnswerMention: "none",
    ...overrides,
  };
}

test("the starter corpus is strict, balanced, and tied to executable catalog members", async () => {
  const corpus = validateFixtureCorpus(await fixtureCorpus());
  assert.equal(corpus.fixtures.length, 12);
  assert.deepEqual(
    Object.fromEntries(["positive", "negative", "ambiguous"].map((label) => [
      label,
      corpus.fixtures.filter((fixture) => fixture.label === label).length,
    ])),
    { positive: 4, negative: 4, ambiguous: 4 },
  );

  const jobs = new Set(corpus.fixtures.flatMap((fixture) => fixture.expectedAnalyticJobs));
  const families = new Set(corpus.fixtures.flatMap((fixture) =>
    fixture.eligibleRepresentations.map((representation) => representation.family),
  ));
  assert.equal(jobs.size >= 8, true);
  assert.equal(families.size >= 8, true);
});

test("fixture validation rejects unknown and content-bearing fields", async () => {
  const corpus = await fixtureCorpus();
  const unknown = clone(corpus);
  unknown.fixtures[0].reviewerNote = "not allowed";
  assert.throws(
    () => validateFixtureCorpus(unknown),
    (error) => error?.code === "UNKNOWN_OPPORTUNITY_EVAL_FIELD" && error?.path.endsWith(".reviewerNote"),
  );
  const prompt = clone(corpus);
  prompt.fixtures[0].sourceShape.prompt = "raw task text";
  assert.throws(
    () => validateFixtureCorpus(prompt),
    (error) => error?.code === "FORBIDDEN_OPPORTUNITY_EVAL_CONTENT" && error?.path.endsWith(".prompt"),
  );

  const absolutePath = clone(corpus);
  absolutePath.fixtures[0].id = "/Users/example/private.txt";
  assert.throws(
    () => validateFixtureCorpus(absolutePath),
    (error) => error?.code === "FORBIDDEN_OPPORTUNITY_EVAL_CONTENT",
  );
});

test("fixture validation rejects unknown or non-executable family members", async () => {
  const corpus = await fixtureCorpus();
  const unknown = clone(corpus);
  unknown.fixtures[0].eligibleRepresentations[0] = { family: "imaginary", member: "wishful" };
  assert.throws(
    () => validateFixtureCorpus(unknown),
    (error) => error?.code === "UNKNOWN_CATALOG_MEMBER",
  );

  const unavailable = clone(corpus);
  unavailable.fixtures[0].eligibleRepresentations[0] = {
    family: "annotated-specimen",
    member: "callout-overlay",
  };
  assert.throws(
    () => validateFixtureCorpus(unavailable),
    (error) => error?.code === "UNAVAILABLE_CATALOG_MEMBER",
  );
});

test("run summaries admit derived metadata only", async () => {
  const corpus = validateFixtureCorpus(await fixtureCorpus());
  const fixtureIds = new Set(corpus.fixtures.map((fixture) => fixture.id));
  const valid = validateRunSummary(run("ranked-comparison"), { fixtureIds });
  assert.equal(valid.finalAnswerMention, "none");

  assert.throws(
    () => validateRunSummary({ ...run("ranked-comparison"), toolArguments: ["--root", "/tmp/private"] }, { fixtureIds }),
    (error) => error?.code === "FORBIDDEN_OPPORTUNITY_EVAL_CONTENT",
  );
  assert.throws(
    () => validateRunSummary({ ...run("ranked-comparison"), reviewerNote: "unbounded text" }, { fixtureIds }),
    (error) => error?.code === "UNKNOWN_OPPORTUNITY_EVAL_FIELD",
  );
  assert.throws(
    () => validateRunSummary(run("missing-fixture"), { fixtureIds }),
    (error) => error?.code === "UNKNOWN_OPPORTUNITY_FIXTURE",
  );
  assert.throws(
    () => validateRunSummary(run("ranked-comparison", {
      tools: ["attend-checkpoint", "raw-shell-command"],
    }), { fixtureIds }),
    (error) => error?.code === "INVALID_OPPORTUNITY_EVAL_RUN",
  );
  assert.throws(
    () => validateRunSummary(run("ranked-comparison", {
      counters: { ...run("ranked-comparison").counters, checkpointCount: 1 },
      resultClasses: ["task-completed"],
    }), { fixtureIds }),
    (error) => error?.code === "INVALID_OPPORTUNITY_EVAL_RUN",
  );
});

test("evaluation reports known-label quality and keeps ambiguous runs separate", async () => {
  const corpus = validateFixtureCorpus(await fixtureCorpus());
  const runs = [
    run("ranked-comparison", {
      resultClasses: ["task-completed", "checkpoint-proceed", "exploration-created", "evidence-valid"],
      counters: {
        ...run("ranked-comparison").counters,
        explorationCount: 1,
        experimentCount: 1,
        promotedCount: 1,
        evidenceValidCount: 1,
      },
      timingsMs: { total: 500, checkpoint: 20, exploration: 400 },
      finalAnswerMention: "single-attend-result",
      explorationLinks: [{
        explorationId: "exploration_000000000000000000000001",
        experimentId: "experiment_000000000000000000000001",
      }],
    }),
    run("dated-change", { timingsMs: { total: 200, checkpoint: 10, exploration: 0 } }),
    run("short-conversation", { timingsMs: { total: 100, checkpoint: 5, exploration: 0 } }),
    run("single-value-answer", {
      resultClasses: ["task-completed", "checkpoint-proceed"],
      finalAnswerMention: "attend-without-result",
      timingsMs: { total: 400, checkpoint: 30, exploration: 0 },
    }),
    run("small-status-table", {
      resultClasses: ["task-completed", "checkpoint-proceed"],
      timingsMs: { total: 300, checkpoint: 15, exploration: 0 },
    }),
  ];

  const report = evaluateOpportunityRuns({ corpus, runs });
  assert.deepEqual(report.cohorts.positive, {
    runs: 2,
    checkpointCoverage: 1,
    proceedRate: 0.5,
    mentionRate: 0.5,
    silentAbstentionRate: 0.5,
    expectedMentionMatchRate: 0.5,
    acceptableAbstentionRate: 0,
  });
  assert.deepEqual(report.cohorts.negative, {
    runs: 2,
    checkpointCoverage: 1,
    proceedRate: 0.5,
    mentionRate: 0.5,
    silentAbstentionRate: 0.5,
    expectedMentionMatchRate: 0.5,
    acceptableAbstentionRate: 1,
  });
  assert.equal(report.cohorts.ambiguous.runs, 1);
  assert.equal(report.knownLabels.positiveRecognition, 0.5);
  assert.equal(report.knownLabels.negativeSilentAbstention, 0.5);
  assert.equal(report.knownLabels.proceedPrecision, 0.5);
  assert.equal(report.integrity.evidenceValidity, 1);
  assert.equal(report.integrity.mentionPolicyCompliance, 0.8);
  assert.deepEqual(report.timingsMs.total, { median: 300, p95: 500 });
});
