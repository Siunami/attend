import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  assertSafeWritePath,
  ensureSafeDirectory,
  projectPaths,
  readJson,
  writeJsonAtomic,
} from "./project.js";
import { createDetachedAgentRunner } from "./agent-runner.js";
import {
  readChatRoute,
  resolveChatRoute,
  safeChatCapability,
  sameChatRoute,
  setChatRoute,
} from "./chat-route.js";
import { evidencePacketForSelection } from "./evidence.js";
import { createQuestionStreamRelay } from "./question-stream.js";
import { createQuestionWorker } from "./question-worker.js";
import { createLibraryServer } from "./server.js";
import { pendingQuestionResponseJobs } from "./session-store.js";
import {
  createLlamaCppModelRunner,
  LOCAL_EVIDENCE_PACKET_BYTES,
  LOCAL_MODEL,
} from "./local-model.js";
import { PACKAGE_VERSION } from "./constants.js";

const SERVICE_SCHEMA_VERSION = 1;
const SERVICE_PROTOCOL_VERSION = 4;
const START_TIMEOUT_MS = 150_000;
const STOP_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 500;
const AGENT_PROBE_TIMEOUT_MS = 4_000;
const LOCK_STALE_MS = 30_000;
const POLL_MS = 50;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const INSTANCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const AGENT_ADAPTER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const AGENT_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const DEFAULT_BIN = fileURLToPath(new URL("../bin/attend.js", import.meta.url));

function servicePaths(root) {
  const local = projectPaths(root).local;
  return Object.freeze({
    local,
    config: join(local, "service.json"),
    runtime: join(local, "service-runtime.json"),
    startup: join(local, "service-startup.json"),
    lock: join(local, "service-start.lock"),
  });
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function formatUrlHost(host) {
  const normalized = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function libraryUrl(config, port = config.preferredPort) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  return `http://${formatUrlHost(config.host)}:${port}/v/${config.token}/`;
}

async function readOptionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validatePort(value, name = "port") {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError(`${name} must be an integer from 0 to 65535`);
  }
  return value;
}

function validateConfig(value) {
  if (
    !value ||
    value.schemaVersion !== SERVICE_SCHEMA_VERSION ||
    !isLoopbackHost(value.host) ||
    !TOKEN_PATTERN.test(value.token ?? "")
  ) {
    throw new Error("Attend's persisted local service configuration is invalid.");
  }
  validatePort(value.preferredPort, "preferredPort");
  return value;
}

function validateRuntime(value, config) {
  if (
    !value ||
    value.schemaVersion !== SERVICE_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !INSTANCE_PATTERN.test(value.instanceId ?? "") ||
    !isLoopbackHost(value.host) ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535 ||
    value.url !== libraryUrl(config, value.port)
  ) {
    return null;
  }
  const agent = safeAgentCapability(value.agent);
  const chat = safeServiceChat(value.chat);
  const { agent: _untrustedAgent, chat: _untrustedChat, ...runtime } = value;
  return {
    ...runtime,
    ...(agent ? { agent } : {}),
    ...(chat ? { chat } : {}),
  };
}

function safeServiceChat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    value.defaultRoute === "local" &&
    value.transport === "owned-local-model" &&
    value.model === LOCAL_MODEL.id
  ) {
    return Object.freeze({
      defaultRoute: "local",
      transport: "owned-local-model",
      model: LOCAL_MODEL.id,
    });
  }
  if (value.defaultRoute === "host" && value.transport === "host-bridge") {
    return Object.freeze({ defaultRoute: "host", transport: "host-bridge" });
  }
  if (
    value.defaultRoute === "detached" &&
    value.transport === "detached-adapter" &&
    (value.adapter === "codex-cli" || value.adapter === "claude-cli")
  ) {
    return Object.freeze({
      defaultRoute: "detached",
      transport: "detached-adapter",
      adapter: value.adapter,
    });
  }
  return null;
}

function serviceChatForRoute(route) {
  if (route.kind === "host") {
    return Object.freeze({ defaultRoute: "host", transport: "host-bridge" });
  }
  if (route.kind === "local") {
    return Object.freeze({
      defaultRoute: "local",
      transport: "owned-local-model",
      model: LOCAL_MODEL.id,
    });
  }
  return Object.freeze({
    defaultRoute: "detached",
    transport: "detached-adapter",
    adapter: route.adapter,
  });
}

