import {
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  link,
  lstat,
  open,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertSafeWritePath,
  ensureSafeDirectory,
  projectPaths,
  readJson,
} from "./project.js";

export const OPPORTUNITY_SCHEMA_VERSION = 1;
export const OPPORTUNITY_BOUNDARY_KINDS = Object.freeze(["before-final-answer"]);
export const OPPORTUNITY_HOST_KINDS = Object.freeze(["codex", "claude", "other"]);
export const OPPORTUNITY_TASK_ACTIONS = Object.freeze([
  "answer",
  "diagnose",
  "review",
  "implement",
  "summarize",
]);
export const OPPORTUNITY_EVIDENCE_STATES = Object.freeze([
  "none",
  "scoped-sources",
  "derived-records",
]);
export const OPPORTUNITY_RESULT_SHAPES = Object.freeze([
  "none",
  "small-list",
  "large-list",
  "table",
  "time-series",
  "network",
  "hierarchy",
  "map",
  "mixed",
]);
export const OPPORTUNITY_VISUAL_JOBS = Object.freeze([
  "comparison",
  "distribution",
  "change",
  "relationship",
  "hierarchy",
  "network",
  "location",
  "sequence",
]);
export const OPPORTUNITY_DECISIONS = Object.freeze(["abstain", "proceed"]);
export const OPPORTUNITY_REASONS = Object.freeze([
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
  "visual-worth-testing",
]);
export const OPPORTUNITY_COUNT_MAX = 1_000_000_000;

export const OPPORTUNITY_ENUMS = Object.freeze({
  boundaryKinds: OPPORTUNITY_BOUNDARY_KINDS,
  hostKinds: OPPORTUNITY_HOST_KINDS,
  taskActions: OPPORTUNITY_TASK_ACTIONS,
  evidenceStates: OPPORTUNITY_EVIDENCE_STATES,
  resultShapes: OPPORTUNITY_RESULT_SHAPES,
  visualJobs: OPPORTUNITY_VISUAL_JOBS,
  decisions: OPPORTUNITY_DECISIONS,
  reasons: OPPORTUNITY_REASONS,
});

const CHECKPOINT_ID = /^checkpoint_[a-f0-9]{24}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_SKILL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,127}$/u;
const REQUEST_KEYS = new Set([
  "boundary",
  "host",
  "taskShape",
  "sourceShape",
  "decision",
  "inspectionHash",
]);
const RECORD_KEYS = new Set([
  "schemaVersion",
  "kind",
  "id",
  "createdAt",
  "boundary",
  "host",
  "taskShape",
  "sourceShape",
  "decision",
  "inspectionHash",
]);
const CONTENT_FIELD = /^(?:content|message|prompt|transcript|quote|excerpt|source(?:text|body)|body|rationale|reasoning|hostticket|ticket|credential|credentials)$/iu;
const CREDENTIAL_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer[ \t]+[A-Za-z0-9._~+/-]+=*|\b(?:api[_-]?key|password|secret|credential|authorization|access[_-]?token|refresh[_-]?token)[=:][^\s]+|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{10,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/u;
const HOST_TICKET_VALUE = /(?:^|[-_:])(?:host[-_:]?|session[-_:]?)?ticket(?:[-_:]|$)/iu;
const CONTENT_VALUE = /(?:^|[-_:])(?:prompt|message|content|transcript|quote|excerpt|source[-_:]?text)(?:[-_:]|$)/iu;
const CREDENTIAL_ID_VALUE = /^(?:api[-_:]?key|password|secret|credential|authorization|access[-_:]?token|refresh[-_:]?token)(?:[-_:]|$)/iu;
const SOURCE_COUNTS = [
  "sourceCount",
  "recordCount",
  "numericTokenCount",
  "isoDateCount",
  "omissionCount",
];

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

function object(value, path, code) {
  if (!plainObject(value)) fail(code, "must be an object", path);
  return value;
}

function rejectUnknown(value, allowed, path, code) {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (!unexpected) return;
  const message = CONTENT_FIELD.test(unexpected)
    ? "content-bearing or sensitive fields are not allowed"
    : `unknown field ${unexpected}`;
  fail(code, message, `${path}.${unexpected}`);
}

function oneOf(value, choices, path, code) {
  if (!choices.includes(value)) {
    fail(code, `must be one of ${choices.join(", ")}`, path);
  }
  return value;
}

function boundedNumber(value, path, code) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(code, "must be a number from 0 through 1", path);
  }
  return value;
}

function boundedCount(value, path, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > OPPORTUNITY_COUNT_MAX) {
    fail(code, `must be an integer from 0 through ${OPPORTUNITY_COUNT_MAX}`, path);
  }
  return value;
}

