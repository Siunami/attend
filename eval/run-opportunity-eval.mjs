#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { requireExecutableCatalogMember } from "../src/catalog/index.js";

const FIXTURE_SCHEMA_VERSION = 1;
const RUN_SCHEMA_VERSION = 1;
const DEFAULT_FIXTURES_URL = new URL("./opportunity-fixtures.json", import.meta.url);

const CORPUS_KEYS = new Set(["schemaVersion", "kind", "fixtures"]);
const FIXTURE_KEYS = new Set([
  "id",
  "label",
  "requestedAction",
  "sourceShape",
  "resultShape",
  "allowedSourceScope",
  "expectedAnalyticJobs",
  "eligibleRepresentations",
  "visualShouldBeMentioned",
  "acceptableAbstentionReasons",
]);
const SOURCE_SHAPE_KEYS = new Set([
  "kind",
  "sourceCount",
  "recordCount",
  "numericFieldCount",
  "dateFieldCount",
  "relationshipCount",
  "locationCount",
  "omissionCount",
]);
const RESULT_SHAPE_KEYS = new Set([
  "kind",
  "resultCount",
  "comparisonCount",
  "complete",
  "evidenceState",
]);
const SOURCE_SCOPE_KEYS = new Set(["kind", "authorization", "maxSources"]);
const REPRESENTATION_KEYS = new Set(["family", "member"]);
const RUN_KEYS = new Set([
  "schemaVersion",
  "kind",
  "fixtureId",
  "tools",
  "resultClasses",
  "counters",
  "timingsMs",
  "finalAnswerMention",
  "explorationLinks",
]);
const RUN_CORPUS_KEYS = new Set(["schemaVersion", "kind", "runs"]);
const COUNTER_KEYS = new Set([
  "sourceCount",
  "resultCount",
  "checkpointCount",
  "explorationCount",
  "experimentCount",
  "promotedCount",
  "evidenceValidCount",
  "evidenceInvalidCount",
]);
const TIMING_KEYS = new Set(["total", "checkpoint", "exploration"]);
const EXPLORATION_LINK_KEYS = new Set(["explorationId", "experimentId"]);

const LABELS = new Set(["positive", "negative", "ambiguous"]);
const REQUESTED_ACTIONS = new Set([
  "compare-records",
  "review-history",
  "analyze-relationship",
  "inspect-network",
  "answer-conversation",
  "report-single-value",
  "debug-failure",
  "summarize-private-corpus",
  "summarize-status",
  "review-variability",
  "explain-process",
  "locate-records",
]);
const SOURCE_KINDS = new Set([
  "none",
  "tabular-records",
  "dated-events",
  "paired-measures",
  "explicit-edges",
  "single-value",
  "partial-debug-state",
  "private-unscoped",
  "ordered-stages",
  "located-records",
]);
const RESULT_KINDS = new Set([
  "none",
  "ordered-values",
  "dated-intervals",
  "paired-observations",
  "explicit-links",
  "single-scalar",
  "incomplete-diagnostic",
  "status-rows",
  "sampled-values",
  "ordered-steps",
  "parent-child-records",
]);
const EVIDENCE_STATES = new Set(["none", "bounded", "partial", "unavailable"]);
const SOURCE_SCOPE_KINDS = new Set(["none", "project-files", "command-results", "private-source"]);
const AUTHORIZATION_STATES = new Set(["not-required", "authorized", "missing"]);
const ANALYTIC_JOBS = new Set([
  "comparison",
  "distribution",
  "change",
  "relationship",
  "hierarchy",
  "network",
  "location",
  "sequence",
]);
const ABSTENTION_REASONS = new Set([
  "evidence-not-bounded",
  "no-bounded-evidence",
  "no-analytic-job",
  "no-executable-family",
  "source-not-authorized",
  "task-incomplete",
  "text-suffices",
  "too-few-records",
  "weak-hypothesis",
  "interruption-cost",
]);
const TOOL_NAMES = new Set([
  "attend-doctor",
  "attend-checkpoint",
  "attend-inspect",
  "attend-explore",
  "attend-map",
  "attend-assess",
  "attend-promote",
  "attend-feedback",
  "attend-workspace",
  "attend-view",
  "source-read",
  "command-run",
  "subagent",
]);
const RESULT_CLASSES = new Set([
  "task-completed",
  "task-failed",
  "checkpoint-abstain",
  "checkpoint-proceed",
  "exploration-created",
  "experiment-completed",
  "experiment-failed",
  "assessment-interesting",
  "assessment-not-interesting",
  "assessment-null",
  "assessment-inconclusive",
  "assessment-invalid",
  "promotion-created",
  "evidence-valid",
  "evidence-invalid",
  ...[...ABSTENTION_REASONS].map((reason) => `abstention-${reason}`),
]);
const FINAL_ANSWER_MENTIONS = new Set([
  "none",
  "single-attend-result",
  "multiple-attend-results",
  "attend-without-result",
]);
const FORBIDDEN_FIELD_NAMES = new Set([
  "argument",
  "arguments",
  "content",
  "credential",
  "credentials",
  "excerpt",
  "excerpts",
  "hostticket",
  "message",
  "messages",
  "output",
  "outputs",
  "password",
  "prompt",
  "quote",
  "quotes",
  "rawtoolarguments",
  "rawtooloutputs",
  "secret",
  "sourcebody",
  "sourcetext",
  "ticket",
  "toolarguments",
  "tooloutputs",
  "transcript",
  "transcripts",
]);
const ABSOLUTE_PATH = /^(?:\/|~[\\/]|[A-Za-z]:[\\/])/u;
const CREDENTIAL_TEXT = /(?:api[_-]?key|authorization|bearer|credential|host[_-]?ticket|password|secret)\s*(?:[:=]|\s)\s*\S+/iu;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const EXPLORATION_ID = /^exploration_[a-f0-9]{24}$/u;
const EXPERIMENT_ID = /^experiment_[a-f0-9]{24}$/u;

