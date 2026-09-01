import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createLlamaCppModelRunner,
  LOCAL_MODEL,
} from "../src/local-model.js";

const encoder = new TextEncoder();

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new EventEmitter();
  child.kill = (signal = "SIGTERM") => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

function streamedResponse(text, cuts = []) {
  const bytes = encoder.encode(text);
  const body = new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const cut of [...cuts, bytes.length]) {
        controller.enqueue(bytes.slice(offset, cut));
        offset = cut;
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function runnerHarness({ completions, healthy = () => true, env = { HOME: "/Users/tester" } }) {
  const spawns = [];
  const requests = [];
  const children = [];
  let calls = 0;
  const runner = createLlamaCppModelRunner({
    executable: "/opt/homebrew/bin/llama-server",
    resolveExecutable: async (value) => value,
    allocatePort: async () => 48765,
    spawnImpl(executable, args, options) {
      spawns.push({ executable, args, options });
      const child = fakeChild();
      children.push(child);
      return child;
    },
    async fetchImpl(url, options) {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/health")) {
        return new Response("{}", { status: healthy(spawns.length) ? 200 : 503 });
      }
      calls += 1;
      return await completions(calls, options);
    },
    startupTimeoutMs: 1_000,
    pollMs: 1,
    env,
  });
  return { runner, spawns, requests, children };
}

const localRequest = Object.freeze({
  question: { id: "turn_local", content: "What changed?" },
  selection: null,
  contextBinding: { mode: "none", selectionTurnId: null },
  evidence: { kind: "attend-evidence-packet", claims: [] },
  conversation: [],
});

function completionBodies(requests) {
  return requests
    .filter((request) => request.url.endsWith("/v1/chat/completions"))
    .map((request) => JSON.parse(request.options.body));
}

test("the owned llama.cpp runner starts offline before answering on loopback", async (t) => {
  const child = fakeChild();
  const spawns = [];
  const requests = [];
  const frames = [
    sseFrame({ choices: [{ delta: { content: "A private " } }], model: "gpt-oss-20b" }),
    sseFrame({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
    sseFrame({ choices: [{ delta: { content: "local answer." } }] }),
    "data: [DONE]\n\n",
  ];
  const insideSecondFrame = encoder.encode(frames[0]).length + 10;
  let healthChecks = 0;
  const runner = createLlamaCppModelRunner({
    executable: "/opt/homebrew/bin/llama-server",
    resolveExecutable: async (value) => value,
    allocatePort: async () => 48765,
    spawnImpl(executable, args, options) {
      spawns.push({ executable, args, options });
      return child;
    },
    async fetchImpl(url, options) {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/health")) {
        healthChecks += 1;
        return new Response(
          JSON.stringify({ status: healthChecks === 1 ? "loading model" : "ok" }),
          { status: healthChecks === 1 ? 503 : 200, headers: { "content-type": "application/json" } },
        );
      }
      return streamedResponse(frames.join(""), [insideSecondFrame]);
    },
    startupTimeoutMs: 1_000,
    pollMs: 1,
    env: {
      HOME: "/Users/tester",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "must-not-reach-the-model",
    },
  });
  t.after(() => runner.close());

  const capability = await runner.start();
  assert.deepEqual(capability, {
    adapter: LOCAL_MODEL.id,
    available: true,
    authenticated: true,
    model: LOCAL_MODEL.id,
    runtime: "llama.cpp",
    privacy: "local-only",
  });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].executable, "/opt/homebrew/bin/llama-server");
  assert.deepEqual(spawns[0].args.slice(0, 4), ["--host", "127.0.0.1", "--port", "48765"]);
  assert.ok(spawns[0].args.includes("--offline"));
  assert.ok(spawns[0].args.includes(LOCAL_MODEL.repository));
  assert.ok(spawns[0].args.includes(LOCAL_MODEL.file));
  assert.equal(spawns[0].options.detached, false);
  assert.deepEqual(spawns[0].options.env, {
    HOME: "/Users/tester",
    LANG: "en_US.UTF-8",
    LLAMA_ARG_OFFLINE: "1",
    HF_HUB_OFFLINE: "1",
    NO_PROXY: "127.0.0.1,localhost",
  });

  const answer = await runner.respond({ ...localRequest });
  assert.deepEqual(answer, {
    answer: "A private local answer.",
    adapter: LOCAL_MODEL.id,
    model: LOCAL_MODEL.id,
  });
  const inference = requests.find((request) => request.url.endsWith("/v1/chat/completions"));
  const body = JSON.parse(inference.options.body);
  assert.equal(body.model, LOCAL_MODEL.id);
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.chat_template_kwargs, { reasoning_effort: "low" });
  assert.equal(body.messages.length, 1);
  assert.match(body.messages[0].content, /ATTEND_UNTRUSTED_CONTEXT/u);
  assert.equal(inference.options.signal instanceof AbortSignal, true);

  await runner.close();
  assert.equal(child.signalCode, "SIGTERM");
});

