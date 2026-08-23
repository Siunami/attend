import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { buildSelection } from "./selection.js";
import {
  appendQueuedQuestion,
  loadSession as loadStoredSession,
  markQuestionResponseFailed,
  retryQuestionResponse,
  safeQuestionResponse,
  sessionPaths,
  updateSession,
} from "./session-store.js";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_CHAT_CHARS = 4_000;
const MAX_QUERY_CHARS = 500;
const MAX_SELECTIONS = 50;

const VIEWER_STATIC_ASSETS = new Map([
  ["", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

const LIBRARY_STATIC_ASSETS = new Map([
  ["", { file: "library.html", type: "text/html; charset=utf-8" }],
  ["index.html", { file: "library.html", type: "text/html; charset=utf-8" }],
  ["library.js", { file: "library.js", type: "text/javascript; charset=utf-8" }],
  ["library.css", { file: "library.css", type: "text/css; charset=utf-8" }],
]);

const FAMILY_LAB_STATIC_ASSETS = new Map([
  ["", { file: "family-lab.html", type: "text/html; charset=utf-8" }],
  ["index.html", { file: "family-lab.html", type: "text/html; charset=utf-8" }],
  ["family-lab.js", { file: "family-lab.js", type: "text/javascript; charset=utf-8" }],
  ["family-lab.css", { file: "family-lab.css", type: "text/css; charset=utf-8" }],
  ["family-datasets.js", { file: "family-datasets.js", type: "text/javascript; charset=utf-8" }],
  ["family-compiler-adapter.js", { file: "family-compiler-adapter.js", type: "text/javascript; charset=utf-8" }],
  ["family-renderers.js", { file: "family-renderers.js", type: "text/javascript; charset=utf-8" }],
  ["core/map-families/registry.js", { file: "../src/map-families/registry.js", type: "text/javascript; charset=utf-8" }],
  ["core/map-families/index.js", { file: "../src/map-families/index.js", type: "text/javascript; charset=utf-8" }],
  ["core/pipeline/data-package.js", { file: "../src/pipeline/data-package.js", type: "text/javascript; charset=utf-8" }],
  ["core/pipeline/compile.js", { file: "../src/pipeline/compile.js", type: "text/javascript; charset=utf-8" }],
  ["core/pipeline/index.js", { file: "../src/pipeline/index.js", type: "text/javascript; charset=utf-8" }],
  ["vendor/d3.min.js", { file: "../node_modules/d3/dist/d3.min.js", type: "text/javascript; charset=utf-8" }],
  ["vendor/topojson-client.min.js", { file: "../node_modules/topojson-client/dist/topojson-client.min.js", type: "text/javascript; charset=utf-8" }],
  ["vendor/us-states.json", { file: "../node_modules/us-atlas/states-10m.json", type: "application/json; charset=utf-8" }],
  ["vendor/us-counties.json", { file: "../node_modules/us-atlas/counties-10m.json", type: "application/json; charset=utf-8" }],
  ["vendor/world-countries.json", { file: "../node_modules/world-atlas/countries-110m.json", type: "application/json; charset=utf-8" }],
]);

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const LIBRARY_PROTOCOL_VERSION = 1;

const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function makeToken(value) {
  if (value === undefined) return randomBytes(24).toString("base64url");
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value)) {
    throw new TypeError("viewer token must be 8-128 URL-safe characters");
  }
  return value;
}

function makeInstanceId(value) {
  if (value === undefined) return randomUUID();
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{8,128}$/u.test(value)) {
    throw new TypeError("instanceId must be 8-128 URL-safe characters");
  }
  return value;
}

function setHeaders(response, extra = {}) {
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...extra })) {
    response.setHeader(name, value);
  }
}

function sendJson(response, status, value, extraHeaders) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  setHeaders(response, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

async function sendAsset(response, requestMethod, assetRoot, asset) {
  const contents = await readFile(resolve(assetRoot, asset.file));
  response.statusCode = 200;
  setHeaders(response, {
    "Content-Type": asset.type,
    "Content-Length": contents.length,
  });
  response.end(requestMethod === "HEAD" ? undefined : contents);
}

function errorBody(code, message, details) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

async function readJsonBody(request) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "request body must be application/json");
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) {
      throw new HttpError(413, "body_too_large", `request body exceeds ${MAX_JSON_BYTES} bytes`);
    }
    chunks.push(chunk);
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "invalid_json", "request body must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  }
  return value;
}

