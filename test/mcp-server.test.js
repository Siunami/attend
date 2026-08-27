import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  hostListenerPresence,
  registerHostAttachment,
} from "../src/chat-route.js";
import {
  ATTEND_MCP_LIMITS,
  MCP_PROTOCOL_VERSION,
  createAttendMcpServer,
  runAttendMcpStdio,
} from "../src/mcp-server.js";

const TICKET = `attend_host_v1.host_0123456789abcdef.${"A".repeat(43)}`;
const REPLY_GUARD = Object.freeze({
  sessionId: "session_mcp",
  questionId: "turn_mcp",
  expectedRevision: 4,
  selectionId: "selection_0123456789abcdef",
});

function packet() {
  return {
    schema: "attend-host-question/1",
    route: {
      kind: "host",
      attachmentId: "host_0123456789abcdef",
      generation: 1,
    },
    replyGuard: { ...REPLY_GUARD },
    question: {
      id: REPLY_GUARD.questionId,
      role: "user",
      content: "What does the selected phrase show?",
    },
    selection: {
      id: REPLY_GUARD.selectionId,
      rowIds: ["phrase_bug_book"],
    },
    contextBinding: {
      mode: "attached",
      selectionTurnId: REPLY_GUARD.questionId,
    },
    evidence: {
      kind: "attend-evidence-packet",
      selectionId: REPLY_GUARD.selectionId,
      sources: [{ id: "source_alpha", content: "Bug book begins here." }],
    },
    conversation: [],
  };
}

function initializeRequest(id = 1, protocolVersion = MCP_PROTOCOL_VERSION) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  };
}

