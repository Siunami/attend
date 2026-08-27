import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, lstat, open, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";

import {
  assertSafeWritePath,
  ensureSafeDirectory,
  projectPaths,
  readJson,
} from "./project.js";
import { getCatalogMember } from "./catalog/index.js";
import { loadOpportunityCheck } from "./opportunity-store.js";
import {
  assertRepresentationIntentSupported,
  normalizeRepresentationIntent,
} from "./representation-intent.js";
import { loadSession } from "./session-store.js";

export const EXPLORATION_SCHEMA_VERSION = 1;
export const EXPERIMENT_OUTCOMES = Object.freeze([
  "interesting",
  "not-interesting",
  "null",
  "inconclusive",
  "invalid",
]);
export const FEEDBACK_KINDS = Object.freeze([
  "useful",
  "already-known",
  "wrong-question",
  "wrong-data",
  "wrong-representation",
  "weak-evidence",
  "misleading",
  "badly-timed",
]);
export const HUMAN_DISPOSITIONS = Object.freeze([
  "unreviewed",
  "starred",
  "dismissed",
  "acted-upon",
]);
export const EXPERIMENT_EVENT_KINDS = Object.freeze([
  "execution-started",
  "execution-completed",
  "execution-failed",
  "assessment-recorded",
  "agent-promoted",
  "human-star-changed",
  "feedback-recorded",
  "human-disposition-recorded",
]);

const EXPLORATION_ID = /^exploration_[a-f0-9]{24}$/u;
const EXPERIMENT_ID = /^experiment_[a-f0-9]{24}$/u;
const CHECKPOINT_ID = /^checkpoint_[a-f0-9]{24}$/u;
const EVENT_ID = /^event_[A-Za-z0-9._-]{8,160}$/u;
const SAFE_MEMBER_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 120, 160, 200, 250];
const MALFORMED_LOCK_STALE_MS = 2_000;
const PLAN_KEYS = new Set([
  "goal",
  "analyticIntent",
  "sourceScope",
  "inspectionHash",
  "checkpointId",
  "limits",
]);
const EXPERIMENT_KEYS = new Set([
  "key",
  "hypothesis",
  "whyUseful",
  "representation",
  "sourceScope",
  "baseline",
  "comparisonCount",
  "origin",
  "analysisMode",
  "timing",
  "parentExperimentId",
]);
const EXPERIMENT_RECORD_KEYS = new Set([
  "schemaVersion",
  "kind",
  "id",
  "explorationId",
  "admittedAt",
  ...EXPERIMENT_KEYS,
]);
const EVENT_RECORD_KEYS = new Set([
  "schemaVersion",
  "kind",
  "id",
  "explorationId",
  "experimentId",
  "actor",
  "at",
  "payload",
]);

function fail(code, message, path) {
  const error = new Error(path ? `${path}: ${message}` : message);
  error.code = code;
  if (path) error.path = path;
  throw error;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, path) {
  if (!plainObject(value)) fail("INVALID_EXPLORATION_RECORD", "must be an object", path);
  return value;
}

function rejectUnknown(value, allowed, path) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    fail("INVALID_EXPLORATION_RECORD", `unknown field ${unexpected[0]}`, `${path}.${unexpected[0]}`);
  }
}

function string(value, path, maximum = 8_000) {
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_EXPLORATION_RECORD", "must be a non-empty string", path);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    fail("INVALID_EXPLORATION_RECORD", `must contain at most ${maximum} characters`, path);
  }
  return normalized;
}

function optionalString(value, path, maximum = 8_000) {
  return value === undefined ? undefined : string(value, path, maximum);
}

function oneOf(value, choices, path) {
  if (!choices.includes(value)) {
    fail("INVALID_EXPLORATION_RECORD", `must be one of ${choices.join(", ")}`, path);
  }
  return value;
}

function isoTimestamp(value, path) {
  const normalized = string(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(normalized)) {
    fail("INVALID_EXPLORATION_RECORD", "must be an ISO 8601 UTC timestamp", path);
  }
  return normalized;
}

function normalizeSourceScope(value, path) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    fail("INVALID_EXPLORATION_RECORD", "must be a non-empty array", path);
  }
  return value.map((source, index) => {
    const sourcePath = `${path}[${index}]`;
    object(source, sourcePath);
    rejectUnknown(source, new Set(["path", "textProjection"]), sourcePath);
    const rawPath = string(source.path, `${sourcePath}.path`, 2_048);
    const forward = rawPath.replaceAll("\\", "/");
    if (
      rawPath.includes("\0")
      || rawPath.startsWith("~")
      || win32.isAbsolute(rawPath)
      || forward.startsWith("/")
      || forward.split("/").includes("..")
    ) {
      fail(
        "INVALID_EXPLORATION_RECORD",
        "must be a relative project path without parent traversal",
        `${sourcePath}.path`,
      );
    }
    const record = { path: posix.normalize(forward) };
    if (source.textProjection !== undefined) {
      record.textProjection = oneOf(
        source.textProjection,
        ["utf8", "normalized-text"],
        `${sourcePath}.textProjection`,
      );
    }
    return record;
  });
}