function assertOnlyKeys(value, permitted) {
  const unexpected = Object.keys(value).filter((key) => !permitted.has(key));
  if (unexpected.length) {
    throw new HttpError(400, "invalid_request", `unexpected field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`);
  }
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, "invalid_revision", "expectedRevision must be a non-negative integer");
  }
  return value;
}

async function loadSession(root, analysisId) {
  return loadStoredSession({ root, sessionId: analysisId });
}

async function sessionIds(root) {
  let entries;
  try {
    entries = await readdir(resolve(root, sessionPaths.directory), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .filter((sessionId) => SESSION_ID.test(sessionId))
    .sort((left, right) => left.localeCompare(right));
}

function libraryEntry(session) {
  const dataPackage = dataPackageFor(session);
  return {
    sessionId: session.id,
    question:
      typeof dataPackage.question?.text === "string"
        ? dataPackage.question.text
        : "Untitled question",
    target:
      typeof dataPackage.question?.target === "string"
        ? dataPackage.question.target
        : "",
    view: {
      id: session.view?.id ?? dataPackage.map?.id,
      version: session.view?.version ?? dataPackage.map?.version,
    },
    counts: {
      phrases: dataPackage.rows.length,
      sources: dataPackage.sources.length,
    },
    updatedAt: session.updatedAt,
    href: `s/${session.id}/`,
  };
}

async function libraryPayload(root) {
  const ids = await sessionIds(root);
  const sessions = [];
  for (const sessionId of ids) {
    try {
      sessions.push(libraryEntry(await loadSession(root, sessionId)));
    } catch (error) {
      // A session may be removed between directory discovery and its read.
      if (isMissing(error)) continue;
      throw error;
    }
  }
  sessions.sort((left, right) => {
    const recency = String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
    return recency || left.sessionId.localeCompare(right.sessionId);
  });
  return {
    schemaVersion: 1,
    sessions,
  };
}

async function patchSession(root, analysisId, revision, patch) {
  return updateSession({
    root,
    sessionId: analysisId,
    expectedRevision: revision,
    patch,
  });
}

function dataPackageFor(session) {
  const dataPackage = session?.dataPackage ?? session?.analysis ?? null;
  if (!dataPackage || !Array.isArray(dataPackage.rows) || !Array.isArray(dataPackage.sources)) {
    throw new HttpError(500, "invalid_analysis", "stored analysis is missing its rows or sources");
  }
  return dataPackage;
}

function selectionFor(session) {
  return buildSelection(dataPackageFor(session), session.state ?? {});
}

function publicSession(session) {
  return {
    schemaVersion: session.schemaVersion,
    id: session.id,
    analysisId: session.analysisId,
    dataPackageId: session.dataPackageId ?? session.dataPackage?.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    view: session.view,
    state: session.state,
    selection: selectionFor(session),
    conversation: {
      turns: conversationTurns(session).map(publicConversationTurn),
    },
  };
}

function conversationTurns(session) {
  if (Array.isArray(session?.conversation)) return session.conversation;
  return Array.isArray(session?.conversation?.turns) ? session.conversation.turns : [];
}

function publicConversationTurn(turn) {
  const { response, ...safeTurn } = turn;
  const safeResponse = safeQuestionResponse(response);
  return {
    ...safeTurn,
    ...(safeResponse === null ? {} : { response: safeResponse }),
  };
}

function validateSelection(body, dataPackage) {
  assertOnlyKeys(body, new Set(["expectedRevision", "selectedIds"]));
  const revision = expectedRevision(body.expectedRevision);
  if (!Array.isArray(body.selectedIds) || body.selectedIds.length > MAX_SELECTIONS) {
    throw new HttpError(400, "invalid_selection", `selectedIds must be an array of at most ${MAX_SELECTIONS} ids`);
  }
  const knownIds = new Set(dataPackage.rows.map((row) => row.id));
  const selectedIds = [];
  for (const id of body.selectedIds) {
    if (typeof id !== "string" || !knownIds.has(id)) {
      throw new HttpError(400, "invalid_selection", `unknown phrase row id: ${String(id)}`);
    }
    if (!selectedIds.includes(id)) selectedIds.push(id);
  }
  return { revision, patch: { selectedIds } };
}

function validateSort(value, currentSort) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_view_state", "sort must be an object");
  }
  assertOnlyKeys(value, new Set(["by", "field", "direction"]));
  if (Object.hasOwn(value, "by") && Object.hasOwn(value, "field")) {
    throw new HttpError(400, "invalid_view_state", "sort must use by or field, not both");
  }
  const field = value.by ?? value.field;
  if (!["occurrenceCount", "distinctSourceCount", "wordCount", "phrase"].includes(field)) {
    throw new HttpError(400, "invalid_view_state", "sort.field is not supported");
  }
  if (!["asc", "desc"].includes(value.direction)) {
    throw new HttpError(400, "invalid_view_state", "sort.direction must be asc or desc");
  }
  return Object.hasOwn(currentSort ?? {}, "by")
    ? { by: field, direction: value.direction }
    : { field, direction: value.direction };
}

