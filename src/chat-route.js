import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  readdir,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  assertSafeWritePath,
  readJson,
  writeJsonAtomic,
} from "./project.js";
import { LOCAL_MODEL } from "./local-model.js";
import { withSessionResponseLock } from "./session-store.js";

const CHAT_ROUTE_SCHEMA_VERSION = 1;
const HOST_ATTACHMENT_SCHEMA_VERSION = 1;
const HOST_LISTENER_SCHEMA_VERSION = 1;
const CHAT_DIRECTORY = ".attend/local/chat";
const DEFAULT_ATTACHMENT_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1_000;
const LISTENER_PRESENCE_TTL_MS = 5_000;
const DEFAULT_ANSWER_LEASE_TTL_MS = 30 * 60 * 1_000;
const HOST_ATTACHMENT_ID = /^host_[a-f0-9]{16}$/u;
const HOST_LISTENER_ID = /^listener_[a-f0-9]{16}$/u;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const TICKET_SECRET = /^[A-Za-z0-9_-]{43}$/u;
const TICKET_DIGEST = /^[a-f0-9]{64}$/u;
const DETACHED_ADAPTERS = new Set(["codex-cli", "claude-cli"]);

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function projectRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("root must be a non-empty path");
  }
  return resolve(root);
}

function timeValue(now = new Date()) {
  const milliseconds = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(milliseconds)) throw new TypeError("now must be a valid time");
  return milliseconds;
}

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    throw new TypeError(
      "sessionId must contain only letters, numbers, dots, underscores, or hyphens",
    );
  }
  return sessionId;
}

function validateAttachmentTtl(ttlMs) {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1_000 ||
    ttlMs > MAX_ATTACHMENT_TTL_MS
  ) {
    throw new TypeError(
      `ttlMs must be an integer between 1000 and ${MAX_ATTACHMENT_TTL_MS}`,
    );
  }
  return ttlMs;
}

function normalizeConfiguredRoute(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new TypeError("route must be an object");
  }
  if (route.kind === "host") return Object.freeze({ kind: "host" });
  if (route.kind === "local" && route.model === LOCAL_MODEL.id) {
    return Object.freeze({ kind: "local", model: LOCAL_MODEL.id });
  }
  if (route.kind === "detached" && DETACHED_ADAPTERS.has(route.adapter)) {
    return Object.freeze({ kind: "detached", adapter: route.adapter });
  }
  throw new TypeError("route must select gpt-oss-20b, host, codex-cli, or claude-cli");
}

export function normalizeBoundChatRoute(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new TypeError("route must be an object");
  }
  if (route.kind === "host") {
    if (
      !HOST_ATTACHMENT_ID.test(route.attachmentId ?? "") ||
      !Number.isSafeInteger(route.generation) ||
      route.generation < 1
    ) {
      throw new TypeError(
        "A host route requires a valid attachmentId and positive generation",
      );
    }
    return Object.freeze({
      kind: "host",
      attachmentId: route.attachmentId,
      generation: route.generation,
    });
  }
  return normalizeConfiguredRoute(route);
}

export function sameChatRoute(left, right) {
  let a;
  let b;
  try {
    a = normalizeBoundChatRoute(left);
    b = normalizeBoundChatRoute(right);
  } catch {
    return false;
  }
  if (a.kind !== b.kind) return false;
  if (a.kind === "host") {
    return a.attachmentId === b.attachmentId && a.generation === b.generation;
  }
  if (a.kind === "local") return a.model === b.model;
  return a.adapter === b.adapter;
}

export function chatRoutePaths(root) {
  const directory = join(projectRoot(root), CHAT_DIRECTORY);
  return Object.freeze({
    directory,
    route: join(directory, "route.json"),
    attachments: join(directory, "attachments"),
    listeners: join(directory, "listeners"),
  });
}

function attachmentPath(root, attachmentId) {
  if (!HOST_ATTACHMENT_ID.test(attachmentId ?? "")) {
    throw new TypeError("attachmentId is invalid");
  }
  return join(chatRoutePaths(root).attachments, `${attachmentId}.json`);
}

function listenerDirectory(root, attachmentId) {
  if (!HOST_ATTACHMENT_ID.test(attachmentId ?? "")) {
    throw new TypeError("attachmentId is invalid");
  }
  return join(chatRoutePaths(root).listeners, attachmentId);
}