function routeForServiceChat(chat) {
  const normalized = safeServiceChat(chat);
  if (!normalized) throw new TypeError("service chat route is invalid");
  if (normalized.defaultRoute === "host") return Object.freeze({ kind: "host" });
  if (normalized.defaultRoute === "local") {
    return Object.freeze({ kind: "local", model: normalized.model });
  }
  return Object.freeze({ kind: "detached", adapter: normalized.adapter });
}

function sameServiceChat(left, right) {
  return Boolean(
    left &&
    right &&
    left.defaultRoute === right.defaultRoute &&
    left.transport === right.transport &&
    left.adapter === right.adapter &&
    left.model === right.model,
  );
}

function configuredChatRoute(route) {
  if (route?.kind === "host") return Object.freeze({ kind: "host" });
  if (route?.kind === "local" && route.model === LOCAL_MODEL.id) {
    return Object.freeze({ kind: "local", model: LOCAL_MODEL.id });
  }
  if (
    route?.kind === "detached" &&
    (route.adapter === "codex-cli" || route.adapter === "claude-cli")
  ) {
    return Object.freeze({ kind: "detached", adapter: route.adapter });
  }
  throw new TypeError("route must select gpt-oss-20b, host, codex-cli, or claude-cli");
}

function sameConfiguredChatRoute(left, right) {
  return Boolean(
    left &&
    right &&
    left.kind === right.kind &&
    (left.kind === "host" ||
      (left.kind === "local" ? left.model === right.model : left.adapter === right.adapter)),
  );
}

function incompatibleActiveJob(activeJobs, requestedRoute) {
  if (!Array.isArray(activeJobs)) {
    throw new TypeError("listJobs must return an array");
  }
  return activeJobs.find(
    (job) => !sameConfiguredChatRoute(job?.route, requestedRoute),
  ) ?? null;
}

function activeRouteChangeError(job, { serviceRestarted = false } = {}) {
  if (job?.legacyRouteMissing === true || job?.route == null) {
    const error = new Error(
      `Attend cannot choose a detached agent for route-less legacy question ${job.questionId}. Run \`attend context --json\`, answer it with \`attend reply --question-id ${job.questionId} ...\`, then run \`attend setup\` again.`,
    );
    error.code = "LEGACY_RESPONSE_ROUTE_REQUIRED";
    error.sessionId = job.sessionId;
    error.questionId = job.questionId;
    error.serviceRestarted = serviceRestarted;
    error.recoveryCommand = "attend context --json";
    return error;
  }
  const error = new Error(
    `Attend cannot change chat routes while question ${job.questionId} is ${job.status} for a different recipient. Answer or explicitly recover that question first.`,
  );
  error.code = "ACTIVE_RESPONSE_ROUTE_CHANGE";
  error.sessionId = job.sessionId;
  error.questionId = job.questionId;
  error.serviceRestarted = serviceRestarted;
  return error;
}

function currentRuntime(value) {
  return value?.protocolVersion === SERVICE_PROTOCOL_VERSION
    && value?.packageVersion === PACKAGE_VERSION;
}

function safeAgentCapability(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !AGENT_ADAPTER_PATTERN.test(value.adapter ?? "") ||
    typeof value.available !== "boolean" ||
    typeof value.authenticated !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    adapter: value.adapter,
    available: value.available,
    authenticated: value.authenticated,
    ...(value.model === LOCAL_MODEL.id ? { model: value.model } : {}),
    ...(value.runtime === "llama.cpp" ? { runtime: value.runtime } : {}),
    ...(value.privacy === "local-only" ? { privacy: value.privacy } : {}),
    ...(typeof value.version === "string" &&
    value.version.length <= 64 &&
    /^[A-Za-z0-9.+_-]+$/u.test(value.version)
      ? { version: value.version }
      : {}),
    ...(typeof value.reason === "string" &&
    AGENT_REASON_PATTERN.test(value.reason)
      ? { reason: value.reason }
      : {}),
  });
}

