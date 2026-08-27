import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";

import { readChatRoute, setChatRoute } from "../src/chat-route.js";
import {
  projectPaths,
  readJson,
  setupProject,
  writeJsonAtomic,
} from "../src/project.js";
import {
  changeServiceChatRoute,
  runForegroundService,
  serviceStatus,
  startService,
  stopService,
} from "../src/service.js";

async function hostRouteFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-service-test-"));
  await mkdir(join(root, ".git"));
  await setupProject({ root });
  await setChatRoute({ root, route: { kind: "host" } });
  t.after(async () => {
    await stopService({ root }).catch(() => {});
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("service state is private and non-loopback starts are rejected", async (t) => {
  const root = await hostRouteFixture(t);

  await assert.rejects(
    startService({ root, host: "0.0.0.0" }),
    /loopback-only/u,
  );
  const started = await startService({ root, port: 0 });
  assert.equal(started.running, true);
  assert.deepEqual(started.chat, {
    defaultRoute: "host",
    transport: "host-bridge",
  });
  assert.equal(Object.hasOwn(started, "agent"), false);

  const paths = projectPaths(root);
  assert.equal((await stat(paths.local)).mode & 0o777, 0o700);
  assert.equal((await stat(join(paths.local, "service.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(paths.local, "service-runtime.json"))).mode & 0o777, 0o600);
});

test("detached provider metadata appears only after an explicit route selection", async (t) => {
  const root = await hostRouteFixture(t);
  await setChatRoute({
    root,
    route: { kind: "detached", adapter: "codex-cli" },
  });
  const started = await startService({ root, port: 0 });
  assert.deepEqual(started.chat, {
    defaultRoute: "detached",
    transport: "detached-adapter",
    adapter: "codex-cli",
  });
  assert.equal(started.agent.adapter, "codex-cli");
  assert.equal(typeof started.agent.available, "boolean");
  assert.equal(typeof started.agent.authenticated, "boolean");
  assert.deepEqual(
    Object.keys(started.agent).sort(),
    Object.keys(started.agent).filter((key) =>
      ["adapter", "available", "authenticated", "version", "reason"].includes(key)
    ).sort(),
    "service status exposes capability metadata but no executable or account paths",
  );
});

test("detached service never probes a provider executable from the analyzed project", async (t) => {
  const root = await hostRouteFixture(t);
  const localBin = join(root, "node_modules", ".bin");
  await mkdir(localBin, { recursive: true });
  const binary = join(localBin, "codex");
  await writeFile(binary, '#!/bin/sh\nprintf invoked > "$0.ran"\nexit 99\n', { mode: 0o755 });
  await setChatRoute({
    root,
    route: { kind: "detached", adapter: "codex-cli" },
  });

  const originalPath = process.env.PATH;
  process.env.PATH = localBin;
  let started;
  try {
    started = await startService({ root, port: 0 });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  assert.deepEqual(started.agent, {
    adapter: "codex-cli",
    available: false,
    authenticated: false,
    reason: "not_installed",
  });
  await assert.rejects(readFile(`${binary}.ran`), /ENOENT/u);
});

test("a live service is replaced when its configured chat transport changes", async (t) => {
  const root = await hostRouteFixture(t);
  const host = await startService({ root, port: 0 });
  await setChatRoute({
    root,
    route: { kind: "detached", adapter: "codex-cli" },
  });
  const detached = await startService({ root });
  assert.equal(detached.reused, false);
  assert.equal(detached.url, host.url);
  assert.notEqual(detached.instanceId, host.instanceId);
  assert.deepEqual(detached.chat, {
    defaultRoute: "detached",
    transport: "detached-adapter",
    adapter: "codex-cli",
  });

  await setChatRoute({ root, route: { kind: "host" } });
  const returned = await startService({ root });
  assert.equal(returned.reused, false);
  assert.equal(returned.url, host.url);
  assert.notEqual(returned.instanceId, detached.instanceId);
  assert.deepEqual(returned.chat, {
    defaultRoute: "host",
    transport: "host-bridge",
  });
  assert.equal(Object.hasOwn(returned, "agent"), false);
});

test("service reuse refuses an out-of-band route change that would orphan work", async (t) => {
  const root = await hostRouteFixture(t);
  const host = await startService({ root, port: 0 });
  await setChatRoute({
    root,
    route: { kind: "detached", adapter: "claude-cli" },
  });
  await assert.rejects(
    startService({
      root,
      async listJobs() {
        return [{
          sessionId: "session_existing_host",
          questionId: "turn_existing_host",
          status: "queued",
          route: {
            kind: "host",
            attachmentId: "host_0123456789abcdef",
            generation: 1,
          },
        }];
      },
    }),
    (error) =>
      error?.code === "ACTIVE_RESPONSE_ROUTE_CHANGE" &&
      error.questionId === "turn_existing_host",
  );
  const preserved = await serviceStatus({ root });
  assert.equal(preserved.running, true);
  assert.equal(preserved.instanceId, host.instanceId);
  assert.deepEqual(preserved.chat, {
    defaultRoute: "host",
    transport: "host-bridge",
  });
});

test("service route replacement rechecks work after the old server is quiesced", async (t) => {
  const root = await hostRouteFixture(t);
  const host = await startService({ root, port: 0 });
  await setChatRoute({
    root,
    route: { kind: "detached", adapter: "claude-cli" },
  });
  let inspections = 0;
  await assert.rejects(
    startService({
      root,
      async listJobs() {
        inspections += 1;
        return inspections === 1
          ? []
          : [{
              sessionId: "session_arrived_during_quiesce",
              questionId: "turn_arrived_during_quiesce",
              status: "queued",
              route: {
                kind: "host",
                attachmentId: "host_0123456789abcdef",
                generation: 1,
              },
            }];
      },
    }),
    (error) =>
      error?.code === "ACTIVE_RESPONSE_ROUTE_CHANGE" &&
      error.questionId === "turn_arrived_during_quiesce" &&
      error.serviceRestarted === true,
  );
  assert.equal(inspections, 2);
  assert.deepEqual(await readChatRoute({ root }), { kind: "host" });
  const recovered = await serviceStatus({ root });
  assert.equal(recovered.running, true);
  assert.notEqual(recovered.instanceId, host.instanceId);
  assert.deepEqual(recovered.chat, {
    defaultRoute: "host",
    transport: "host-bridge",
  });
});

test("a route-less job arriving during replacement cannot restore a detached preference", async (t) => {
  const root = await hostRouteFixture(t);
  await setChatRoute({
    root,
    route: { kind: "detached", adapter: "claude-cli" },
  });
  const detached = await startService({ root, port: 0 });
  await setChatRoute({ root, route: { kind: "host" } });
  let inspections = 0;

  await assert.rejects(
    startService({
      root,
      async listJobs() {
        inspections += 1;
        return inspections === 1
          ? []
          : [{
              sessionId: "session_arrived_unbound",
              questionId: "turn_arrived_unbound",
              status: "queued",
              route: null,
              legacyRouteMissing: true,
            }];
      },
    }),
    (error) =>
      error?.code === "LEGACY_RESPONSE_ROUTE_REQUIRED" &&
      error.questionId === "turn_arrived_unbound" &&
      error.serviceRestarted === true,
  );
  assert.equal(inspections, 2);
  assert.deepEqual(await readChatRoute({ root }), { kind: "host" });
  const recovered = await serviceStatus({ root });
  assert.equal(recovered.running, true);
  assert.notEqual(recovered.instanceId, detached.instanceId);
  assert.deepEqual(recovered.chat, {
    defaultRoute: "host",
    transport: "host-bridge",
  });
});

test("a stopped service preserves the snapshotted route of legacy active work", async (t) => {
  const root = await hostRouteFixture(t);
  await assert.rejects(
    startService({
      root,
      port: 0,
      async listJobs() {
        return [{
          sessionId: "session_stopped_legacy",
          questionId: "turn_stopped_legacy",
          status: "queued",
          route: { kind: "detached", adapter: "codex-cli" },
        }];
      },
    }),
    (error) =>
      error?.code === "ACTIVE_RESPONSE_ROUTE_CHANGE" &&
      error.questionId === "turn_stopped_legacy" &&
      error.serviceRestarted === true,
  );
  assert.deepEqual(await readChatRoute({ root }), {
    kind: "detached",
    adapter: "codex-cli",
  });
  const recovered = await serviceStatus({ root });
  assert.equal(recovered.running, true);
  assert.equal(recovered.chat.adapter, "codex-cli");
});

test("a stopped service never invents a detached preference for route-less legacy work", async (t) => {
  const root = await hostRouteFixture(t);
  await assert.rejects(
    startService({
      root,
      port: 0,
      async listJobs() {
        return [{
          sessionId: "session_stopped_unbound_legacy",
          questionId: "turn_stopped_unbound_legacy",
          status: "queued",
          route: null,
          legacyRouteMissing: true,
        }];
      },
    }),
    (error) =>
      error?.code === "LEGACY_RESPONSE_ROUTE_REQUIRED" &&
      error.questionId === "turn_stopped_unbound_legacy" &&
      error.serviceRestarted === true &&
      /attend context --json/u.test(error.message) &&
      /attend reply/u.test(error.message),
  );
  assert.deepEqual(await readChatRoute({ root }), { kind: "host" });
  const recovered = await serviceStatus({ root });
  assert.equal(recovered.running, true);
  assert.deepEqual(recovered.chat, {
    defaultRoute: "host",
    transport: "host-bridge",
  });
  assert.equal(Object.hasOwn(recovered, "agent"), false);
});

test("route changes quiesce the service and preserve every active job recipient", async (t) => {
  const root = await hostRouteFixture(t);
  const host = await startService({ root, port: 0 });

  await assert.rejects(
    changeServiceChatRoute({
      root,
      route: { kind: "detached", adapter: "claude-cli" },
      async listJobs() {
        return [{
          sessionId: "session_active_host",
          questionId: "turn_active_host",
          status: "queued",
          route: {
            kind: "host",
            attachmentId: "host_0123456789abcdef",
            generation: 1,
          },
        }];
      },
    }),
    (error) =>
      error?.code === "ACTIVE_RESPONSE_ROUTE_CHANGE" &&
      error.questionId === "turn_active_host" &&
      error.serviceRestarted === true,
  );
  assert.deepEqual(await readChatRoute({ root }), { kind: "host" });
  const restored = await serviceStatus({ root });
  assert.equal(restored.running, true);
  assert.notEqual(restored.instanceId, host.instanceId);

  const recoveredLegacy = await changeServiceChatRoute({
    root,
    route: { kind: "detached", adapter: "codex-cli" },
    async listJobs() {
      return [{
        sessionId: "session_legacy_codex",
        questionId: "turn_legacy_codex",
        status: "queued",
        route: { kind: "detached", adapter: "codex-cli" },
      }];
    },
  });
  assert.equal(recoveredLegacy.changed, true);
  assert.equal(recoveredLegacy.serviceStopped, true);
  assert.deepEqual(await readChatRoute({ root }), {
    kind: "detached",
    adapter: "codex-cli",
  });
  assert.equal((await serviceStatus({ root })).running, false);
});

test("service startup refuses a symlinked local-state directory", async (t) => {
  const root = await hostRouteFixture(t);
  const outside = await mkdtemp(join(tmpdir(), "attend-service-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(projectPaths(root).local, { recursive: true, force: true });
  await symlink(outside, projectPaths(root).local);

  await assert.rejects(
    startService({ root }),
    (error) => error?.code === "UNSAFE_SYMLINK",
  );
  assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(outside)), []);
});

test("the local model must be healthy before the page server starts", async (t) => {
  const root = await hostRouteFixture(t);
  await startService({ root, port: 0 });
  await stopService({ root });
  await setChatRoute({
    root,
    route: { kind: "local", model: "gpt-oss-20b" },
  });
  const instanceId = "local_model_order_0001";
  await writeJsonAtomic(join(projectPaths(root).local, "service-startup.json"), {
    schemaVersion: 1,
    instanceId,
    state: "starting",
    startedAt: new Date().toISOString(),
  }, { root });

  let modelClosed = false;
  let libraryStarted = false;
  await assert.rejects(
    runForegroundService({
      root,
      instanceId,
      localRunnerFactory() {
        return {
          async start() {
            throw new Error("model unavailable");
          },
          async close() {
            modelClosed = true;
          },
        };
      },
      async libraryFactory() {
        libraryStarted = true;
        throw new Error("page server must not start");
      },
    }),
    /model unavailable/u,
  );
  assert.equal(modelClosed, true);
  assert.equal(libraryStarted, false);
});

test("start and stop preserve a live runtime they cannot verify", async (t) => {
  const root = await hostRouteFixture(t);
  const started = await startService({ root, port: 0 });
  await stopService({ root });

  const paths = projectPaths(root);
  const config = await readJson(join(paths.local, "service.json"));
  const port = Number(new URL(started.url).port);
  await writeJsonAtomic(join(paths.local, "service-runtime.json"), {
    schemaVersion: 1,
    pid: process.pid,
    instanceId: "stale_instance_0001",
    host: config.host,
    port,
    url: started.url,
    startedAt: new Date().toISOString(),
  }, { root });

  const stale = await serviceStatus({ root });
  assert.equal(stale.state, "stale");
  assert.equal(stale.pidAlive, true);
  await assert.rejects(
    stopService({ root }),
    { code: "SERVICE_IDENTITY_UNVERIFIED" },
  );
  await assert.rejects(
    startService({ root }),
    { code: "SERVICE_IDENTITY_UNVERIFIED" },
  );
  assert.equal((await readJson(join(paths.local, "service-runtime.json"))).pid, process.pid);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("a blocked route change restores service after quiescing a verified-stale runtime", async (t) => {
  const root = await hostRouteFixture(t);
  const initial = await startService({ root, port: 0 });
  await stopService({ root });
  const paths = projectPaths(root);
  const config = await readJson(join(paths.local, "service.json"));
  const instanceId = "legacy_route_change_0001";
  const legacy = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { createServer } from "node:http";
      const prefix = "/v/" + process.env.ATTEND_TEST_TOKEN + "/api/health";
      const server = createServer((request, response) => {
        if (request.url !== prefix) { response.statusCode = 404; response.end(); return; }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          service: "attend-library",
          protocolVersion: 1,
          instanceId: process.env.ATTEND_TEST_INSTANCE,
          sessionCount: 0,
        }));
      });
      server.listen(Number(process.env.ATTEND_TEST_PORT), "127.0.0.1", () => process.stdout.write("ready\\n"));
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    `,
  ], {
    env: {
      ...process.env,
      ATTEND_TEST_TOKEN: config.token,
      ATTEND_TEST_INSTANCE: instanceId,
      ATTEND_TEST_PORT: new URL(initial.url).port,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => {
    if (legacy.exitCode === null) legacy.kill("SIGTERM");
  });
  await once(legacy.stdout, "data");
  await writeJsonAtomic(join(paths.local, "service-runtime.json"), {
    schemaVersion: 1,
    pid: legacy.pid,
    instanceId,
    host: config.host,
    port: Number(new URL(initial.url).port),
    url: initial.url,
    startedAt: new Date().toISOString(),
  }, { root });
  assert.equal((await serviceStatus({ root })).verifiedStale, true);

  await assert.rejects(
    changeServiceChatRoute({
      root,
      route: { kind: "detached", adapter: "claude-cli" },
      async listJobs() {
        return [{
          sessionId: "session_stale_host",
          questionId: "turn_stale_host",
          status: "queued",
          route: {
            kind: "host",
            attachmentId: "host_0123456789abcdef",
            generation: 1,
          },
        }];
      },
    }),
    (error) =>
      error?.code === "ACTIVE_RESPONSE_ROUTE_CHANGE" &&
      error.questionId === "turn_stale_host" &&
      error.serviceRestarted === true,
  );
  assert.deepEqual(await readChatRoute({ root }), { kind: "host" });
  const restored = await serviceStatus({ root });
  assert.equal(restored.running, true);
  assert.deepEqual(restored.chat, {
    defaultRoute: "host",
    transport: "host-bridge",
  });
});

test("stop waits for the verified daemon process to finish draining", async (t) => {
  const root = await hostRouteFixture(t);
  const initial = await startService({ root, port: 0 });
  await stopService({ root });
  const paths = projectPaths(root);
  const config = await readJson(join(paths.local, "service.json"));
  const instanceId = "draining_instance_0001";
  const drainDelayMs = 300;
  const draining = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { createServer } from "node:http";
      const prefix = "/v/" + process.env.ATTEND_TEST_TOKEN + "/api/health";
      const server = createServer((request, response) => {
        if (request.url !== prefix) { response.statusCode = 404; response.end(); return; }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          service: "attend-library",
          protocolVersion: 4,
          packageVersion: "0.5.2",
          instanceId: process.env.ATTEND_TEST_INSTANCE,
          sessionCount: 0,
        }));
      });
      server.listen(Number(process.env.ATTEND_TEST_PORT), "127.0.0.1", () => process.stdout.write("ready\\n"));
      process.on("SIGTERM", () => {
        server.close();
        setTimeout(() => process.exit(0), Number(process.env.ATTEND_TEST_DRAIN_MS));
      });
    `,
  ], {
    env: {
      ...process.env,
      ATTEND_TEST_TOKEN: config.token,
      ATTEND_TEST_INSTANCE: instanceId,
      ATTEND_TEST_PORT: new URL(initial.url).port,
      ATTEND_TEST_DRAIN_MS: String(drainDelayMs),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => {
    if (draining.exitCode === null) draining.kill("SIGTERM");
  });
  await once(draining.stdout, "data");
  await writeJsonAtomic(join(paths.local, "service-runtime.json"), {
    schemaVersion: 1,
    protocolVersion: 4,
    packageVersion: "0.5.2",
    pid: draining.pid,
    instanceId,
    host: config.host,
    port: Number(new URL(initial.url).port),
    url: initial.url,
    chat: { defaultRoute: "host", transport: "host-bridge" },
    startedAt: new Date().toISOString(),
  }, { root });
  assert.equal((await serviceStatus({ root })).running, true);

  const startedAt = Date.now();
  const stopped = await stopService({ root, timeoutMs: 2_000 });
  assert.equal(stopped.stopped, true);
  assert.throws(
    () => process.kill(draining.pid, 0),
    (error) => error?.code === "ESRCH",
  );
  assert.ok(
    Date.now() - startedAt >= drainDelayMs - 50,
    "stop must not report completion merely because the health endpoint closed",
  );
  if (draining.exitCode === null) await once(draining, "exit");
});

test("an upgrade replaces only a token-verified older Attend service with a fresh launch budget", async (t) => {
  const root = await hostRouteFixture(t);
  const initial = await startService({ root, port: 0 });
  await stopService({ root });
  const paths = projectPaths(root);
  const config = await readJson(join(paths.local, "service.json"));
  const port = Number(new URL(initial.url).port);
  const instanceId = "legacy_instance_0001";
  const legacyProgram = `
    import { createServer } from "node:http";
    const prefix = "/v/" + process.env.ATTEND_TEST_TOKEN + "/api/health";
    const server = createServer((request, response) => {
      if (request.url !== prefix) { response.statusCode = 404; response.end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        service: "attend-library",
        protocolVersion: 1,
        instanceId: process.env.ATTEND_TEST_INSTANCE,
        sessionCount: 0,
      }));
    });
    server.listen(Number(process.env.ATTEND_TEST_PORT), "127.0.0.1", () => process.stdout.write("ready\\n"));
    process.on("SIGTERM", () => setTimeout(() => server.close(() => process.exit(0)), 1200));
  `;
  const legacy = spawn(process.execPath, ["--input-type=module", "--eval", legacyProgram], {
    env: {
      ...process.env,
      ATTEND_TEST_TOKEN: config.token,
      ATTEND_TEST_INSTANCE: instanceId,
      ATTEND_TEST_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => {
    if (legacy.exitCode === null) legacy.kill("SIGTERM");
  });
  await once(legacy.stdout, "data");
  await writeJsonAtomic(join(paths.local, "service-runtime.json"), {
    schemaVersion: 1,
    pid: legacy.pid,
    instanceId,
    host: config.host,
    port,
    url: initial.url,
    startedAt: new Date().toISOString(),
  }, { root });

  const stale = await serviceStatus({ root });
  assert.equal(stale.verifiedStale, true);
  assert.equal(stale.staleHealth.protocolVersion, 1);
  await assert.rejects(
    startService({
      root,
      timeoutMs: 1000,
      async listJobs() {
        return [{
          sessionId: "session_legacy_codex",
          questionId: "turn_legacy_codex",
          status: "queued",
          route: null,
          legacyRouteMissing: true,
        }];
      },
    }),
    (error) =>
      error?.code === "LEGACY_RESPONSE_ROUTE_REQUIRED" &&
      error.questionId === "turn_legacy_codex",
  );
  const preserved = await serviceStatus({ root });
  assert.equal(preserved.verifiedStale, true);
  assert.equal(preserved.stalePid, legacy.pid);
  assert.equal(legacy.exitCode, null);
  assert.deepEqual(await readChatRoute({ root }), { kind: "host" });
  let upgradeInspections = 0;
  await assert.rejects(
    startService({
      root,
      timeoutMs: 1000,
      async listJobs() {
        upgradeInspections += 1;
        return upgradeInspections === 1
          ? []
          : [{
              sessionId: "session_arrived_during_upgrade",
              questionId: "turn_arrived_during_upgrade",
              status: "queued",
              route: { kind: "detached", adapter: "codex-cli" },
            }];
      },
    }),
    (error) =>
      error?.code === "ACTIVE_RESPONSE_ROUTE_CHANGE" &&
      error.questionId === "turn_arrived_during_upgrade" &&
      error.serviceRestarted === true,
  );
  assert.equal(upgradeInspections, 2);
  assert.deepEqual(await readChatRoute({ root }), {
    kind: "detached",
    adapter: "codex-cli",
  });
  const recoveredLegacy = await serviceStatus({ root });
  assert.equal(recoveredLegacy.running, true);
  assert.equal(recoveredLegacy.chat.adapter, "codex-cli");
  await changeServiceChatRoute({
    root,
    route: { kind: "host" },
    listJobs: async () => [],
  });
  const upgraded = await startService({ root, timeoutMs: 1000 });
  assert.equal(upgraded.running, true);
  assert.equal(upgraded.reused, false);
  assert.equal(upgraded.health.protocolVersion, 4);
  assert.equal(upgraded.health.packageVersion, "0.5.2");
  assert.notEqual(upgraded.pid, legacy.pid);
  if (legacy.exitCode === null) await once(legacy, "exit");
});

test("an occupied persisted port fails instead of silently changing the stable URL", async (t) => {
  const root = await hostRouteFixture(t);
  const first = await startService({ root, port: 0 });
  await stopService({ root });

  const occupiedPort = Number(new URL(first.url).port);
  const blocker = createServer((_request, response) => response.end("not attend"));
  await new Promise((resolveListen, rejectListen) => {
    blocker.once("error", rejectListen);
    blocker.listen(occupiedPort, "127.0.0.1", resolveListen);
  });
  try {
    await assert.rejects(
      startService({ root }),
      (error) => error?.code === "EADDRINUSE" && /stable local URL/u.test(error.message),
    );
    const configured = await serviceStatus({ root });
    assert.equal(configured.running, false);
    assert.equal(configured.url, first.url);
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      blocker.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }

  const restarted = await startService({ root });
  assert.equal(restarted.url, first.url);
});