function validateSourceScope(value, dataPackage) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_view_state", "sourceScope must be an object");
  }
  assertOnlyKeys(value, new Set(["mode", "sourceIds"]));
  if (!["all", "include"].includes(value.mode) || !Array.isArray(value.sourceIds)) {
    throw new HttpError(400, "invalid_view_state", "sourceScope requires mode and sourceIds");
  }
  if (value.mode === "all") {
    if (value.sourceIds.length !== 0) {
      throw new HttpError(
        400,
        "invalid_view_state",
        "all source scope must use an empty sourceIds array",
      );
    }
    return { mode: "all", sourceIds: [] };
  }
  const knownIds = new Set(dataPackage.sources.map((source) => source.id));
  const sourceIds = [];
  for (const id of value.sourceIds) {
    if (typeof id !== "string" || !knownIds.has(id)) {
      throw new HttpError(400, "invalid_view_state", `unknown source id: ${String(id)}`);
    }
    if (!sourceIds.includes(id)) sourceIds.push(id);
  }
  return { mode: "include", sourceIds };
}

function validateViewState(body, dataPackage, state) {
  assertOnlyKeys(body, new Set(["expectedRevision", "query", "minCount", "sort", "sourceScope"]));
  const revision = expectedRevision(body.expectedRevision);
  const patch = {};
  if (Object.hasOwn(body, "query")) {
    if (typeof body.query !== "string" || body.query.length > MAX_QUERY_CHARS) {
      throw new HttpError(400, "invalid_view_state", `query must be at most ${MAX_QUERY_CHARS} characters`);
    }
    patch.query = body.query;
  }
  if (Object.hasOwn(body, "minCount")) {
    if (!Number.isSafeInteger(body.minCount) || body.minCount < 1 || body.minCount > 1_000_000) {
      throw new HttpError(400, "invalid_view_state", "minCount must be an integer between 1 and 1000000");
    }
    patch.minCount = body.minCount;
  }
  if (Object.hasOwn(body, "sort")) patch.sort = validateSort(body.sort, state?.sort);
  if (Object.hasOwn(body, "sourceScope")) patch.sourceScope = validateSourceScope(body.sourceScope, dataPackage);
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "invalid_view_state", "view-state update did not include a mutable field");
  }
  return { revision, patch };
}

async function appendQuestion(root, analysisId, revision, message, selection) {
  const turns = [{
    id: `turn_${randomUUID()}`,
    role: "user",
    content: message,
    createdAt: new Date().toISOString(),
    selection,
  }];
  const session = await appendQueuedQuestion({
    root,
    sessionId: analysisId,
    expectedRevision: revision,
    turn: turns[0],
    consumeSelectedIds: true,
  });
  const persisted = conversationTurns(session).at(-1) ?? turns[0];
  return {
    session,
    persistedQuestion: persisted,
  };
}

