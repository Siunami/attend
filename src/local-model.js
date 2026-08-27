import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { attendQuestionPrompt } from "./agent-runner.js";

const MAX_ANSWER_BYTES = 64 * 1024;
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

async function jsonResponse(response, code, message) {
  let value;
  try {
    value = await response.json();
  } catch (cause) {
    throw modelError(code, message, cause);
  }
  return value;
}

function answerFrom(value) {
  const answer = value?.choices?.[0]?.message?.content;
  if (
    typeof answer !== "string" ||
    answer.trim().length === 0 ||
    answer.includes("\0") ||
    Buffer.byteLength(answer, "utf8") > MAX_ANSWER_BYTES
  ) {
    throw modelError("AGENT_RUN_INVALID_OUTPUT", "The local model returned an invalid answer");
  }
  return answer.trim();
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
    const signal = requestSignal(request.signal, responseTimeoutMs);
    let response;
    try {
      response = await fetchImpl(new URL("v1/chat/completions", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: LOCAL_MODEL.id,
          stream: false,
          temperature: 1,
          messages: [{ role: "user", content: attendQuestionPrompt(request) }],
        }),
        signal,
      });
    } catch (cause) {
      if (signal.aborted) {
        throw modelError("AGENT_RUN_TIMEOUT", "The private local answer timed out", cause);
      }
      throw modelError("AGENT_RUN_FAILED", "The private local model could not answer", cause);
    }
    if (!response.ok) {
      throw modelError("AGENT_RUN_FAILED", `The private local model returned HTTP ${response.status}`);
    }
    const value = await jsonResponse(
      response,
      "AGENT_RUN_INVALID_OUTPUT",
      "The private local model returned invalid JSON",
    );
    return Object.freeze({
      answer: answerFrom(value),
      adapter: LOCAL_MODEL.id,
      model: typeof value.model === "string" && value.model.length <= 256
        ? value.model
        : LOCAL_MODEL.id,
    });
  };

  const infer = async (request) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await start();
      try {
        return await inferOnce(request);
      } catch (error) {
        if (error?.code === "AGENT_RUN_TIMEOUT" || attempt === 1) throw error;
        await stopChild();
      }
    }
    throw modelError("AGENT_RUN_FAILED", "The private local model could not answer");
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