function normalizeLimits(value, path) {
  if (value === undefined) return undefined;
  object(value, path);
  rejectUnknown(value, new Set(["maxExperiments", "maxComparisons"]), path);
  const normalized = {};
  for (const key of ["maxExperiments", "maxComparisons"]) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) {
      fail("INVALID_EXPLORATION_RECORD", "must be a positive integer", `${path}.${key}`);
    }
    normalized[key] = value[key];
  }
  return normalized;
}

function normalizeExplorationPlan(value) {
  object(value, "exploration");
  rejectUnknown(value, PLAN_KEYS, "exploration");
  const plan = {
    goal: string(value.goal, "exploration.goal", 4_000),
    analyticIntent: string(value.analyticIntent, "exploration.analyticIntent", 8_000),
    sourceScope: normalizeSourceScope(value.sourceScope, "exploration.sourceScope"),
  };
  const inspectionHash = optionalString(value.inspectionHash, "exploration.inspectionHash", 64);
  if (inspectionHash !== undefined && !/^[a-f0-9]{64}$/u.test(inspectionHash)) {
    fail("INVALID_EXPLORATION_RECORD", "must be a SHA-256 digest", "exploration.inspectionHash");
  }
  if (inspectionHash !== undefined) plan.inspectionHash = inspectionHash;
  if (value.checkpointId !== undefined) {
    if (typeof value.checkpointId !== "string" || !CHECKPOINT_ID.test(value.checkpointId)) {
      fail("INVALID_EXPLORATION_RECORD", "must be a checkpoint id", "exploration.checkpointId");
    }
    plan.checkpointId = value.checkpointId;
  }
  const limits = normalizeLimits(value.limits, "exploration.limits");
  if (limits !== undefined) plan.limits = limits;
  return plan;
}

export function validateExplorationPlan(value) {
  return normalizeExplorationPlan(value);
}