function enqueueCommittedQuestion(enqueueQuestion, job) {
  if (!enqueueQuestion) return;
  queueMicrotask(() => {
    Promise.resolve()
      .then(() => enqueueQuestion(job))
      .catch(() =>
        markQuestionResponseFailed({
          ...job,
          errorCode: "enqueue_failed",
        }).catch(() => {}),
      );
  });
}

function isConflict(error) {
  return error?.code === "CONFLICT" || error?.code === "revision_conflict" || error?.status === 409;
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "NOT_FOUND" || error?.code === "SESSION_NOT_FOUND" || error?.status === 404;
}

async function conflictResponse(response, root, analysisId) {
  let current;
  try {
    current = publicSession(await loadSession(root, analysisId));
  } catch {
    current = undefined;
  }
  sendJson(response, 409, errorBody(
    "revision_conflict",
    "the viewer state changed; reload it before applying this update",
    current ? { current } : undefined,
  ));
}

function validateChat(body) {
  assertOnlyKeys(body, new Set(["expectedRevision", "selectionId", "message"]));
  const revision = expectedRevision(body.expectedRevision);
  if (typeof body.selectionId !== "string" || !body.selectionId.trim() || body.selectionId.length > 128) {
    throw new HttpError(400, "invalid_selection_id", "selectionId must be a non-empty selection id");
  }
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > MAX_CHAT_CHARS) {
    throw new HttpError(400, "invalid_chat", `message must contain 1-${MAX_CHAT_CHARS} characters`);
  }
  return { revision, selectionId: body.selectionId.trim(), message: body.message.trim() };
}

function validateChatRetry(body) {
  assertOnlyKeys(body, new Set(["questionId"]));
  if (
    typeof body.questionId !== "string" ||
    !body.questionId.trim() ||
    body.questionId.length > 128
  ) {
    throw new HttpError(
      400,
      "invalid_question_id",
      "questionId must be a non-empty question id",
    );
  }
  return body.questionId.trim();
}

function responseLifecycleHttpError(error) {
  if (error?.code === "QUESTION_NOT_FOUND") {
    return new HttpError(404, "question_not_found", "question not found");
  }
  if (error?.code === "QUESTION_ALREADY_ANSWERED") {
    return new HttpError(
      409,
      "question_already_answered",
      "question is already answered",
    );
  }
  if (error?.code === "QUESTION_RESPONSE_NOT_RETRYABLE") {
    return new HttpError(
      409,
      "response_not_retryable",
      "only a failed response can be retried",
    );
  }
  return null;
}