function fail(code, message, path) {
  const error = new Error(`${path}: ${message}`);
  error.code = code;
  error.path = path;
  throw error;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectForbiddenContent(value, path = "value") {
  if (typeof value === "string") {
    if (ABSOLUTE_PATH.test(value) || CREDENTIAL_TEXT.test(value)) {
      fail("FORBIDDEN_OPPORTUNITY_EVAL_CONTENT", "contains content that evaluation records cannot retain", path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenContent(item, `${path}[${index}]`));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[-_]/gu, "");
    if (FORBIDDEN_FIELD_NAMES.has(normalizedKey)) {
      fail("FORBIDDEN_OPPORTUNITY_EVAL_CONTENT", `field ${key} can retain raw content`, `${path}.${key}`);
    }
    rejectForbiddenContent(item, `${path}.${key}`);
  }
}

function object(value, path) {
  if (!plainObject(value)) fail("INVALID_OPPORTUNITY_EVAL", "must be an object", path);
  return value;
}

function rejectUnknown(value, allowed, path) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail("UNKNOWN_OPPORTUNITY_EVAL_FIELD", `unknown field ${unknown}`, `${path}.${unknown}`);
}

function enumValue(value, allowed, path, code = "INVALID_OPPORTUNITY_EVAL") {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(code, `must be one of ${[...allowed].join(", ")}`, path);
  }
  return value;
}

function integer(value, path, maximum = 100_000, code = "INVALID_OPPORTUNITY_EVAL") {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(code, `must be an integer between 0 and ${maximum}`, path);
  }
  return value;
}

function boolean(value, path, code = "INVALID_OPPORTUNITY_EVAL") {
  if (typeof value !== "boolean") fail(code, "must be a boolean", path);
  return value;
}

function uniqueEnumArray(value, allowed, path, { maximum = 16, code = "INVALID_OPPORTUNITY_EVAL" } = {}) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail(code, `must be an array with at most ${maximum} entries`, path);
  }
  const normalized = value.map((item, index) => enumValue(item, allowed, `${path}[${index}]`, code));
  if (new Set(normalized).size !== normalized.length) fail(code, "must not contain duplicates", path);
  return normalized;
}

