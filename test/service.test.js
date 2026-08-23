import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  projectPaths,
  readJson,
  setupProject,
  writeJsonAtomic,
} from "../src/project.js";
import {
  serviceStatus,
  startService,
  stopService,
} from "../src/service.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-service-test-"));
  await mkdir(join(root, ".git"));
  await setupProject({ root });
  t.after(async () => {
    await stopService({ root }).catch(() => {});
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("service state is private and non-loopback starts are rejected", async (t) => {
  const root = await fixture(t);

  await assert.rejects(
    startService({ root, host: "0.0.0.0" }),
    /loopback-only/u,
  );
  const started = await startService({ root, port: 0 });
  assert.equal(started.running, true);
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

  const paths = projectPaths(root);
  assert.equal((await stat(paths.local)).mode & 0o777, 0o700);
  assert.equal((await stat(join(paths.local, "service.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(paths.local, "service-runtime.json"))).mode & 0o777, 0o600);
});

test("service startup refuses a symlinked local-state directory", async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "attend-service-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, projectPaths(root).local);

  await assert.rejects(
    startService({ root }),
    (error) => error?.code === "UNSAFE_SYMLINK",
  );
  assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(outside)), []);
});

test("stop never signals a stale PID without matching tokenized health", async (t) => {
  const root = await fixture(t);
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
  const stopped = await stopService({ root });
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.running, false);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("an occupied persisted port fails instead of silently changing the stable URL", async (t) => {
  const root = await fixture(t);
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
