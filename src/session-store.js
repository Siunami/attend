import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  artifactAdapterFor,
  buildArtifactSelection,
  clearArtifactSelection,
  createArtifactState,
  normalizeArtifactState,
  patchArtifactState,
  validateArtifactPackage,
  verifyArtifactPackage,
  viewDescriptorForArtifact,
} from "./artifacts/index.js";
import {
  assertSafeWritePath,
  ensureSafeDirectory,
  writeJsonAtomic,
} from "./project.js";
import { LOCAL_MODEL } from "./local-model.js";
import { validateSessionAssetReceipt } from "./media/session-assets.js";

const SESSION_SCHEMA_VERSION = 1;
const SESSION_DIRECTORY = ".attend/local/sessions";
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CHAT_THREAD_ID = /^(?:thread|legacy)_[a-f0-9]{24}$/u;
const EXPLORATION_ID = /^exploration_[a-f0-9]{24}$/u;
const EXPERIMENT_ID = /^experiment_[a-f0-9]{24}$/u;
const MAX_INLINE_SOURCE_REFS = 50;
const LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 120, 160, 200, 250];
const MALFORMED_LOCK_STALE_MS = 2_000;
const RESPONSE_STATUSES = new Set([
  "queued",
  "running",
  "failed",
  "completed",
]);
const RESPONSE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const HOST_ATTACHMENT_ID = /^host_[a-f0-9]{16}$/u;
const DETACHED_ADAPTERS = new Set(["codex-cli", "claude-cli"]);
// Keyed by the session file's stat identity, so an out-of-band edit preserving
// mtime, size, and inode is not re-detected within one process. A hit skips the
// staged-asset manifest, but readSessionAsset revalidates the receipt itself.
const SESSION_CACHE = new Map();
const SESSION_CACHE_MAX = 32;

function normalizeResponseRoute(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new TypeError("turn.response.route must be an object");
  }
  if (route.kind === "host") {
    if (
      !HOST_ATTACHMENT_ID.test(route.attachmentId ?? "") ||
      !Number.isSafeInteger(route.generation) ||
      route.generation < 1
    ) {
      throw new TypeError(
        "A host response route requires a valid attachmentId and positive generation",
      );
    }
    return {
      kind: "host",
      attachmentId: route.attachmentId,
      generation: route.generation,
    };
  }
  if (route.kind === "local" && route.model === LOCAL_MODEL.id) {
    return { kind: "local", model: LOCAL_MODEL.id };
  }
  if (route.kind === "detached" && DETACHED_ADAPTERS.has(route.adapter)) {
    return { kind: "detached", adapter: route.adapter };
  }
  throw new TypeError("Unsupported response route");
}

function publicResponseRoute(route) {
  if (route === undefined) return null;
  const normalized = normalizeResponseRoute(route);
  if (normalized.kind === "host") return { kind: "host" };
  if (normalized.kind === "local") return { kind: "local", model: normalized.model };
  return { kind: "detached", adapter: normalized.adapter };
}

function sameResponseRoute(left, right) {
  const a = normalizeResponseRoute(left);
  const b = normalizeResponseRoute(right);
  if (a.kind !== b.kind) return false;
  if (a.kind === "host") {
    return a.attachmentId === b.attachmentId && a.generation === b.generation;
  }
  if (a.kind === "local") return a.model === b.model;
  return a.adapter === b.adapter;
}

export class SessionConflictError extends Error {
  constructor({ sessionId, expectedRevision, actualRevision, message }) {
    super(
      message ??
        `Session ${sessionId} is at revision ${actualRevision}; expected ${expectedRevision}.`,
    );
    this.name = "SessionConflictError";
    this.code = "CONFLICT";
    this.sessionId = sessionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function cloneJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (encoded === undefined) {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  return JSON.parse(encoded);
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    const error = new TypeError(
      "sessionId must contain only letters, numbers, dots, underscores, or hyphens",
    );
    error.code = "INVALID_SESSION_ID";
    throw error;
  }
  return sessionId;
}

function sessionsDirectory(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("A project root is required");
  }
  return resolve(root, SESSION_DIRECTORY);
}

export function sessionFilePath({ root, sessionId }) {
  return join(sessionsDirectory(root), `${validateSessionId(sessionId)}.json`);
}

function compactSelectionSourceScope(selection) {
  const sourceScope = selection?.filters?.sourceScope;
  if (sourceScope?.mode !== "all") {
    return selection;
  }
  selection.filters.sourceScope = { mode: "all", sourceIds: [] };
  return selection;
}

function selectionCarriesVisualContext(selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return false;
  }
  return (
    (Array.isArray(selection.selectedMarkIds) &&
      selection.selectedMarkIds.length > 0) ||
    (Array.isArray(selection.marks) && selection.marks.length > 0) ||
    (Array.isArray(selection.sourceRefs) && selection.sourceRefs.length > 0) ||
    (selection.predicate !== null && selection.predicate !== undefined)
  );
}

function contextSelectionOrigin(turns, question) {
  if (!question || question.role !== "user") return null;
  if (selectionCarriesVisualContext(question.selection)) return question;

  const sameContextScope = (turn) => (
    turn?.threadId === question.threadId &&
    turn?.page?.sessionId === question.page?.sessionId
  );

  const byId = new Map(
    turns
      .filter(
        (turn) =>
          turn?.role === "user" &&
          typeof turn.id === "string" &&
          turn.id.length > 0 &&
          sameContextScope(turn),
      )
      .map((turn) => [turn.id, turn]),
  );
  const seen = new Set([question.id]);
  let selectionTurnId = question.context?.selectionTurnId;
  while (typeof selectionTurnId === "string" && !seen.has(selectionTurnId)) {
    seen.add(selectionTurnId);
    const origin = byId.get(selectionTurnId);
    if (!origin) break;
    if (selectionCarriesVisualContext(origin.selection)) return origin;
    selectionTurnId = origin.context?.selectionTurnId;
  }
  return null;
}

function questionVisualContext(session, question) {
  const origin = contextSelectionOrigin(conversationTurns(session), question);
  if (!origin) {
    return {
      selection: null,
      selectionTurnId: null,
      mode: "none",
    };
  }
  return {
    selection: cloneJson(origin.selection, "conversation visual context"),
    selectionTurnId: origin.id,
    mode: origin.id === question.id ? "attached" : "inherited",
  };
}

function questionReplySelection(session, question) {
  return questionVisualContext(session, question).selection ??
    cloneJson(question.selection, "question selection");
}