function validateSourceShape(value, path) {
  object(value, path);
  rejectUnknown(value, SOURCE_SHAPE_KEYS, path);
  return {
    kind: enumValue(value.kind, SOURCE_KINDS, `${path}.kind`),
    sourceCount: integer(value.sourceCount, `${path}.sourceCount`, 64),
    recordCount: integer(value.recordCount, `${path}.recordCount`),
    numericFieldCount: integer(value.numericFieldCount, `${path}.numericFieldCount`, 128),
    dateFieldCount: integer(value.dateFieldCount, `${path}.dateFieldCount`, 128),
    relationshipCount: integer(value.relationshipCount, `${path}.relationshipCount`),
    locationCount: integer(value.locationCount, `${path}.locationCount`),
    omissionCount: integer(value.omissionCount, `${path}.omissionCount`),
  };
}

function validateResultShape(value, path) {
  object(value, path);
  rejectUnknown(value, RESULT_SHAPE_KEYS, path);
  return {
    kind: enumValue(value.kind, RESULT_KINDS, `${path}.kind`),
    resultCount: integer(value.resultCount, `${path}.resultCount`),
    comparisonCount: integer(value.comparisonCount, `${path}.comparisonCount`, 1_000_000),
    complete: boolean(value.complete, `${path}.complete`),
    evidenceState: enumValue(value.evidenceState, EVIDENCE_STATES, `${path}.evidenceState`),
  };
}

function validateSourceScope(value, path) {
  object(value, path);
  rejectUnknown(value, SOURCE_SCOPE_KEYS, path);
  return {
    kind: enumValue(value.kind, SOURCE_SCOPE_KINDS, `${path}.kind`),
    authorization: enumValue(value.authorization, AUTHORIZATION_STATES, `${path}.authorization`),
    maxSources: integer(value.maxSources, `${path}.maxSources`, 64),
  };
}

function validateRepresentation(value, path) {
  object(value, path);
  rejectUnknown(value, REPRESENTATION_KEYS, path);
  if (typeof value.family !== "string" || !ID.test(value.family)) {
    fail("INVALID_OPPORTUNITY_EVAL", "must be a catalog family id", `${path}.family`);
  }
  if (typeof value.member !== "string" || !ID.test(value.member)) {
    fail("INVALID_OPPORTUNITY_EVAL", "must be a catalog member id", `${path}.member`);
  }
  requireExecutableCatalogMember(value.family, value.member);
  return { family: value.family, member: value.member };
}

function validateFixture(value, path) {
  object(value, path);
  rejectUnknown(value, FIXTURE_KEYS, path);
  if (typeof value.id !== "string" || !ID.test(value.id) || value.id.length > 80) {
    fail("INVALID_OPPORTUNITY_EVAL", "must be a bounded kebab-case id", `${path}.id`);
  }
  const label = enumValue(value.label, LABELS, `${path}.label`);
  const sourceShape = validateSourceShape(value.sourceShape, `${path}.sourceShape`);
  const resultShape = validateResultShape(value.resultShape, `${path}.resultShape`);
  const allowedSourceScope = validateSourceScope(value.allowedSourceScope, `${path}.allowedSourceScope`);
  const expectedAnalyticJobs = uniqueEnumArray(
    value.expectedAnalyticJobs,
    ANALYTIC_JOBS,
    `${path}.expectedAnalyticJobs`,
    { maximum: 8 },
  );
  if (!Array.isArray(value.eligibleRepresentations) || value.eligibleRepresentations.length > 8) {
    fail("INVALID_OPPORTUNITY_EVAL", "must be an array with at most 8 entries", `${path}.eligibleRepresentations`);
  }
  const eligibleRepresentations = value.eligibleRepresentations.map((representation, index) =>
    validateRepresentation(representation, `${path}.eligibleRepresentations[${index}]`),
  );
  const representationKeys = eligibleRepresentations.map(({ family, member }) => `${family}/${member}`);
  if (new Set(representationKeys).size !== representationKeys.length) {
    fail("INVALID_OPPORTUNITY_EVAL", "must not contain duplicate family/member pairs", `${path}.eligibleRepresentations`);
  }
  const visualShouldBeMentioned = boolean(value.visualShouldBeMentioned, `${path}.visualShouldBeMentioned`);
  const acceptableAbstentionReasons = uniqueEnumArray(
    value.acceptableAbstentionReasons,
    ABSTENTION_REASONS,
    `${path}.acceptableAbstentionReasons`,
    { maximum: 10 },
  );
  if (acceptableAbstentionReasons.length === 0) {
    fail("INVALID_OPPORTUNITY_EVAL", "must name at least one bounded reason", `${path}.acceptableAbstentionReasons`);
  }
  if (visualShouldBeMentioned && (expectedAnalyticJobs.length === 0 || eligibleRepresentations.length === 0)) {
    fail(
      "INVALID_OPPORTUNITY_EVAL",
      "a mention expectation requires an analytic job and executable representation",
      path,
    );
  }
  if (label === "positive" && !visualShouldBeMentioned) {
    fail("INVALID_OPPORTUNITY_EVAL", "positive fixtures must expect a useful mention", `${path}.visualShouldBeMentioned`);
  }
  if (label === "negative" && visualShouldBeMentioned) {
    fail("INVALID_OPPORTUNITY_EVAL", "negative fixtures must expect silence", `${path}.visualShouldBeMentioned`);
  }
  if (allowedSourceScope.authorization === "authorized" && sourceShape.sourceCount > allowedSourceScope.maxSources) {
    fail("INVALID_OPPORTUNITY_EVAL", "sourceCount exceeds the allowed source scope", `${path}.sourceShape.sourceCount`);
  }
  return {
    id: value.id,
    label,
    requestedAction: enumValue(value.requestedAction, REQUESTED_ACTIONS, `${path}.requestedAction`),
    sourceShape,
    resultShape,
    allowedSourceScope,
    expectedAnalyticJobs,
    eligibleRepresentations,
    visualShouldBeMentioned,
    acceptableAbstentionReasons,
  };
}

