import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createLlamaCppModelRunner,
  LOCAL_MODEL,
} from "../src/local-model.js";

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

test("the owned llama.cpp runner starts offline before answering on loopback", async (t) => {
  const child = fakeChild();
  const spawns = [];
  const requests = [];
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
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "A private local answer." } }],
        model: LOCAL_MODEL.id,
      }), { status: 200, headers: { "content-type": "application/json" } });
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

  const answer = await runner.respond({
    question: { id: "turn_local", content: "What changed?" },
    selection: null,
    contextBinding: { mode: "none", selectionTurnId: null },
    evidence: { kind: "attend-evidence-packet", claims: [] },
    conversation: [],
  });
  assert.deepEqual(answer, {
    answer: "A private local answer.",
    adapter: LOCAL_MODEL.id,
    model: LOCAL_MODEL.id,
  });
  const inference = requests.find((request) => request.url.endsWith("/v1/chat/completions"));
  const body = JSON.parse(inference.options.body);
  assert.equal(body.model, LOCAL_MODEL.id);
  assert.equal(body.stream, false);
  assert.equal(body.messages.length, 1);
  assert.match(body.messages[0].content, /ATTEND_UNTRUSTED_CONTEXT/u);
  assert.equal(inference.options.signal instanceof AbortSignal, true);

  await runner.close();
  assert.equal(child.signalCode, "SIGTERM");
});
