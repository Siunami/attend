import { randomBytes, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

import {
  artifactAdapterFor,
  buildArtifactSelection,
  libraryMetadataForArtifact,
  publicArtifactForBrowser,
  renderModelForArtifact,
  resolveArtifactVisualTarget,
  selectableIdsForArtifact,
  validateArtifactPackage,
} from "./artifacts/index.js";
import {
  listProjectChatThreads,
  projectChatThread,
} from "./chat-thread-projection.js";
import {
  appendThreadQuestion,
  retryThreadQuestion,
} from "./chat-thread-service.js";
import {
  chatThreadFilePath,
  createChatThread,
  validateChatThreadId,
} from "./chat-thread-store.js";
import {
  appendQueuedQuestion,
  loadSession as loadStoredSession,
  markQuestionResponseFailed,
  retryQuestionResponse,
  safeQuestionResponse,
  sessionPaths,
  updateSession,
} from "./session-store.js";
import {
  FEEDBACK_KINDS,
  appendExperimentEvent,
  loadExploration,
  publicExperiment,
  publicExploration,
} from "./exploration-store.js";
import { PACKAGE_VERSION } from "./constants.js";
import { GENERATED_FORM_RUNTIME } from "./catalog/generated-form-runtime.js";
import { readSessionAsset } from "./media/session-assets.js";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_CHAT_CHARS = 4_000;
const MAX_QUERY_CHARS = 500;
const MAX_SELECTIONS = 50;
const WORKSPACE_MUTATION_ID = /^mutation_[A-Za-z0-9._-]{8,80}$/u;

function generatedViewerAssetEntries() {
  return GENERATED_FORM_RUNTIME.staticAssets.map((relativePath) => {
    const file = relativePath.slice(2);
    const type = file.endsWith(".json")
      ? "application/json; charset=utf-8"
      : file.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";
    return [file, { file, type }];
  });
}

function generatedFamilyLabCoreAssetEntries() {
  return GENERATED_FORM_RUNTIME.familyLabCoreAssets.map(({ route, file }) => [
    route,
    { file, type: "text/javascript; charset=utf-8" },
  ]);
}

const VIEWER_STATIC_ASSETS = new Map([
  ["", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  // Package-native Atlas rendering is a closed set of bundled, self-hosted
  // modules. A package can record a renderer receipt, but never a module path,
  // stylesheet, CDN URL, or vendor asset to serve.
  ["package-model.js", { file: "package-model.js", type: "text/javascript; charset=utf-8" }],
  ["package-renderer.js", { file: "package-renderer.js", type: "text/javascript; charset=utf-8" }],
  ["family-renderers.js", { file: "family-renderers.js", type: "text/javascript; charset=utf-8" }],
  ["visualization-inspector.js", { file: "visualization-inspector.js", type: "text/javascript; charset=utf-8" }],
  ["vendor/d3.min.js", { file: "vendor/d3.min.js", type: "text/javascript; charset=utf-8" }],
  ["vendor/topojson-client.min.js", { file: "vendor/topojson-client.min.js", type: "text/javascript; charset=utf-8" }],
  ["vendor/us-states.json", { file: "vendor/us-states.json", type: "application/json; charset=utf-8" }],
  ["vendor/us-counties.json", { file: "vendor/us-counties.json", type: "application/json; charset=utf-8" }],
  ["vendor/world-countries.json", { file: "vendor/world-countries.json", type: "application/json; charset=utf-8" }],
  ...generatedViewerAssetEntries(),
]);

const LIBRARY_STATIC_ASSETS = new Map([
  ["", { file: "library.html", type: "text/html; charset=utf-8" }],
  ["index.html", { file: "library.html", type: "text/html; charset=utf-8" }],
  ["library.js", { file: "library.js", type: "text/javascript; charset=utf-8" }],
  ["library.css", { file: "library.css", type: "text/css; charset=utf-8" }],
]);

const WORKSPACE_STATIC_ASSETS = new Map([
  ["", { file: "workspace.html", type: "text/html; charset=utf-8" }],
  ["index.html", { file: "workspace.html", type: "text/html; charset=utf-8" }],
  ["workspace.js", { file: "workspace.js", type: "text/javascript; charset=utf-8" }],
  ["workspace.css", { file: "workspace.css", type: "text/css; charset=utf-8" }],
]);

const FAMILY_LAB_STATIC_ASSETS = new Map([
  ["", { file: "family-lab.html", type: "text/html; charset=utf-8" }],
  ["index.html", { file: "family-lab.html", type: "text/html; charset=utf-8" }],
  ["family-lab.js", { file: "family-lab.js", type: "text/javascript; charset=utf-8" }],
  ["family-lab.css", { file: "family-lab.css", type: "text/css; charset=utf-8" }],
  ["family-browser.js", { file: "family-browser.js", type: "text/javascript; charset=utf-8" }],
  ["family-catalog.js", { file: "family-catalog.js", type: "text/javascript; charset=utf-8" }],
  ["family-datasets.js", { file: "family-datasets.js", type: "text/javascript; charset=utf-8" }],
  ["family-compiler-adapter.js", { file: "family-compiler-adapter.js", type: "text/javascript; charset=utf-8" }],
  ["package-model.js", { file: "package-model.js", type: "text/javascript; charset=utf-8" }],
  ["package-renderer.js", { file: "package-renderer.js", type: "text/javascript; charset=utf-8" }],
  ["family-renderers.js", { file: "family-renderers.js", type: "text/javascript; charset=utf-8" }],
  ["visualization-inspector.js", { file: "visualization-inspector.js", type: "text/javascript; charset=utf-8" }],
  ...generatedFamilyLabCoreAssetEntries(),
  ["vendor/d3.min.js", { file: "vendor/d3.min.js", type: "text/javascript; charset=utf-8" }],
  ["vendor/topojson-client.min.js", { file: "vendor/topojson-client.min.js", type: "text/javascript; charset=utf-8" }],
  ["vendor/us-states.json", { file: "vendor/us-states.json", type: "application/json; charset=utf-8" }],
  ["vendor/us-counties.json", { file: "vendor/us-counties.json", type: "application/json; charset=utf-8" }],
  ["vendor/world-countries.json", { file: "vendor/world-countries.json", type: "application/json; charset=utf-8" }],
  ...generatedViewerAssetEntries(),
]);

export const PACKAGED_ATLAS_ASSET_FILES = Object.freeze(
  [...new Set(
    [
      ...VIEWER_STATIC_ASSETS.values(),
      ...FAMILY_LAB_STATIC_ASSETS.values(),
      ...WORKSPACE_STATIC_ASSETS.values(),
    ]
      .map((asset) => asset.file),
  )].sort((left, right) => left.localeCompare(right)),
);

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const HOST_ATTACHMENT_ID = /^host_[a-f0-9]{16}$/u;
const LIBRARY_PROTOCOL_VERSION = 4;

const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    // 'self', not 'none': the exploration workspace embeds finished artifacts
    // as same-origin gallery previews. Foreign origins stay blocked.
    "frame-ancestors 'self'",
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
  "X-Frame-Options": "SAMEORIGIN",
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

const SSE_HEARTBEAT_MS = 15_000;
const SSE_STATE_DEBOUNCE_MS = 100;
const SSE_OPEN_PREAMBLE = "retry: 2000\n\n: open\n\n";
const SSE_KEEPALIVE_FRAME = ": ping\n\n";

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${data}\n\n`;
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
  let contents;
  try {
    contents = await readFile(resolve(assetRoot, asset.file));
  } catch (error) {
    if (error?.code === "ENOENT") throw new HttpError(404, "not_found", "not found");
    throw error;
  }
  response.statusCode = 200;
  setHeaders(response, {
    "Content-Type": asset.type,
    "Content-Length": contents.length,
  });
  response.end(requestMethod === "HEAD" ? undefined : contents);
}

async function sendSessionImageAsset(response, requestMethod, root, session, assetId) {
  let asset;
  try {
    asset = await readSessionAsset({ root, session, assetId });
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("ASSET_")) {
      throw new HttpError(404, "not_found", "not found");
    }
    throw error;
  }
  response.statusCode = 200;
  setHeaders(response, {
    "Content-Type": asset.mimeType,
    "Content-Length": asset.byteLength,
    "Content-Disposition": `inline; filename="${asset.assetId}.jpg"`,
  });
  response.end(requestMethod === "HEAD" ? undefined : asset.bytes);
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
  const metadata = libraryMetadataForArtifact(dataPackage);
  return {
    sessionId: session.id,
    question: metadata.question,
    target: metadata.target,
    view: session.view ?? {
      id: dataPackage.map?.id,
      version: dataPackage.map?.version,
    },
    counts: metadata.counts,
    updatedAt: session.updatedAt,
    href: `s/${session.id}/`,
  };
}

async function libraryPayload(root) {
  const ids = await sessionIds(root);
  const sessions = [];
  let unavailableSessionCount = 0;
  for (const sessionId of ids) {
    try {
      const session = await loadSession(root, sessionId);
      if (session.exploration) continue;
      sessions.push(libraryEntry(session));
    } catch (error) {
      // A session may be removed between directory discovery and its read.
      if (isMissing(error)) continue;
      // A stale or invalid package stays unavailable at its direct route, but
      // cannot take healthy sessions out of the aggregate library with it.
      unavailableSessionCount += 1;
    }
  }
  sessions.sort((left, right) => {
    const recency = String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
    return recency || left.sessionId.localeCompare(right.sessionId);
  });
  return {
    schemaVersion: 1,
    sessions,
    unavailableSessionCount,
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
  try {
    return validateArtifactPackage(dataPackage);
  } catch {
    throw new HttpError(
      500,
      "invalid_analysis",
      "stored analysis is not a supported Attend artifact package",
    );
  }
}

function selectionFor(session) {
  return buildArtifactSelection(dataPackageFor(session), session.state ?? {});
}

function publicSession(session, chat = null, thread = null) {
  const conversation = thread === null
    ? {
        turns: conversationTurns(session).map(publicConversationTurn),
      }
    : {
        threadId: thread.id,
        revision: thread.revision,
        turns: thread.turns.map(publicConversationTurn),
        events: clonePublicThreadEvents(thread.events),
      };
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
    conversation,
    ...(chat === null ? {} : { chat }),
  };
}

function clonePublicThreadEvents(events) {
  return events.map((event) => event.type === "page-context"
    ? {
        type: "page-context",
        id: event.id,
        page: {
          sessionId: event.page.sessionId,
          label: event.page.label,
          href: `../../s/${encodeURIComponent(event.page.sessionId)}/`,
        },
        createdAt: event.createdAt,
      }
    : {
        type: "message",
        id: event.id,
        turnId: event.turnId,
        createdAt: event.createdAt,
      });
}

function conversationTurns(session) {
  if (Array.isArray(session?.conversation)) return session.conversation;
  return Array.isArray(session?.conversation?.turns) ? session.conversation.turns : [];
}

function activeQuestionResponse(session) {
  const turns = conversationTurns(session);
  const answered = new Set(
    turns
      .filter(
        (turn) =>
          turn?.role === "assistant" &&
          typeof turn.replyToTurnId === "string",
      )
      .map((turn) => turn.replyToTurnId),
  );
  const active = turns.find(
    (turn) =>
      turn?.role === "user" &&
      typeof turn.id === "string" &&
      !answered.has(turn.id) &&
      (turn.response?.status === "queued" || turn.response?.status === "running"),
  );
  return active
    ? { questionId: active.id, route: active.response.route }
    : null;
}

function publicConversationTurn(turn) {
  const { response, ...safeTurn } = turn;
  const safeResponse = safeQuestionResponse(response);
  return {
    ...safeTurn,
    ...(safeResponse === null ? {} : { response: safeResponse }),
  };
}

async function validateSelection(body, dataPackage, sessionId) {
  const adapter = artifactAdapterFor(dataPackage);
  if (adapter.artifactKind === "phrase-v1") {
    assertOnlyKeys(body, new Set(["expectedRevision", "selectedIds"]));
    const revision = expectedRevision(body.expectedRevision);
    if (!Array.isArray(body.selectedIds) || body.selectedIds.length > MAX_SELECTIONS) {
      throw new HttpError(400, "invalid_selection", `selectedIds must be an array of at most ${MAX_SELECTIONS} ids`);
    }
    const knownIds = new Set(selectableIdsForArtifact(dataPackage));
    const selectedIds = [];
    for (const id of body.selectedIds) {
      if (typeof id !== "string" || !knownIds.has(id)) {
        throw new HttpError(400, "invalid_selection", `unknown phrase row id: ${String(id)}`);
      }
      if (!selectedIds.includes(id)) selectedIds.push(id);
    }
    return { revision, patch: { selectedIds } };
  }

  assertOnlyKeys(body, new Set(["sessionId", "revision", "markId", "markIds", "nodeId", "targetId"]));
  if (body.sessionId !== sessionId) {
    throw new HttpError(400, "invalid_selection", "Atlas selection sessionId does not match the routed session");
  }
  const revision = expectedRevision(body.revision);
  const hasMarkId = Object.hasOwn(body, "markId");
  const hasMarkIds = Object.hasOwn(body, "markIds");
  const hasNodeId = Object.hasOwn(body, "nodeId");
  const hasTargetId = Object.hasOwn(body, "targetId");
  if ([hasMarkId, hasMarkIds, hasNodeId, hasTargetId].filter(Boolean).length !== 1) {
    throw new HttpError(400, "invalid_selection", "Atlas selection requires exactly one markId, markIds, nodeId, or targetId");
  }
  if (hasTargetId) {
    if (typeof body.targetId !== "string" || !/^target_[a-f0-9]{16}$/u.test(body.targetId)) {
      throw new HttpError(400, "invalid_selection", "targetId must be a governed aggregate target id");
    }
    try {
      await resolveArtifactVisualTarget(dataPackage, body.targetId, { offset: 0, limit: 1 });
    } catch {
      throw new HttpError(400, "invalid_selection", `unknown or invalid Atlas target id: ${body.targetId}`);
    }
    return {
      revision,
      patch: { markIds: [], focus: null, targetId: body.targetId },
    };
  }
  if (hasNodeId) {
    if (typeof body.nodeId !== "string" || body.nodeId.length === 0) {
      throw new HttpError(400, "invalid_selection", "nodeId must be a selectable graph node id");
    }
    const knownNodes = new Set(
      Array.isArray(dataPackage.payload?.nodes) ? dataPackage.payload.nodes.map(String) : [],
    );
    if (!knownNodes.has(body.nodeId)) {
      throw new HttpError(400, "invalid_selection", `unknown Atlas node id: ${String(body.nodeId)}`);
    }
    const markIds = dataPackage.marks
      .filter((mark) => String(mark.values?.source) === body.nodeId || String(mark.values?.target) === body.nodeId)
      .map((mark) => mark.id);
    if (markIds.length === 0 || markIds.length > MAX_SELECTIONS) {
      throw new HttpError(400, "invalid_selection", `node must resolve to between 1 and ${MAX_SELECTIONS} evidence marks`);
    }
    return {
      revision,
      patch: { markIds, focus: { kind: "node", id: body.nodeId } },
    };
  }
  if (hasMarkIds) {
    if (!Array.isArray(body.markIds) || body.markIds.some((id) => typeof id !== "string" || id.length === 0)) {
      throw new HttpError(400, "invalid_selection", "markIds must be an array of selectable mark ids");
    }
    const seen = new Set();
    const markIds = [];
    for (const id of body.markIds) {
      if (!seen.has(id)) {
        seen.add(id);
        markIds.push(id);
      }
    }
    if (markIds.length === 0 || markIds.length > MAX_SELECTIONS) {
      throw new HttpError(400, "invalid_selection", `markIds must select between 1 and ${MAX_SELECTIONS} marks`);
    }
    const knownIds = new Set(selectableIdsForArtifact(dataPackage));
    for (const id of markIds) {
      if (!knownIds.has(id)) {
        throw new HttpError(400, "invalid_selection", `unknown Atlas mark id: ${id}`);
      }
    }
    return {
      revision,
      patch: { markIds, focus: null, targetId: null },
    };
  }
  if (body.markId !== null && (typeof body.markId !== "string" || body.markId.length === 0)) {
    throw new HttpError(400, "invalid_selection", "markId must be a selectable mark id or null");
  }
  if (body.markId !== null && !new Set(selectableIdsForArtifact(dataPackage)).has(body.markId)) {
    throw new HttpError(400, "invalid_selection", `unknown Atlas mark id: ${String(body.markId)}`);
  }
  return {
    revision,
    patch: {
      markIds: body.markId === null ? [] : [body.markId],
      focus: null,
      targetId: null,
    },
  };
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
  if (artifactAdapterFor(dataPackage).artifactKind !== "phrase-v1") {
    throw new HttpError(400, "invalid_view_state", "Atlas views do not accept phrase filter state");
  }
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

async function appendQuestion(root, analysisId, revision, message, selection, route) {
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
    route,
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
  return error?.code === "CONFLICT"
    || error?.code === "CHAT_THREAD_BUSY"
    || error?.code === "revision_conflict"
    || error?.code === "EXPERIMENT_REVISION_CONFLICT"
    || error?.code === "EXPERIMENT_EVENT_BUSY"
    || error?.status === 409;
}

function isMissing(error) {
  return error?.code === "ENOENT"
    || error?.code === "NOT_FOUND"
    || error?.code === "SESSION_NOT_FOUND"
    || error?.code === "EXPLORATION_NOT_FOUND"
    || error?.code === "EXPERIMENT_NOT_FOUND"
    || error?.code === "CHAT_THREAD_NOT_FOUND"
    || error?.status === 404;
}

async function conflictResponse(
  response,
  root,
  analysisId,
  projectChat,
  hostRoute,
) {
  let current;
  try {
    const session = await loadSession(root, analysisId);
    current = publicSession(
      session,
      projectChat ? await projectChat(session, hostRoute) : null,
    );
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
  assertOnlyKeys(body, new Set(["expectedRevision", "selectionId", "threadId", "message"]));
  const revision = expectedRevision(body.expectedRevision);
  if (typeof body.selectionId !== "string" || !body.selectionId.trim() || body.selectionId.length > 128) {
    throw new HttpError(400, "invalid_selection_id", "selectionId must be a non-empty selection id");
  }
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > MAX_CHAT_CHARS) {
    throw new HttpError(400, "invalid_chat", `message must contain 1-${MAX_CHAT_CHARS} characters`);
  }
  return {
    revision,
    selectionId: body.selectionId.trim(),
    threadId: body.threadId === undefined ? undefined : chatThreadId(body.threadId),
    message: body.message.trim(),
  };
}

function chatThreadId(value) {
  try {
    return validateChatThreadId(value);
  } catch {
    throw new HttpError(400, "invalid_chat_thread_id", "threadId must be a valid chat thread id");
  }
}

function chatThreadIdFromRequestTarget(target) {
  const queryIndex = String(target ?? "").indexOf("?");
  if (queryIndex < 0) return undefined;
  const values = new URLSearchParams(String(target).slice(queryIndex + 1)).getAll("threadId");
  if (values.length === 0) return undefined;
  if (values.length !== 1) {
    throw new HttpError(400, "invalid_chat_thread_id", "state accepts one threadId");
  }
  return chatThreadId(values[0]);
}

function targetPageFromRequestTarget(target) {
  const queryIndex = String(target ?? "").indexOf("?");
  const params = new URLSearchParams(queryIndex < 0 ? "" : String(target).slice(queryIndex + 1));
  const targetIds = params.getAll("targetId");
  if (targetIds.length !== 1 || !/^target_[a-f0-9]{16}$/u.test(targetIds[0])) {
    throw new HttpError(400, "invalid_visual_target", "targetId must identify one governed visual target");
  }
  const integer = (name, fallback, minimum, maximum) => {
    const values = params.getAll(name);
    if (values.length === 0) return fallback;
    if (values.length !== 1 || !/^\d+$/u.test(values[0])) {
      throw new HttpError(400, "invalid_visual_target", `${name} must be one integer`);
    }
    const value = Number(values[0]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new HttpError(400, "invalid_visual_target", `${name} is outside its allowed range`);
    }
    return value;
  };
  return {
    targetId: targetIds[0],
    offset: integer("offset", 0, 0, Number.MAX_SAFE_INTEGER),
    limit: integer("limit", 50, 1, 100),
  };
}

function hostRouteFromRequestTarget(target) {
  const queryIndex = String(target ?? "").indexOf("?");
  if (queryIndex < 0) return null;
  const params = new URLSearchParams(String(target).slice(queryIndex + 1));
  const attachmentIds = params.getAll("attend-host");
  const generations = params.getAll("attend-generation");
  if (attachmentIds.length === 0 && generations.length === 0) return null;
  if (attachmentIds.length !== 1 || generations.length !== 1) return null;
  const generation = Number(generations[0]);
  if (
    !HOST_ATTACHMENT_ID.test(attachmentIds[0]) ||
    !/^\d+$/u.test(generations[0]) ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return null;
  }
  return {
    kind: "host",
    attachmentId: attachmentIds[0],
    generation,
  };
}

function validateChatRetry(body) {
  assertOnlyKeys(body, new Set(["threadId", "questionId"]));
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
  return {
    questionId: body.questionId.trim(),
    threadId: body.threadId === undefined ? undefined : chatThreadId(body.threadId),
  };
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
  if (error?.code === "QUESTION_RESPONSE_ROUTE_MISMATCH") {
    return new HttpError(
      409,
      "response_route_mismatch",
      "This response belongs to a different explicit chat route. Select that route and reopen the view before retrying.",
    );
  }
  if (error?.code === "ACTIVE_RESPONSE_EXISTS") {
    return new HttpError(
      409,
      "active_response_exists",
      "wait for the current response to finish before retrying another question",
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

function parseExplorationRoute(route) {
  const match = /^e\/(exploration_[a-f0-9]{24})\/(.*)$/u.exec(route);
  if (!match) return null;
  return { explorationId: match[1], route: match[2] };
}

function parseWorkspaceMutationRoute(route) {
  const match = /^api\/experiments\/(experiment_[a-f0-9]{24})\/(star|feedback)$/u.exec(route);
  return match ? { experimentId: match[1], action: match[2] } : null;
}

function workspaceMutationId(body) {
  if (typeof body.mutationId !== "string" || !WORKSPACE_MUTATION_ID.test(body.mutationId)) {
    throw new HttpError(400, "invalid_request", "mutationId must be a valid workspace mutation id");
  }
  return body.mutationId;
}

function feedbackCounts(feedback) {
  const counts = {};
  for (const item of feedback) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

function workspaceExperiment(experiment) {
  const started = experiment.events.filter((event) => event.kind === "execution-started");
  const completed = [...experiment.events].reverse().find(
    (event) => event.kind === "execution-completed",
  );
  const failed = [...experiment.events].reverse().find(
    (event) => event.kind === "execution-failed",
  );
  const lastEvent = experiment.events.at(-1);
  return {
    id: experiment.id,
    explorationId: experiment.explorationId,
    revision: experiment.events.length,
    createdAt: experiment.admittedAt,
    updatedAt: lastEvent?.at ?? experiment.admittedAt,
    hypothesis: {
      text: experiment.hypothesis,
      whyUseful: experiment.whyUseful,
      baseline: experiment.baseline,
      origin: experiment.origin,
      analysisMode: experiment.analysisMode,
      timing: experiment.timing,
    },
    representation: experiment.representation,
    sourceScope: experiment.sourceScope,
    comparisonCount: experiment.comparisonCount,
    ...(experiment.parentExperimentId === undefined
      ? {}
      : { parentExperimentId: experiment.parentExperimentId }),
    execution: {
      status: experiment.execution,
      attemptCount: started.length || (completed || failed ? 1 : 0),
      ...(started.length ? { startedAt: started.at(-1).at } : {}),
      ...(completed ? { completedAt: completed.at } : {}),
      ...(failed ? { failedAt: failed.at, error: failed.payload } : {}),
    },
    outcome: experiment.assessment
      ? {
          kind: experiment.outcome,
          summary: experiment.assessment.summary,
        }
      : null,
    assessment: experiment.assessment
      ? {
          whatSurfaced: experiment.assessment.summary,
          rationale: experiment.assessment.rationale,
          evidenceStrength: experiment.assessment.evidenceStrength,
          interestingness: experiment.assessment.interestingness,
          transformations: experiment.assessment.transformations,
          omissions: experiment.assessment.omissions,
          limitations: experiment.assessment.limitations,
          factors: [
            ...experiment.assessment.transformations,
            ...experiment.assessment.omissions,
          ],
        }
      : null,
    promotion: experiment.promotion
      ? {
          promotedAt: experiment.promotion.at,
          rationale: experiment.promotion.rationale,
        }
      : null,
    human: {
      starred: experiment.humanStarred,
      starredAt: experiment.starChangedAt,
      disposition: experiment.humanDisposition,
    },
    feedbackSummary: feedbackCounts(experiment.feedback),
    feedback: experiment.feedback,
    artifact: experiment.result
      ? {
          analysisId: experiment.result.analysisId,
          sessionId: experiment.result.sessionId,
          packageHash: experiment.result.packageHash,
          href: `../../s/${encodeURIComponent(experiment.result.sessionId)}/`,
        }
      : null,
    history: experiment.events,
  };
}

async function workspacePayload(root, explorationId) {
  const projected = await publicExploration({ root, explorationId });
  return {
    schemaVersion: 1,
    exploration: {
      ...projected.exploration,
      counts: {
        experiments: projected.counts.total,
        queued: projected.counts.queued,
        running: projected.counts.running,
        completed: projected.counts.completed,
        failed: projected.counts.failed,
        attempted: projected.counts.attempted,
        comparisonsDeclared: projected.counts.comparisonsDeclared,
        comparisonsAttempted: projected.counts.comparisonsAttempted,
        promoted: projected.counts.promoted,
        starred: projected.counts.starred,
      },
    },
    experiments: projected.experiments.map(workspaceExperiment),
  };
}

async function workspaceExperimentResponse(root, explorationId, experimentId) {
  const experiment = await publicExperiment({ root, experimentId });
  if (experiment.explorationId !== explorationId) {
    throw new HttpError(404, "not_found", "not found");
  }
  return { ok: true, experiment: workspaceExperiment(experiment) };
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
  resolveQuestionRoute,
  questionStream,
  chatCapability,
  serviceChat,
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
  if (resolveQuestionRoute !== undefined && typeof resolveQuestionRoute !== "function") {
    throw new TypeError("resolveQuestionRoute must be a function when supplied");
  }
  if (questionStream !== undefined && typeof questionStream?.subscribe !== "function") {
    throw new TypeError("questionStream must expose a subscribe function when supplied");
  }
  if (chatCapability !== undefined && typeof chatCapability !== "function") {
    throw new TypeError("chatCapability must be a function when supplied");
  }
  if (serviceChat !== undefined && (!serviceChat || typeof serviceChat !== "object" || Array.isArray(serviceChat))) {
    throw new TypeError("serviceChat must be an object when supplied");
  }

  const token = makeToken(suppliedToken);
  const instanceId = makeInstanceId(suppliedInstanceId);
  const basePath = `/v/${token}/`;
  const assetRoot = resolve(assetsDir);
  let origin = null;
  let authority = null;

  const questionRouteFor = async (sessionId, hostRoute) => {
    const route = resolveQuestionRoute
      ? await resolveQuestionRoute({ root, sessionId, hostRoute })
      : enqueueQuestion
        ? { kind: "detached", adapter: "codex-cli" }
        : null;
    if (route === null) return null;
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      throw new Error("The configured chat route is invalid");
    }
    return route;
  };
  const projectChatCapability = async (session, hostRoute) => {
    if (!chatCapability) return null;
    const activeResponse = activeQuestionResponse(session);
    return chatCapability({
      root,
      sessionId: session.id,
      hostRoute,
      responseRoute: activeResponse?.route ?? null,
      responseQuestionId: activeResponse?.questionId ?? null,
    });
  };
  const publicProjectSession = async (session, hostRoute, threadId) => {
    const thread = threadId === undefined
      ? null
      : await projectChatThread({ root, threadId });
    return publicSession(
      session,
      await projectChatCapability(session, hostRoute),
      thread,
    );
  };

  const openStreams = new Set();
  const stateWatchers = new Map();
  const watchedDirectories = [
    resolve(root, sessionPaths.directory),
    // chat-thread-store exports no directory accessor, so read it back off the
    // path a syntactically valid thread id would be written to.
    dirname(chatThreadFilePath({ root, threadId: `thread_${"0".repeat(24)}` })),
  ];
  let stateBroadcastTimer = null;

  const broadcastState = () => {
    stateBroadcastTimer = null;
    const frame = sseFrame("state", "{}");
    for (const stream of openStreams) stream.response.write(frame);
  };
  const scheduleStateBroadcast = () => {
    if (stateBroadcastTimer) return;
    stateBroadcastTimer = setTimeout(broadcastState, SSE_STATE_DEBOUNCE_MS);
    stateBroadcastTimer.unref();
  };
  const attachStateWatchers = () => {
    for (const directory of watchedDirectories) {
      if (stateWatchers.has(directory)) continue;
      let watcher;
      try {
        watcher = watch(directory, { persistent: false }, scheduleStateBroadcast);
      } catch {
        continue;
      }
      watcher.on("error", () => {
        watcher.close();
        if (stateWatchers.get(directory) === watcher) stateWatchers.delete(directory);
      });
      stateWatchers.set(directory, watcher);
    }
  };

  const releaseStream = (stream) => {
    if (!openStreams.delete(stream)) return false;
    clearInterval(stream.heartbeat);
    stream.unsubscribe();
    return true;
  };
  const openEventStream = (response, sessionId) => {
    attachStateWatchers();
    response.flushHeaders?.();
    response.write(SSE_OPEN_PREAMBLE);
    const heartbeat = setInterval(() => response.write(SSE_KEEPALIVE_FRAME), SSE_HEARTBEAT_MS);
    heartbeat.unref();
    const stream = { response, heartbeat, unsubscribe: () => {} };
    openStreams.add(stream);
    response.once("close", () => releaseStream(stream));
    if (questionStream) {
      stream.unsubscribe = questionStream.subscribe(sessionId, (event) => {
        // JSON encoding is what keeps newline-bearing delta text from ending
        // the SSE frame early.
        response.write(sseFrame("question", JSON.stringify(event)));
      });
    }
  };

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
      const rawTarget = String(request.url ?? "/");
      const rawPath = rawTarget.split("?", 1)[0];
      const requestHostRoute = hostRouteFromRequestTarget(rawTarget);
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

        const explorationRoute = parseExplorationRoute(route);
        if (explorationRoute) {
          await loadExploration({ root, explorationId: explorationRoute.explorationId });
          const workspaceAsset = WORKSPACE_STATIC_ASSETS.get(explorationRoute.route);
          if (workspaceAsset) {
            await sendAsset(response, request.method, assetRoot, workspaceAsset);
            return;
          }
          if (explorationRoute.route === "api/exploration") {
            sendJson(
              response,
              200,
              await workspacePayload(root, explorationRoute.explorationId),
            );
            return;
          }
          throw new HttpError(404, "not_found", "not found");
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
            packageVersion: PACKAGE_VERSION,
            instanceId,
            sessionCount: (await libraryPayload(root)).sessions.length,
            ...(serviceChat === undefined ? {} : { chat: serviceChat }),
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
        const imageAsset = /^assets\/(asset_[a-f0-9]{32})$/u.exec(sessionRoute.route);
        if (imageAsset) {
          await sendSessionImageAsset(
            response,
            request.method,
            root,
            session,
            imageAsset[1],
          );
          return;
        }
        const viewerAsset = VIEWER_STATIC_ASSETS.get(sessionRoute.route);
        if (viewerAsset) {
          await sendAsset(response, request.method, assetRoot, viewerAsset);
          return;
        }
        if (sessionRoute.route === "api/health") {
          const projectedChat = await projectChatCapability(session, requestHostRoute);
          sendJson(response, 200, {
            ok: true,
            analysisId: session.analysisId ?? dataPackageFor(session).id,
            sessionId: session.id,
            revision: session.state?.revision ?? 0,
            dataPackageId: dataPackageFor(session).id,
            ...(projectedChat === null ? {} : { chat: projectedChat }),
          });
          return;
        }
        if (sessionRoute.route === "api/data") {
          sendJson(response, 200, publicArtifactForBrowser(dataPackageFor(session)));
          return;
        }
        if (sessionRoute.route === "api/render-model") {
          sendJson(response, 200, renderModelForArtifact(dataPackageFor(session)));
          return;
        }
        if (sessionRoute.route === "api/target-members") {
          const { targetId, offset, limit } = targetPageFromRequestTarget(rawTarget);
          try {
            sendJson(
              response,
              200,
              await resolveArtifactVisualTarget(
                dataPackageFor(session),
                targetId,
                { offset, limit },
              ),
            );
          } catch (error) {
            if (
              error?.code === "UNKNOWN_VISUAL_TARGET" ||
              error?.code === "VISUAL_TARGET_MISMATCH" ||
              error?.code === "UNSUPPORTED_VISUAL_TARGET" ||
              error instanceof TypeError ||
              error instanceof RangeError
            ) {
              throw new HttpError(
                400,
                "invalid_visual_target",
                "targetId does not resolve through the package's exact form",
              );
            }
            throw error;
          }
          return;
        }
        if (sessionRoute.route === "api/chat/threads") {
          sendJson(response, 200, {
            schemaVersion: 1,
            threads: await listProjectChatThreads({ root }),
          });
          return;
        }
        if (sessionRoute.route === "api/state") {
          const threadId = chatThreadIdFromRequestTarget(rawTarget);
          sendJson(
            response,
            200,
            await publicProjectSession(session, requestHostRoute, threadId),
          );
          return;
        }
        if (sessionRoute.route === "api/events") {
          response.statusCode = 200;
          setHeaders(response, { "Content-Type": "text/event-stream" });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          openEventStream(response, routedSessionId);
          return;
        }
        throw new HttpError(404, "not_found", "not found");
      }

      if (request.method === "POST") {
        const explorationRoute = parseExplorationRoute(route);
        if (explorationRoute) {
          await loadExploration({ root, explorationId: explorationRoute.explorationId });
          if (request.headers.origin !== origin) {
            throw new HttpError(403, "origin_forbidden", "mutation requires the viewer's exact Origin header");
          }
          const mutation = parseWorkspaceMutationRoute(explorationRoute.route);
          if (!mutation) throw new HttpError(404, "not_found", "not found");
          const experiment = await publicExperiment({ root, experimentId: mutation.experimentId });
          if (experiment.explorationId !== explorationRoute.explorationId) {
            throw new HttpError(404, "not_found", "not found");
          }
          const body = await readJsonBody(request);
          if (mutation.action === "star") {
            assertOnlyKeys(body, new Set(["starred", "mutationId", "expectedRevision"]));
            if (typeof body.starred !== "boolean") {
              throw new HttpError(400, "invalid_request", "starred must be a boolean");
            }
            const mutationId = workspaceMutationId(body);
            const revision = expectedRevision(body.expectedRevision);
            await appendExperimentEvent({
              root,
              experimentId: mutation.experimentId,
              kind: "human-star-changed",
              payload: { starred: body.starred },
              actor: "human",
              idempotencyKey: mutationId,
              expectedRevision: revision,
              dedupeConsecutive: true,
            });
          } else {
            assertOnlyKeys(body, new Set(["kind", "note", "mutationId", "expectedRevision"]));
            if (typeof body.kind !== "string") {
              throw new HttpError(400, "invalid_request", "feedback kind must be a string");
            }
            const mutationId = workspaceMutationId(body);
            const revision = expectedRevision(body.expectedRevision);
            if (["dismissed", "acted-upon"].includes(body.kind)) {
              if (body.note !== undefined) {
                throw new HttpError(400, "invalid_request", "dispositions do not accept a note");
              }
              await appendExperimentEvent({
                root,
                experimentId: mutation.experimentId,
                kind: "human-disposition-recorded",
                payload: { disposition: body.kind },
                actor: "human",
                idempotencyKey: mutationId,
                expectedRevision: revision,
                dedupeConsecutive: true,
              });
            } else {
              if (!FEEDBACK_KINDS.includes(body.kind)) {
                throw new HttpError(400, "invalid_request", "feedback kind is not supported");
              }
              if (body.note !== undefined && (typeof body.note !== "string" || !body.note.trim())) {
                throw new HttpError(400, "invalid_request", "feedback note must be a non-empty string");
              }
              await appendExperimentEvent({
                root,
                experimentId: mutation.experimentId,
                kind: "feedback-recorded",
                payload: {
                  kind: body.kind,
                  ...(body.note === undefined ? {} : { note: body.note }),
                },
                actor: "human",
                idempotencyKey: mutationId,
                expectedRevision: revision,
              });
            }
          }
          sendJson(
            response,
            200,
            await workspaceExperimentResponse(
              root,
              explorationRoute.explorationId,
              mutation.experimentId,
            ),
          );
          return;
        }

        const sessionRoute = parseSessionRoute(route);
        if (!sessionRoute) throw new HttpError(404, "not_found", "not found");
        routedSessionId = sessionRoute.sessionId;
        if (request.headers.origin !== origin) {
          throw new HttpError(403, "origin_forbidden", "mutation requires the viewer's exact Origin header");
        }
        const body = await readJsonBody(request);
        const session = await loadSession(root, routedSessionId);
        const dataPackage = dataPackageFor(session);

        if (sessionRoute.route === "api/chat/threads") {
          assertOnlyKeys(body, new Set());
          const record = await createChatThread({ root, session });
          sendJson(response, 201, {
            ok: true,
            thread: await projectChatThread({ root, threadId: record.id }),
          });
          return;
        }
        if (sessionRoute.route === "api/selection") {
          const { revision, patch } = await validateSelection(body, dataPackage, routedSessionId);
          try {
            const updated = await patchSession(root, routedSessionId, revision, patch);
            sendJson(response, 200, await publicProjectSession(updated, requestHostRoute));
          } catch (error) {
            if (isConflict(error)) {
              return conflictResponse(
                response,
                root,
                routedSessionId,
                projectChatCapability,
                requestHostRoute,
              );
            }
            throw error;
          }
          return;
        }
        if (sessionRoute.route === "api/view-state") {
          const { revision, patch } = validateViewState(body, dataPackage, session.state);
          try {
            const updated = await patchSession(root, routedSessionId, revision, patch);
            sendJson(response, 200, await publicProjectSession(updated, requestHostRoute));
          } catch (error) {
            if (isConflict(error)) {
              return conflictResponse(
                response,
                root,
                routedSessionId,
                projectChatCapability,
                requestHostRoute,
              );
            }
            throw error;
          }
          return;
        }
        if (sessionRoute.route === "api/chat/retry") {
          const { questionId, threadId } = validateChatRetry(body);
          let retried;
          try {
            if (threadId === undefined) {
              const retryRoute = await questionRouteFor(
                routedSessionId,
                requestHostRoute,
              );
              if (!retryRoute) {
                throw new HttpError(
                  409,
                  "chat_route_unavailable",
                  "No coding agent is attached to this visualization. Open it again from Attend before retrying.",
                );
              }
              retried = {
                ...await retryQuestionResponse({
                  root,
                  sessionId: routedSessionId,
                  questionId,
                  expectedRoute: retryRoute,
                }),
                ownerSessionId: routedSessionId,
              };
            } else {
              retried = await retryThreadQuestion({
                root,
                threadId,
                questionId,
                routeForSession: (ownerSessionId) => questionRouteFor(
                  ownerSessionId,
                  requestHostRoute,
                ),
              });
            }
          } catch (error) {
            if (error?.code === "CHAT_ROUTE_UNAVAILABLE") {
              throw new HttpError(
                409,
                "chat_route_unavailable",
                "No coding agent is attached to this visualization. Open it again from Attend before retrying.",
              );
            }
            const httpError = responseLifecycleHttpError(error);
            if (httpError) throw httpError;
            throw error;
          }
          const currentSession = retried.ownerSessionId === routedSessionId
            ? retried.session
            : await loadSession(root, routedSessionId);
          const publicUpdated = await publicProjectSession(
            currentSession,
            requestHostRoute,
            threadId,
          );
          sendJson(response, 200, {
            ok: true,
            status: "queued",
            questionId,
            revision: currentSession.state.revision,
            session: publicUpdated,
          });
          enqueueCommittedQuestion(enqueueQuestion, {
            root,
            sessionId: retried.ownerSessionId,
            questionId,
            route: retried.question.response?.route,
          });
          return;
        }
        if (sessionRoute.route === "api/chat") {
          const { revision, selectionId, threadId, message } = validateChat(body);
          const selection = selectionFor(session);
          if (session.state?.revision !== revision || selection.id !== selectionId) {
            return conflictResponse(
              response,
              root,
              routedSessionId,
              projectChatCapability,
              requestHostRoute,
            );
          }
          try {
            const questionRoute = await questionRouteFor(
              routedSessionId,
              requestHostRoute,
            );
            if (!questionRoute) {
              throw new HttpError(
                409,
                "chat_route_unavailable",
                "No coding agent is attached to this visualization. Open it again from Attend before asking.",
              );
            }
            const appended = threadId === undefined
              ? await appendQuestion(
                  root,
                  routedSessionId,
                  revision,
                  message,
                  selection,
                  questionRoute,
                )
              : await appendThreadQuestion({
                  root,
                  threadId,
                  sessionId: routedSessionId,
                  expectedRevision: revision,
                  selection,
                  message,
                  route: questionRoute,
                });
            const updated = appended.session;
            const publicQuestion = publicConversationTurn(
              appended.persistedQuestion,
            );
            enqueueCommittedQuestion(enqueueQuestion, {
              root,
              sessionId: routedSessionId,
              questionId: appended.persistedQuestion.id,
              route: questionRoute,
            });
            sendJson(response, 200, {
              ok: true,
              status: "queued",
              revision: updated.state?.revision ?? revision + 1,
              selectionId,
              question: publicQuestion,
              session: await publicProjectSession(
                updated,
                requestHostRoute,
                threadId,
              ),
            });
          } catch (error) {
            if (isConflict(error)) {
              return conflictResponse(
                response,
                root,
                routedSessionId,
                projectChatCapability,
                requestHostRoute,
              );
            }
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
          await conflictResponse(
            response,
            root,
            routedSessionId,
            projectChatCapability,
            requestHostRoute,
          );
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
      for (const stream of [...openStreams]) {
        if (releaseStream(stream)) stream.response.end();
      }
      for (const [directory, watcher] of stateWatchers) {
        watcher.close();
        stateWatchers.delete(directory);
      }
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