function formatUrlHost(host) {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function parseSessionRoute(route) {
  const match = /^s\/([^/]+)\/(.*)$/u.exec(route);
  if (!match) return null;
  if (!SESSION_ID.test(match[1])) {
    throw new HttpError(404, "not_found", "not found");
  }
  return { sessionId: match[1], route: match[2] };
}

/**
 * Start the private, loopback-only library and its session viewers.
 *
 * The URL capability token is deliberately part of every static and API path.
 * Mutations additionally require an exact same-origin Origin header and an
 * optimistic state revision. Supplying analysisId preserves the original
 * createViewerServer return contract by making `url` that session's viewer;
 * `libraryUrl` always identifies the multi-session library.
 */
export async function createViewerServer({
  root,
  analysisId,
  assetsDir,
  host = "127.0.0.1",
  port = 0,
  token: suppliedToken,
  instanceId: suppliedInstanceId,
  enqueueQuestion,
}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");
  if (analysisId !== undefined && (typeof analysisId !== "string" || !SESSION_ID.test(analysisId))) {
    throw new TypeError("analysisId must be a valid session id when supplied");
  }
  if (typeof assetsDir !== "string" || !assetsDir) throw new TypeError("assetsDir is required");
  if (!isLoopbackHost(host)) throw new TypeError("viewer host must be loopback-only");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("port must be 0-65535");
  if (enqueueQuestion !== undefined && typeof enqueueQuestion !== "function") {
    throw new TypeError("enqueueQuestion must be a function when supplied");
  }

  const token = makeToken(suppliedToken);
  const instanceId = makeInstanceId(suppliedInstanceId);
  const basePath = `/v/${token}/`;
  const assetRoot = resolve(assetsDir);
  let origin = null;
  let authority = null;

  // Fail before opening a socket if a backwards-compatible default session was
  // requested but does not satisfy the minimal viewer contract.
  if (analysisId !== undefined) {
    dataPackageFor(await loadSession(root, analysisId));
  }

  const server = createServer(async (request, response) => {
    let routedSessionId;
    try {
      if (!origin || request.headers.host !== authority) {
        throw new HttpError(421, "misdirected_request", "request authority does not match this viewer");
      }
      // Route against the raw request target. URL parsing normalizes dot
      // segments before pathname inspection, which could otherwise turn a
      // traversal-shaped request into a valid library route.
      const rawPath = String(request.url ?? "/").split("?", 1)[0];
      if (!rawPath.startsWith(basePath)) {
        throw new HttpError(404, "not_found", "not found");
      }
      const route = rawPath.slice(basePath.length);

      if (request.method === "GET" || request.method === "HEAD") {
        if (route.startsWith("families/")) {
          const familyAsset = FAMILY_LAB_STATIC_ASSETS.get(route.slice("families/".length));
          if (!familyAsset) throw new HttpError(404, "not_found", "not found");
          await sendAsset(response, request.method, assetRoot, familyAsset);
          return;
        }

        const libraryAsset = LIBRARY_STATIC_ASSETS.get(route);
        if (libraryAsset) {
          await sendAsset(response, request.method, assetRoot, libraryAsset);
          return;
        }

        if (route === "api/health") {
          sendJson(response, 200, {
            ok: true,
            service: "attend-library",
            protocolVersion: LIBRARY_PROTOCOL_VERSION,
            instanceId,
            sessionCount: (await sessionIds(root)).length,
          });
          return;
        }
        if (route === "api/library") {
          sendJson(response, 200, await libraryPayload(root));
          return;
        }

        const sessionRoute = parseSessionRoute(route);
        if (!sessionRoute) throw new HttpError(404, "not_found", "not found");
        routedSessionId = sessionRoute.sessionId;
        // Resolve the session before serving even a bundled asset, so a guessed
        // or stale session id never becomes a valid viewer surface.
        const session = await loadSession(root, routedSessionId);
        const viewerAsset = VIEWER_STATIC_ASSETS.get(sessionRoute.route);
        if (viewerAsset) {
          await sendAsset(response, request.method, assetRoot, viewerAsset);
          return;
        }
        if (sessionRoute.route === "api/health") {
          sendJson(response, 200, {
            ok: true,
            analysisId: session.analysisId ?? dataPackageFor(session).id,
            sessionId: session.id,
            revision: session.state?.revision ?? 0,
            dataPackageId: dataPackageFor(session).id,
          });
          return;
        }
        if (sessionRoute.route === "api/data") {
          sendJson(response, 200, dataPackageFor(session));
          return;
        }
        if (sessionRoute.route === "api/state") {
          sendJson(response, 200, publicSession(session));
          return;
        }
        throw new HttpError(404, "not_found", "not found");
      }

      if (request.method === "POST") {
        const sessionRoute = parseSessionRoute(route);
        if (!sessionRoute) throw new HttpError(404, "not_found", "not found");
        routedSessionId = sessionRoute.sessionId;
        if (request.headers.origin !== origin) {
          throw new HttpError(403, "origin_forbidden", "mutation requires the viewer's exact Origin header");
        }
        const body = await readJsonBody(request);
        const session = await loadSession(root, routedSessionId);
        const dataPackage = dataPackageFor(session);

        if (sessionRoute.route === "api/selection") {
          const { revision, patch } = validateSelection(body, dataPackage);
          try {
            const updated = await patchSession(root, routedSessionId, revision, patch);
            sendJson(response, 200, publicSession(updated));
          } catch (error) {
            if (isConflict(error)) return conflictResponse(response, root, routedSessionId);
            throw error;
          }
          return;
        }
        if (sessionRoute.route === "api/view-state") {
          const { revision, patch } = validateViewState(body, dataPackage, session.state);
          try {
            const updated = await patchSession(root, routedSessionId, revision, patch);
            sendJson(response, 200, publicSession(updated));
          } catch (error) {
            if (isConflict(error)) return conflictResponse(response, root, routedSessionId);
            throw error;
          }
          return;
        }
        if (sessionRoute.route === "api/chat/retry") {
          const questionId = validateChatRetry(body);
          let retried;
          try {
            retried = await retryQuestionResponse({
              root,
              sessionId: routedSessionId,
              questionId,
            });
          } catch (error) {
            const httpError = responseLifecycleHttpError(error);
            if (httpError) throw httpError;
            throw error;
          }
          const publicUpdated = publicSession(retried.session);
          sendJson(response, 200, {
            ok: true,
            status: "queued",
            questionId,
            revision: retried.session.state.revision,
            session: publicUpdated,
          });
          enqueueCommittedQuestion(enqueueQuestion, {
            root,
            sessionId: routedSessionId,
            questionId,
          });
          return;
        }
        if (sessionRoute.route === "api/chat") {
          const { revision, selectionId, message } = validateChat(body);
          const selection = selectionFor(session);
          if (session.state?.revision !== revision || selection.id !== selectionId) {
            return conflictResponse(response, root, routedSessionId);
          }
          try {
            const appended = await appendQuestion(root, routedSessionId, revision, message, selection);
            const updated = appended.session;
            const publicQuestion = publicConversationTurn(
              appended.persistedQuestion,
            );
            sendJson(response, 200, {
              ok: true,
              status: "queued",
              revision: updated.state?.revision ?? revision + 1,
              selectionId,
              question: publicQuestion,
              session: publicSession(updated),
            });
            enqueueCommittedQuestion(enqueueQuestion, {
              root,
              sessionId: routedSessionId,
              questionId: appended.persistedQuestion.id,
            });
          } catch (error) {
            if (isConflict(error)) return conflictResponse(response, root, routedSessionId);
            if (error?.code === "ACTIVE_RESPONSE_EXISTS") {
              throw new HttpError(
                409,
                "active_response_exists",
                "wait for the current response to finish before sending another question",
              );
            }
            throw error;
          }
          return;
        }
        throw new HttpError(404, "not_found", "not found");
      }

      throw new HttpError(405, "method_not_allowed", "method not allowed");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, errorBody(error.code, error.message, error.details),
          error.status === 405 ? { Allow: "GET, HEAD, POST" } : undefined);
        return;
      }
      if (isConflict(error)) {
        if (routedSessionId) {
          await conflictResponse(response, root, routedSessionId);
          return;
        }
        sendJson(response, 409, errorBody("revision_conflict", "the viewer state changed"));
        return;
      }
      if (isMissing(error)) {
        sendJson(response, 404, errorBody("not_found", "not found"));
        return;
      }
      sendJson(response, 500, errorBody("internal_error", "the local viewer could not complete the request"));
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error("viewer server did not expose a TCP address");
  }
  origin = `http://${formatUrlHost(host)}:${address.port}`;
  authority = new URL(origin).host;
  const libraryUrl = `${origin}${basePath}`;
  const viewerUrl = analysisId === undefined
    ? undefined
    : `${libraryUrl}s/${analysisId}/`;
  const url = viewerUrl ?? libraryUrl;

  let closing;
  const close = () => {
    closing ??= new Promise((resolveClose, rejectClose) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeIdleConnections?.();
    });
    return closing;
  };

  return {
    server,
    url,
    libraryUrl,
    ...(viewerUrl === undefined ? {} : { viewerUrl }),
    port: address.port,
    close,
    token,
    instanceId,
  };
}

export function createLibraryServer(options = {}) {
  const { analysisId: _ignoredAnalysisId, ...libraryOptions } = options;
  return createViewerServer(libraryOptions);
}

// Kept as a named export so focused tests and future adapters can publish the
// exact upper bound without duplicating it.
export const VIEWER_JSON_LIMIT = MAX_JSON_BYTES;