export function validateFixtureCorpus(value) {
  rejectForbiddenContent(value, "corpus");
  object(value, "corpus");
  rejectUnknown(value, CORPUS_KEYS, "corpus");
  if (value.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    fail("INVALID_OPPORTUNITY_EVAL", `schemaVersion must be ${FIXTURE_SCHEMA_VERSION}`, "corpus.schemaVersion");
  }
  if (value.kind !== "attend-opportunity-fixture-corpus") {
    fail("INVALID_OPPORTUNITY_EVAL", "has an unsupported kind", "corpus.kind");
  }
  if (!Array.isArray(value.fixtures) || value.fixtures.length === 0 || value.fixtures.length > 100) {
    fail("INVALID_OPPORTUNITY_EVAL", "fixtures must contain between 1 and 100 records", "corpus.fixtures");
  }
  const fixtures = value.fixtures.map((fixture, index) => validateFixture(fixture, `corpus.fixtures[${index}]`));
  const ids = fixtures.map((fixture) => fixture.id);
  if (new Set(ids).size !== ids.length) fail("INVALID_OPPORTUNITY_EVAL", "fixture ids must be unique", "corpus.fixtures");
  for (const label of LABELS) {
    if (!fixtures.some((fixture) => fixture.label === label)) {
      fail("INVALID_OPPORTUNITY_EVAL", `must include a ${label} cohort`, "corpus.fixtures");
    }
  }
  return { schemaVersion: FIXTURE_SCHEMA_VERSION, kind: value.kind, fixtures };
}

function validateCounters(value, path) {
  object(value, path);
  rejectUnknown(value, COUNTER_KEYS, path);
  const normalized = Object.fromEntries([...COUNTER_KEYS].map((key) => [
    key,
    integer(value[key], `${path}.${key}`, key === "checkpointCount" ? 1 : 100_000, "INVALID_OPPORTUNITY_EVAL_RUN"),
  ]));
  if (normalized.promotedCount > normalized.experimentCount) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "promotedCount cannot exceed experimentCount", `${path}.promotedCount`);
  }
  return normalized;
}

function validateTimings(value, path) {
  object(value, path);
  rejectUnknown(value, TIMING_KEYS, path);
  const normalized = Object.fromEntries([...TIMING_KEYS].map((key) => [
    key,
    integer(value[key], `${path}.${key}`, 86_400_000, "INVALID_OPPORTUNITY_EVAL_RUN"),
  ]));
  if (normalized.checkpoint + normalized.exploration > normalized.total) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "component timings cannot exceed total", path);
  }
  return normalized;
}

