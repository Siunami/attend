import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { attendQuestionPrompt } from "./agent-runner.js";

const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_ANSWER_TOKENS = 2048;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_MS = 100;
const LLAMA_SERVER_CANDIDATES = Object.freeze([
  "/opt/homebrew/bin/llama-server",
  "/usr/local/bin/llama-server",
  "/usr/bin/llama-server",
]);
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "XDG_CACHE_HOME",
]);

export const LOCAL_MODEL = Object.freeze({
  id: "gpt-oss-20b",
  repository: "ggml-org/gpt-oss-20b-GGUF",
  file: "gpt-oss-20b-MXFP4.gguf",
  runtime: "llama.cpp",
  contextTokens: 32_768,
});

export const LOCAL_REASONING_EFFORT = "low";

// A 32k-token window holds roughly 120 KB of text. Capping evidence at 64 KiB
// leaves room for the prompt scaffold, the 48 KB conversation history, and the
// answer. Detached routes keep the 1 MiB default.
export const LOCAL_EVIDENCE_PACKET_BYTES = 64 * 1024;

function modelError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

async function installedExecutable(explicit) {
  const candidates = explicit === undefined ? LLAMA_SERVER_CANDIDATES : [explicit];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.includes("\0")) {
      continue;
    }
    try {
      const canonical = await realpath(candidate);
      const info = await stat(canonical);
      if (!info.isFile()) continue;
      await access(canonical, fsConstants.X_OK);
      return canonical;
    } catch {}
  }
  throw modelError(
    "AGENT_RUN_UNAVAILABLE",
    "Attend requires llama.cpp. Install it with `brew install llama.cpp`, then run `attend model install`.",
  );
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local model port");
  }
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

function boundedDiagnostic(previous, chunk) {
  const next = `${previous}${String(chunk)}`;
  return next.length <= MAX_DIAGNOSTIC_BYTES
    ? next
    : next.slice(next.length - MAX_DIAGNOSTIC_BYTES);
}

function liveChild(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function capability(available, reason) {
  return Object.freeze({
    adapter: LOCAL_MODEL.id,
    available,
    authenticated: true,
    model: LOCAL_MODEL.id,
    runtime: LOCAL_MODEL.runtime,
    privacy: "local-only",
    ...(reason ? { reason } : {}),
  });
}

function serverArguments({ host, port, allowDownload }) {
  return [
    "--host", host,
    "--port", String(port),
    "--hf-repo", LOCAL_MODEL.repository,
    "--hf-file", LOCAL_MODEL.file,
    "--alias", LOCAL_MODEL.id,
    "--ctx-size", String(LOCAL_MODEL.contextTokens),
    "--parallel", "1",
    "--cache-reuse", "256",
    "--jinja",
    "--no-webui",
    "--no-mmproj",
    "--log-colors", "off",
    ...(allowDownload ? [] : ["--offline"]),
  ];
}

function localModelEnvironment(environment, allowDownload) {
  const safe = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value === "string" && !value.includes("\0")) safe[key] = value;
  }
  return {
    ...safe,
    LLAMA_ARG_OFFLINE: allowDownload ? "0" : "1",
    HF_HUB_OFFLINE: allowDownload ? "0" : "1",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const framed = line.trim();
      if (framed.startsWith("data:")) yield framed.slice(5).trim();
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

function validateAnswer(text) {
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    text.includes("\0") ||
    Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES
  ) {
    throw modelError("AGENT_RUN_INVALID_OUTPUT", "The local model returned an invalid answer");
  }
  return text.trim();
}

/**
 * Own one loopback-only llama.cpp server. The Attend page server starts only
 * after this runner reports healthy, and every inference request stays on the
 * private loopback address.
 */