function normalizeConversationContext(turns) {
  let legacySelectionTurnId = null;
  const originsByQuestionId = new Map();
  for (const turn of turns) {
    compactSelectionSourceScope(turn?.selection);
    if (turn?.role !== "user" || typeof turn.id !== "string") continue;

    let selectionTurnId = null;
    if (selectionCarriesVisualContext(turn.selection)) {
      selectionTurnId = turn.id;
    } else {
      const explicitlyBound = Object.hasOwn(turn.context ?? {}, "selectionTurnId");
      const requestedOrigin = turn.context?.selectionTurnId ?? null;
      if (explicitlyBound) {
        const requested = originsByQuestionId.get(requestedOrigin);
        if (
          typeof requestedOrigin === "string" &&
          requested &&
          requested.threadId === turn.threadId &&
          requested.pageSessionId === turn.page?.sessionId
        ) {
          selectionTurnId = requested.selectionTurnId;
        }
      } else if (turn.threadId === undefined) {
        selectionTurnId = legacySelectionTurnId;
      }
    }

    if (selectionTurnId) {
      turn.context = { selectionTurnId };
    } else if (turn.threadId !== undefined) {
      turn.context = { selectionTurnId: null };
    } else {
      delete turn.context;
    }
    if (turn.threadId === undefined) legacySelectionTurnId = selectionTurnId;
    originsByQuestionId.set(turn.id, {
      selectionTurnId,
      threadId: turn.threadId,
      pageSessionId: turn.page?.sessionId,
    });
  }
}

function normalizeStoredSession(session) {
  if (session?.exploration !== undefined) {
    session.exploration = normalizeExplorationProvenance(session.exploration);
  }
  if (session?.dataPackage) {
    const dataPackage = validateArtifactPackage(session.dataPackage);
    session.state = normalizeArtifactState(dataPackage, session.state);
  }

  const turns = Array.isArray(session?.conversation)
    ? session.conversation
    : session?.conversation?.turns;
  if (Array.isArray(turns)) {
    normalizeConversationContext(turns);
  }
  return session;
}

function normalizeExplorationProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("session.exploration must be an object");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("explorationId") ||
    !keys.includes("experimentId") ||
    !EXPLORATION_ID.test(value.explorationId ?? "") ||
    !EXPERIMENT_ID.test(value.experimentId ?? "")
  ) {
    throw new TypeError(
      "session.exploration requires valid explorationId and experimentId fields",
    );
  }
  return {
    explorationId: value.explorationId,
    experimentId: value.experimentId,
  };
}

async function verifyStoredArtifact(session) {
  await verifyArtifactPackage(session?.dataPackage);
  return session;
}

async function readJson(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error(`Session not found: ${path}`);
      missing.code = "SESSION_NOT_FOUND";
      throw missing;
    }
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    const invalid = new Error(`Session JSON is invalid: ${path}`);
    invalid.code = "INVALID_SESSION";
    invalid.cause = error;
    throw invalid;
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
  const stale = alive === false || (
    alive === null && Date.now() - info.mtimeMs >= MALFORMED_LOCK_STALE_MS
  );
  if (!stale) return false;

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

async function acquireLock(path, sessionId, expectedRevision) {
  const lockPath = `${path}.lock`;
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
        return { handle, lockPath, dev: info.dev, ino: info.ino };
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
      throw new SessionConflictError({
        sessionId,
        expectedRevision,
        actualRevision: null,
        message: `Session ${sessionId} is being updated by another process.`,
      });
    }
  }
  throw new Error("unreachable lock acquisition state");
}

async function releaseLock(lock) {
  if (!lock) return;
  await lock.handle.close().catch(() => {});
  const current = await lstat(lock.lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current || current.dev !== lock.dev || current.ino !== lock.ino) return;
  await unlink(lock.lockPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

function assertExpectedRevision(session, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative integer");
  }
  if (session.state?.revision !== expectedRevision) {
    throw new SessionConflictError({
      sessionId: session.id,
      expectedRevision,
      actualRevision: session.state?.revision,
    });
  }
}

function derivedSourceRefs(session) {
  const selected = new Set(session.state.selectedIds);
  const refs = [];
  let total = 0;
  for (const row of session.dataPackage.rows) {
    if (!selected.has(row.id)) continue;
    for (const occurrence of row.occurrences ?? []) {
      total += 1;
      if (refs.length < MAX_INLINE_SOURCE_REFS) {
        refs.push({
          rowId: row.id,
          phrase: row.phrase,
          ...cloneJson(occurrence, "source reference"),
        });
      }
    }
  }
  return { refs, total };
}

function phraseSnapshot(session, supplied = {}) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new TypeError("turn.selection must be an object when supplied");
  }
  const suppliedSnapshot = compactSelectionSourceScope(
    cloneJson(supplied, "turn selection"),
  );
  const selectedMarkIds = cloneJson(
    session.state.selectedIds,
    "selected mark ids",
  );
  const derivedEvidence = derivedSourceRefs(session);
  const sourceRefs = Object.hasOwn(supplied, "sourceRefs")
    ? cloneJson(supplied.sourceRefs, "selection sourceRefs")
    : derivedEvidence.refs;
  const dataHash = session.dataPackage.hashes?.data ?? null;
  const base = {
    analysisId: session.analysisId,
    dataPackageId: session.dataPackage.id,
    dataPackageHash: dataHash,
    dataHash,
    map: cloneJson(session.view, "view"),
    stateRevision: session.state.revision,
    selectedMarkIds,
    predicate: Object.hasOwn(supplied, "predicate")
      ? cloneJson(supplied.predicate, "selection predicate")
      : {
          field: "id",
          operator: "in",
          values: selectedMarkIds,
        },
    filters: Object.hasOwn(supplied, "filters")
      ? cloneJson(supplied.filters, "selection filters")
      : {
          query: session.state.query,
          minCount: session.state.minCount,
          minSources: session.dataPackage.config?.minSources ?? 1,
          sourceScope: cloneJson(session.state.sourceScope, "source scope"),
        },
    aggregation: Object.hasOwn(supplied, "aggregation")
      ? cloneJson(supplied.aggregation, "selection aggregation")
      : {
          labelField: session.dataPackage.map?.labelField ?? "phrase",
          valueField:
            session.dataPackage.map?.valueField ?? "occurrenceCount",
        },
    sort: cloneJson(session.state.sort, "sort"),
    sourceRefCount: Object.hasOwn(supplied, "sourceRefCount")
      ? supplied.sourceRefCount
      : derivedEvidence.total,
    sourceRefsTruncated: Object.hasOwn(supplied, "sourceRefsTruncated")
      ? supplied.sourceRefsTruncated
      : derivedEvidence.total > sourceRefs.length,
    sourceRefs,
  };
  return {
    ...base,
    ...suppliedSnapshot,
    // These identify the persisted state, so a caller cannot accidentally
    // snapshot a different package or revision into this session's trail.
    analysisId: session.analysisId,
    dataPackageId: session.dataPackage.id,
    dataPackageHash: dataHash,
    dataHash,
    map: base.map,
    stateRevision: base.stateRevision,
    selectedMarkIds: base.selectedMarkIds,
    predicate: Object.hasOwn(suppliedSnapshot, "predicate")
      ? suppliedSnapshot.predicate
      : base.predicate,
    filters: Object.hasOwn(suppliedSnapshot, "filters")
      ? suppliedSnapshot.filters
      : base.filters,
    aggregation: Object.hasOwn(suppliedSnapshot, "aggregation")
      ? suppliedSnapshot.aggregation
      : base.aggregation,
    sort: Object.hasOwn(suppliedSnapshot, "sort")
      ? suppliedSnapshot.sort
      : base.sort,
    sourceRefs: Object.hasOwn(suppliedSnapshot, "sourceRefs")
      ? suppliedSnapshot.sourceRefs
      : base.sourceRefs,
  };
}