test("streamed content reaches onDelta in order while the reasoning channel stays private", async (t) => {
  const frames = [
    sseFrame({ choices: [{ delta: { content: "  Two " } }] }),
    sseFrame({ choices: [{ delta: { reasoning_content: "weighing the evidence" } }] }),
    sseFrame({ choices: [{ delta: { content: "parts, naïvely. " } }] }),
    "data: [DONE]\n\n",
  ].join("");
  const insideMultiByte = encoder.encode(frames.slice(0, frames.indexOf("ï"))).length + 1;
  const harness = runnerHarness({
    completions: async () => streamedResponse(frames, [insideMultiByte]),
  });
  t.after(() => harness.runner.close());

  const deltas = [];
  const answer = await harness.runner.respond({
    ...localRequest,
    onDelta: (content) => deltas.push(content),
  });
  assert.deepEqual(deltas, ["  Two ", "parts, naïvely. "]);
  assert.equal(deltas.join(""), "  Two parts, naïvely. ");
  assert.equal(answer.answer, "Two parts, naïvely.");
});

test("a runtime that rejects chat_template_kwargs is retried once without the field", async (t) => {
  const frames = [
    sseFrame({ choices: [{ delta: { content: "Answered without tuning." } }] }),
    "data: [DONE]\n\n",
  ].join("");
  const harness = runnerHarness({
    completions: async (call) => call === 1
      ? new Response(
        JSON.stringify({ error: { message: "Unsupported param: chat_template_kwargs" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
      : streamedResponse(frames),
  });
  t.after(() => harness.runner.close());

  const answer = await harness.runner.respond({ ...localRequest });
  assert.equal(answer.answer, "Answered without tuning.");
  const bodies = completionBodies(harness.requests);
  assert.equal(bodies.length, 2);
  assert.equal("chat_template_kwargs" in bodies[0], true);
  assert.equal("chat_template_kwargs" in bodies[1], false);
  delete bodies[0].chat_template_kwargs;
  assert.deepEqual(bodies[0], bodies[1]);
});

test("a healthy child is retried in place without reloading the model", async (t) => {
  const frames = [
    sseFrame({ choices: [{ delta: { content: "The second attempt answered." } }] }),
    "data: [DONE]\n\n",
  ].join("");
  const harness = runnerHarness({
    completions: async (call) => {
      if (call === 1) throw new Error("socket hang up");
      return streamedResponse(frames);
    },
  });
  t.after(() => harness.runner.close());

  const answer = await harness.runner.respond({ ...localRequest });
  assert.equal(answer.answer, "The second attempt answered.");
  assert.equal(harness.spawns.length, 1);
  assert.equal(completionBodies(harness.requests).length, 2);
});

test("a wedged child is restarted before the retry", async (t) => {
  const frames = [
    sseFrame({ choices: [{ delta: { content: "A fresh child answered." } }] }),
    "data: [DONE]\n\n",
  ].join("");
  let wedged = false;
  const harness = runnerHarness({
    healthy: (spawnCount) => spawnCount === 2 || !wedged,
    completions: async (call) => {
      if (call === 1) {
        wedged = true;
        throw new Error("socket hang up");
      }
      return streamedResponse(frames);
    },
  });
  t.after(() => harness.runner.close());

  const answer = await harness.runner.respond({ ...localRequest });
  assert.equal(answer.answer, "A fresh child answered.");
  assert.equal(harness.spawns.length, 2);
});

test("a stream longer than the answer cap is rejected as invalid output", async (t) => {
  const frame = sseFrame({ choices: [{ delta: { content: "x".repeat(8 * 1024) } }] });
  const attempts = [];
  const harness = runnerHarness({
    completions: async (call, options) => {
      const served = { frames: 0 };
      attempts.push(served);
      const body = new ReadableStream({
        // Mirror undici: an aborted fetch errors its body. Aborting before the
        // reader breaks would surface an AbortError as AGENT_RUN_FAILED.
        start(controller) {
          options.signal.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
        pull(controller) {
          served.frames += 1;
          controller.enqueue(encoder.encode(served.frames > 12 ? "data: [DONE]\n\n" : frame));
          if (served.frames > 12) controller.close();
        },
      });
      return new Response(body, { status: 200 });
    },
  });
  t.after(() => harness.runner.close());

  await assert.rejects(
    harness.runner.respond({ ...localRequest }),
    (error) => error.code === "AGENT_RUN_INVALID_OUTPUT",
  );
  for (const served of attempts) {
    assert.ok(served.frames < 12, `read ${served.frames} frames past the cap`);
  }
});