function explorationPlanFields(value) {
  return Object.fromEntries(
    [...PLAN_KEYS]
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
}

function normalizeRepresentation(value, path) {
  object(value, path);
  rejectUnknown(value, new Set(["family", "member", "representationIntent"]), path);
  const representation = {
    family: string(value.family, `${path}.family`, 128),
    member: string(value.member, `${path}.member`, 128),
    representationIntent: normalizeRepresentationIntent(value.representationIntent, {
      path: `${path}.representationIntent`,
    }),
  };
  if (!SAFE_MEMBER_ID.test(representation.family) || !SAFE_MEMBER_ID.test(representation.member)) {
    fail("INVALID_EXPLORATION_RECORD", "family and member must use catalog identifiers", path);
  }
  if (representation.representationIntent.mode === "exact") {
    const catalogMember = getCatalogMember(representation.family, representation.member);
    if (catalogMember?.status !== "executable") {
      fail(
        "UNSUPPORTED_REQUESTED_REPRESENTATION",
        `${representation.family}/${representation.member} is not executable in this release`,
        `${path}.member`,
      );
    }
    assertRepresentationIntentSupported(representation.representationIntent, {
      family: representation.family,
      member: catalogMember,
      path: `${path}.representationIntent`,
    });
  }
  return representation;
}

function normalizeBaseline(value, path) {
  object(value, path);
  rejectUnknown(value, new Set(["name", "description"]), path);
  return {
    name: string(value.name, `${path}.name`, 256),
    description: string(value.description, `${path}.description`, 4_000),
  };
}

function normalizeExperimentPlan(value) {
  object(value, "experiment");
  rejectUnknown(value, EXPERIMENT_KEYS, "experiment");
  const comparisonCount = value.comparisonCount ?? 1;
  if (!Number.isSafeInteger(comparisonCount) || comparisonCount < 1) {
    fail("INVALID_EXPLORATION_RECORD", "must be a positive integer", "experiment.comparisonCount");
  }
  const plan = {
    key: string(value.key, "experiment.key", 256),
    hypothesis: string(value.hypothesis, "experiment.hypothesis", 8_000),
    whyUseful: string(value.whyUseful, "experiment.whyUseful", 8_000),
    representation: normalizeRepresentation(value.representation, "experiment.representation"),
    sourceScope: normalizeSourceScope(value.sourceScope, "experiment.sourceScope"),
    baseline: normalizeBaseline(value.baseline, "experiment.baseline"),
    comparisonCount,
    origin: oneOf(value.origin, ["agent", "user"], "experiment.origin"),
    analysisMode: oneOf(
      value.analysisMode,
      ["exploratory", "confirmatory"],
      "experiment.analysisMode",
    ),
    timing: oneOf(value.timing, ["pre-result", "post-hoc"], "experiment.timing"),
  };
  if (value.parentExperimentId !== undefined) {
    if (typeof value.parentExperimentId !== "string" || !EXPERIMENT_ID.test(value.parentExperimentId)) {
      fail("INVALID_EXPLORATION_RECORD", "must be an experiment id", "experiment.parentExperimentId");
    }
    plan.parentExperimentId = value.parentExperimentId;
  }
  return plan;
}

export function validateExperimentPlan(value) {
  return normalizeExperimentPlan(value);
}

function generatedId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function explorationIdForCheckpoint(checkpointId) {
  if (typeof checkpointId !== "string" || !CHECKPOINT_ID.test(checkpointId)) {
    fail("INVALID_EXPLORATION_ID", "checkpoint id is invalid");
  }
  return `exploration_${checkpointId.slice("checkpoint_".length)}`;
}

function generatedEventId(at) {
  return `event_${at.replaceAll(/[:.]/gu, "-")}_${randomUUID()}`;
}

function assertId(value, expression, label) {
  if (typeof value !== "string" || !expression.test(value)) {
    fail("INVALID_EXPLORATION_ID", `${label} is invalid`);
  }
  return value;
}

export function explorationPaths(root, explorationId, experimentId) {
  const directory = join(projectPaths(root).local, "explorations");
  const explorationDirectory = explorationId ? join(directory, explorationId) : null;
  const experimentsDirectory = explorationDirectory
    ? join(explorationDirectory, "experiments")
    : null;
  const experimentDirectory = experimentId && experimentsDirectory
    ? join(experimentsDirectory, experimentId)
    : null;
  return Object.freeze({
    directory,
    explorationDirectory,
    exploration: explorationDirectory ? join(explorationDirectory, "exploration.json") : null,
    experimentsDirectory,
    experimentDirectory,
    experiment: experimentDirectory ? join(experimentDirectory, "experiment.json") : null,
    eventsDirectory: experimentDirectory ? join(experimentDirectory, "events") : null,
  });
}

async function writeJsonCreate(root, path, value, existsCode) {
  await assertSafeWritePath(root, path);
  await ensureSafeDirectory(root, dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await assertSafeWritePath(root, path);
    await link(temporary, path);
  } catch (error) {
    if (error?.code === "EEXIST") fail(existsCode, `record already exists: ${path}`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

async function reclaimStaleLock(lockPath) {
  let info;
  let metadata;
  try {
    info = await lstat(lockPath);
    if (info.isSymbolicLink() || !info.isFile()) return false;
    metadata = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    metadata = null;
  }
  const alive = processIsAlive(metadata?.pid);
  if (
    alive !== false
    && !(alive === null && Date.now() - info.mtimeMs >= MALFORMED_LOCK_STALE_MS)
  ) {
    return false;
  }
  const current = await lstat(lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current) return true;
  if (current.dev !== info.dev || current.ino !== info.ino) return false;
  await unlink(lockPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

async function acquireLock(root, lockPath, busyCode, busyMessage) {
  await assertSafeWritePath(root, lockPath);
  await ensureSafeDirectory(root, dirname(lockPath));
  const owner = randomUUID();
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          pid: process.pid,
          owner,
          createdAt: new Date().toISOString(),
        })}\n`);
        await handle.sync();
        const info = await handle.stat();
        return { handle, path: lockPath, dev: info.dev, ino: info.ino };
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimStaleLock(lockPath)) continue;
      if (attempt < LOCK_RETRY_DELAYS_MS.length) {
        await delay(LOCK_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      fail(busyCode, busyMessage);
    }
  }
  throw new Error("unreachable exploration lock state");
}

async function releaseLock(lock) {
  if (!lock) return;
  await lock.handle.close().catch(() => {});
  const current = await lstat(lock.path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current || current.dev !== lock.dev || current.ino !== lock.ino) return;
  await unlink(lock.path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

export async function withExperimentExecutionLock({ root, experimentId, operation }) {
  if (typeof operation !== "function") {
    throw new TypeError("experiment execution operation must be a function");
  }
  const experiment = await loadExperiment({ root, experimentId });
  const lockPath = join(
    explorationPaths(root, experiment.explorationId, experimentId).experimentDirectory,
    ".execution.lock",
  );
  let lock;
  try {
    lock = await acquireLock(
      root,
      lockPath,
      "EXPERIMENT_EXECUTION_BUSY",
      `experiment is already executing: ${experimentId}`,
    );
    return await operation(experiment);
  } finally {
    await releaseLock(lock);
  }
}

function missing(error, code, message) {
  if (error?.code !== "ENOENT") throw error;
  fail(code, message);
}

export async function createExploration({ root, plan, id, now = () => new Date() }) {
  const normalizedPlan = normalizeExplorationPlan(plan);
  const linkedExplorationId = normalizedPlan.checkpointId === undefined
    ? null
    : explorationIdForCheckpoint(normalizedPlan.checkpointId);
  if (normalizedPlan.checkpointId !== undefined) {
    const checkpoint = await loadOpportunityCheck({
      root,
      checkpointId: normalizedPlan.checkpointId,
    });
    if (checkpoint.decision.kind !== "proceed") {
      fail(
        "CHECKPOINT_NOT_PROCEEDING",
        `checkpoint did not authorize an exploration: ${normalizedPlan.checkpointId}`,
      );
    }
  }
  const explorationId = id === undefined
    ? linkedExplorationId ?? generatedId("exploration")
    : assertId(id, EXPLORATION_ID, "exploration id");
  if (linkedExplorationId !== null && explorationId !== linkedExplorationId) {
    fail(
      "CHECKPOINT_LINK_CONFLICT",
      `checkpoint ${normalizedPlan.checkpointId} is reserved for ${linkedExplorationId}`,
    );
  }
  const createdAt = isoTimestamp(now().toISOString(), "createdAt");
  const record = {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    kind: "attend-exploration",
    id: explorationId,
    createdAt,
    ...normalizedPlan,
  };
  try {
    await writeJsonCreate(
      root,
      explorationPaths(root, explorationId).exploration,
      record,
      "EXPLORATION_EXISTS",
    );
  } catch (error) {
    if (error?.code !== "EXPLORATION_EXISTS" || linkedExplorationId === null) throw error;
    const existing = await loadExploration({ root, explorationId });
    const existingPlan = normalizeExplorationPlan(explorationPlanFields(existing));
    if (JSON.stringify(existingPlan) !== JSON.stringify(normalizedPlan)) {
      fail(
        "CHECKPOINT_LINK_CONFLICT",
        `checkpoint already links to a different exploration plan: ${normalizedPlan.checkpointId}`,
      );
    }
    return existing;
  }
  return record;
}

export async function loadExploration({ root, explorationId }) {
  assertId(explorationId, EXPLORATION_ID, "exploration id");
  const value = await readJson(explorationPaths(root, explorationId).exploration)
    .catch((error) => missing(error, "EXPLORATION_NOT_FOUND", `exploration not found: ${explorationId}`));
  if (!plainObject(value)) {
    fail("INVALID_EXPLORATION_RECORD", `stored exploration is invalid: ${explorationId}`);
  }
  rejectUnknown(
    value,
    new Set(["schemaVersion", "kind", "id", "createdAt", ...PLAN_KEYS]),
    "stored exploration",
  );
  if (
    value.schemaVersion !== EXPLORATION_SCHEMA_VERSION
    || value.kind !== "attend-exploration"
    || value.id !== explorationId
  ) {
    fail("INVALID_EXPLORATION_RECORD", `stored exploration is invalid: ${explorationId}`);
  }
  return {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    kind: "attend-exploration",
    id: explorationId,
    createdAt: isoTimestamp(value.createdAt, "stored exploration.createdAt"),
    ...normalizeExplorationPlan(explorationPlanFields(value)),
  };
}

async function idsIn(directory, expression) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && expression.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function listExplorations({ root }) {
  const ids = await idsIn(explorationPaths(root).directory, EXPLORATION_ID);
  const records = [];
  for (const explorationId of ids) records.push(await loadExploration({ root, explorationId }));
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

export async function createExperiment({
  root,
  explorationId,
  plan,
  id,
  now = () => new Date(),
}) {
  const exploration = await loadExploration({ root, explorationId });
  const experimentId = id === undefined
    ? generatedId("experiment")
    : assertId(id, EXPERIMENT_ID, "experiment id");
  const normalized = normalizeExperimentPlan(plan);
  assertExperimentSourcesAuthorized(exploration, normalized);
  if (normalized.parentExperimentId !== undefined) {
    const parent = await loadExperiment({ root, experimentId: normalized.parentExperimentId });
    if (parent.explorationId !== explorationId) {
      fail("INVALID_EXPERIMENT_PARENT", "parent experiment belongs to another exploration");
    }
  }
  const record = {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    kind: "attend-experiment",
    id: experimentId,
    explorationId,
    admittedAt: isoTimestamp(now().toISOString(), "admittedAt"),
    ...normalized,
  };
  const lockPath = join(
    explorationPaths(root, explorationId).explorationDirectory,
    ".admission.lock",
  );
  let lock;
  try {
    lock = await acquireLock(
      root,
      lockPath,
      "EXPLORATION_BUSY",
      `exploration is admitting another experiment: ${explorationId}`,
    );
    const existing = await listExperiments({ root, explorationId });
    if (existing.some((experiment) => experiment.key === normalized.key)) {
      fail("EXPERIMENT_KEY_EXISTS", `experiment key already exists: ${normalized.key}`);
    }
    if (exploration.limits?.maxExperiments && existing.length >= exploration.limits.maxExperiments) {
      fail("EXPLORATION_LIMIT", `exploration admits at most ${exploration.limits.maxExperiments} experiments`);
    }
    const comparisonTotal = existing.reduce(
      (total, experiment) => total + experiment.comparisonCount,
      normalized.comparisonCount,
    );
    if (exploration.limits?.maxComparisons && comparisonTotal > exploration.limits.maxComparisons) {
      fail(
        "EXPLORATION_LIMIT",
        `exploration admits at most ${exploration.limits.maxComparisons} comparisons`,
      );
    }
    await writeJsonCreate(
      root,
      explorationPaths(root, explorationId, experimentId).experiment,
      record,
      "EXPERIMENT_EXISTS",
    );
    return record;
  } finally {
    await releaseLock(lock);
  }
}

function assertExperimentSourcesAuthorized(exploration, experiment) {
  for (const source of experiment.sourceScope) {
    const authorized = exploration.sourceScope.some((scope) =>
      (scope.path === "."
        || source.path === scope.path
        || source.path.startsWith(`${scope.path}/`))
      && (scope.textProjection ?? "utf8") === (source.textProjection ?? "utf8"));
    if (!authorized) {
      fail(
        "SOURCE_SCOPE_NOT_AUTHORIZED",
        `experiment source is outside the exploration scope: ${source.path}`,
      );
    }
  }
}

function normalizeStoredExperiment(value, expectedExperimentId, expectedExplorationId) {
  object(value, "stored experiment");
  rejectUnknown(value, EXPERIMENT_RECORD_KEYS, "stored experiment");
  if (
    value.schemaVersion !== EXPLORATION_SCHEMA_VERSION
    || value.kind !== "attend-experiment"
  ) {
    fail(
      "INVALID_EXPLORATION_RECORD",
      `stored experiment is invalid: ${expectedExperimentId}`,
    );
  }
  const experimentId = assertId(value.id, EXPERIMENT_ID, "experiment id");
  const explorationId = assertId(value.explorationId, EXPLORATION_ID, "exploration id");
  if (
    experimentId !== expectedExperimentId
    || explorationId !== expectedExplorationId
  ) {
    fail(
      "INVALID_EXPLORATION_RECORD",
      `stored experiment is invalid: ${expectedExperimentId}`,
    );
  }
  return {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    kind: "attend-experiment",
    id: experimentId,
    explorationId,
    admittedAt: isoTimestamp(value.admittedAt, "stored experiment.admittedAt"),
    ...normalizeExperimentPlan(
      Object.fromEntries(
        [...EXPERIMENT_KEYS]
          .filter((key) => Object.hasOwn(value, key))
          .map((key) => [key, value[key]]),
      ),
    ),
  };
}

export async function loadExperiment({ root, experimentId, explorationId }) {
  assertId(experimentId, EXPERIMENT_ID, "experiment id");
  if (explorationId !== undefined) {
    assertId(explorationId, EXPLORATION_ID, "exploration id");
    const value = await readJson(explorationPaths(root, explorationId, experimentId).experiment)
      .catch((error) => missing(error, "EXPERIMENT_NOT_FOUND", `experiment not found: ${experimentId}`));
    const normalized = normalizeStoredExperiment(value, experimentId, explorationId);
    assertExperimentSourcesAuthorized(
      await loadExploration({ root, explorationId }),
      normalized,
    );
    return normalized;
  }
  for (const exploration of await listExplorations({ root })) {
    try {
      return await loadExperiment({ root, experimentId, explorationId: exploration.id });
    } catch (error) {
      if (error?.code !== "EXPERIMENT_NOT_FOUND") throw error;
    }
  }
  fail("EXPERIMENT_NOT_FOUND", `experiment not found: ${experimentId}`);
}

export async function listExperiments({ root, explorationId }) {
  await loadExploration({ root, explorationId });
  const directory = explorationPaths(root, explorationId).experimentsDirectory;
  const ids = await idsIn(directory, EXPERIMENT_ID);
  const records = [];
  for (const experimentId of ids) {
    records.push(await loadExperiment({ root, explorationId, experimentId }));
  }
  return records.sort((left, right) => left.admittedAt.localeCompare(right.admittedAt) || left.id.localeCompare(right.id));
}

function normalizeInterestingness(value, path) {
  object(value, path);
  const dimensions = [
    "taskRelevance",
    "evidenceSufficiency",
    "surprise",
    "novelty",
    "actionability",
    "representationalDiversity",
    "uncertainty",
    "interruptionCost",
  ];
  rejectUnknown(value, new Set(dimensions), path);
  const normalized = {};
  for (const dimension of dimensions) {
    const score = value[dimension];
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      fail("INVALID_EXPERIMENT_EVENT", "must be a number from 0 through 1", `${path}.${dimension}`);
    }
    normalized[dimension] = score;
  }
  return normalized;
}

function stringArray(value, path, maximumItems = 1_000) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    fail("INVALID_EXPERIMENT_EVENT", `must be an array of at most ${maximumItems} strings`, path);
  }
  return value.map((item, index) => string(item, `${path}[${index}]`, 4_000));
}

function normalizeEventPayload(kind, value) {
  object(value, "event.payload");
  if (kind === "execution-started") {
    rejectUnknown(value, new Set(), "event.payload");
    return {};
  }
  if (kind === "execution-completed") {
    rejectUnknown(value, new Set(["analysisId", "sessionId", "packageHash", "comparisonCount"]), "event.payload");
    if (!Number.isSafeInteger(value.comparisonCount) || value.comparisonCount < 1) {
      fail("INVALID_EXPERIMENT_EVENT", "must be a positive integer", "event.payload.comparisonCount");
    }
    const packageHash = string(value.packageHash, "event.payload.packageHash", 64);
    if (!/^[a-f0-9]{64}$/u.test(packageHash)) {
      fail("INVALID_EXPERIMENT_EVENT", "must be a SHA-256 digest", "event.payload.packageHash");
    }
    return {
      analysisId: string(value.analysisId, "event.payload.analysisId", 128),
      sessionId: string(value.sessionId, "event.payload.sessionId", 128),
      packageHash,
      comparisonCount: value.comparisonCount,
    };
  }
  if (kind === "execution-failed") {
    rejectUnknown(value, new Set(["code", "message"]), "event.payload");
    return {
      code: string(value.code, "event.payload.code", 128),
      message: string(value.message, "event.payload.message", 4_000),
    };
  }
  if (kind === "assessment-recorded") {
    rejectUnknown(value, new Set([
      "outcome",
      "summary",
      "rationale",
      "evidenceStrength",
      "interestingness",
      "transformations",
      "omissions",
      "limitations",
    ]), "event.payload");
    return {
      outcome: oneOf(value.outcome, EXPERIMENT_OUTCOMES, "event.payload.outcome"),
      summary: string(value.summary, "event.payload.summary", 8_000),
      rationale: string(value.rationale, "event.payload.rationale", 8_000),
      evidenceStrength: oneOf(value.evidenceStrength, ["strong", "moderate", "weak", "none"], "event.payload.evidenceStrength"),
      interestingness: normalizeInterestingness(value.interestingness, "event.payload.interestingness"),
      transformations: stringArray(value.transformations ?? [], "event.payload.transformations"),
      omissions: stringArray(value.omissions ?? [], "event.payload.omissions"),
      limitations: stringArray(value.limitations ?? [], "event.payload.limitations"),
    };
  }
  if (kind === "agent-promoted") {
    rejectUnknown(value, new Set(["rationale"]), "event.payload");
    return { rationale: string(value.rationale, "event.payload.rationale", 8_000) };
  }
  if (kind === "human-star-changed") {
    rejectUnknown(value, new Set(["starred"]), "event.payload");
    if (typeof value.starred !== "boolean") fail("INVALID_EXPERIMENT_EVENT", "must be a boolean", "event.payload.starred");
    return { starred: value.starred };
  }
  if (kind === "feedback-recorded") {
    rejectUnknown(value, new Set(["kind", "note"]), "event.payload");
    const note = optionalString(value.note, "event.payload.note", 4_000);
    return {
      kind: oneOf(value.kind, FEEDBACK_KINDS, "event.payload.kind"),
      ...(note === undefined ? {} : { note }),
    };
  }
  if (kind === "human-disposition-recorded") {
    rejectUnknown(value, new Set(["disposition"]), "event.payload");
    return {
      disposition: oneOf(value.disposition, ["dismissed", "acted-upon", "unreviewed"], "event.payload.disposition"),
    };
  }
  fail("INVALID_EXPERIMENT_EVENT", `unknown event kind: ${kind}`);
}

function normalizeStoredEvent(value, { experiment, expectedEventId }) {
  object(value, "stored event");
  rejectUnknown(value, EVENT_RECORD_KEYS, "stored event");
  if (value.schemaVersion !== EXPLORATION_SCHEMA_VERSION) {
    fail("INVALID_EXPERIMENT_EVENT", `stored event is invalid: ${expectedEventId}`);
  }
  const kind = oneOf(value.kind, EXPERIMENT_EVENT_KINDS, "stored event.kind");
  if (typeof value.id !== "string" || !EVENT_ID.test(value.id)) {
    fail("INVALID_EXPERIMENT_EVENT", "stored event.id is invalid");
  }
  if (value.id !== expectedEventId) {
    fail("INVALID_EXPERIMENT_EVENT", "stored event id does not match its filename");
  }
  if (
    value.explorationId !== experiment.explorationId
    || value.experimentId !== experiment.id
  ) {
    fail("INVALID_EXPERIMENT_EVENT", "stored event is linked to the wrong experiment");
  }
  return {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    kind,
    id: value.id,
    explorationId: experiment.explorationId,
    experimentId: experiment.id,
    actor: oneOf(value.actor, ["agent", "human", "system"], "stored event.actor"),
    at: isoTimestamp(value.at, "stored event.at"),
    payload: normalizeEventPayload(kind, value.payload),
  };
}

function normalizedIdempotencyKey(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    fail("INVALID_EXPERIMENT_EVENT", "idempotencyKey must be a non-empty string of at most 256 characters");
  }
  return value.trim();
}

function idempotentEventId(experimentId, kind, actor, idempotencyKey) {
  const digest = createHash("sha256")
    .update(`${experimentId}\u0000${kind}\u0000${actor}\u0000${idempotencyKey}`)
    .digest("hex");
  return `event_${kind}_${digest.slice(0, 32)}`;
}

function sourceWithinScope(displayPath, sourceScope) {
  return sourceScope.some((scope) =>
    scope.path === "."
    || displayPath === scope.path
    || displayPath.startsWith(`${scope.path}/`)
    || displayPath.startsWith(`${scope.path}#`));
}

async function verifyCompletedResult(root, experiment, payload) {
  let session;
  try {
    session = await loadSession({ root, sessionId: payload.sessionId });
  } catch {
    fail(
      "INVALID_EXPERIMENT_RESULT",
      `completed result does not reference a valid Attend session: ${payload.sessionId}`,
    );
  }
  const dataPackage = session.dataPackage;
  if (
    session.id !== payload.sessionId
    || session.analysisId !== payload.analysisId
    || dataPackage?.id !== payload.analysisId
    || dataPackage?.hashes?.data !== payload.packageHash
    || session.exploration?.explorationId !== experiment.explorationId
    || session.exploration?.experimentId !== experiment.id
    || dataPackage?.family?.id !== experiment.representation.family
    || dataPackage?.catalog?.member !== experiment.representation.member
    || payload.comparisonCount !== experiment.comparisonCount
  ) {
    fail(
      "INVALID_EXPERIMENT_RESULT",
      `completed result does not match the immutable experiment plan: ${experiment.id}`,
    );
  }
  const sources = Array.isArray(dataPackage.sources) ? dataPackage.sources : [];
  if (
    !sources.length
    || sources.some((source) =>
      typeof source?.displayPath !== "string"
      || !sourceWithinScope(source.displayPath, experiment.sourceScope))
  ) {
    fail(
      "INVALID_EXPERIMENT_RESULT",
      `completed result contains a source outside the experiment scope: ${experiment.id}`,
    );
  }
}

function sameEventContent(left, right) {
  return left?.schemaVersion === right.schemaVersion
    && left?.kind === right.kind
    && left?.id === right.id
    && left?.explorationId === right.explorationId
    && left?.experimentId === right.experimentId
    && left?.actor === right.actor
    && JSON.stringify(left?.payload) === JSON.stringify(right.payload);
}

export async function appendExperimentEvent({
  root,
  experimentId,
  kind,
  payload,
  actor = "agent",
  id,
  idempotencyKey,
  expectedRevision,
  dedupeConsecutive = false,
  at,
  now = () => new Date(),
}) {
  const experiment = await loadExperiment({ root, experimentId });
  oneOf(kind, EXPERIMENT_EVENT_KINDS, "event.kind");
  oneOf(actor, ["agent", "human", "system"], "event.actor");
  if (id !== undefined && idempotencyKey !== undefined) {
    fail("INVALID_EXPERIMENT_EVENT", "event id and idempotencyKey are mutually exclusive");
  }
  if (
    expectedRevision !== undefined
    && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
  ) {
    fail("INVALID_EXPERIMENT_EVENT", "expectedRevision must be a non-negative integer");
  }
  if (typeof dedupeConsecutive !== "boolean") {
    fail("INVALID_EXPERIMENT_EVENT", "dedupeConsecutive must be a boolean");
  }
  const normalizedPayload = normalizeEventPayload(kind, payload);
  const occurredAt = isoTimestamp(at ?? now().toISOString(), "event.at");
  const normalizedKey = idempotencyKey === undefined
    ? null
    : normalizedIdempotencyKey(idempotencyKey);
  const eventId = id !== undefined
    ? assertId(id, EVENT_ID, "event id")
    : normalizedKey === null
      ? generatedEventId(occurredAt)
      : idempotentEventId(experimentId, kind, actor, normalizedKey);
  const event = {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    kind,
    id: eventId,
    explorationId: experiment.explorationId,
    experimentId,
    actor,
    at: occurredAt,
    payload: normalizedPayload,
  };
  const path = join(
    explorationPaths(root, experiment.explorationId, experimentId).eventsDirectory,
    `${eventId}.json`,
  );
  const lockPath = join(
    explorationPaths(root, experiment.explorationId, experimentId).experimentDirectory,
    ".events.lock",
  );
  let lock;
  try {
    lock = await acquireLock(
      root,
      lockPath,
      "EXPERIMENT_EVENT_BUSY",
      `experiment is recording another event: ${experimentId}`,
    );
    const events = normalizedKey !== null || expectedRevision !== undefined || dedupeConsecutive
      ? await listExperimentEvents({ root, experimentId })
      : [];
    if (normalizedKey !== null) {
      const existing = events.find((candidate) => candidate.id === eventId);
      if (existing) {
        if (!sameEventContent(existing, event)) {
          fail(
            "IDEMPOTENCY_CONFLICT",
            `idempotencyKey was already used with different event content: ${normalizedKey}`,
          );
        }
        return existing;
      }
    }
    if (expectedRevision !== undefined && events.length !== expectedRevision) {
      fail(
        "EXPERIMENT_REVISION_CONFLICT",
        `experiment revision changed from ${expectedRevision} to ${events.length}`,
      );
    }
    if (dedupeConsecutive) {
      if (kind === "human-star-changed") {
        const current = reduceExperiment(experiment, events);
        if (current.humanStarred === normalizedPayload.starred) {
          return [...events].reverse().find((candidate) =>
            candidate.kind === kind && candidate.actor === actor) ?? null;
        }
      } else {
        const latest = [...events].reverse().find((candidate) =>
          candidate.kind === kind && candidate.actor === actor);
        if (latest && JSON.stringify(latest.payload) === JSON.stringify(normalizedPayload)) {
          return latest;
        }
      }
    }
    if (kind === "execution-completed") {
      await verifyCompletedResult(root, experiment, normalizedPayload);
    }
    try {
      await writeJsonCreate(root, path, event, "EXPERIMENT_EVENT_EXISTS");
    } catch (error) {
      if (error?.code !== "EXPERIMENT_EVENT_EXISTS" || normalizedKey === null) throw error;
      const existing = normalizeStoredEvent(await readJson(path), {
        experiment,
        expectedEventId: event.id,
      });
      if (!sameEventContent(existing, event)) {
        fail(
          "IDEMPOTENCY_CONFLICT",
          `idempotencyKey was already used with different event content: ${normalizedKey}`,
        );
      }
      return existing;
    }
    return event;
  } finally {
    await releaseLock(lock);
  }
}

export async function listExperimentEvents({ root, experimentId }) {
  const experiment = await loadExperiment({ root, experimentId });
  const directory = explorationPaths(root, experiment.explorationId, experimentId).eventsDirectory;
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const events = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const match = entry.name.match(/^(event_[A-Za-z0-9._-]{8,160})\.json$/u);
    if (!entry.isFile() || !match) {
      fail("INVALID_EXPERIMENT_EVENT", `stored event is invalid: ${entry.name}`);
    }
    const event = normalizeStoredEvent(await readJson(join(directory, entry.name)), {
      experiment,
      expectedEventId: match[1],
    });
    if (event.kind === "execution-completed") {
      await verifyCompletedResult(root, experiment, event.payload);
    }
    events.push(event);
  }
  return events.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

export function reduceExperiment(experiment, events) {
  let execution = "queued";
  let outcome = null;
  let assessment = null;
  let promotion = null;
  let starred = false;
  let starChangedAt = null;
  let explicitDisposition = "unreviewed";
  const feedback = [];
  let completedAt = null;
  let result = null;
  let failure = null;
  for (const event of events) {
    if (event.kind === "execution-started") {
      execution = "running";
      completedAt = null;
      result = null;
      failure = null;
    }
    if (event.kind === "execution-completed") {
      execution = "completed";
      completedAt = event.at;
      result = event.payload;
      failure = null;
    }
    if (event.kind === "execution-failed") {
      execution = "failed";
      completedAt = event.at;
      failure = event.payload;
      result = null;
    }
    if (event.kind === "assessment-recorded") {
      outcome = event.payload.outcome;
      assessment = { ...event.payload, at: event.at };
    }
    if (event.kind === "agent-promoted") promotion = { ...event.payload, at: event.at };
    if (event.kind === "human-star-changed") {
      starred = event.payload.starred;
      starChangedAt = event.at;
    }
    if (event.kind === "feedback-recorded") feedback.push({ ...event.payload, at: event.at });
    if (event.kind === "human-disposition-recorded") explicitDisposition = event.payload.disposition;
  }
  return {
    ...experiment,
    execution,
    outcome,
    humanDisposition: explicitDisposition === "unreviewed" && starred
      ? "starred"
      : explicitDisposition,
    agentPromoted: promotion !== null,
    promotion,
    humanStarred: starred,
    starChangedAt,
    assessment,
    completedAt,
    result,
    failure,
    feedback,
    events,
  };
}

export async function publicExperiment({ root, experimentId }) {
  const experiment = await loadExperiment({ root, experimentId });
  return reduceExperiment(experiment, await listExperimentEvents({ root, experimentId }));
}

export async function publicExploration({ root, explorationId }) {
  const exploration = await loadExploration({ root, explorationId });
  const experiments = [];
  for (const experiment of await listExperiments({ root, explorationId })) {
    experiments.push(await publicExperiment({ root, experimentId: experiment.id }));
  }
  return {
    schemaVersion: EXPLORATION_SCHEMA_VERSION,
    exploration,
    experiments,
    counts: {
      total: experiments.length,
      queued: experiments.filter((experiment) => experiment.execution === "queued").length,
      running: experiments.filter((experiment) => experiment.execution === "running").length,
      completed: experiments.filter((experiment) => experiment.execution === "completed").length,
      failed: experiments.filter((experiment) => experiment.execution === "failed").length,
      attempted: experiments.filter((experiment) => experiment.execution !== "queued").length,
      comparisonsDeclared: experiments.reduce(
        (total, experiment) => total + experiment.comparisonCount,
        0,
      ),
      comparisonsAttempted: experiments
        .filter((experiment) => experiment.execution !== "queued")
        .reduce((total, experiment) => total + experiment.comparisonCount, 0),
      promoted: experiments.filter((experiment) => experiment.agentPromoted).length,
      starred: experiments.filter((experiment) => experiment.humanStarred).length,
    },
  };
}