function validateExplorationLinks(value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "must be an array with at most 32 entries", path);
  }
  const links = value.map((link, index) => {
    const itemPath = `${path}[${index}]`;
    object(link, itemPath);
    rejectUnknown(link, EXPLORATION_LINK_KEYS, itemPath);
    if (typeof link.explorationId !== "string" || !EXPLORATION_ID.test(link.explorationId)) {
      fail("INVALID_OPPORTUNITY_EVAL_RUN", "must be an exploration id", `${itemPath}.explorationId`);
    }
    if (typeof link.experimentId !== "string" || !EXPERIMENT_ID.test(link.experimentId)) {
      fail("INVALID_OPPORTUNITY_EVAL_RUN", "must be an experiment id", `${itemPath}.experimentId`);
    }
    return { explorationId: link.explorationId, experimentId: link.experimentId };
  });
  const keys = links.map(({ explorationId, experimentId }) => `${explorationId}/${experimentId}`);
  if (new Set(keys).size !== keys.length) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "must not contain duplicate links", path);
  }
  return links;
}

export function validateRunSummary(value, { fixtureIds } = {}) {
  rejectForbiddenContent(value, "run");
  object(value, "run");
  rejectUnknown(value, RUN_KEYS, "run");
  if (value.schemaVersion !== RUN_SCHEMA_VERSION) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", `schemaVersion must be ${RUN_SCHEMA_VERSION}`, "run.schemaVersion");
  }
  if (value.kind !== "attend-opportunity-eval-run") {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "has an unsupported kind", "run.kind");
  }
  if (typeof value.fixtureId !== "string" || !ID.test(value.fixtureId) || value.fixtureId.length > 80) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "must be a bounded fixture id", "run.fixtureId");
  }
  if (fixtureIds && !fixtureIds.has(value.fixtureId)) {
    fail("UNKNOWN_OPPORTUNITY_FIXTURE", "does not name a fixture in this corpus", "run.fixtureId");
  }
  const tools = uniqueEnumArray(value.tools, TOOL_NAMES, "run.tools", {
    maximum: 32,
    code: "INVALID_OPPORTUNITY_EVAL_RUN",
  });
  const resultClasses = uniqueEnumArray(value.resultClasses, RESULT_CLASSES, "run.resultClasses", {
    maximum: 20,
    code: "INVALID_OPPORTUNITY_EVAL_RUN",
  });
  if (resultClasses.length === 0) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "must contain at least one derived result class", "run.resultClasses");
  }
  const counters = validateCounters(value.counters, "run.counters");
  const timingsMs = validateTimings(value.timingsMs, "run.timingsMs");
  const finalAnswerMention = enumValue(
    value.finalAnswerMention,
    FINAL_ANSWER_MENTIONS,
    "run.finalAnswerMention",
    "INVALID_OPPORTUNITY_EVAL_RUN",
  );
  const explorationLinks = validateExplorationLinks(value.explorationLinks, "run.explorationLinks");
  const checkpointClasses = resultClasses.filter((item) => item.startsWith("checkpoint-"));
  if (checkpointClasses.length !== counters.checkpointCount) {
    fail(
      "INVALID_OPPORTUNITY_EVAL_RUN",
      "checkpointCount must equal the number of checkpoint result classes",
      "run.counters.checkpointCount",
    );
  }
  const abstentionClasses = resultClasses.filter((item) => item.startsWith("abstention-"));
  if (resultClasses.includes("checkpoint-abstain") && abstentionClasses.length !== 1) {
    fail(
      "INVALID_OPPORTUNITY_EVAL_RUN",
      "checkpoint-abstain requires exactly one bounded abstention reason class",
      "run.resultClasses",
    );
  }
  if (!resultClasses.includes("checkpoint-abstain") && abstentionClasses.length !== 0) {
    fail(
      "INVALID_OPPORTUNITY_EVAL_RUN",
      "abstention reason classes require checkpoint-abstain",
      "run.resultClasses",
    );
  }
  if (explorationLinks.length > counters.experimentCount) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "links cannot exceed experimentCount", "run.explorationLinks");
  }
  if ((counters.evidenceValidCount > 0) !== resultClasses.includes("evidence-valid")) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "evidence-valid must match its counter", "run.resultClasses");
  }
  if ((counters.evidenceInvalidCount > 0) !== resultClasses.includes("evidence-invalid")) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "evidence-invalid must match its counter", "run.resultClasses");
  }
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    kind: value.kind,
    fixtureId: value.fixtureId,
    tools,
    resultClasses,
    counters,
    timingsMs,
    finalAnswerMention,
    ...(explorationLinks.length ? { explorationLinks } : {}),
  };
}