async function readyServer(options = {}) {
  const server = createAttendMcpServer({ root: "/tmp/attend-mcp", ...options });
  const initialized = await server.dispatch(initializeRequest());
  assert.equal(initialized.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(
    await server.dispatch({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
    null,
  );
  return server;
}

test("initialize advertises the three host bridge tools with exact schemas", async () => {
  const server = createAttendMcpServer({ root: "/tmp/attend-mcp" });
  const fallback = await server.dispatch(initializeRequest(17, "2099-01-01"));
  assert.deepEqual(fallback, {
    jsonrpc: "2.0",
    id: 17,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "attend-local", version: "0.5.0" },
      instructions:
        "Wait with the ticket from attend view. If view reports a question bound to an earlier host, ask the user to approve takeover before rebinding that exact question with confirmTakeover: true; takeover revokes the earlier attachment. Answer only from returned evidence, then pass its exact replyGuard to attend_reply. A timeout leaves the question queued.",
    },
  });

  assert.deepEqual(await server.dispatch({
    jsonrpc: "2.0",
    id: 18,
    method: "ping",
    params: {},
  }), {
    jsonrpc: "2.0",
    id: 18,
    result: {},
  });

  await server.dispatch({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const listed = await server.dispatch({
    jsonrpc: "2.0",
    id: "tools",
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["attend_wait_for_question", "attend_rebind_question", "attend_reply"],
  );
  assert.equal(listed.result.tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ["ticket"]);
  assert.equal(
    listed.result.tools[0].inputSchema.properties.timeoutSeconds.maximum,
    ATTEND_MCP_LIMITS.maxTimeoutSeconds,
  );
  assert.equal(listed.result.tools[1].inputSchema.additionalProperties, false);
  assert.deepEqual(
    listed.result.tools[1].inputSchema.required,
    ["ticket", "questionId", "expectedRevision", "confirmTakeover"],
  );
  assert.deepEqual(
    listed.result.tools[1].inputSchema.properties.confirmTakeover,
    { const: true },
  );
  assert.equal(listed.result.tools[1].annotations.destructiveHint, true);
  assert.equal(listed.result.tools[2].inputSchema.additionalProperties, false);
  assert.deepEqual(
    listed.result.tools[2].inputSchema.required,
    ["ticket", "replyGuard", "message"],
  );
  assert.equal(
    listed.result.tools[2].inputSchema.properties.replyGuard.additionalProperties,
    false,
  );
  server.close();
});

test("wait delegates to the fixed-root bridge and returns JSON text plus structured content", async () => {
  const calls = [];
  const question = packet();
  const server = await readyServer({
    async waitForQuestion(options) {
      calls.push(options);
      return question;
    },
  });
  const response = await server.dispatch({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "attend_wait_for_question",
      arguments: { ticket: TICKET, timeoutSeconds: 12 },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, "/tmp/attend-mcp");
  assert.equal(calls[0].ticket, TICKET);
  assert.equal(calls[0].timeoutMs, 12_000);
  assert.equal(calls[0].signal instanceof AbortSignal, true);
  assert.deepEqual(response.result.structuredContent, {
    event: "question",
    packet: question,
  });
  assert.deepEqual(
    JSON.parse(response.result.content[0].text),
    response.result.structuredContent,
  );
  assert.equal(response.result.isError, undefined);
  server.close();
});

test("wait defaults to five minutes and reports timeout without claiming a question", async () => {
  let received;
  const server = await readyServer({
    async waitForQuestion(options) {
      received = options;
      return null;
    },
  });
  const response = await server.dispatch({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "attend_wait_for_question",
      arguments: { ticket: TICKET },
    },
  });
  assert.equal(
    received.timeoutMs,
    ATTEND_MCP_LIMITS.defaultTimeoutSeconds * 1_000,
  );
  assert.deepEqual(response.result.structuredContent, {
    event: "timeout",
    timeoutSeconds: ATTEND_MCP_LIMITS.defaultTimeoutSeconds,
  });
  server.close();
});

test("cancellation aborts only the matching in-flight wait and suppresses its response", async () => {
  const waits = new Map();
  const started = [];
  const server = await readyServer({
    waitForQuestion({ ticket, signal }) {
      let resolveWait;
      const result = new Promise((resolve) => {
        resolveWait = resolve;
      });
      waits.set(ticket, { signal, resolve: resolveWait });
      started.shift()?.();
      return result;
    },
  });
  const waitStarted = () => new Promise((resolve) => started.push(resolve));
  const otherTicket = `attend_host_v1.host_fedcba9876543210.${"B".repeat(43)}`;

  const firstStarted = waitStarted();
  const firstResponse = server.dispatch({
    jsonrpc: "2.0",
    id: "wait-first",
    method: "tools/call",
    params: {
      name: "attend_wait_for_question",
      arguments: { ticket: TICKET, timeoutSeconds: 30 },
    },
  });
  await firstStarted;

  const secondStarted = waitStarted();
  const secondResponse = server.dispatch({
    jsonrpc: "2.0",
    id: "wait-second",
    method: "tools/call",
    params: {
      name: "attend_wait_for_question",
      arguments: { ticket: otherTicket, timeoutSeconds: 30 },
    },
  });
  await secondStarted;

  assert.equal(await server.dispatch({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "wait-first", extra: true },
  }), null);
  assert.equal(waits.get(TICKET).signal.aborted, false);
  const cancellationRequest = await server.dispatch({
    jsonrpc: "2.0",
    id: "cancel-as-request",
    method: "notifications/cancelled",
    params: { requestId: "wait-first" },
  });
  assert.equal(cancellationRequest.error.code, -32600);
  assert.equal(waits.get(TICKET).signal.aborted, false);

  assert.equal(await server.dispatch({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: {
      requestId: "wait-first",
      reason: "user stopped waiting",
      _meta: { progressToken: "cancel-wait-first" },
    },
  }), null);
  assert.equal(waits.get(TICKET).signal.aborted, true);
  assert.equal(waits.get(otherTicket).signal.aborted, false);

  waits.get(TICKET).resolve(null);
  waits.get(otherTicket).resolve(null);
  assert.equal(await firstResponse, null);
  assert.deepEqual((await secondResponse).result.structuredContent, {
    event: "timeout",
    timeoutSeconds: 30,
  });
  server.close();
});

test("cancellation after delivery releases the host answer lease", async () => {
  let resolveWait;
  let started;
  const waitStarted = new Promise((resolveStarted) => {
    started = resolveStarted;
  });
  const released = [];
  const server = await readyServer({
    async waitForQuestion() {
      started();
      return new Promise((resolve) => {
        resolveWait = resolve;
      });
    },
    async releaseQuestion(options) {
      released.push(options);
    },
  });
  const pending = server.dispatch({
    jsonrpc: "2.0",
    id: "cancel-after-delivery",
    method: "tools/call",
    params: {
      name: "attend_wait_for_question",
      arguments: { ticket: TICKET, timeoutSeconds: 30 },
    },
  });
  await waitStarted;
  await server.dispatch({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "cancel-after-delivery" },
  });
  resolveWait(packet());

  assert.equal(await pending, null);
  assert.deepEqual(released, [{
    root: "/tmp/attend-mcp",
    ticket: TICKET,
    questionId: REPLY_GUARD.questionId,
  }]);
  server.close();
});

test("guarded reply and takeover finish visibly after a cancellation notification", async () => {
  let releaseReply;
  let replyStarted;
  const replyGate = new Promise((resolve) => {
    releaseReply = resolve;
  });
  const replyReady = new Promise((resolve) => {
    replyStarted = resolve;
  });
  const replyServer = await readyServer({
    async completeQuestion() {
      replyStarted();
      await replyGate;
      return {
        session: { id: REPLY_GUARD.sessionId, state: { revision: 5 } },
        answer: {
          replyToTurnId: REPLY_GUARD.questionId,
          selection: { id: REPLY_GUARD.selectionId },
        },
        repeated: false,
      };
    },
  });
  const pendingReply = replyServer.dispatch({
    jsonrpc: "2.0",
    id: "guarded-reply",
    method: "tools/call",
    params: {
      name: "attend_reply",
      arguments: {
        ticket: TICKET,
        replyGuard: REPLY_GUARD,
        message: "The guarded answer.",
      },
    },
  });
  await replyReady;
  await replyServer.dispatch({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "guarded-reply" },
  });
  releaseReply();
  assert.equal(
    (await pendingReply).result.structuredContent.event,
    "committed",
  );
  replyServer.close();

  let releaseRebind;
  let rebindStarted;
  const rebindGate = new Promise((resolve) => {
    releaseRebind = resolve;
  });
  const rebindReady = new Promise((resolve) => {
    rebindStarted = resolve;
  });
  const rebindServer = await readyServer({
    async rebindQuestion() {
      rebindStarted();
      await rebindGate;
      return {
        session: { id: REPLY_GUARD.sessionId, state: { revision: 5 } },
        question: {
          id: REPLY_GUARD.questionId,
          response: { status: "queued" },
        },
        repeated: false,
      };
    },
  });
  const pendingRebind = rebindServer.dispatch({
    jsonrpc: "2.0",
    id: "guarded-rebind",
    method: "tools/call",
    params: {
      name: "attend_rebind_question",
      arguments: {
        ticket: TICKET,
        questionId: REPLY_GUARD.questionId,
        expectedRevision: REPLY_GUARD.expectedRevision,
        confirmTakeover: true,
      },
    },
  });
  await rebindReady;
  await rebindServer.dispatch({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "guarded-rebind" },
  });
  releaseRebind();
  assert.equal(
    (await pendingRebind).result.structuredContent.event,
    "rebound",
  );
  rebindServer.close();
});

