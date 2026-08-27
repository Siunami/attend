import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { PACKAGE_VERSION } from "./constants.js";
import {
  completeHostQuestion,
  releaseHostQuestion,
  rebindHostQuestion,
  waitForHostQuestion,
} from "./host-bridge.js";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const COMPATIBLE_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
]);
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 600;
const HOST_TICKET_PATTERN =
  /^attend_host_v1\.host_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const WAIT_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    ticket: {
      type: "string",
      pattern: HOST_TICKET_PATTERN.source,
      description: "The one-time host attachment ticket returned by attend view.",
    },
    timeoutSeconds: {
      type: "integer",
      minimum: 0,
      maximum: MAX_TIMEOUT_SECONDS,
      default: DEFAULT_TIMEOUT_SECONDS,
      description: "How long to wait. A timeout leaves the question queued.",
    },
  },
  required: ["ticket"],
});

const REPLY_GUARD_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: {
      type: "string",
      pattern: SAFE_IDENTIFIER_PATTERN.source,
    },
    questionId: {
      type: "string",
      pattern: SAFE_IDENTIFIER_PATTERN.source,
    },
    expectedRevision: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    selectionId: {
      type: "string",
      pattern: SAFE_IDENTIFIER_PATTERN.source,
    },
  },
  required: [
    "sessionId",
    "questionId",
    "expectedRevision",
    "selectionId",
  ],
});

const REBIND_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    ticket: {
      type: "string",
      pattern: HOST_TICKET_PATTERN.source,
      description: "The replacement host attachment ticket returned by attend view.",
    },
    questionId: {
      type: "string",
      pattern: SAFE_IDENTIFIER_PATTERN.source,
      description: "The exact queued question reported by attend view.",
    },
    expectedRevision: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "The session revision reported with the recovery action.",
    },
    confirmTakeover: {
      const: true,
    },
  },
  required: ["ticket", "questionId", "expectedRevision", "confirmTakeover"],
});

const REPLY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    ticket: {
      type: "string",
      pattern: HOST_TICKET_PATTERN.source,
      description: "The host attachment ticket that received the question.",
    },
    replyGuard: REPLY_GUARD_SCHEMA,
    message: {
      type: "string",
      minLength: 1,
      maxLength: 65_536,
      description: "The answer to commit, limited to 64 KiB of UTF-8 text.",
    },
  },
  required: ["ticket", "replyGuard", "message"],
});

export const ATTEND_MCP_TOOLS = Object.freeze([
  Object.freeze({
    name: "attend_wait_for_question",
    title: "Wait for an Attend question",
    description:
      "Wait for one queued sidebar question bound to this host ticket. Returns its immutable selection, verified evidence, bounded Attend history, and reply guard. Reading does not claim the question.",
    inputSchema: WAIT_INPUT_SCHEMA,
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "attend_rebind_question",
    title: "Rebind an Attend question",
    description:
      "After the user approves takeover, move one exact queued host question to this replacement host ticket and revoke its earlier attachment. Pass confirmTakeover: true. It cannot capture detached work or a question from another session. Once dispatched, this guarded mutation finishes and returns an idempotent receipt even if the client sends a cancellation notification.",
    inputSchema: REBIND_INPUT_SCHEMA,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "attend_reply",
    title: "Reply to an Attend question",
    description:
      "Commit an answer with the exact host ticket and reply guard returned by attend_wait_for_question. Exact repeated replies are idempotent; stale or changed replies fail. Once dispatched, this guarded mutation finishes and returns its receipt even if the client sends a cancellation notification.",
    inputSchema: REPLY_INPUT_SCHEMA,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
  }),
]);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function projectRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("root must be a non-empty path");
  }
  return resolve(root);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidParams(message) {
  throw new RpcError(-32602, message);
}