function listenerPath(root, attachmentId, listenerId) {
  if (!HOST_LISTENER_ID.test(listenerId ?? "")) {
    throw new TypeError("listenerId is invalid");
  }
  return join(listenerDirectory(root, attachmentId), `${listenerId}.json`);
}

async function readOptionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Read the machine-local preference. Private gpt-oss-20b is the default. */
export async function readChatRoute({ root } = {}) {
  const stored = await readOptionalJson(chatRoutePaths(root).route);
  if (!stored) return Object.freeze({ kind: "local", model: LOCAL_MODEL.id });
  if (stored.schemaVersion !== CHAT_ROUTE_SCHEMA_VERSION) {
    throw routeError("CHAT_ROUTE_INVALID", "Attend's local chat route is invalid");
  }
  try {
    return normalizeConfiguredRoute(stored);
  } catch (cause) {
    const error = routeError("CHAT_ROUTE_INVALID", "Attend's local chat route is invalid");
    error.cause = cause;
    throw error;
  }
}

/** Persist only an explicit machine-wide preference, never a per-question capability. */
export async function setChatRoute({ root, route } = {}) {
  const normalized = normalizeConfiguredRoute(route);
  const path = chatRoutePaths(root).route;
  await writeJsonAtomic(path, {
    schemaVersion: CHAT_ROUTE_SCHEMA_VERSION,
    ...normalized,
    updatedAt: new Date().toISOString(),
  }, { root: projectRoot(root) });
  return normalized;
}

/**
 * Resolve the route that a newly persisted question must snapshot. An exact
 * hostRoute binds a browser opened by one agent to that attachment. Callers
 * may require that binding instead of selecting the newest live attachment.
 * Detached preferences are already complete.
 */
export async function resolveChatRoute({
  root,
  sessionId,
  hostRoute,
  requireHostRoute = false,
  now = new Date(),
} = {}) {
  const safeSessionId = validateSessionId(sessionId);
  const checkedAt = timeValue(now);
  if (hostRoute !== undefined && hostRoute !== null) {
    let requested;
    try {
      requested = normalizeBoundChatRoute(hostRoute);
    } catch {
      return null;
    }
    if (requested.kind !== "host") return null;
    const storedValue = await readOptionalJson(
      attachmentPath(root, requested.attachmentId),
    );
    let stored;
    try {
      stored = storedValue
        ? validateStoredAttachment(storedValue, requested.attachmentId)
        : null;
    } catch {
      return null;
    }
    if (
      !stored ||
      stored.sessionId !== safeSessionId ||
      stored.generation !== requested.generation ||
      Date.parse(stored.expiresAt) <= checkedAt
    ) {
      return null;
    }
    return attachmentRoute(stored);
  }

  const configured = await readChatRoute({ root });
  if (configured.kind === "detached" || configured.kind === "local") return configured;
  if (requireHostRoute) return null;

  const directory = chatRoutePaths(root).attachments;
  await assertSafeWritePath(projectRoot(root), directory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const attachmentId = entry.name.slice(0, -5);
    if (!HOST_ATTACHMENT_ID.test(attachmentId)) continue;
    let value;
    try {
      value = validateStoredAttachment(
        await readJson(join(directory, entry.name)),
        attachmentId,
      );
    } catch {
      continue;
    }
    if (
      value.sessionId === safeSessionId &&
      Date.parse(value.expiresAt) > checkedAt
    ) {
      candidates.push(value);
    }
  }
  candidates.sort((left, right) => {
    const createdAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (createdAt) return createdAt;
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  });
  return candidates.length ? attachmentRoute(candidates[0]) : null;
}

function ticketDigest(ticket) {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

function createTicket(attachmentId) {
  return `attend_host_v1.${attachmentId}.${randomBytes(32).toString("base64url")}`;
}

function parseTicket(ticket) {
  if (typeof ticket !== "string") {
    throw routeError("HOST_TICKET_INVALID", "The host attachment ticket is invalid");
  }
  const [prefix, attachmentId, secret, extra] = ticket.split(".");
  if (
    prefix !== "attend_host_v1" ||
    !HOST_ATTACHMENT_ID.test(attachmentId ?? "") ||
    !TICKET_SECRET.test(secret ?? "") ||
    extra !== undefined
  ) {
    throw routeError("HOST_TICKET_INVALID", "The host attachment ticket is invalid");
  }
  return { attachmentId };
}

function validateStoredAttachment(value, expectedId) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== HOST_ATTACHMENT_SCHEMA_VERSION ||
    value.kind !== "attend-host-attachment" ||
    value.id !== expectedId ||
    !HOST_ATTACHMENT_ID.test(value.id ?? "") ||
    !SESSION_ID.test(value.sessionId ?? "") ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !TICKET_DIGEST.test(value.ticketDigest ?? "") ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw routeError("HOST_ATTACHMENT_INVALID", "The host attachment record is invalid");
  }
  return value;
}