export function createLlamaCppModelRunner({
  executable,
  host = "127.0.0.1",
  allowDownload = false,
  spawnImpl = spawn,
  fetchImpl = fetch,
  allocatePort = availableLoopbackPort,
  resolveExecutable = installedExecutable,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  env = process.env,
} = {}) {
  if (host !== "127.0.0.1") throw new TypeError("The local model host must be 127.0.0.1");
  if (executable !== undefined && (
    typeof executable !== "string" || !isAbsolute(executable) || executable.includes("\0")
  )) {
    throw new TypeError("executable must be an absolute path when supplied");
  }
  if (typeof spawnImpl !== "function" || typeof fetchImpl !== "function") {
    throw new TypeError("spawnImpl and fetchImpl must be functions");
  }
  if (typeof allocatePort !== "function" || typeof resolveExecutable !== "function") {
    throw new TypeError("allocatePort and resolveExecutable must be functions");
  }

  let child = null;
  let origin = null;
  let startPromise = null;
  let closing = false;
  // Runner-scoped rather than module-scoped: the service builds one runner per
  // process, so the production lifetime is identical, and module state would
  // leak between tests sharing a file.
  let templateKwargsSupported = true;
  let diagnostics = "";
  let resolvedExecutable = null;

  const health = async () => {
    if (!origin || !liveChild(child)) return false;
    try {
      const response = await fetchImpl(new URL("health", origin), {
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(1_000, startupTimeoutMs)),
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  const stopChild = async () => {
    const active = child;
    child = null;
    origin = null;
    if (!liveChild(active)) return;
    await new Promise((resolveClose) => {
      const timer = setTimeout(() => {
        if (liveChild(active)) active.kill("SIGKILL");
        resolveClose();
      }, 2_000);
      active.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
      active.kill("SIGTERM");
    });
  };

  const launch = async () => {
    if (closing) throw modelError("AGENT_RUN_UNAVAILABLE", "The local model is shutting down");
    const port = await allocatePort();
    const args = serverArguments({ host, port, allowDownload });
    resolvedExecutable ??= await resolveExecutable(executable);
    diagnostics = "";
    let spawned;
    try {
      spawned = spawnImpl(resolvedExecutable, args, {
        cwd: "/",
        detached: false,
        env: localModelEnvironment(env, allowDownload),
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (cause) {
      throw modelError(
        "AGENT_RUN_UNAVAILABLE",
        "Attend requires llama.cpp and the local gpt-oss-20b model",
        cause,
      );
    }
    child = spawned;
    origin = new URL(`http://${host}:${port}/`);
    child.stderr?.on("data", (chunk) => {
      diagnostics = boundedDiagnostic(diagnostics, chunk);
    });

    let exitFailure = null;
    const onError = (cause) => {
      exitFailure = modelError(
        "AGENT_RUN_UNAVAILABLE",
        "Attend could not start its private local model",
        cause,
      );
    };
    const onClose = () => {
      exitFailure ??= modelError(
        "AGENT_RUN_UNAVAILABLE",
        allowDownload
          ? "The local model stopped before installation completed"
          : "The private model is not installed. Run `attend model install`.",
      );
    };
    child.once("error", onError);
    child.once("close", onClose);

    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline && !exitFailure) {
      if (await health()) {
        child.off("error", onError);
        child.off("close", onClose);
        return capability(true);
      }
      await delay(pollMs);
    }
    child.off("error", onError);
    child.off("close", onClose);
    const failure = exitFailure ?? modelError(
      "AGENT_RUN_TIMEOUT",
      allowDownload
        ? "The gpt-oss-20b download or startup did not finish in time"
        : "The private local model did not become ready in time",
    );
    failure.diagnostic = diagnostics;
    await stopChild();
    throw failure;
  };

  const start = async () => {
    if (await health()) return capability(true);
    if (!startPromise) {
      startPromise = launch().finally(() => {
        startPromise = null;
      });
    }
    return startPromise;
  };

  const inferOnce = async (request) => {
    const timeout = requestSignal(request.signal, responseTimeoutMs);
    const controller = new AbortController();
    const signal = AbortSignal.any([timeout, controller.signal]);
    const prompt = attendQuestionPrompt(request);
    const transportError = (cause) => timeout.aborted
      ? modelError("AGENT_RUN_TIMEOUT", "The private local answer timed out", cause)
      : modelError("AGENT_RUN_FAILED", "The private local model could not answer", cause);
    const post = async (withTemplateKwargs) => {
      try {
        return await fetchImpl(new URL("v1/chat/completions", origin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: LOCAL_MODEL.id,
            stream: true,
            temperature: 1,
            max_tokens: MAX_ANSWER_TOKENS,
            ...(withTemplateKwargs
              ? { chat_template_kwargs: { reasoning_effort: LOCAL_REASONING_EFFORT } }
              : {}),
            messages: [{ role: "user", content: prompt }],
          }),
          signal,
        });
      } catch (cause) {
        throw transportError(cause);
      }
    };

    const withTemplateKwargs = templateKwargsSupported && typeof LOCAL_REASONING_EFFORT === "string";
    let response = await post(withTemplateKwargs);
    if (withTemplateKwargs && response.status === 400) {
      const detail = (await response.text().catch(() => "")).slice(0, MAX_DIAGNOSTIC_BYTES);
      if (detail.includes("chat_template_kwargs")) {
        templateKwargsSupported = false;
        response = await post(false);
      }
    }
    if (!response.ok) {
      throw modelError("AGENT_RUN_FAILED", `The private local model returned HTTP ${response.status}`);
    }

    let answer = "";
    let answerBytes = 0;
    let model = null;
    let overflowed = false;
    try {
      for await (const data of sseData(response.body ?? [])) {
        if (data === "[DONE]") break;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (model === null && typeof chunk?.model === "string" && chunk.model.length > 0) {
          model = chunk.model;
        }
        const content = chunk?.choices?.[0]?.delta?.content;
        if (typeof content !== "string" || content.length === 0) continue;
        answer += content;
        answerBytes += Buffer.byteLength(content, "utf8");
        if (answerBytes > MAX_ANSWER_BYTES) {
          overflowed = true;
          break;
        }
        if (typeof request.onDelta === "function") request.onDelta(content);
      }
    } catch (cause) {
      throw transportError(cause);
    }
    if (overflowed) {
      controller.abort();
      throw modelError("AGENT_RUN_INVALID_OUTPUT", "The local model returned an invalid answer");
    }

    return Object.freeze({
      answer: validateAnswer(answer),
      adapter: LOCAL_MODEL.id,
      model: typeof model === "string" && model.length <= 256 ? model : LOCAL_MODEL.id,
    });
  };

  const infer = async (request) => {
    await start();
    try {
      return await inferOnce(request);
    } catch (error) {
      if (error?.code === "AGENT_RUN_TIMEOUT") throw error;
      if (!await health()) {
        await stopChild();
        await start();
      }
      // A retry replays the stream from its first token and the onDelta contract
      // carries no reset signal, so re-emitting would duplicate text already in
      // the subscriber's buffer.
      return await inferOnce({ ...request, onDelta: undefined });
    }
  };

  return Object.freeze({
    adapter: LOCAL_MODEL.id,
    start,
    async capability() {
      return await health() ? capability(true) : capability(false, "not_running");
    },
    respond: infer,
    async close() {
      closing = true;
      await stopChild();
    },
  });
}

export const LOCAL_MODEL_LIMITS = Object.freeze({
  answerBytes: MAX_ANSWER_BYTES,
  startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  responseTimeoutMs: DEFAULT_RESPONSE_TIMEOUT_MS,
});