function exactObject(value, label, allowedKeys) {
  if (!isPlainObject(value)) invalidParams(`${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length) {
    invalidParams(`${label} contains unsupported field: ${unexpected[0]}`);
  }
  return value;
}

function hostTicket(value) {
  if (typeof value !== "string" || !HOST_TICKET_PATTERN.test(value)) {
    invalidParams("ticket must be the host ticket returned by attend view");
  }
  return value;
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    invalidParams(`${label} must be a safe non-empty identifier`);
  }
  return value;
}

function waitArguments(value) {
  const input = exactObject(
    value,
    "attend_wait_for_question arguments",
    new Set(["ticket", "timeoutSeconds"]),
  );
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 0 ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    invalidParams(
      `timeoutSeconds must be an integer between 0 and ${MAX_TIMEOUT_SECONDS}`,
    );
  }
  return {
    ticket: hostTicket(input.ticket),
    timeoutSeconds,
  };
}

function cancellationArguments(value) {
  const input = exactObject(
    value,
    "notifications/cancelled params",
    new Set(["requestId", "reason", "_meta"]),
  );
  if (
    (typeof input.requestId !== "string" && typeof input.requestId !== "number") ||
    (typeof input.requestId === "number" && !Number.isFinite(input.requestId))
  ) {
    invalidParams("notifications/cancelled.requestId must be a string or finite number");
  }
  if (input.reason !== undefined && typeof input.reason !== "string") {
    invalidParams("notifications/cancelled.reason must be a string when supplied");
  }
  if (input._meta !== undefined && !isPlainObject(input._meta)) {
    invalidParams("notifications/cancelled._meta must be an object when supplied");
  }
  return { requestId: input.requestId };
}

function rebindArguments(value) {
  const input = exactObject(
    value,
    "attend_rebind_question arguments",
    new Set(["ticket", "questionId", "expectedRevision", "confirmTakeover"]),
  );
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    invalidParams("expectedRevision must be a non-negative integer");
  }
  if (input.confirmTakeover !== true) {
    invalidParams("confirmTakeover must be true");
  }
  return {
    ticket: hostTicket(input.ticket),
    questionId: safeIdentifier(input.questionId, "questionId"),
    expectedRevision: input.expectedRevision,
    confirmTakeover: true,
  };
}

function replyArguments(value) {
  const input = exactObject(
    value,
    "attend_reply arguments",
    new Set(["ticket", "replyGuard", "message"]),
  );
  const guard = exactObject(
    input.replyGuard,
    "replyGuard",
    new Set(["sessionId", "questionId", "expectedRevision", "selectionId"]),
  );
  if (
    !Number.isSafeInteger(guard.expectedRevision) ||
    guard.expectedRevision < 0
  ) {
    invalidParams("replyGuard.expectedRevision must be a non-negative integer");
  }
  if (
    typeof input.message !== "string" ||
    input.message.length === 0 ||
    input.message.includes("\0") ||
    Buffer.byteLength(input.message, "utf8") > 64 * 1024
  ) {
    invalidParams("message must be non-empty UTF-8 text of at most 64 KiB");
  }
  return {
    ticket: hostTicket(input.ticket),
    replyGuard: {
      sessionId: safeIdentifier(guard.sessionId, "replyGuard.sessionId"),
      questionId: safeIdentifier(guard.questionId, "replyGuard.questionId"),
      expectedRevision: guard.expectedRevision,
      selectionId: safeIdentifier(guard.selectionId, "replyGuard.selectionId"),
    },
    message: input.message,
  };
}

function jsonTextResult(structuredContent, options = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(options.isError ? { isError: true } : {}),
  };
}

function publicToolError(error) {
  const code =
    typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : "HOST_BRIDGE_ERROR";
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "The Attend host bridge failed";
  return jsonTextResult(
    { event: "error", error: { code, message } },
    { isError: true },
  );
}

function requestId(message) {
  if (!Object.hasOwn(message, "id")) return undefined;
  if (
    (typeof message.id !== "string" && typeof message.id !== "number") ||
    (typeof message.id === "number" && !Number.isFinite(message.id))
  ) {
    throw new RpcError(-32600, "Request id must be a string or finite number");
  }
  return message.id;
}

function validateMessage(message) {
  if (!isPlainObject(message) || message.jsonrpc !== "2.0") {
    throw new RpcError(-32600, "Invalid JSON-RPC request");
  }
  const id = requestId(message);
  if (typeof message.method !== "string" || message.method.length === 0) {
    throw new RpcError(-32600, "JSON-RPC method must be a non-empty string");
  }
  return { id, notification: id === undefined };
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, error) {
  const rpcError = error instanceof RpcError
    ? error
    : new RpcError(-32603, "Internal error");
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: rpcError.code,
      message: rpcError.message,
      ...(rpcError.data === undefined ? {} : { data: rpcError.data }),
    },
  };
}

function initializeResult(params, serverVersion) {
  const input = exactObject(
    params,
    "initialize params",
    new Set(["protocolVersion", "capabilities", "clientInfo", "_meta"]),
  );
  if (typeof input.protocolVersion !== "string" || input.protocolVersion.length === 0) {
    invalidParams("initialize.protocolVersion must be a non-empty string");
  }
  if (!isPlainObject(input.capabilities)) {
    invalidParams("initialize.capabilities must be an object");
  }
  if (!isPlainObject(input.clientInfo)) {
    invalidParams("initialize.clientInfo must be an object");
  }
  if (
    typeof input.clientInfo.name !== "string" ||
    input.clientInfo.name.length === 0 ||
    typeof input.clientInfo.version !== "string" ||
    input.clientInfo.version.length === 0
  ) {
    invalidParams("initialize.clientInfo requires name and version strings");
  }
  return {
    protocolVersion: COMPATIBLE_PROTOCOL_VERSIONS.has(input.protocolVersion)
      ? input.protocolVersion
      : MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "attend-local", version: serverVersion },
    instructions:
      "Wait with the ticket from attend view. If view reports a question bound to an earlier host, ask the user to approve takeover before rebinding that exact question with confirmTakeover: true; takeover revokes the earlier attachment. Answer only from returned evidence, then pass its exact replyGuard to attend_reply. A timeout leaves the question queued.",
  };
}

function rebindProjection(rebound, questionId) {
  const sessionId = rebound?.session?.id;
  const stateRevision = rebound?.session?.state?.revision;
  if (
    !SAFE_IDENTIFIER_PATTERN.test(sessionId ?? "") ||
    !Number.isSafeInteger(stateRevision) ||
    rebound?.question?.id !== questionId ||
    rebound?.question?.response?.status !== "queued"
  ) {
    throw new Error("The host rebind returned an invalid recovery result");
  }
  return {
    event: "rebound",
    sessionId,
    questionId,
    stateRevision,
    repeated: rebound.repeated === true,
    nextTool: "attend_wait_for_question",
  };
}

function replyProjection(completed, replyGuard) {
  const sessionId = completed?.session?.id;
  const stateRevision = completed?.session?.state?.revision;
  const selectionId = completed?.answer?.selection?.id;
  if (
    sessionId !== replyGuard.sessionId ||
    !Number.isSafeInteger(stateRevision) ||
    selectionId !== replyGuard.selectionId ||
    completed?.answer?.replyToTurnId !== replyGuard.questionId
  ) {
    throw new Error("The guarded host reply returned an invalid completion result");
  }
  return {
    event: "committed",
    sessionId,
    stateRevision,
    selectionId,
    questionId: replyGuard.questionId,
    repeated: completed.repeated === true,
  };
}

/**
 * Create one MCP endpoint bound to one project root. The endpoint delegates to
 * the host bridge and owns no queue, provider process, or evidence reader.
 */
export function createAttendMcpServer({
  root,
  waitForQuestion = waitForHostQuestion,
  releaseQuestion = releaseHostQuestion,
  rebindQuestion = rebindHostQuestion,
  completeQuestion = completeHostQuestion,
  serverVersion = PACKAGE_VERSION,
} = {}) {
  const boundary = projectRoot(root);
  if (typeof waitForQuestion !== "function") {
    throw new TypeError("waitForQuestion must be a function");
  }
  if (typeof releaseQuestion !== "function") {
    throw new TypeError("releaseQuestion must be a function");
  }
  if (typeof rebindQuestion !== "function") {
    throw new TypeError("rebindQuestion must be a function");
  }
  if (typeof completeQuestion !== "function") {
    throw new TypeError("completeQuestion must be a function");
  }
  if (typeof serverVersion !== "string" || serverVersion.length === 0) {
    throw new TypeError("serverVersion must be a non-empty string");
  }

  let lifecycle = "created";
  const shutdown = new AbortController();
  const inFlight = new Map();

  async function callTool(params, signal) {
    const input = exactObject(
      params,
      "tools/call params",
      new Set(["name", "arguments", "_meta"]),
    );
    if (typeof input.name !== "string" || input.name.length === 0) {
      invalidParams("tools/call requires a tool name");
    }

    if (input.name === "attend_wait_for_question") {
      const args = waitArguments(input.arguments);
      try {
        const packet = await waitForQuestion({
          root: boundary,
          ticket: args.ticket,
          timeoutMs: args.timeoutSeconds * 1_000,
          signal,
        });
        if (signal.aborted && packet?.replyGuard?.questionId) {
          await releaseQuestion({
            root: boundary,
            ticket: args.ticket,
            questionId: packet.replyGuard.questionId,
          });
        }
        signal.throwIfAborted();
        if (packet === null) {
          return jsonTextResult({
            event: "timeout",
            timeoutSeconds: args.timeoutSeconds,
          });
        }
        if (
          !isPlainObject(packet) ||
          packet.schema !== "attend-host-question/1" ||
          !isPlainObject(packet.replyGuard) ||
          !isPlainObject(packet.question) ||
          !Object.hasOwn(packet, "selection") ||
          !isPlainObject(packet.evidence)
        ) {
          throw new Error("The Attend host bridge returned an invalid question packet");
        }
        return jsonTextResult({ event: "question", packet });
      } catch (error) {
        if (signal.aborted) throw error;
        return publicToolError(error);
      }
    }

    if (input.name === "attend_reply") {
      const args = replyArguments(input.arguments);
      try {
        const completed = await completeQuestion({
          root: boundary,
          ticket: args.ticket,
          replyGuard: args.replyGuard,
          message: args.message,
        });
        return jsonTextResult(replyProjection(completed, args.replyGuard));
      } catch (error) {
        return publicToolError(error);
      }
    }

    if (input.name === "attend_rebind_question") {
      const args = rebindArguments(input.arguments);
      try {
        const rebound = await rebindQuestion({
          root: boundary,
          ticket: args.ticket,
          questionId: args.questionId,
          expectedRevision: args.expectedRevision,
          confirmTakeover: args.confirmTakeover,
        });
        return jsonTextResult(rebindProjection(rebound, args.questionId));
      } catch (error) {
        return publicToolError(error);
      }
    }

    invalidParams(`Unknown Attend tool: ${input.name}`);
  }

  async function dispatch(message) {
    let envelope;
    try {
      envelope = validateMessage(message);
      const { id, notification } = envelope;

      if (message.method === "initialize") {
        if (notification) {
          throw new RpcError(-32600, "initialize must be a request");
        }
        if (lifecycle !== "created") {
          throw new RpcError(-32600, "Attend MCP is already initialized");
        }
        const result = initializeResult(message.params, serverVersion);
        lifecycle = "awaiting-initialized";
        return success(id, result);
      }

      if (message.method === "notifications/initialized") {
        if (!notification) {
          throw new RpcError(-32600, "notifications/initialized must not have an id");
        }
        if (lifecycle === "awaiting-initialized") lifecycle = "ready";
        return null;
      }

      if (message.method === "notifications/cancelled") {
        if (!notification) {
          throw new RpcError(-32600, "notifications/cancelled must not have an id");
        }
        const { requestId: cancelledId } = cancellationArguments(message.params);
        const request = inFlight.get(cancelledId);
        if (request?.cancellable && !request.controller.signal.aborted) {
          request.controller.abort(new Error("MCP request was cancelled"));
        }
        return null;
      }

      if (notification) return null;
      if (message.method === "ping") {
        if (message.params !== undefined && !isPlainObject(message.params)) {
          invalidParams("ping params must be an object when supplied");
        }
        return success(id, {});
      }
      if (lifecycle !== "ready") {
        throw new RpcError(-32002, "Attend MCP is not initialized");
      }

      if (message.method === "tools/list") {
        if (
          message.params !== undefined &&
          !isPlainObject(message.params)
        ) {
          invalidParams("tools/list params must be an object when supplied");
        }
        return success(id, { tools: cloneJson(ATTEND_MCP_TOOLS) });
      }
      if (message.method === "tools/call") {
        if (inFlight.has(id)) {
          throw new RpcError(-32600, "Request id is already in flight");
        }
        const cancellable = message.params?.name === "attend_wait_for_question";
        const controller = new AbortController();
        const signal = cancellable
          ? AbortSignal.any([shutdown.signal, controller.signal])
          : controller.signal;
        const request = { cancellable, controller };
        inFlight.set(id, request);
        try {
          const result = await callTool(message.params, signal);
          return success(id, result);
        } catch (error) {
          if (signal.aborted) return null;
          throw error;
        } finally {
          if (inFlight.get(id) === request) inFlight.delete(id);
        }
      }
      throw new RpcError(-32601, `Method not found: ${message.method}`);
    } catch (error) {
      if (envelope?.notification) return null;
      return failure(envelope?.id, error);
    }
  }

  function close() {
    if (!shutdown.signal.aborted) {
      shutdown.abort(new Error("Attend MCP is shutting down"));
    }
  }

  return Object.freeze({
    root: boundary,
    dispatch,
    close,
  });
}

async function writeMessage(output, message) {
  const line = `${JSON.stringify(message)}\n`;
  if (output.write(line)) return;
  await once(output, "drain");
}

/** Run a newline-delimited JSON-RPC 2.0 MCP server over stdio streams. */
export async function runAttendMcpStdio({
  root,
  input = process.stdin,
  output = process.stdout,
  ...serverOptions
} = {}) {
  if (!input || typeof input.on !== "function") {
    throw new TypeError("input must be a readable stream");
  }
  if (!output || typeof output.write !== "function") {
    throw new TypeError("output must be a writable stream");
  }
  const server = createAttendMcpServer({ root, ...serverOptions });
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const pending = new Set();
  let writes = Promise.resolve();

  function enqueueResponse(response) {
    if (response === null) return;
    writes = writes.then(() => writeMessage(output, response));
  }

  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        enqueueResponse(failure(null, new RpcError(-32700, "Parse error")));
        continue;
      }
      const operation = server.dispatch(message).then(enqueueResponse);
      pending.add(operation);
      operation.finally(() => pending.delete(operation));
    }
  } finally {
    server.close();
    await Promise.allSettled(pending);
    await writes;
    lines.close();
  }
}

export const ATTEND_MCP_LIMITS = Object.freeze({
  defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
});

export { MCP_PROTOCOL_VERSION };