function safeAttachment(value) {
  return Object.freeze({
    id: value.id,
    sessionId: value.sessionId,
    generation: value.generation,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  });
}

function attachmentRoute(value) {
  return Object.freeze({
    kind: "host",
    attachmentId: value.id,
    generation: value.generation,
  });
}

/**
 * Create one capability for the agent conversation opening a visualization.
 * Only its digest is persisted; the raw ticket is returned once.
 */
export async function registerHostAttachment({
  root,
  sessionId,
  ttlMs = DEFAULT_ATTACHMENT_TTL_MS,
  now = new Date(),
} = {}) {
  const boundary = projectRoot(root);
  const safeSessionId = validateSessionId(sessionId);
  const lifetime = validateAttachmentTtl(ttlMs);
  const createdAtMs = timeValue(now);
  const attachmentId = `host_${randomBytes(8).toString("hex")}`;
  const ticket = createTicket(attachmentId);
  const record = {
    schemaVersion: HOST_ATTACHMENT_SCHEMA_VERSION,
    kind: "attend-host-attachment",
    id: attachmentId,
    sessionId: safeSessionId,
    generation: 1,
    ticketDigest: ticketDigest(ticket),
    createdAt: isoTime(createdAtMs),
    expiresAt: isoTime(createdAtMs + lifetime),
  };
  await writeJsonAtomic(attachmentPath(boundary, attachmentId), record, {
    root: boundary,
  });
  return Object.freeze({
    route: attachmentRoute(record),
    ticket,
    attachment: safeAttachment(record),
  });
}

/** Resolve the current route for `view`, attaching only in default host mode. */
export async function registerChatAttachment(options = {}) {
  const configured = await readChatRoute(options);
  if (configured.kind === "detached" || configured.kind === "local") {
    return Object.freeze({ route: configured, ticket: null, attachment: null });
  }
  return registerHostAttachment(options);
}

/** Verify capability ownership without ever returning its persisted digest. */
export async function verifyHostTicket({
  root,
  ticket,
  expectedRoute,
  now = new Date(),
} = {}) {
  const { attachmentId } = parseTicket(ticket);
  let value;
  try {
    value = await readJson(attachmentPath(root, attachmentId));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw routeError("HOST_TICKET_INVALID", "The host attachment ticket is invalid");
    }
    throw error;
  }
  const stored = validateStoredAttachment(value, attachmentId);
  const actual = Buffer.from(ticketDigest(ticket), "hex");
  const expected = Buffer.from(stored.ticketDigest, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw routeError("HOST_TICKET_INVALID", "The host attachment ticket is invalid");
  }
  if (Date.parse(stored.expiresAt) <= timeValue(now)) {
    throw routeError("HOST_ATTACHMENT_EXPIRED", "The host attachment has expired");
  }
  const route = attachmentRoute(stored);
  if (expectedRoute !== undefined && !sameChatRoute(route, expectedRoute)) {
    throw routeError(
      "HOST_ATTACHMENT_MISMATCH",
      "The host ticket does not own this question route",
    );
  }
  return Object.freeze({ route, attachment: safeAttachment(stored) });
}

function validateListener(value, { attachmentId, listenerId } = {}) {
  const phase = value?.phase ?? "waiting";
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schemaVersion === HOST_LISTENER_SCHEMA_VERSION &&
    value.kind === "attend-host-listener" &&
    value.attachmentId === attachmentId &&
    value.id === listenerId &&
    HOST_LISTENER_ID.test(value.id ?? "") &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    Number.isFinite(Date.parse(value.heartbeatAt)) &&
    Number.isFinite(Date.parse(value.presenceExpiresAt)) &&
    Number.isFinite(Date.parse(value.waitExpiresAt)) &&
    (
      phase === "waiting" && value.questionId === undefined ||
      phase === "delivered" &&
        typeof value.questionId === "string" &&
        value.questionId.length > 0 &&
        value.questionId.length <= 128
    ),
  );
}