test("stdio cancellation clears the host listener and emits no response for the wait", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-mcp-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = await registerHostAttachment({
    root,
    sessionId: "session_mcp_cancel",
  });
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let written = "";
  output.on("data", (chunk) => {
    written += chunk;
  });

  const serving = runAttendMcpStdio({ root, input, output });
  input.write(`${JSON.stringify(initializeRequest("initialize-cancel"))}\n`);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  })}\n`);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "cancelled-wait",
    method: "tools/call",
    params: {
      name: "attend_wait_for_question",
      arguments: { ticket: owner.ticket, timeoutSeconds: 30 },
    },
  })}\n`);

  let presence = { present: false };
  for (let attempt = 0; attempt < 100 && !presence.present; attempt += 1) {
    await delay(5);
    presence = await hostListenerPresence({ root, route: owner.route });
  }
  assert.deepEqual(presence, { present: true });

  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "cancelled-wait", reason: "user stopped waiting" },
  })}\n`);
  for (let attempt = 0; attempt < 100 && presence.present; attempt += 1) {
    await delay(5);
    presence = await hostListenerPresence({ root, route: owner.route });
  }
  assert.deepEqual(presence, { present: false });

  input.end();
  await serving;
  const messages = written.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.id), ["initialize-cancel"]);
});

test("rebind passes one exact question, revision, and takeover confirmation", async () => {
  const calls = [];
  const server = await readyServer({
    async rebindQuestion(options) {
      calls.push(options);
      return {
        session: { id: REPLY_GUARD.sessionId, state: { revision: 5 } },
        question: {
          id: REPLY_GUARD.questionId,
          response: { status: "queued" },
        },
        repeated: false,
      };
    },
  });
  const response = await server.dispatch({
    jsonrpc: "2.0",
    id: "rebind",
    method: "tools/call",
    params: {
      name: "attend_rebind_question",
      arguments: {
        ticket: TICKET,
        questionId: REPLY_GUARD.questionId,
        expectedRevision: REPLY_GUARD.expectedRevision,
        confirmTakeover: true,
      },
    },
  });

  assert.deepEqual(calls, [{
    root: "/tmp/attend-mcp",
    ticket: TICKET,
    questionId: REPLY_GUARD.questionId,
    expectedRevision: REPLY_GUARD.expectedRevision,
    confirmTakeover: true,
  }]);
  assert.deepEqual(response.result.structuredContent, {
    event: "rebound",
    sessionId: REPLY_GUARD.sessionId,
    questionId: REPLY_GUARD.questionId,
    stateRevision: 5,
    repeated: false,
    nextTool: "attend_wait_for_question",
  });
  assert.deepEqual(
    JSON.parse(response.result.content[0].text),
    response.result.structuredContent,
  );
  server.close();
});

test("reply passes the returned guard unchanged and exposes only a bounded receipt", async () => {
  const calls = [];
  const server = await readyServer({
    async completeQuestion(options) {
      calls.push(options);
      return {
        session: { id: REPLY_GUARD.sessionId, state: { revision: 4 } },
        answer: {
          replyToTurnId: REPLY_GUARD.questionId,
          selection: { id: REPLY_GUARD.selectionId },
        },
        repeated: false,
      };
    },
  });
  const response = await server.dispatch({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "attend_reply",
      arguments: {
        ticket: TICKET,
        replyGuard: { ...REPLY_GUARD },
        message: "It records a recurring observation.",
      },
    },
  });

  assert.deepEqual(calls, [{
    root: "/tmp/attend-mcp",
    ticket: TICKET,
    replyGuard: REPLY_GUARD,
    message: "It records a recurring observation.",
  }]);
  assert.deepEqual(response.result.structuredContent, {
    event: "committed",
    sessionId: REPLY_GUARD.sessionId,
    stateRevision: 4,
    selectionId: REPLY_GUARD.selectionId,
    questionId: REPLY_GUARD.questionId,
    repeated: false,
  });
  assert.deepEqual(
    JSON.parse(response.result.content[0].text),
    response.result.structuredContent,
  );
  server.close();
});

test("tool arguments reject extra trust paths and waits longer than ten minutes", async () => {
  let called = false;
  const server = await readyServer({
    async waitForQuestion() {
      called = true;
      return null;
    },
  });
  const extraRoot = await server.dispatch({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "attend_wait_for_question",
      arguments: {
        ticket: TICKET,
        timeoutSeconds: 1,
        root: "/tmp/other-project",
      },
    },
  });
  assert.equal(extraRoot.error.code, -32602);
  assert.match(extraRoot.error.message, /unsupported field: root/u);

  const unbounded = await server.dispatch({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "attend_wait_for_question",
      arguments: { ticket: TICKET, timeoutSeconds: 601 },
    },
  });
  assert.equal(unbounded.error.code, -32602);
  assert.match(unbounded.error.message, /between 0 and 600/u);
  const extraSession = await server.dispatch({
    jsonrpc: "2.0",
    id: "rebind-extra-session",
    method: "tools/call",
    params: {
      name: "attend_rebind_question",
      arguments: {
        ticket: TICKET,
        questionId: REPLY_GUARD.questionId,
        expectedRevision: REPLY_GUARD.expectedRevision,
        sessionId: "session_other",
      },
    },
  });
  assert.equal(extraSession.error.code, -32602);
  assert.match(extraSession.error.message, /unsupported field: sessionId/u);

  const unconfirmedTakeover = await server.dispatch({
    jsonrpc: "2.0",
    id: "rebind-without-confirmation",
    method: "tools/call",
    params: {
      name: "attend_rebind_question",
      arguments: {
        ticket: TICKET,
        questionId: REPLY_GUARD.questionId,
        expectedRevision: REPLY_GUARD.expectedRevision,
      },
    },
  });
  assert.equal(unconfirmedTakeover.error.code, -32602);
  assert.match(unconfirmedTakeover.error.message, /confirmTakeover must be true/u);
  assert.equal(called, false);
  server.close();
});

test("bridge failures are MCP tool errors without stack traces", async () => {
  const server = await readyServer({
    async waitForQuestion() {
      const error = new Error("The host attachment expired");
      error.code = "HOST_ATTACHMENT_EXPIRED";
      throw error;
    },
  });
  const response = await server.dispatch({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "attend_wait_for_question",
      arguments: { ticket: TICKET, timeoutSeconds: 0 },
    },
  });
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.structuredContent, {
    event: "error",
    error: {
      code: "HOST_ATTACHMENT_EXPIRED",
      message: "The host attachment expired",
    },
  });
  assert.equal(response.result.content[0].text.includes("stack"), false);
  server.close();
});

test("stdio uses newline-delimited JSON-RPC and never writes for notifications", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let written = "";
  output.on("data", (chunk) => {
    written += chunk;
  });

  const serving = runAttendMcpStdio({
    root: "/tmp/attend-mcp",
    input,
    output,
  });
  input.write(`${JSON.stringify(initializeRequest(8))}\n`);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  })}\n`);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/list",
  })}\n`);
  input.write("{bad json}\n");
  input.end();
  await serving;

  const messages = written.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.id), [8, 9, null]);
  assert.equal(messages[0].result.serverInfo.name, "attend-local");
  assert.equal(messages[1].result.tools.length, 3);
  assert.deepEqual(messages[2].error, { code: -32700, message: "Parse error" });
});