function safeString(value, path, expression, maximum, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail(code, `must be a non-empty string of at most ${maximum} characters`, path);
  }
  if (
    value.startsWith("~")
    || value.startsWith("/")
    || win32.isAbsolute(value)
  ) {
    fail(code, "absolute paths are not allowed", path);
  }
  if (CREDENTIAL_VALUE.test(value)) {
    fail(code, "credential-like values are not allowed", path);
  }
  if (!expression.test(value)) fail(code, "contains unsupported characters", path);
  return value;
}

function normalizeBoundaryRequest(value, code) {
  object(value, "request.boundary", code);
  rejectUnknown(value, new Set(["kind", "id"]), "request.boundary", code);
  const id = safeString(value.id, "request.boundary.id", SAFE_OPAQUE_ID, 256, code);
  if (HOST_TICKET_VALUE.test(id)) {
    fail(code, "host tickets are not allowed", "request.boundary.id");
  }
  if (CONTENT_VALUE.test(id)) {
    fail(code, "content-bearing identifiers are not allowed", "request.boundary.id");
  }
  if (CREDENTIAL_ID_VALUE.test(id)) {
    fail(code, "credential-like identifiers are not allowed", "request.boundary.id");
  }
  return {
    kind: oneOf(
      value.kind,
      OPPORTUNITY_BOUNDARY_KINDS,
      "request.boundary.kind",
      code,
    ),
    id,
  };
}

function normalizeHost(value, path, code) {
  object(value, path, code);
  rejectUnknown(value, new Set(["kind", "skillVersion"]), path, code);
  return {
    kind: oneOf(value.kind, OPPORTUNITY_HOST_KINDS, `${path}.kind`, code),
    skillVersion: safeString(
      value.skillVersion,
      `${path}.skillVersion`,
      SAFE_SKILL_VERSION,
      128,
      code,
    ),
  };
}

function normalizeTaskShape(value, path, code) {
  object(value, path, code);
  rejectUnknown(
    value,
    new Set(["action", "evidenceState", "resultShape", "visualJobs"]),
    path,
    code,
  );
  if (!Array.isArray(value.visualJobs) || value.visualJobs.length > OPPORTUNITY_VISUAL_JOBS.length) {
    fail(code, `must be an array of at most ${OPPORTUNITY_VISUAL_JOBS.length} jobs`, `${path}.visualJobs`);
  }
  const visualJobs = value.visualJobs.map((job, index) => oneOf(
    job,
    OPPORTUNITY_VISUAL_JOBS,
    `${path}.visualJobs[${index}]`,
    code,
  ));
  if (new Set(visualJobs).size !== visualJobs.length) {
    fail(code, "must not contain duplicate jobs", `${path}.visualJobs`);
  }
  return {
    action: oneOf(value.action, OPPORTUNITY_TASK_ACTIONS, `${path}.action`, code),
    evidenceState: oneOf(
      value.evidenceState,
      OPPORTUNITY_EVIDENCE_STATES,
      `${path}.evidenceState`,
      code,
    ),
    resultShape: oneOf(
      value.resultShape,
      OPPORTUNITY_RESULT_SHAPES,
      `${path}.resultShape`,
      code,
    ),
    visualJobs,
  };
}

function normalizeSourceShape(value, path, code) {
  object(value, path, code);
  rejectUnknown(value, new Set(["origin", ...SOURCE_COUNTS]), path, code);
  const sourceShape = {
    origin: oneOf(value.origin, ["self-report"], `${path}.origin`, code),
  };
  for (const key of SOURCE_COUNTS) {
    sourceShape[key] = boundedCount(value[key], `${path}.${key}`, code);
  }
  return sourceShape;
}

function normalizeDecision(value, path, code) {
  object(value, path, code);
  rejectUnknown(
    value,
    new Set(["kind", "reason", "confidence", "interruptionCost"]),
    path,
    code,
  );
  const kind = oneOf(value.kind, OPPORTUNITY_DECISIONS, `${path}.kind`, code);
  const reason = oneOf(value.reason, OPPORTUNITY_REASONS, `${path}.reason`, code);
  if ((kind === "proceed") !== (reason === "visual-worth-testing")) {
    fail(
      code,
      kind === "proceed"
        ? "proceed requires visual-worth-testing"
        : "visual-worth-testing requires proceed",
      `${path}.reason`,
    );
  }
  return {
    kind,
    reason,
    confidence: boundedNumber(value.confidence, `${path}.confidence`, code),
    interruptionCost: boundedNumber(
      value.interruptionCost,
      `${path}.interruptionCost`,
      code,
    ),
  };
}