function listenerRecord(attachment, listenerId, startedAtMs, waitExpiresAtMs, nowMs) {
  return {
    schemaVersion: HOST_LISTENER_SCHEMA_VERSION,
    kind: "attend-host-listener",
    id: listenerId,
    attachmentId: attachment.id,
    generation: attachment.generation,
    phase: "waiting",
    startedAt: isoTime(startedAtMs),
    heartbeatAt: isoTime(nowMs),
    presenceExpiresAt: isoTime(
      Math.min(nowMs + LISTENER_PRESENCE_TTL_MS, waitExpiresAtMs),
    ),
    waitExpiresAt: isoTime(waitExpiresAtMs),
  };
}

function answerLeaseRecord(
  attachment,
  listenerId,
  questionId,
  startedAtMs,
  nowMs,
  expiresAtMs,
) {
  return {
    schemaVersion: HOST_LISTENER_SCHEMA_VERSION,
    kind: "attend-host-listener",
    id: listenerId,
    attachmentId: attachment.id,
    generation: attachment.generation,
    phase: "delivered",
    questionId,
    startedAt: isoTime(startedAtMs),
    heartbeatAt: isoTime(nowMs),
    presenceExpiresAt: isoTime(expiresAtMs),
    waitExpiresAt: isoTime(expiresAtMs),
  };
}

export async function beginHostListener({
  root,
  ticket,
  waitExpiresAt,
  now = new Date(),
} = {}) {
  const boundary = projectRoot(root);
  const verified = await verifyHostTicket({ root: boundary, ticket, now });
  return withSessionResponseLock({
    root: boundary,
    sessionId: verified.attachment.sessionId,
    async operation() {
      const startedAtMs = timeValue(now);
      const suppliedDeadline = timeValue(waitExpiresAt);
      const attachmentDeadline = Date.parse(verified.attachment.expiresAt);
      const deadline = Math.min(suppliedDeadline, attachmentDeadline);
      if (deadline <= startedAtMs) {
        throw new TypeError("waitExpiresAt must be in the future");
      }
      const listenerId = `listener_${randomBytes(8).toString("hex")}`;
      const record = listenerRecord(
        verified.attachment,
        listenerId,
        startedAtMs,
        deadline,
        startedAtMs,
      );
      await writeJsonAtomic(
        listenerPath(boundary, verified.attachment.id, listenerId),
        record,
        { root: boundary },
      );
      return Object.freeze({
        id: listenerId,
        route: verified.route,
        attachment: verified.attachment,
        startedAt: record.startedAt,
        waitExpiresAt: record.waitExpiresAt,
      });
    },
  });
}

export async function refreshHostListener({
  root,
  ticket,
  listener,
  now = new Date(),
} = {}) {
  if (!listener || typeof listener !== "object") {
    throw new TypeError("listener is required");
  }
  const verified = await verifyHostTicket({
    root,
    ticket,
    expectedRoute: listener.route,
    now,
  });
  const boundary = projectRoot(root);
  return withSessionResponseLock({
    root: boundary,
    sessionId: verified.attachment.sessionId,
    async operation() {
      const path = listenerPath(boundary, verified.attachment.id, listener.id);
      const existing = await readOptionalJson(path);
      if (!validateListener(existing, {
        attachmentId: verified.attachment.id,
        listenerId: listener.id,
      })) {
        throw routeError("HOST_LISTENER_INVALID", "The host listener record is invalid");
      }
      const nowMs = timeValue(now);
      const deadline = Date.parse(existing.waitExpiresAt);
      if (deadline <= nowMs) {
        throw routeError("HOST_LISTENER_EXPIRED", "The host listener has expired");
      }
      const next = listenerRecord(
        verified.attachment,
        listener.id,
        Date.parse(existing.startedAt),
        deadline,
        nowMs,
      );
      await writeJsonAtomic(path, next, { root: boundary });
      return listener;
    },
  });
}