export function validateRunCorpus(value, { fixtureIds } = {}) {
  rejectForbiddenContent(value, "runCorpus");
  object(value, "runCorpus");
  rejectUnknown(value, RUN_CORPUS_KEYS, "runCorpus");
  if (value.schemaVersion !== RUN_SCHEMA_VERSION) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", `schemaVersion must be ${RUN_SCHEMA_VERSION}`, "runCorpus.schemaVersion");
  }
  if (value.kind !== "attend-opportunity-eval-runs") {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "has an unsupported kind", "runCorpus.kind");
  }
  if (!Array.isArray(value.runs) || value.runs.length === 0 || value.runs.length > 10_000) {
    fail("INVALID_OPPORTUNITY_EVAL_RUN", "runs must contain between 1 and 10000 summaries", "runCorpus.runs");
  }
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    kind: value.kind,
    runs: value.runs.map((run, index) => {
      try {
        return validateRunSummary(run, { fixtureIds });
      } catch (error) {
        if (error?.path?.startsWith("run")) error.path = `runCorpus.runs[${index}]${error.path.slice(3)}`;
        throw error;
      }
    }),
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function isProceed(run) {
  return run.resultClasses.includes("checkpoint-proceed");
}

function isAbstain(run) {
  return run.resultClasses.includes("checkpoint-abstain");
}

function isMentioned(run) {
  return run.finalAnswerMention !== "none";
}

function abstentionReason(run) {
  const resultClass = run.resultClasses.find((item) => item.startsWith("abstention-"));
  return resultClass?.slice("abstention-".length) ?? null;
}

function cohortMetrics(entries) {
  const expectedMentionMatches = entries.filter(({ fixture, run }) =>
    fixture.visualShouldBeMentioned
      ? run.finalAnswerMention === "single-attend-result"
      : run.finalAnswerMention === "none",
  ).length;
  return {
    runs: entries.length,
    checkpointCoverage: ratio(entries.filter(({ run }) => run.counters.checkpointCount === 1).length, entries.length),
    proceedRate: ratio(entries.filter(({ run }) => isProceed(run)).length, entries.length),
    mentionRate: ratio(entries.filter(({ run }) => isMentioned(run)).length, entries.length),
    silentAbstentionRate: ratio(
      entries.filter(({ run }) => isAbstain(run) && run.finalAnswerMention === "none").length,
      entries.length,
    ),
    expectedMentionMatchRate: ratio(expectedMentionMatches, entries.length),
    acceptableAbstentionRate: ratio(
      entries.filter(({ run, fixture }) => {
        const reason = abstentionReason(run);
        return reason && fixture.acceptableAbstentionReasons.includes(reason);
      }).length,
      entries.filter(({ run }) => isAbstain(run)).length,
    ),
  };
}

function percentile(values, percentage) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  if (percentage === 0.5 && sorted.length % 2 === 0) {
    return (sorted[(sorted.length / 2) - 1] + sorted[sorted.length / 2]) / 2;
  }
  return sorted[Math.max(0, Math.ceil(percentage * sorted.length) - 1)];
}