function normalizeInspectionHash(value, path, code) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(code, "must be a lowercase SHA-256 digest", path);
  }
  return value;
}

function normalizeRequest(value) {
  const code = "INVALID_OPPORTUNITY_REQUEST";
  object(value, "request", code);
  rejectUnknown(value, REQUEST_KEYS, "request", code);
  const boundary = normalizeBoundaryRequest(value.boundary, code);
  const inspectionHash = normalizeInspectionHash(
    value.inspectionHash,
    "request.inspectionHash",
    code,
  );
  return {
    boundary,
    host: normalizeHost(value.host, "request.host", code),
    taskShape: normalizeTaskShape(value.taskShape, "request.taskShape", code),
    sourceShape: normalizeSourceShape(value.sourceShape, "request.sourceShape", code),
    decision: normalizeDecision(value.decision, "request.decision", code),
    ...(inspectionHash === undefined ? {} : { inspectionHash }),
  };
}

function checkpointId(value, code = "INVALID_OPPORTUNITY_ID") {
  if (typeof value !== "string" || !CHECKPOINT_ID.test(value)) {
    fail(code, "checkpoint id is invalid");
  }
  return value;
}

function isoTimestamp(value, path, code) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    fail(code, "must be an ISO 8601 UTC timestamp", path);
  }
  return value;
}

function normalizeStoredRecord(value, expectedId) {
  const code = "INVALID_OPPORTUNITY_RECORD";
  object(value, "checkpoint", code);
  rejectUnknown(value, RECORD_KEYS, "checkpoint", code);
  if (value.schemaVersion !== OPPORTUNITY_SCHEMA_VERSION) {
    fail(code, `schemaVersion must be ${OPPORTUNITY_SCHEMA_VERSION}`, "checkpoint.schemaVersion");
  }
  if (value.kind !== "attend-opportunity-check") {
    fail(code, "kind must be attend-opportunity-check", "checkpoint.kind");
  }
  const id = checkpointId(value.id, code);
  if (expectedId !== undefined && id !== expectedId) {
    fail(code, "stored id does not match its filename", "checkpoint.id");
  }
  object(value.boundary, "checkpoint.boundary", code);
  rejectUnknown(
    value.boundary,
    new Set(["kind", "idempotencyDigest"]),
    "checkpoint.boundary",
    code,
  );
  const digest = value.boundary.idempotencyDigest;
  if (typeof digest !== "string" || !SHA256.test(digest)) {
    fail(code, "must be a lowercase HMAC-SHA-256 digest", "checkpoint.boundary.idempotencyDigest");
  }
  const inspectionHash = normalizeInspectionHash(
    value.inspectionHash,
    "checkpoint.inspectionHash",
    code,
  );
  return {
    schemaVersion: OPPORTUNITY_SCHEMA_VERSION,
    kind: "attend-opportunity-check",
    id,
    createdAt: isoTimestamp(value.createdAt, "checkpoint.createdAt", code),
    boundary: {
      kind: oneOf(
        value.boundary.kind,
        OPPORTUNITY_BOUNDARY_KINDS,
        "checkpoint.boundary.kind",
        code,
      ),
      idempotencyDigest: digest,
    },
    host: normalizeHost(value.host, "checkpoint.host", code),
    taskShape: normalizeTaskShape(value.taskShape, "checkpoint.taskShape", code),
    sourceShape: normalizeSourceShape(value.sourceShape, "checkpoint.sourceShape", code),
    decision: normalizeDecision(value.decision, "checkpoint.decision", code),
    ...(inspectionHash === undefined ? {} : { inspectionHash }),
  };
}

export function opportunityPaths(root, id) {
  const local = projectPaths(root).local;
  const directory = join(local, "checkpoints");
  const normalizedId = id === undefined ? null : checkpointId(id);
  return Object.freeze({
    directory,
    salt: join(local, "checkpoint-salt"),
    checkpoint: normalizedId === null ? null : join(directory, `${normalizedId}.json`),
  });
}