/** Replace a waiting listener with a bounded lease while its agent answers. */
export async function beginHostAnswerLease({
  root,
  ticket,
  listener = null,
  questionId,
  ttlMs = DEFAULT_ANSWER_LEASE_TTL_MS,
  now,
} = {}) {
  if (
    typeof questionId !== "string" ||
    questionId.length === 0 ||
    questionId.length > 128
  ) {
    throw new TypeError("questionId must be a non-empty string of at most 128 characters");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_ATTACHMENT_TTL_MS) {
    throw new TypeError(`ttlMs must be an integer between 1 and ${MAX_ATTACHMENT_TTL_MS}`);
  }
  const boundary = projectRoot(root);
  const verified = await verifyHostTicket({
    root: boundary,
    ticket,
    ...(now === undefined ? {} : { now }),
  });
  if (listener !== null && !sameChatRoute(listener?.route, verified.route)) {
    throw routeError(
      "HOST_ATTACHMENT_MISMATCH",
      "The waiting listener does not belong to this host attachment",
    );
  }
  return withSessionResponseLock({
    root: boundary,
    sessionId: verified.attachment.sessionId,
    includeSession: true,
    async operation({ session }) {
      const turns = Array.isArray(session?.conversation)
        ? session.conversation
        : session?.conversation?.turns ?? [];
      const question = turns.find((turn) =>
        turn?.role === "user" && turn.id === questionId);
      if (
        question?.response?.status !== "queued" ||
        !sameChatRoute(question.response.route, verified.route)
      ) {
        throw routeError(
          "HOST_QUESTION_ROUTE_CHANGED",
          "The queued question is no longer bound to this host attachment",
        );
      }
      const nowMs = now === undefined ? Date.now() : timeValue(now);
      const expiresAtMs = Math.min(
        nowMs + ttlMs,
        Date.parse(verified.attachment.expiresAt),
      );
      if (expiresAtMs <= nowMs) {
        throw routeError("HOST_ATTACHMENT_EXPIRED", "The host attachment has expired");
      }
      const listenerId = listener?.id ?? `listener_${randomBytes(8).toString("hex")}`;
      let startedAtMs = nowMs;
      if (listener !== null) {
        const existing = await readOptionalJson(
          listenerPath(boundary, verified.attachment.id, listenerId),
        );
        if (!validateListener(existing, {
          attachmentId: verified.attachment.id,
          listenerId,
        })) {
          throw routeError("HOST_LISTENER_INVALID", "The host listener record is invalid");
        }
        if (
          Date.parse(existing.presenceExpiresAt) <= nowMs ||
          Date.parse(existing.waitExpiresAt) <= nowMs
        ) {
          throw routeError("HOST_LISTENER_EXPIRED", "The host listener has expired");
        }
        startedAtMs = Date.parse(existing.startedAt);
      }
      const record = answerLeaseRecord(
        verified.attachment,
        listenerId,
        questionId,
        startedAtMs,
        nowMs,
        expiresAtMs,
      );
      await writeJsonAtomic(
        listenerPath(boundary, verified.attachment.id, listenerId),
        record,
        { root: boundary },
      );
      return Object.freeze({
        id: listenerId,
        route: verified.route,
        attachment: verified.attachment,
        phase: "delivered",
        questionId,
        startedAt: record.startedAt,
        waitExpiresAt: record.waitExpiresAt,
      });
    },
  });
}

export async function endHostListener({ root, listener } = {}) {
  if (
    !listener ||
    typeof listener !== "object" ||
    !HOST_ATTACHMENT_ID.test(listener.attachment?.id ?? "") ||
    !HOST_LISTENER_ID.test(listener.id ?? "")
  ) {
    throw new TypeError("listener is invalid");
  }
  const path = listenerPath(root, listener.attachment.id, listener.id);
  await assertSafeWritePath(projectRoot(root), path);
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

/** Clear delivered-answer leases for one completed question and host ticket. */
export async function endHostAnswerLease({
  root,
  ticket,
  questionId,
} = {}) {
  if (
    typeof questionId !== "string" ||
    questionId.length === 0 ||
    questionId.length > 128
  ) {
    throw new TypeError("questionId must be a non-empty string of at most 128 characters");
  }
  const boundary = projectRoot(root);
  const verified = await verifyHostTicket({ root: boundary, ticket });
  return withSessionResponseLock({
    root: boundary,
    sessionId: verified.attachment.sessionId,
    async operation() {
      const directory = listenerDirectory(boundary, verified.attachment.id);
      await assertSafeWritePath(boundary, directory);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const listenerId = entry.name.slice(0, -5);
        if (!HOST_LISTENER_ID.test(listenerId)) continue;
        const path = join(directory, entry.name);
        const value = await readOptionalJson(path);
        if (
          validateListener(value, {
            attachmentId: verified.attachment.id,
            listenerId,
          }) &&
          value.generation === verified.route.generation &&
          value.phase === "delivered" &&
          value.questionId === questionId
        ) {
          await unlink(path).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
        }
      }
    },
  });
}