function snapshot(session, supplied = {}) {
  const adapter = artifactAdapterFor(session.dataPackage);
  if (adapter.artifactKind === "phrase-v1") return phraseSnapshot(session, supplied);

  // Atlas selections are never accepted from callers. The state and canonical
  // package are both held under the session lock, so this is the one place a
  // frozen chat attachment is derived before it is persisted.
  return buildArtifactSelection(session.dataPackage, session.state);
}

async function mutateSession({ root, sessionId, expectedRevision, mutate }) {
  const path = sessionFilePath({ root, sessionId });
  await ensureSafeDirectory(root, dirname(path));
  await assertSafeWritePath(root, path);
  let lock;
  try {
    lock = await acquireLock(path, sessionId, expectedRevision);
    const current = await readJson(path);
    assertExpectedRevision(current, expectedRevision);
    const normalized = normalizeStoredSession(cloneJson(current, "session"));
    await verifyStoredArtifact(normalized);
    const next = await mutate(normalized);
    next.state.revision = expectedRevision + 1;
    next.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path, next, { root });
    return cloneJson(next, "session");
  } finally {
    await releaseLock(lock);
  }
}

/**
 * Mutate whichever revision is current while holding the same per-session
 * lock used by optimistic viewer updates. Response workers are asynchronous:
 * the visualization may legitimately move between queueing, starting, and
 * completing a response, so those lifecycle writes must never replay an old
 * view-state snapshot over newer state.
 */
async function mutateLatestSession({ root, sessionId, mutate }) {
  const validatedSessionId = validateSessionId(sessionId);
  const path = sessionFilePath({ root, sessionId: validatedSessionId });
  await ensureSafeDirectory(root, dirname(path));
  await assertSafeWritePath(root, path);
  let lock;
  try {
    lock = await acquireLock(path, validatedSessionId, undefined);
    const session = normalizeStoredSession(
      cloneJson(await readJson(path), "session"),
    );
    await verifyStoredArtifact(session);
    const outcome = (await mutate(session)) ?? {};
    if (outcome.changed === false) {
      return {
        session: cloneJson(session, "session"),
        changed: false,
        ...(outcome.value === undefined
          ? {}
          : { value: cloneJson(outcome.value, "mutation result") }),
      };
    }
    session.state.revision += 1;
    session.updatedAt = new Date().toISOString();
    await writeJsonAtomic(path, session, { root });
    return {
      session: cloneJson(session, "session"),
      changed: true,
      ...(outcome.value === undefined
        ? {}
        : { value: cloneJson(outcome.value, "mutation result") }),
    };
  } finally {
    await releaseLock(lock);
  }
}

/** Serialize an external host-ownership operation with session mutations. */
export async function withSessionResponseLock({
  root,
  sessionId,
  operation,
  includeSession = false,
} = {}) {
  const validatedSessionId = validateSessionId(sessionId);
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function");
  }
  const path = sessionFilePath({ root, sessionId: validatedSessionId });
  await ensureSafeDirectory(root, dirname(path));
  await assertSafeWritePath(root, path);
  let lock;
  try {
    lock = await acquireLock(path, validatedSessionId, undefined);
    if (!includeSession) return await operation({ session: null });
    const session = normalizeStoredSession(
      cloneJson(await readJson(path), "session"),
    );
    await verifyStoredArtifact(session);
    return await operation({ session });
  } finally {
    await releaseLock(lock);
  }
}

export async function createSession({
  root,
  dataPackage,
  id,
  state = {},
  exploration,
  assetReceipt,
} = {}) {
  const packageSnapshot = cloneJson(dataPackage, "dataPackage");
  validateArtifactPackage(packageSnapshot);
  await verifyArtifactPackage(packageSnapshot);
  const sessionId = validateSessionId(id ?? packageSnapshot.id);
  const normalizedAssetReceipt = assetReceipt === undefined
    ? undefined
    : await validateSessionAssetReceipt({
        root,
        sessionId,
        dataPackage: packageSnapshot,
        receipt: assetReceipt,
      });
  const path = sessionFilePath({ root, sessionId });
  await ensureSafeDirectory(root, dirname(path));
  await assertSafeWritePath(root, path);

  let lock;
  try {
    lock = await acquireLock(path, sessionId, 0);
    try {
      await readFile(path);
      const exists = new Error(`Session already exists: ${sessionId}`);
      exists.code = "SESSION_EXISTS";
      throw exists;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const now = new Date().toISOString();
    const session = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: sessionId,
      analysisId: packageSnapshot.id,
      dataPackageId: packageSnapshot.id,
      createdAt: now,
      updatedAt: now,
      view: viewDescriptorForArtifact(packageSnapshot),
      dataPackage: packageSnapshot,
      state: createArtifactState(packageSnapshot, state),
      conversation: { turns: [] },
      ...(normalizedAssetReceipt === undefined
        ? {}
        : { assetReceipt: normalizedAssetReceipt }),
      ...(exploration === undefined
        ? {}
        : { exploration: normalizeExplorationProvenance(exploration) }),
    };
    await writeJsonAtomic(path, session, { root });
    return cloneJson(session, "session");
  } finally {
    await releaseLock(lock);
  }
}