async function probeAgentRunner(runner) {
  try {
    const capability = safeAgentCapability(await runner.capability({
      signal: AbortSignal.timeout(AGENT_PROBE_TIMEOUT_MS),
    }));
    if (capability) return capability;
  } catch (error) {
    return Object.freeze({
      adapter: AGENT_ADAPTER_PATTERN.test(runner?.adapter ?? "")
        ? runner.adapter
        : "codex-cli",
      available: false,
      authenticated: false,
      reason: error?.code === "AGENT_RUN_CANCELLED"
        ? "probe_timed_out"
        : "probe_failed",
    });
  }
  return Object.freeze({
    adapter: AGENT_ADAPTER_PATTERN.test(runner?.adapter ?? "")
      ? runner.adapter
      : "codex-cli",
    available: false,
    authenticated: false,
    reason: "probe_failed",
  });
}

async function loadConfig(root) {
  const value = await readOptionalJson(servicePaths(root).config);
  return value ? validateConfig(value) : null;
}

async function writeConfig(root, config) {
  validateConfig(config);
  await writeJsonAtomic(servicePaths(root).config, config, { root });
  return config;
}

async function ensureConfig(root, { host, port } = {}) {
  if (host !== undefined && !isLoopbackHost(host)) {
    throw new TypeError("Attend's local service host must be loopback-only");
  }
  if (port !== undefined) validatePort(port);

  const existing = await loadConfig(root);
  const next = existing
    ? {
        ...existing,
        ...(host === undefined ? {} : { host }),
        ...(port === undefined ? {} : { preferredPort: port }),
      }
    : {
        schemaVersion: SERVICE_SCHEMA_VERSION,
        host: host ?? "127.0.0.1",
        preferredPort: port ?? 0,
        token: randomBytes(24).toString("base64url"),
        createdAt: new Date().toISOString(),
      };
  if (!existing || JSON.stringify(existing) !== JSON.stringify(next)) {
    await writeConfig(root, next);
  }
  return next;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readHealthAt(url) {
  try {
    const response = await fetch(new URL("api/health", url), {
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const health = await response.json();
    return health?.ok === true && health.service === "attend-library"
      ? health
      : null;
  } catch {
    return null;
  }
}

function currentHealth(value) {
  return value?.protocolVersion === SERVICE_PROTOCOL_VERSION
    && value?.packageVersion === PACKAGE_VERSION;
}

function refuseUnverifiedLiveService(status) {
  if (status?.state !== "stale" || !status.pidAlive || status.verifiedStale) return;
  const error = new Error(
    "Attend found a live process in its runtime record but could not verify the tokenized service identity. The runtime record was preserved and no process was signaled; retry after the service is responsive or stop that process explicitly.",
  );
  error.code = "SERVICE_IDENTITY_UNVERIFIED";
  throw error;
}

function refuseVerifiedServiceWithoutPid(status) {
  if (status?.state !== "stale" || !status.verifiedStale || status.pidAlive) return;
  const error = new Error(
    "Attend verified an incompatible service at its tokenized URL, but the recorded process is no longer live. The runtime record was preserved and no process was signaled. Stop the process that owns the local URL, then run `attend setup` again.",
  );
  error.code = "SERVICE_PID_UNVERIFIED";
  throw error;
}

export async function serviceStatus({ root }) {
  const projectRoot = resolve(root);
  const paths = servicePaths(projectRoot);
  const config = await loadConfig(projectRoot);
  if (!config) {
    return {
      ok: true,
      root: projectRoot,
      state: "stopped",
      running: false,
      configured: false,
      compatibility: "not-running",
      hostBridgeActive: false,
      url: null,
    };
  }

  const storedRuntime = await readOptionalJson(paths.runtime);
  const runtime = validateRuntime(storedRuntime, config);
  const health = runtime ? await readHealthAt(runtime.url) : null;
  const identityMatches = Boolean(
    runtime &&
    health &&
    health.instanceId === runtime.instanceId,
  );
  const healthy = identityMatches && currentRuntime(runtime) && currentHealth(health);
  const verifiedStale = identityMatches && !healthy;
  const pidAlive = runtime ? processExists(runtime.pid) : false;
  const compatibility = healthy
    ? "current"
    : verifiedStale
      ? "incompatible"
      : pidAlive
        ? "unverified"
        : "not-running";
  const hostBridgeActive = Boolean(
    healthy &&
    runtime.chat?.defaultRoute === "host" &&
    runtime.chat.transport === "host-bridge",
  );

  return {
    ok: true,
    root: projectRoot,
    state: healthy ? "running" : storedRuntime ? "stale" : "stopped",
    running: healthy,
    configured: true,
    compatibility,
    hostBridgeActive,
    url: healthy ? runtime.url : libraryUrl(config),
    preferredPort: config.preferredPort,
    ...(healthy ? { pid: runtime.pid, instanceId: runtime.instanceId, health } : {}),
    ...(healthy && runtime.agent ? { agent: runtime.agent } : {}),
    ...(healthy && runtime.chat ? { chat: runtime.chat } : {}),
    ...(storedRuntime && !healthy ? {
      stalePid: runtime?.pid ?? null,
      staleInstanceId: runtime?.instanceId ?? null,
      pidAlive,
      verifiedStale,
      ...(verifiedStale ? { staleHealth: health } : {}),
    } : {}),
  };
}

async function stopVerifiedStaleService({ root, status, timeoutMs = STOP_TIMEOUT_MS }) {
  if (!status?.verifiedStale || !status.pidAlive || !status.stalePid || !status.staleInstanceId) {
    return false;
  }
  const confirmed = await serviceStatus({ root });
  if (
    !confirmed.verifiedStale ||
    confirmed.stalePid !== status.stalePid ||
    confirmed.staleInstanceId !== status.staleInstanceId
  ) {
    throw new Error("Attend's stale service identity changed before it could be replaced; no process was signaled.");
  }
  try {
    process.kill(status.stalePid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(status.stalePid)) {
      await removeIfInstance(servicePaths(root).runtime, status.staleInstanceId);
      return true;
    }
    await delay(POLL_MS);
  }
  throw new Error("Attend's verified stale service did not stop after SIGTERM; it was not force-killed.");
}

async function removeIfInstance(path, instanceId) {
  const value = await readOptionalJson(path).catch(() => null);
  if (value?.instanceId !== instanceId) return false;
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

async function acquireStartLock(root, deadline) {
  const paths = servicePaths(root);
  await ensureSafeDirectory(root, paths.local, 0o700);
  const lockId = randomUUID();

  while (Date.now() < deadline) {
    await assertSafeWritePath(root, paths.lock);
    try {
      await mkdir(paths.lock, { mode: 0o700 });
      await writeJsonAtomic(join(paths.lock, "owner.json"), {
        schemaVersion: 1,
        lockId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }, { root });
      return async () => {
        await assertSafeWritePath(root, paths.lock);
        const owner = await readOptionalJson(join(paths.lock, "owner.json")).catch(() => null);
        if (owner?.lockId !== lockId) return;
        await rm(paths.lock, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    await assertSafeWritePath(root, paths.lock);
    const lockStat = await stat(paths.lock).catch(() => null);
    if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
      const stale = `${paths.lock}.stale-${randomUUID()}`;
      await assertSafeWritePath(root, stale);
      try {
        await rename(paths.lock, stale);
        await assertSafeWritePath(root, stale);
        await rm(stale, { recursive: true, force: true });
      } catch (error) {
        if (!["ENOENT", "EEXIST"].includes(error?.code)) throw error;
      }
    }
    await delay(POLL_MS);
  }
  throw new Error("Timed out waiting for another Attend service start to finish.");
}

async function spawnDaemon({ root, instanceId, binPath }) {
  const paths = servicePaths(root);
  await writeJsonAtomic(paths.startup, {
    schemaVersion: SERVICE_SCHEMA_VERSION,
    instanceId,
    state: "starting",
    requestedAt: new Date().toISOString(),
  }, { root });

  const child = spawn(process.execPath, [binPath, "_serve", "--root", root, "--instance-id", instanceId], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  child.unref();
  return child;
}

async function waitForStart({ root, instanceId, child, deadline }) {
  const paths = servicePaths(root);
  while (Date.now() < deadline) {
    const status = await serviceStatus({ root });
    if (status.running && status.instanceId === instanceId) return status;

    const startup = await readOptionalJson(paths.startup).catch(() => null);
    if (startup?.instanceId === instanceId && startup.state === "failed") {
      const error = new Error(startup.message || "Attend's local service did not start.");
      error.code = startup.code || "SERVICE_START_FAILED";
      throw error;
    }
    if (child.exitCode !== null) {
      throw new Error(`Attend's local service exited during startup (code ${child.exitCode}).`);
    }
    await delay(POLL_MS);
  }
  throw new Error("Timed out waiting for Attend's local service to become healthy.");
}

async function stopFailedLaunch({ root, instanceId, child }) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await delay(POLL_MS);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await removeIfInstance(servicePaths(root).runtime, instanceId).catch(() => {});
}

async function launchOnce({ root, binPath, deadline }) {
  const instanceId = randomUUID().replaceAll("-", "_");
  const child = await spawnDaemon({ root, instanceId, binPath });
  try {
    return await waitForStart({ root, instanceId, child, deadline });
  } catch (error) {
    await stopFailedLaunch({ root, instanceId, child });
    throw error;
  }
}

export async function startService({
  root,
  host,
  port,
  binPath = DEFAULT_BIN,
  timeoutMs = START_TIMEOUT_MS,
  listJobs = pendingQuestionResponseJobs,
} = {}) {
  const projectRoot = resolve(root);
  if (host !== undefined && !isLoopbackHost(host)) {
    throw new TypeError("Attend's local service host must be loopback-only");
  }
  if (port !== undefined) validatePort(port);
  if (typeof listJobs !== "function") {
    throw new TypeError("listJobs must be a function");
  }

  const existing = await serviceStatus({ root: projectRoot });
  refuseUnverifiedLiveService(existing);
  refuseVerifiedServiceWithoutPid(existing);

  const deadline = Date.now() + timeoutMs;
  const release = await acquireStartLock(projectRoot, deadline);

  try {
    let afterLock = await serviceStatus({ root: projectRoot });
    const lockedRoute = await readChatRoute({ root: projectRoot });
    const lockedChat = serviceChatForRoute(lockedRoute);
    if (afterLock.running && sameServiceChat(afterLock.chat, lockedChat)) {
      return { ...afterLock, reused: true };
    }
    if (afterLock.running) {
      const priorRoute = routeForServiceChat(afterLock.chat);
      const blockedJob = incompatibleActiveJob(
        await listJobs({ root: projectRoot }),
        lockedRoute,
      );
      if (blockedJob) throw activeRouteChangeError(blockedJob);
      await stopService({ root: projectRoot });
      afterLock = await serviceStatus({ root: projectRoot });
      const arrivedDuringQuiesce = incompatibleActiveJob(
        await listJobs({ root: projectRoot }),
        lockedRoute,
      );
      if (arrivedDuringQuiesce) {
        if (arrivedDuringQuiesce.route != null) {
          await setChatRoute({ root: projectRoot, route: priorRoute });
        }
        const restarted = await launchOnce({
          root: projectRoot,
          binPath,
          deadline: Date.now() + timeoutMs,
        });
        throw activeRouteChangeError(arrivedDuringQuiesce, {
          serviceRestarted: restarted.running,
        });
      }
    }
    refuseUnverifiedLiveService(afterLock);
    refuseVerifiedServiceWithoutPid(afterLock);
    if (afterLock.verifiedStale && afterLock.pidAlive) {
      const blockedJob = incompatibleActiveJob(
        await listJobs({ root: projectRoot }),
        lockedRoute,
      );
      if (blockedJob) throw activeRouteChangeError(blockedJob);
      await stopVerifiedStaleService({ root: projectRoot, status: afterLock });
      afterLock = await serviceStatus({ root: projectRoot });
      if (afterLock.running) return { ...afterLock, reused: true };
      const arrivedDuringUpgrade = incompatibleActiveJob(
        await listJobs({ root: projectRoot }),
        lockedRoute,
      );
      if (arrivedDuringUpgrade) {
        if (arrivedDuringUpgrade.route != null) {
          await setChatRoute({
            root: projectRoot,
            route: configuredChatRoute(arrivedDuringUpgrade.route),
          });
        }
        const restarted = await launchOnce({
          root: projectRoot,
          binPath,
          deadline: Date.now() + timeoutMs,
        });
        throw activeRouteChangeError(arrivedDuringUpgrade, {
          serviceRestarted: restarted.running,
        });
      }
    }

    const blockedBeforeLaunch = incompatibleActiveJob(
      await listJobs({ root: projectRoot }),
      lockedRoute,
    );
    if (blockedBeforeLaunch) {
      if (blockedBeforeLaunch.route != null) {
        await setChatRoute({
          root: projectRoot,
          route: configuredChatRoute(blockedBeforeLaunch.route),
        });
      }
      await unlink(servicePaths(projectRoot).runtime).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await ensureConfig(projectRoot, { host, port });
      const restarted = await launchOnce({
        root: projectRoot,
        binPath,
        deadline: Date.now() + timeoutMs,
      });
      throw activeRouteChangeError(blockedBeforeLaunch, {
        serviceRestarted: restarted.running,
      });
    }

    await unlink(servicePaths(projectRoot).runtime).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    const config = await ensureConfig(projectRoot, { host, port });
    const launchDeadline = Date.now() + timeoutMs;
    try {
      const started = await launchOnce({ root: projectRoot, binPath, deadline: launchDeadline });
      return { ...started, reused: false };
    } catch (error) {
      if (error?.code === "EADDRINUSE" && config.preferredPort !== 0) {
        const occupied = new Error(
          `Attend's stable local URL needs port ${config.preferredPort}, but that port is occupied. Stop the process using it or explicitly choose a new port with \`attend view --port <number>\`.`,
        );
        occupied.code = "EADDRINUSE";
        throw occupied;
      }
      throw error;
    }
  } finally {
    await release();
  }
}

/**
 * Change the machine-local chat route only after quiescing the service. Active
 * jobs keep their snapshotted recipient; a change is allowed only when every
 * such job already belongs to the explicitly requested route.
 */
export async function changeServiceChatRoute({
  root,
  route,
  timeoutMs = START_TIMEOUT_MS,
  listJobs = pendingQuestionResponseJobs,
} = {}) {
  const projectRoot = resolve(root);
  const requestedRoute = configuredChatRoute(route);
  if (typeof listJobs !== "function") {
    throw new TypeError("listJobs must be a function");
  }
  const release = await acquireStartLock(projectRoot, Date.now() + timeoutMs);
  let wasRunning = false;
  let blockedJob = null;
  let stopped = false;
  let unchangedRoute = null;
  let operationError = null;
  try {
    const currentRoute = await readChatRoute({ root: projectRoot });
    if (sameConfiguredChatRoute(currentRoute, requestedRoute)) {
      unchangedRoute = currentRoute;
    } else {
      const status = await serviceStatus({ root: projectRoot });
      wasRunning = status.running || (status.verifiedStale && status.pidAlive);
      if (status.running || status.state === "stale") {
        const result = await stopService({ root: projectRoot });
        stopped = result.stopped === true;
      }

      const activeJobs = await listJobs({ root: projectRoot });
      blockedJob = incompatibleActiveJob(activeJobs, requestedRoute);
      if (blockedJob === null) {
        await setChatRoute({ root: projectRoot, route: requestedRoute });
      }
    }
  } catch (error) {
    operationError = error;
  } finally {
    await release();
  }

  if (unchangedRoute) {
    return {
      route: unchangedRoute,
      changed: false,
      serviceStopped: false,
    };
  }

  let restarted = false;
  if ((blockedJob || operationError) && wasRunning && stopped) {
    restarted = (await startService({ root: projectRoot, timeoutMs })).running;
  }
  if (operationError) throw operationError;

  if (blockedJob) {
    throw activeRouteChangeError(blockedJob, { serviceRestarted: restarted });
  }

  return {
    route: requestedRoute,
    changed: true,
    serviceStopped: stopped,
  };
}

export async function stopService({ root, timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const projectRoot = resolve(root);
  const paths = servicePaths(projectRoot);
  const status = await serviceStatus({ root: projectRoot });
  if (!status.running) {
    refuseUnverifiedLiveService(status);
    refuseVerifiedServiceWithoutPid(status);
    const stopped = await stopVerifiedStaleService({ root: projectRoot, status, timeoutMs });
    await unlink(paths.runtime).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return { ...status, state: "stopped", running: false, stopped };
  }

  // Recheck the tokenized, per-launch identity immediately before signaling.
  // A PID by itself is never evidence that the process belongs to Attend.
  const confirmed = await serviceStatus({ root: projectRoot });
  if (
    !confirmed.running ||
    confirmed.pid !== status.pid ||
    confirmed.instanceId !== status.instanceId
  ) {
    throw new Error("Attend's service identity changed before it could be stopped; no process was signaled.");
  }

  try {
    process.kill(status.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(status.pid)) {
      const current = await serviceStatus({ root: projectRoot });
      await removeIfInstance(paths.runtime, status.instanceId);
      return {
        ...current,
        state: "stopped",
        running: false,
        stopped: true,
        url: status.url,
      };
    }
    await delay(POLL_MS);
  }
  throw new Error("Attend's local service did not stop after SIGTERM; it was not force-killed.");
}

export async function runForegroundService({
  root,
  assetsDir,
  instanceId,
  runnerFactory = createDetachedAgentRunner,
  localRunnerFactory = createLlamaCppModelRunner,
  libraryFactory = createLibraryServer,
} = {}) {
  const projectRoot = resolve(root);
  if (!INSTANCE_PATTERN.test(instanceId ?? "")) {
    throw new TypeError("internal service instance id is invalid");
  }
  const paths = servicePaths(projectRoot);
  const startup = await readOptionalJson(paths.startup);
  if (startup?.instanceId !== instanceId || startup.state !== "starting") {
    throw new Error("internal service launch does not match the active start request");
  }

  const config = await loadConfig(projectRoot);
  if (!config) throw new Error("Attend's local service is not configured");

  let library;
  let questionWorker;
  let modelRunner;
  try {
    const configuredRoute = await readChatRoute({ root: projectRoot });
    const serviceChat = serviceChatForRoute(configuredRoute);
    let agent;
    let runner;
    let streamRelay;
    if (configuredRoute.kind === "local") {
      modelRunner = localRunnerFactory({ projectRoot });
      agent = safeAgentCapability(await modelRunner.start());
      if (!agent?.available || !agent.authenticated) {
        throw new Error("Attend's private local model did not become ready");
      }
      runner = modelRunner;
      streamRelay = createQuestionStreamRelay();
    } else if (configuredRoute.kind === "detached") {
      runner = runnerFactory(configuredRoute.adapter, {
        projectRoot,
      });
      agent = await probeAgentRunner(runner);
    }
    if (runner) {
      questionWorker = createQuestionWorker({
        root: projectRoot,
        runner,
        capability: agent,
        route: configuredRoute,
        ...(configuredRoute.kind === "local" ? {
          evidenceForSelection: (request) => evidencePacketForSelection({
            ...request,
            maxBytes: LOCAL_EVIDENCE_PACKET_BYTES,
          }),
        } : {}),
        ...(streamRelay ? { streamRelay } : {}),
      });
    }

    const resolveProjectRoute = ({ sessionId, hostRoute }) => {
      if (configuredRoute.kind === "detached" || configuredRoute.kind === "local") {
        return configuredRoute;
      }
      if (!hostRoute) return null;
      return resolveChatRoute({
        root: projectRoot,
        sessionId,
        hostRoute,
        requireHostRoute: true,
      });
    };
    const projectChatCapability = async ({
      sessionId,
      hostRoute,
      responseRoute,
      responseQuestionId,
    }) => {
      let route;
      if (responseRoute?.kind === "host") {
        route = await resolveChatRoute({
          root: projectRoot,
          sessionId,
          hostRoute: responseRoute,
          requireHostRoute: true,
        });
      } else if (responseRoute?.kind === "detached" || responseRoute?.kind === "local") {
        route = responseRoute;
      } else {
        route = await resolveProjectRoute({ sessionId, hostRoute });
      }
      const capability = await safeChatCapability({
        root: projectRoot,
        route,
        questionId: responseQuestionId,
      });
      if (capability.kind === "local") {
        const live = safeAgentCapability(await modelRunner.capability());
        return {
          defaultRoute: "local",
          active: {
            kind: "local",
            model: LOCAL_MODEL.id,
            label: "Private AI on this Mac",
            available: live?.available === true,
            disclosure: "Questions and selected evidence stay on this Mac.",
          },
        };
      }
      if (capability.kind === "host") {
        const ownership = responseRoute?.kind === "host"
          ? hostRoute && sameChatRoute(hostRoute, responseRoute)
            ? "this-view"
            : "another-host"
          : route?.kind === "host"
            ? "this-view"
            : "unattached";
        const label = ownership === "another-host"
          ? "Another coding agent"
          : ownership === "unattached"
            ? "No coding agent attached"
            : "Opening coding agent";
        return {
          defaultRoute: "host",
          active: {
            kind: "host",
            label,
            ownership,
            listener: capability.listenerState === "delivered"
              ? "delivered"
              : capability.listenerPresent
                ? "listening"
                : "not-listening",
            registered: capability.availability !== "unavailable",
            disclosure: ownership === "another-host"
              ? "This queued question remains bound to another coding agent."
              : ownership === "unattached"
                ? "Sidebar chat is unavailable from this unbound library link."
                : "Selected evidence is returned to the coding agent that opened this view through that agent's configured route.",
          },
        };
      }
      const currentAdapter =
        configuredRoute.kind === "detached" &&
        configuredRoute.adapter === capability.adapter;
      return {
        defaultRoute: "detached",
        active: {
          kind: "detached",
          adapter: capability.adapter,
          label: capability.label,
          available: currentAdapter && agent?.available === true,
          authenticated: currentAdapter && agent?.authenticated === true,
          disclosure: capability.disclosure,
        },
      };
    };
    library = await libraryFactory({
      root: projectRoot,
      assetsDir,
      host: config.host,
      port: config.preferredPort,
      token: config.token,
      instanceId,
      ...(questionWorker ? { enqueueQuestion: questionWorker.enqueueQuestion } : {}),
      ...(streamRelay ? { questionStream: streamRelay } : {}),
      resolveQuestionRoute: resolveProjectRoute,
      chatCapability: projectChatCapability,
      serviceChat,
    });
    await questionWorker?.recover();
    await writeConfig(projectRoot, { ...config, preferredPort: library.port });
    await writeJsonAtomic(paths.runtime, {
      schemaVersion: SERVICE_SCHEMA_VERSION,
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      packageVersion: PACKAGE_VERSION,
      pid: process.pid,
      instanceId,
      host: config.host,
      port: library.port,
      url: library.libraryUrl,
      chat: serviceChat,
      ...(agent ? { agent } : {}),
      startedAt: new Date().toISOString(),
    }, { root: projectRoot });
    await writeJsonAtomic(paths.startup, {
      schemaVersion: SERVICE_SCHEMA_VERSION,
      instanceId,
      state: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, { root: projectRoot });
  } catch (error) {
    await questionWorker?.close().catch(() => {});
    await modelRunner?.close().catch(() => {});
    await library?.close().catch(() => {});
    await removeIfInstance(paths.runtime, instanceId).catch(() => {});
    await writeJsonAtomic(paths.startup, {
      schemaVersion: SERVICE_SCHEMA_VERSION,
      instanceId,
      state: "failed",
      code: typeof error?.code === "string" ? error.code : "SERVICE_START_FAILED",
      message: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(),
    }, { root: projectRoot }).catch(() => {});
    throw error;
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    questionWorker?.close().catch(() => {});
    modelRunner?.close().catch(() => {});
    library.close().catch(() => {});
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await new Promise((resolveClose) => library.server.once("close", resolveClose));
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await questionWorker?.close().catch(() => {});
    await modelRunner?.close().catch(() => {});
    await removeIfInstance(paths.runtime, instanceId).catch(() => {});
  }
}

export const SERVICE_VERSION = Object.freeze({
  schema: SERVICE_SCHEMA_VERSION,
  protocol: SERVICE_PROTOCOL_VERSION,
});