export async function hostListenerPresence({
  root,
  route,
  now = new Date(),
} = {}) {
  const presence = await hostListenerStatus({ root, route, now });
  return Object.freeze({ present: presence.present });
}

export async function hostListenerStatus({
  root,
  route,
  questionId,
  now = new Date(),
} = {}) {
  if (
    questionId !== undefined &&
    questionId !== null &&
    (typeof questionId !== "string" || questionId.length === 0 || questionId.length > 128)
  ) {
    throw new TypeError("questionId must be null or a non-empty string of at most 128 characters");
  }
  let normalized;
  try {
    normalized = normalizeBoundChatRoute(route);
  } catch {
    return Object.freeze({ present: false, phase: null });
  }
  if (normalized.kind !== "host") {
    return Object.freeze({ present: false, phase: null });
  }

  const directory = listenerDirectory(root, normalized.attachmentId);
  await assertSafeWritePath(projectRoot(root), directory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ present: false, phase: null });
    }
    throw error;
  }
  const checkedAt = timeValue(now);
  let delivered = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const listenerId = entry.name.slice(0, -5);
    if (!HOST_LISTENER_ID.test(listenerId)) continue;
    let value;
    try {
      value = await readJson(join(directory, entry.name));
    } catch {
      continue;
    }
    if (
      validateListener(value, {
        attachmentId: normalized.attachmentId,
        listenerId,
      }) &&
      value.generation === normalized.generation &&
      Date.parse(value.presenceExpiresAt) > checkedAt &&
      Date.parse(value.waitExpiresAt) > checkedAt
    ) {
      if (value.phase !== "delivered") {
        return Object.freeze({ present: true, phase: "waiting" });
      }
      if (questionId === undefined || value.questionId === questionId) {
        delivered = true;
      }
    }
  }
  if (delivered) return Object.freeze({ present: true, phase: "delivered" });
  return Object.freeze({ present: false, phase: null });
}

/** Fixed, non-secret capability projection suitable for `/api/state`. */
export async function safeChatCapability({
  root,
  route,
  questionId = null,
  now = new Date(),
} = {}) {
  if (route?.kind === "local") {
    const normalized = normalizeBoundChatRoute(route);
    return Object.freeze({
      kind: "local",
      model: normalized.model,
      label: "Private AI on this Mac",
      availability: "configured",
      listenerPresent: false,
      disclosure: "Questions and selected evidence stay on this Mac.",
    });
  }
  if (route?.kind === "detached") {
    const normalized = normalizeBoundChatRoute(route);
    const codex = normalized.adapter === "codex-cli";
    return Object.freeze({
      kind: "detached",
      adapter: normalized.adapter,
      label: codex ? "Detached fallback: Codex CLI" : "Detached fallback: Claude CLI",
      availability: "configured",
      listenerPresent: false,
      disclosure: `Selected evidence will be sent to the detached ${codex ? "Codex" : "Claude"} CLI fallback.`,
    });
  }

  let normalized;
  try {
    normalized = normalizeBoundChatRoute(route);
  } catch {
    normalized = null;
  }
  const bound = normalized?.kind === "host";
  const presence = bound
    ? await hostListenerStatus({ root, route: normalized, questionId, now })
    : { present: false, phase: null };
  return Object.freeze({
    kind: "host",
    label: "Agent that opened this view",
    availability: presence.present ? "listening" : bound ? "registered" : "unavailable",
    listenerPresent: presence.present,
    listenerState: presence.phase,
    disclosure:
      "Selected evidence will be returned to the coding agent that opened this view.",
  });
}

export const CHAT_ROUTE_LIMITS = Object.freeze({
  defaultAttachmentTtlMs: DEFAULT_ATTACHMENT_TTL_MS,
  maxAttachmentTtlMs: MAX_ATTACHMENT_TTL_MS,
  listenerPresenceTtlMs: LISTENER_PRESENCE_TTL_MS,
  answerLeaseTtlMs: DEFAULT_ANSWER_LEASE_TTL_MS,
});