async function sessionStatKey(path) {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}:${info.ino}`;
  } catch {
    return undefined;
  }
}

export async function loadSession({ root, sessionId } = {}) {
  const path = sessionFilePath({ root, sessionId });
  await assertSafeWritePath(root, path);
  const statKey = await sessionStatKey(path);
  const cached = statKey === undefined ? undefined : SESSION_CACHE.get(path);
  if (cached !== undefined && cached.statKey === statKey) {
    SESSION_CACHE.delete(path);
    SESSION_CACHE.set(path, cached);
    return JSON.parse(cached.serialized);
  }

  const session = normalizeStoredSession(cloneJson(await readJson(path), "session"));
  await verifyStoredArtifact(session);
  if (session.assetReceipt !== undefined) {
    session.assetReceipt = await validateSessionAssetReceipt({
      root,
      sessionId: session.id,
      dataPackage: session.dataPackage,
      receipt: session.assetReceipt,
    });
  }
  // Without this, an atomic rename landing between the first stat and the read
  // would cache stale bytes under the new file's identity and serve them forever.
  const settledStatKey = await sessionStatKey(path);
  if (settledStatKey !== undefined && settledStatKey === statKey) {
    SESSION_CACHE.delete(path);
    SESSION_CACHE.set(path, { statKey, serialized: JSON.stringify(session) });
    while (SESSION_CACHE.size > SESSION_CACHE_MAX) {
      SESSION_CACHE.delete(SESSION_CACHE.keys().next().value);
    }
  }
  return session;
}

export async function updateSession({
  root,
  sessionId,
  expectedRevision,
  patch,
} = {}) {
  return mutateSession({
    root,
    sessionId: validateSessionId(sessionId),
    expectedRevision,
    mutate(session) {
      session.state = patchArtifactState(session.dataPackage, session.state, patch);
      return session;
    },
  });
}

function normalizeTurnPage(page, threadId) {
  if (threadId === undefined && page === undefined) return undefined;
  if (
    typeof threadId !== "string" ||
    !CHAT_THREAD_ID.test(threadId) ||
    !page ||
    typeof page !== "object" ||
    Array.isArray(page) ||
    typeof page.sessionId !== "string" ||
    !SESSION_ID.test(page.sessionId) ||
    typeof page.label !== "string" ||
    !page.label.trim() ||
    page.label.length > 500
  ) {
    throw new TypeError("A threaded turn requires a valid threadId and page");
  }
  return {
    threadId,
    page: { sessionId: page.sessionId, label: page.label.trim() },
  };
}

function normalizeTurnContext(context, threadId) {
  if (context === undefined) return undefined;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("turn.context must be an object when supplied");
  }
  const keys = Object.keys(context);
  if (keys.length !== 1 || keys[0] !== "selectionTurnId") {
    throw new TypeError("turn.context only supports selectionTurnId");
  }
  const selectionTurnId = context.selectionTurnId;
  if (
    selectionTurnId !== null &&
    (typeof selectionTurnId !== "string" || selectionTurnId.length === 0)
  ) {
    throw new TypeError("turn.context.selectionTurnId must be a turn id or null");
  }
  if (threadId === undefined && selectionTurnId === null) {
    throw new TypeError("Only a threaded turn can explicitly reset visual context");
  }
  return { selectionTurnId };
}

function normalizeTurn(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
    throw new TypeError("turn must be an object");
  }
  if (turn.role !== "user" && turn.role !== "assistant") {
    throw new TypeError("turn.role must be 'user' or 'assistant'");
  }
  const content = turn.content ?? turn.body;
  if (typeof content !== "string" || content.length === 0) {
    throw new TypeError("turn.content must be a non-empty string");
  }
  const id = turn.id ?? `turn_${randomUUID()}`;
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("turn.id must be a non-empty string");
  }
  const replyToTurnId = turn.replyToTurnId;
  if (
    replyToTurnId !== undefined &&
    (typeof replyToTurnId !== "string" || replyToTurnId.length === 0)
  ) {
    throw new TypeError("turn.replyToTurnId must be a non-empty string when supplied");
  }
  if (replyToTurnId !== undefined && turn.role !== "assistant") {
    throw new TypeError("Only an assistant turn can reply to a question");
  }
  const response = turn.response === undefined
    ? undefined
    : normalizeResponseState(turn.response, turn.role);
  const thread = normalizeTurnPage(turn.page, turn.threadId);
  const threadSequence = turn.threadSequence;
  if (
    threadSequence !== undefined &&
    (!Number.isSafeInteger(threadSequence) || threadSequence < 0 || thread === undefined)
  ) {
    throw new TypeError("turn.threadSequence must be a non-negative integer on a threaded turn");
  }
  const suppliedContext = normalizeTurnContext(turn.context, thread?.threadId);
  return {
    id,
    role: turn.role,
    content,
    createdAt: turn.createdAt ?? new Date().toISOString(),
    suppliedSelection: turn.selection ?? {},
    ...(thread === undefined ? {} : thread),
    ...(threadSequence === undefined ? {} : { threadSequence }),
    ...(suppliedContext === undefined ? {} : { suppliedContext }),
    ...(replyToTurnId === undefined ? {} : { replyToTurnId }),
    ...(response === undefined ? {} : { response }),
  };
}

function conversationTurns(session) {
  if (Array.isArray(session?.conversation)) return session.conversation;
  return Array.isArray(session?.conversation?.turns)
    ? session.conversation.turns
    : [];
}

function normalizeResponseState(response, role = "user") {
  if (role !== "user") {
    throw new TypeError("Only a user question can have response state");
  }
  const value = cloneJson(response, "turn response");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("turn.response must be an object");
  }
  if (!RESPONSE_STATUSES.has(value.status)) {
    throw new TypeError(`Unsupported response status: ${String(value.status)}`);
  }
  if (
    value.errorCode !== undefined &&
    (typeof value.errorCode !== "string" ||
      !RESPONSE_ERROR_CODE.test(value.errorCode))
  ) {
    throw new TypeError(
      "turn.response.errorCode must be a safe lowercase error code",
    );
  }
  value.route = normalizeResponseRoute(value.route);
  return value;
}

function responseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function linkedAnswerFor(session, questionId) {
  return conversationTurns(session).find(
    (turn) =>
      turn?.role === "assistant" && turn.replyToTurnId === questionId,
  );
}

function hasActiveResponseJob(session, exceptQuestionId, threadId) {
  return conversationTurns(session).some(
    (turn) =>
      turn?.role === "user" &&
      turn.id !== exceptQuestionId &&
      turn.threadId === threadId &&
      (turn.response?.status === "queued" ||
        turn.response?.status === "running") &&
      !linkedAnswerFor(session, turn.id),
  );
}

function responseQuestionFor(session, questionId) {
  if (typeof questionId !== "string" || questionId.length === 0) {
    throw new TypeError("questionId must be a non-empty string");
  }
  const question = conversationTurns(session).find(
    (turn) => turn?.id === questionId,
  );
  if (!isExactUserQuestion(question)) {
    throw responseError(
      "QUESTION_NOT_FOUND",
      `Response question not found: ${questionId}`,
    );
  }
  return question;
}

function publicResponseStatus(response) {
  if (
    !response ||
    typeof response !== "object" ||
    !RESPONSE_STATUSES.has(response.status)
  ) {
    return null;
  }
  return {
    status: response.status,
    route: publicResponseRoute(response.route),
    ...(typeof response.errorCode === "string" &&
    RESPONSE_ERROR_CODE.test(response.errorCode)
      ? { errorCode: response.errorCode }
      : {}),
  };
}

/** Return only the response fields that are safe to expose in the viewer. */
export function safeQuestionResponse(response) {
  return publicResponseStatus(response);
}

function isExactUserQuestion(turn) {
  return (
    turn?.role === "user" &&
    typeof turn.id === "string" &&
    turn.id.length > 0 &&
    typeof turn.selection?.id === "string" &&
    turn.selection.id.length > 0
  );
}

/**
 * Return the first exact browser question that has no linked assistant reply.
 * Conversation insertion order is the queue order; timestamps are descriptive
 * and deliberately do not reorder persisted turns.
 */
export function oldestUnansweredQuestion(session) {
  const turns = conversationTurns(session);
  const answered = new Set(
    turns
      .filter(
        (turn) =>
          turn?.role === "assistant" &&
          typeof turn.replyToTurnId === "string" &&
          turn.replyToTurnId.length > 0,
      )
      .map((turn) => turn.replyToTurnId),
  );

  for (let index = 0; index < turns.length; index += 1) {
    const question = turns[index];
    if (!isExactUserQuestion(question) || answered.has(question.id)) continue;
    const pending = cloneJson(question, "pending question");
    pending.selection = questionReplySelection(session, question);
    return pending;
  }
  return null;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function pendingQuestionOrder(left, right) {
  const leftCreatedAt = Date.parse(left.question.createdAt);
  const rightCreatedAt = Date.parse(right.question.createdAt);
  const leftTime = Number.isFinite(leftCreatedAt)
    ? leftCreatedAt
    : Number.POSITIVE_INFINITY;
  const rightTime = Number.isFinite(rightCreatedAt)
    ? rightCreatedAt
    : Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime - rightTime;

  const createdAtOrder = compareText(
    typeof left.question.createdAt === "string" ? left.question.createdAt : "",
    typeof right.question.createdAt === "string" ? right.question.createdAt : "",
  );
  if (createdAtOrder) return createdAtOrder;

  const sessionOrder = compareText(left.sessionId, right.sessionId);
  if (sessionOrder) return sessionOrder;
  return compareText(left.question.id, right.question.id);
}

export async function storedSessionIds(root) {
  const directory = sessionsDirectory(root);
  await assertSafeWritePath(root, directory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .filter((sessionId) => SESSION_ID.test(sessionId))
    .sort(compareText);
}

/**
 * Return the oldest unanswered browser question anywhere in one Attend
 * project. Each session contributes its insertion-ordered queue head; those
 * heads are ordered by question creation time with stable identifier ties.
 */
export async function oldestUnansweredQuestionAcrossSessions({ root } = {}) {
  const candidates = [];
  for (const sessionId of await storedSessionIds(root)) {
    let session;
    try {
      session = await loadSession({ root, sessionId });
    } catch (error) {
      // A session can be removed after directory discovery without making the
      // remaining project queue invalid.
      if (error?.code === "SESSION_NOT_FOUND") continue;
      throw error;
    }
    if (session?.id !== sessionId) {
      const error = new Error(
        `Session file ${sessionId}.json identifies a different session`,
      );
      error.code = "INVALID_SESSION";
      throw error;
    }
    const question = oldestUnansweredQuestion(session);
    if (question) candidates.push({ sessionId, session, question });
  }
  candidates.sort(pendingQuestionOrder);
  return candidates[0] ?? null;
}

function replyTarget(session, entry) {
  const turns = conversationTurns(session);
  const question = turns.find((turn) => turn?.id === entry.replyToTurnId);
  if (!isExactUserQuestion(question)) {
    const error = new Error(`Pending question not found: ${entry.replyToTurnId}`);
    error.code = "QUESTION_NOT_FOUND";
    throw error;
  }
  if (
    turns.some(
      (turn) =>
        turn?.role === "assistant" &&
        turn.replyToTurnId === question.id,
    )
  ) {
    const error = new Error(`Pending question is already answered: ${question.id}`);
    error.code = "QUESTION_ALREADY_ANSWERED";
    throw error;
  }
  const suppliedSelectionId = entry.suppliedSelection?.id;
  const contextSelection = questionReplySelection(session, question);
  if (
    typeof suppliedSelectionId !== "string" ||
    suppliedSelectionId !== contextSelection.id
  ) {
    const error = new Error(
      `Reply selection does not match pending question ${question.id}`,
    );
    error.code = "QUESTION_SELECTION_MISMATCH";
    throw error;
  }
  return question;
}

export async function appendConversationTurns({
  root,
  sessionId,
  expectedRevision,
  turns,
  consumeSelectedIds = false,
} = {}) {
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new TypeError("turns must be a non-empty array");
  }
  const entries = turns.map(normalizeTurn);
  if (typeof consumeSelectedIds !== "boolean") {
    throw new TypeError("consumeSelectedIds must be a boolean");
  }
  if (
    consumeSelectedIds &&
    (entries.length !== 1 ||
      entries[0].role !== "user" ||
      entries[0].replyToTurnId !== undefined)
  ) {
    throw new TypeError(
      "consumeSelectedIds requires exactly one user question",
    );
  }

  return mutateSession({
    root,
    sessionId: validateSessionId(sessionId),
    expectedRevision,
    mutate(session) {
      let consumedSelection = null;
      if (consumeSelectedIds) {
        consumedSelection = buildArtifactSelection(session.dataPackage, session.state);
        if (entries[0].suppliedSelection?.id !== consumedSelection.id) {
          const mismatch = new Error(
            "Consumed selection does not match the current session selection",
          );
          mismatch.code = "SELECTION_MISMATCH";
          throw mismatch;
        }
      }
      if (!session.conversation || typeof session.conversation !== "object") {
        session.conversation = { turns: [] };
      }
      if (!Array.isArray(session.conversation.turns)) {
        session.conversation.turns = [];
      }
      const existing = new Set(
        session.conversation.turns.map((item) => item.id),
      );
      for (const entry of entries) {
        if (entry.page && entry.page.sessionId !== session.id) {
          throw new TypeError("A threaded turn page must match its owning session");
        }
        if (
          entry.role === "user" &&
          entry.response?.status === "queued" &&
          hasActiveResponseJob(session, undefined, entry.threadId)
        ) {
          throw responseError(
            "ACTIVE_RESPONSE_EXISTS",
            "This session already has an active response job",
          );
        }
        if (existing.has(entry.id)) {
          const duplicate = new Error(
            `Conversation turn already exists: ${entry.id}`,
          );
          duplicate.code = "TURN_EXISTS";
          throw duplicate;
        }
        existing.add(entry.id);
        const question = entry.replyToTurnId
          ? replyTarget(session, entry)
          : null;
        const turnSelection = question
          ? questionReplySelection(session, question)
          : snapshot(
              session,
              consumedSelection ?? entry.suppliedSelection,
            );
        const storedTurn = {
          id: entry.id,
          role: entry.role,
          content: entry.content,
          createdAt: entry.createdAt,
          selection: cloneJson(turnSelection, "turn selection"),
          ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
          ...(entry.threadSequence === undefined
            ? {}
            : { threadSequence: entry.threadSequence }),
          ...(entry.page === undefined
            ? {}
            : { page: cloneJson(entry.page, "turn page") }),
          ...(question ? { replyToTurnId: question.id } : {}),
          ...(entry.response === undefined
            ? {}
            : { response: cloneJson(entry.response, "turn response") }),
        };
        if (entry.role === "user") {
          const priorQuestions = session.conversation.turns.filter(
            (turn) =>
              turn?.role === "user" &&
              turn.threadId === entry.threadId &&
              turn.page?.sessionId === entry.page?.sessionId,
          );
          const priorQuestion = priorQuestions.at(-1);
          const priorOrigin = priorQuestion
            ? contextSelectionOrigin(session.conversation.turns, priorQuestion)
            : null;
          let selectionTurnId = null;
          if (selectionCarriesVisualContext(turnSelection)) {
            selectionTurnId = entry.id;
          } else if (entry.suppliedContext !== undefined) {
            const requested = entry.suppliedContext.selectionTurnId;
            if (requested !== null) {
              const requestedQuestion = session.conversation.turns.find(
                (turn) => turn?.role === "user" && turn.id === requested,
              );
              const requestedOrigin = requestedQuestion
                ? contextSelectionOrigin(session.conversation.turns, requestedQuestion)
                : null;
              if (
                !requestedQuestion ||
                requestedQuestion.threadId !== entry.threadId ||
                requestedQuestion.page?.sessionId !== entry.page?.sessionId ||
                !requestedOrigin
              ) {
                throw new TypeError("turn context does not belong to the same chat and page");
              }
              selectionTurnId = requestedOrigin.id;
            }
          } else if (entry.threadId === undefined) {
            selectionTurnId = priorOrigin?.id ?? null;
          }
          if (selectionTurnId !== null || entry.threadId !== undefined) {
            storedTurn.context = { selectionTurnId };
          }
        }
        session.conversation.turns.push(storedTurn);
        if (question?.response) {
          const now = new Date().toISOString();
          question.response = {
            ...question.response,
            status: "completed",
            completedAt: now,
            updatedAt: now,
            answerTurnId: entry.id,
          };
          delete question.response.errorCode;
        }
      }
      // A browser selection is displayed as a one-message attachment. Snapshot
      // it while the selected state is current, then consume only the staged
      // mark ids in this same mutation. The user turn's context pointer keeps
      // the latest relevant immutable attachment active for normal follow-ups.
      // Filters, sorting, query, and historical snapshots remain unchanged.
      if (consumeSelectedIds) {
        session.state = clearArtifactSelection(session.dataPackage, session.state);
      }
      return session;
    },
  });
}

export async function appendConversationTurn(options = {}) {
  const { turn, ...rest } = options;
  return appendConversationTurns({ ...rest, turns: [turn] });
}

/**
 * Persist a browser question and its one-shot attachment as one queued response
 * job. The caller may enqueue work only after this promise resolves.
 */
export async function appendQueuedQuestion({
  root,
  sessionId,
  expectedRevision,
  turn,
  consumeSelectedIds = true,
  route = { kind: "detached", adapter: "codex-cli" },
} = {}) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
    throw new TypeError("turn must be an object");
  }
  if (turn.role !== "user") {
    throw new TypeError("A queued response job must belong to a user question");
  }
  if (turn.response !== undefined) {
    throw new TypeError("Queued response state is managed by Attend");
  }
  const createdAt = turn.createdAt ?? new Date().toISOString();
  const responseRoute = normalizeResponseRoute(route);
  return appendConversationTurn({
    root,
    sessionId,
    expectedRevision,
    consumeSelectedIds,
    turn: {
      ...turn,
      createdAt,
      response: {
        status: "queued",
        route: responseRoute,
        queuedAt: createdAt,
        updatedAt: createdAt,
        attempt: 0,
      },
    },
  });
}

function validateResponseErrorCode(errorCode) {
  if (typeof errorCode !== "string" || !RESPONSE_ERROR_CODE.test(errorCode)) {
    throw new TypeError(
      "errorCode must start with a lowercase letter and contain only lowercase letters, numbers, or underscores",
    );
  }
  return errorCode;
}

function lifecycleResult(result, questionId) {
  return {
    session: result.session,
    question: cloneJson(
      responseQuestionFor(result.session, questionId),
      "response question",
    ),
    changed: result.changed,
  };
}

export async function markQuestionResponseRunning({
  root,
  sessionId,
  questionId,
  route,
  adapter = "codex-cli",
} = {}) {
  const expectedRoute = normalizeResponseRoute(
    route ?? { kind: "detached", adapter },
  );
  const result = await mutateLatestSession({
    root,
    sessionId,
    mutate(session) {
      const question = responseQuestionFor(session, questionId);
      if (linkedAnswerFor(session, question.id) || question.response?.status === "completed") {
        return { changed: false };
      }
      if (question.response?.status === "running") {
        return { changed: false };
      }
      if (question.response?.status !== "queued") {
        throw responseError(
          "QUESTION_RESPONSE_NOT_RUNNABLE",
          `Question response is not queued: ${question.id}`,
        );
      }
      if (!sameResponseRoute(question.response.route, expectedRoute)) {
        throw responseError(
          "QUESTION_RESPONSE_ROUTE_MISMATCH",
          `Question is not queued for this response worker: ${question.id}`,
        );
      }
      const now = new Date().toISOString();
      question.response = {
        ...question.response,
        status: "running",
        startedAt: now,
        updatedAt: now,
        attempt:
          (Number.isSafeInteger(question.response.attempt)
            ? question.response.attempt
            : 0) + 1,
      };
      delete question.response.errorCode;
      delete question.response.failedAt;
      return { changed: true };
    },
  });
  return lifecycleResult(result, questionId);
}

export async function markQuestionResponseFailed({
  root,
  sessionId,
  questionId,
  errorCode,
} = {}) {
  const safeErrorCode = validateResponseErrorCode(errorCode);
  const result = await mutateLatestSession({
    root,
    sessionId,
    mutate(session) {
      const question = responseQuestionFor(session, questionId);
      if (linkedAnswerFor(session, question.id) || question.response?.status === "completed") {
        return { changed: false };
      }
      if (question.response?.status === "failed") {
        return { changed: false };
      }
      if (
        question.response?.status !== "queued" &&
        question.response?.status !== "running"
      ) {
        throw responseError(
          "QUESTION_RESPONSE_NOT_RUNNING",
          `Question response is not queued or running: ${question.id}`,
        );
      }
      const now = new Date().toISOString();
      question.response = {
        ...question.response,
        status: "failed",
        errorCode: safeErrorCode,
        failedAt: now,
        updatedAt: now,
      };
      return { changed: true };
    },
  });
  return lifecycleResult(result, questionId);
}

export async function retryQuestionResponse({
  root,
  sessionId,
  questionId,
  expectedRoute,
} = {}) {
  const retryRoute = expectedRoute === undefined
    ? null
    : normalizeResponseRoute(expectedRoute);
  const result = await mutateLatestSession({
    root,
    sessionId,
    mutate(session) {
      const question = responseQuestionFor(session, questionId);
      if (linkedAnswerFor(session, question.id) || question.response?.status === "completed") {
        throw responseError(
          "QUESTION_ALREADY_ANSWERED",
          `Question is already answered: ${question.id}`,
        );
      }
      if (question.response?.status !== "failed") {
        throw responseError(
          "QUESTION_RESPONSE_NOT_RETRYABLE",
          `Question response is not failed: ${question.id}`,
        );
      }
      if (
        retryRoute !== null &&
        !sameResponseRoute(question.response.route, retryRoute)
      ) {
        throw responseError(
          "QUESTION_RESPONSE_ROUTE_MISMATCH",
          `Question belongs to a different explicit chat route: ${question.id}`,
        );
      }
      if (hasActiveResponseJob(session, question.id, question.threadId)) {
        throw responseError(
          "ACTIVE_RESPONSE_EXISTS",
          "This session already has an active response job",
        );
      }
      const now = new Date().toISOString();
      question.response = {
        ...question.response,
        status: "queued",
        queuedAt: now,
        updatedAt: now,
        retryCount:
          (Number.isSafeInteger(question.response.retryCount)
            ? question.response.retryCount
            : 0) + 1,
      };
      delete question.response.errorCode;
      delete question.response.failedAt;
      delete question.response.startedAt;
      return { changed: true };
    },
  });
  return lifecycleResult(result, questionId);
}

/**
 * Append one linked answer and mark the exact question completed in the same
 * file replacement. Retrying after an uncertain outcome returns the existing
 * answer without appending a duplicate.
 */
export async function completeQuestionResponse({
  root,
  sessionId,
  questionId,
  content,
  route,
  adapter = "codex-cli",
  answerId = `turn_${randomUUID()}`,
  createdAt = new Date().toISOString(),
} = {}) {
  if (typeof content !== "string" || content.length === 0) {
    throw new TypeError("content must be a non-empty string");
  }
  if (typeof answerId !== "string" || answerId.length === 0) {
    throw new TypeError("answerId must be a non-empty string");
  }
  const result = await mutateLatestSession({
    root,
    sessionId,
    mutate(session) {
      const question = responseQuestionFor(session, questionId);
      const existingAnswer = linkedAnswerFor(session, question.id);
      if (existingAnswer) {
        if (question.response?.status !== "completed") {
          const now = new Date().toISOString();
          question.response = {
            ...(question.response ?? {}),
            status: "completed",
            answerTurnId: existingAnswer.id,
            completedAt: now,
            updatedAt: now,
          };
          delete question.response.errorCode;
          return { changed: true };
        }
        return { changed: false };
      }
      if (!question.response) {
        throw responseError(
          "QUESTION_RESPONSE_NOT_QUEUED",
          `Question has no response job: ${question.id}`,
        );
      }
      if (question.response.status === "completed") {
        throw responseError(
          "INVALID_QUESTION_RESPONSE",
          `Completed question has no linked answer: ${question.id}`,
        );
      }
      if (question.response.status !== "running") {
        throw responseError(
          "QUESTION_RESPONSE_NOT_RUNNING",
          `Question response is not running: ${question.id}`,
        );
      }
      const expectedRoute = route ?? { kind: "detached", adapter };
      if (!sameResponseRoute(question.response.route, expectedRoute)) {
        throw responseError(
          "QUESTION_RESPONSE_ROUTE_MISMATCH",
          `Question is not running through this response worker: ${question.id}`,
        );
      }
      if (conversationTurns(session).some((turn) => turn?.id === answerId)) {
        throw responseError(
          "TURN_EXISTS",
          `Conversation turn already exists: ${answerId}`,
        );
      }
      const answer = {
        id: answerId,
        role: "assistant",
        content,
        createdAt,
        selection: questionReplySelection(session, question),
        replyToTurnId: question.id,
      };
      session.conversation.turns.push(answer);
      const now = new Date().toISOString();
      question.response = {
        ...question.response,
        status: "completed",
        answerTurnId: answer.id,
        completedAt: now,
        updatedAt: now,
      };
      delete question.response.errorCode;
      delete question.response.failedAt;
      return { changed: true };
    },
  });
  const answer = linkedAnswerFor(result.session, questionId);
  return {
    ...lifecycleResult(result, questionId),
    answer: cloneJson(answer, "assistant answer"),
  };
}

/**
 * Move one exact queued host question to a replacement host attachment. The
 * caller proves the replacement attachment before entering this store. This
 * transition never changes the question, its frozen selection, or its queued
 * status. Exact retries to the same route are idempotent.
 */
export async function rebindQueuedHostQuestionResponse({
  root,
  sessionId,
  questionId,
  expectedRevision,
  route,
  beforeRebind,
} = {}) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative integer");
  }
  const targetRoute = normalizeResponseRoute(route);
  if (targetRoute.kind !== "host") {
    throw new TypeError("Host rebind requires a host response route");
  }
  if (beforeRebind !== undefined && typeof beforeRebind !== "function") {
    throw new TypeError("beforeRebind must be a function when supplied");
  }

  const result = await mutateLatestSession({
    root,
    sessionId,
    async mutate(session) {
      const question = responseQuestionFor(session, questionId);
      if (linkedAnswerFor(session, question.id) || question.response?.status === "completed") {
        throw responseError(
          "QUESTION_ALREADY_ANSWERED",
          `Question is already answered: ${question.id}`,
        );
      }
      if (question.response?.status !== "queued") {
        throw responseError(
          "QUESTION_RESPONSE_NOT_QUEUED",
          `Host question response is not queued: ${question.id}`,
        );
      }

      const currentRoute = normalizeResponseRoute(question.response.route);
      if (currentRoute.kind !== "host") {
        throw responseError(
          "QUESTION_RESPONSE_ROUTE_MISMATCH",
          `Question is not bound to a host attachment: ${question.id}`,
        );
      }
      if (sameResponseRoute(currentRoute, targetRoute)) {
        return { changed: false, value: { repeated: true } };
      }
      if (session.state?.revision !== expectedRevision) {
        throw new SessionConflictError({
          sessionId: session.id,
          expectedRevision,
          actualRevision: session.state?.revision,
        });
      }
      await beforeRebind?.({
        currentRoute,
        targetRoute,
        sessionId: session.id,
        questionId: question.id,
      });
      const replySelection = questionReplySelection(session, question);
      if (typeof replySelection?.id !== "string" || replySelection.id.length === 0) {
        throw responseError(
          "QUESTION_SELECTION_MISMATCH",
          `Queued question has no frozen reply selection: ${question.id}`,
        );
      }

      const now = new Date().toISOString();
      question.response = {
        ...question.response,
        route: targetRoute,
        reboundAt: now,
        updatedAt: now,
        rebindCount:
          (Number.isSafeInteger(question.response.rebindCount)
            ? question.response.rebindCount
            : 0) + 1,
      };
      return { changed: true, value: { repeated: false } };
    },
  });

  return {
    ...lifecycleResult(result, questionId),
    repeated: result.value?.repeated === true,
  };
}

/**
 * Commit an answer produced inside the attached host conversation. Reading a
 * host packet never claims or starts the job, so this is the only host-side
 * response transition. Exact replays are idempotent; a different answer or a
 * stale visualization is rejected under the same session lock.
 */
export async function completeHostQuestionResponse({
  root,
  sessionId,
  questionId,
  expectedRevision,
  expectedSelectionId,
  route,
  content,
  createdAt = new Date().toISOString(),
} = {}) {
  if (
    typeof content !== "string" ||
    content.length === 0 ||
    content.includes("\0") ||
    Buffer.byteLength(content, "utf8") > 64 * 1024
  ) {
    throw new TypeError("content must be a non-empty string of at most 64 KiB");
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative integer");
  }
  if (typeof expectedSelectionId !== "string" || expectedSelectionId.length === 0) {
    throw new TypeError("expectedSelectionId must be a non-empty string");
  }
  const expectedRoute = normalizeResponseRoute(route);
  if (expectedRoute.kind !== "host") {
    throw new TypeError("Host completion requires a host response route");
  }
  const answerDigest = createHash("sha256").update(content).digest("hex");
  const answerId = `turn_host_${createHash("sha256")
    .update(`${questionId}\0${answerDigest}`)
    .digest("hex")
    .slice(0, 16)}`;

  const result = await mutateLatestSession({
    root,
    sessionId,
    mutate(session) {
      const question = responseQuestionFor(session, questionId);
      if (!sameResponseRoute(question.response?.route, expectedRoute)) {
        throw responseError(
          "QUESTION_RESPONSE_ROUTE_MISMATCH",
          `Question is not bound to this host attachment: ${question.id}`,
        );
      }

      const existingAnswer = linkedAnswerFor(session, question.id);
      if (existingAnswer) {
        if (
          question.response?.status === "completed" &&
          question.response.answerDigest === answerDigest &&
          existingAnswer.content === content
        ) {
          return { changed: false, value: { repeated: true } };
        }
        throw responseError(
          "QUESTION_ALREADY_ANSWERED",
          `Question is already answered: ${question.id}`,
        );
      }

      if (session.state?.revision !== expectedRevision) {
        throw new SessionConflictError({
          sessionId: session.id,
          expectedRevision,
          actualRevision: session.state?.revision,
        });
      }
      const replySelection = questionReplySelection(session, question);
      if (replySelection?.id !== expectedSelectionId) {
        throw responseError(
          "QUESTION_SELECTION_MISMATCH",
          `Reply selection does not match pending question ${question.id}`,
        );
      }
      if (question.response?.status !== "queued") {
        throw responseError(
          "QUESTION_RESPONSE_NOT_QUEUED",
          `Host question response is not queued: ${question.id}`,
        );
      }
      if (conversationTurns(session).some((turn) => turn?.id === answerId)) {
        throw responseError("TURN_EXISTS", `Conversation turn already exists: ${answerId}`);
      }

      const answer = {
        id: answerId,
        role: "assistant",
        content,
        createdAt,
        selection: cloneJson(replySelection, "host reply selection"),
        replyToTurnId: question.id,
      };
      session.conversation.turns.push(answer);
      const now = new Date().toISOString();
      question.response = {
        ...question.response,
        status: "completed",
        answerTurnId: answer.id,
        answerDigest,
        completedAt: now,
        updatedAt: now,
      };
      delete question.response.errorCode;
      delete question.response.failedAt;
      return { changed: true, value: { repeated: false } };
    },
  });

  return {
    ...lifecycleResult(result, questionId),
    answer: cloneJson(linkedAnswerFor(result.session, questionId), "assistant answer"),
    repeated: result.value?.repeated === true,
  };
}

/** Read one response job with its immutable active conversation context. */
export async function loadQuestionResponseContext({
  root,
  sessionId,
  questionId,
} = {}) {
  const session = await loadSession({ root, sessionId });
  const question = responseQuestionFor(session, questionId);
  if (linkedAnswerFor(session, question.id) || question.response?.status === "completed") {
    throw responseError(
      "QUESTION_ALREADY_ANSWERED",
      `Question is already answered: ${question.id}`,
    );
  }
  if (!question.response) {
    throw responseError(
      "QUESTION_RESPONSE_NOT_QUEUED",
      `Question has no response job: ${question.id}`,
    );
  }
  const visualContext = questionVisualContext(session, question);
  return {
    session: cloneJson(session, "session"),
    question: cloneJson(question, "response question"),
    visualContext: visualContext.selection,
    visualContextBinding: {
      mode: visualContext.mode,
      selectionTurnId: visualContext.selectionTurnId,
    },
    conversation: cloneJson(conversationTurns(session), "conversation"),
  };
}

/** Enumerate every recoverable response job; never select only a queue head. */
export async function pendingQuestionResponseJobs({ root } = {}) {
  const candidates = [];
  for (const sessionId of await storedSessionIds(root)) {
    let session;
    try {
      session = await loadSession({ root, sessionId });
    } catch (error) {
      if (error?.code === "SESSION_NOT_FOUND") continue;
      throw error;
    }
    const answered = new Set(
      conversationTurns(session)
        .filter(
          (turn) =>
            turn?.role === "assistant" &&
            typeof turn.replyToTurnId === "string",
        )
        .map((turn) => turn.replyToTurnId),
    );
    for (const question of conversationTurns(session)) {
      if (
        !isExactUserQuestion(question) ||
        answered.has(question.id) ||
        (question.response?.status !== "queued" &&
          question.response?.status !== "running")
      ) {
        continue;
      }
      const legacyRouteMissing = question.response.route === undefined;
      candidates.push({
        sessionId,
        questionId: question.id,
        status: question.response.status,
        route: legacyRouteMissing
          ? null
          : normalizeResponseRoute(question.response.route),
        ...(legacyRouteMissing ? { legacyRouteMissing: true } : {}),
        createdAt:
          typeof question.createdAt === "string" ? question.createdAt : "",
      });
    }
  }
  candidates.sort((left, right) => {
    const createdAt = compareText(left.createdAt, right.createdAt);
    if (createdAt) return createdAt;
    const sessionId = compareText(left.sessionId, right.sessionId);
    if (sessionId) return sessionId;
    return compareText(left.questionId, right.questionId);
  });
  return candidates.map(({
    sessionId,
    questionId,
    status,
    route,
    legacyRouteMissing,
  }) => ({
    sessionId,
    questionId,
    status,
    route,
    ...(legacyRouteMissing ? { legacyRouteMissing: true } : {}),
  }));
}

export const sessionPaths = Object.freeze({ directory: SESSION_DIRECTORY });