function timingMetrics(entries, key) {
  const values = entries.map(({ run }) => run.timingsMs[key]);
  return { median: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

export function evaluateOpportunityRuns({ corpus, runs }) {
  const validatedCorpus = validateFixtureCorpus(corpus);
  const fixtureById = new Map(validatedCorpus.fixtures.map((fixture) => [fixture.id, fixture]));
  const fixtureIds = new Set(fixtureById.keys());
  const validatedRuns = runs.map((run) => validateRunSummary(run, { fixtureIds }));
  const entries = validatedRuns.map((run) => ({ run, fixture: fixtureById.get(run.fixtureId) }));
  const cohorts = Object.fromEntries([...LABELS].map((label) => [
    label,
    cohortMetrics(entries.filter(({ fixture }) => fixture.label === label)),
  ]));
  const positives = entries.filter(({ fixture }) => fixture.label === "positive");
  const negatives = entries.filter(({ fixture }) => fixture.label === "negative");
  const positiveProceeds = positives.filter(({ run }) => isProceed(run)).length;
  const negativeProceeds = negatives.filter(({ run }) => isProceed(run)).length;
  const evidenceValid = entries.reduce((sum, { run }) => sum + run.counters.evidenceValidCount, 0);
  const evidenceInvalid = entries.reduce((sum, { run }) => sum + run.counters.evidenceInvalidCount, 0);
  const linkedExperiments = entries.reduce((sum, { run }) => sum + (run.explorationLinks?.length ?? 0), 0);
  const experiments = entries.reduce((sum, { run }) => sum + run.counters.experimentCount, 0);

  return {
    schemaVersion: 1,
    kind: "attend-opportunity-eval-report",
    fixtureCorpus: {
      total: validatedCorpus.fixtures.length,
      positive: validatedCorpus.fixtures.filter((fixture) => fixture.label === "positive").length,
      negative: validatedCorpus.fixtures.filter((fixture) => fixture.label === "negative").length,
      ambiguous: validatedCorpus.fixtures.filter((fixture) => fixture.label === "ambiguous").length,
    },
    runs: {
      total: entries.length,
      uniqueFixtures: new Set(entries.map(({ fixture }) => fixture.id)).size,
    },
    cohorts,
    knownLabels: {
      positiveRecognition: ratio(positiveProceeds, positives.length),
      negativeSilentAbstention: ratio(
        negatives.filter(({ run }) => isAbstain(run) && run.finalAnswerMention === "none").length,
        negatives.length,
      ),
      proceedPrecision: ratio(positiveProceeds, positiveProceeds + negativeProceeds),
    },
    integrity: {
      evidenceValidity: ratio(evidenceValid, evidenceValid + evidenceInvalid),
      mentionPolicyCompliance: ratio(
        entries.filter(({ run }) => ["none", "single-attend-result"].includes(run.finalAnswerMention)).length,
        entries.length,
      ),
      explorationLinkCoverage: ratio(linkedExperiments, experiments),
    },
    timingsMs: {
      total: timingMetrics(entries, "total"),
      checkpoint: timingMetrics(entries, "checkpoint"),
      exploration: timingMetrics(entries, "exploration"),
    },
  };
}

async function readJson(pathOrUrl, label) {
  let raw;
  try {
    raw = await readFile(pathOrUrl, "utf8");
  } catch (cause) {
    const error = new Error(`Cannot read ${label}: ${cause.message}`, { cause });
    error.code = "OPPORTUNITY_EVAL_READ_FAILED";
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`${label} is not valid JSON: ${cause.message}`, { cause });
    error.code = "OPPORTUNITY_EVAL_JSON_INVALID";
    throw error;
  }
}

async function main(argv) {
  let fixturePath = DEFAULT_FIXTURES_URL;
  let runPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--fixtures") {
      const value = argv[index + 1];
      if (!value) throw new Error("--fixtures requires a path");
      fixturePath = resolve(value);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node eval/run-opportunity-eval.mjs <run-summaries.json> [--fixtures <fixtures.json>]\n");
      return;
    } else if (!runPath) {
      runPath = resolve(argument);
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  if (!runPath) throw new Error("A derived run-summary file is required. Use --help for usage.");
  const corpus = validateFixtureCorpus(await readJson(fixturePath, "fixture corpus"));
  const fixtureIds = new Set(corpus.fixtures.map((fixture) => fixture.id));
  const runCorpus = validateRunCorpus(await readJson(runPath, "run summaries"), { fixtureIds });
  process.stdout.write(`${JSON.stringify(evaluateOpportunityRuns({ corpus, runs: runCorpus.runs }), null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