async function createExclusive(root, path, contents) {
  await assertSafeWritePath(root, path);
  await ensureSafeDirectory(root, dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertSafeWritePath(root, path);
    await link(temporary, path);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function loadSalt(root) {
  const { salt } = opportunityPaths(root);
  await assertSafeWritePath(root, salt);
  let info;
  let value;
  try {
    [info, value] = await Promise.all([lstat(salt), readFile(salt)]);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
    fail("UNSAFE_CHECKPOINT_SALT", "checkpoint salt must be a regular file with mode 0600");
  }
  if (value.length !== 32) {
    fail("INVALID_CHECKPOINT_SALT", "checkpoint salt must contain exactly 32 bytes");
  }
  return value;
}

async function projectSalt(root) {
  const existing = await loadSalt(root);
  if (existing) return existing;
  const value = randomBytes(32);
  await createExclusive(root, opportunityPaths(root).salt, value);
  const stored = await loadSalt(root);
  if (!stored) fail("INVALID_CHECKPOINT_SALT", "checkpoint salt was not created");
  return stored;
}

function idempotencyDigest(salt, request) {
  return createHmac("sha256", salt)
    .update("attend-opportunity-check-v1\0")
    .update(request.host.kind)
    .update("\0")
    .update(request.boundary.kind)
    .update("\0")
    .update(request.boundary.id)
    .digest("hex");
}

function comparableRecord(record) {
  return {
    boundary: record.boundary,
    host: record.host,
    taskShape: record.taskShape,
    sourceShape: record.sourceShape,
    decision: record.decision,
    ...(record.inspectionHash === undefined ? {} : { inspectionHash: record.inspectionHash }),
  };
}

function expectedRecordPayload(request, digest) {
  return {
    boundary: {
      kind: request.boundary.kind,
      idempotencyDigest: digest,
    },
    host: request.host,
    taskShape: request.taskShape,
    sourceShape: request.sourceShape,
    decision: request.decision,
    ...(request.inspectionHash === undefined ? {} : { inspectionHash: request.inspectionHash }),
  };
}

function assertReplay(record, request, digest) {
  if (!isDeepStrictEqual(comparableRecord(record), expectedRecordPayload(request, digest))) {
    fail(
      "OPPORTUNITY_IDEMPOTENCY_CONFLICT",
      "the same boundary already has a different checkpoint payload",
    );
  }
  return record;
}

function missing(error, id) {
  if (error?.code !== "ENOENT") throw error;
  fail("OPPORTUNITY_NOT_FOUND", `opportunity checkpoint not found: ${id}`);
}

export async function loadOpportunityCheck({ root, checkpointId: id }) {
  const normalizedId = checkpointId(id);
  const path = opportunityPaths(root, normalizedId).checkpoint;
  await assertSafeWritePath(root, path);
  const value = await readJson(path).catch((error) => missing(error, normalizedId));
  return normalizeStoredRecord(value, normalizedId);
}

export async function createOpportunityCheck({ root, request, now = () => new Date() }) {
  const normalized = normalizeRequest(request);
  const salt = await projectSalt(root);
  const digest = idempotencyDigest(salt, normalized);
  const id = `checkpoint_${digest.slice(0, 24)}`;
  try {
    const existing = await loadOpportunityCheck({ root, checkpointId: id });
    return assertReplay(existing, normalized, digest);
  } catch (error) {
    if (error?.code !== "OPPORTUNITY_NOT_FOUND") throw error;
  }

  const record = normalizeStoredRecord({
    schemaVersion: OPPORTUNITY_SCHEMA_VERSION,
    kind: "attend-opportunity-check",
    id,
    createdAt: now().toISOString(),
    ...expectedRecordPayload(normalized, digest),
  }, id);
  const created = await createExclusive(
    root,
    opportunityPaths(root, id).checkpoint,
    `${JSON.stringify(record, null, 2)}\n`,
  );
  if (created) return record;
  return assertReplay(
    await loadOpportunityCheck({ root, checkpointId: id }),
    normalized,
    digest,
  );
}

export async function listOpportunityChecks({ root }) {
  const { directory } = opportunityPaths(root);
  await assertSafeWritePath(root, directory);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const ids = [];
  for (const entry of entries) {
    const match = entry.name.match(/^(checkpoint_[a-f0-9]{24})\.json$/u);
    if (!match) continue;
    if (!entry.isFile()) {
      fail("INVALID_OPPORTUNITY_RECORD", `checkpoint path is not a regular file: ${entry.name}`);
    }
    ids.push(match[1]);
  }
  const records = [];
  for (const id of ids.sort()) {
    records.push(await loadOpportunityCheck({ root, checkpointId: id }));
  }
  return records.sort(
    (left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
  );
}

export function publicOpportunityCheck(record) {
  const normalized = normalizeStoredRecord(record);
  return {
    schemaVersion: normalized.schemaVersion,
    kind: normalized.kind,
    id: normalized.id,
    createdAt: normalized.createdAt,
    boundary: { kind: normalized.boundary.kind },
    host: normalized.host,
    taskShape: normalized.taskShape,
    sourceShape: normalized.sourceShape,
    decision: normalized.decision,
    ...(normalized.inspectionHash === undefined
      ? {}
      : { inspectionHash: normalized.inspectionHash }),
  };
}
