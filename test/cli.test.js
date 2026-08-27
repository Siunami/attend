import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { openUrl, run } from "../src/cli.js";
import {
  beginHostListener,
  endHostListener,
  registerHostAttachment,
  setChatRoute,
} from "../src/chat-route.js";
import { evidenceStorePath } from "../src/evidence.js";
import { projectPaths, readJson, writeJsonAtomic } from "../src/project.js";
import { buildSelection } from "../src/selection.js";
import { serviceStatus, startService, stopService } from "../src/service.js";
import {
  appendConversationTurn,
  appendQueuedQuestion,
  createSession,
  loadSession,
  updateSession,
} from "../src/session-store.js";
import { CATALOG_COUNTS } from "../src/catalog/index.js";

const BIN = fileURLToPath(new URL("../bin/attend.js", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

function capture() {
  let contents = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        contents += chunk.toString();
        callback();
      },
    }),
    text: () => contents,
    json: () => JSON.parse(contents.trim()),
  };
}

async function projectFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-cli-test-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "notes"));
  await Promise.all([
    writeFile(
      join(root, "notes", "one.md"),
      "# First\n\nA local instrument makes private context legible.\nA local instrument stays near its evidence.\n",
    ),
    writeFile(
      join(root, "notes", "two.txt"),
      "The local instrument should remain quiet.\nPrivate context should remain private.\n",
    ),
  ]);
  t.after(async () => {
    await stopService({ root }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function runJson(root, args, { viewDependencies, modelDependencies } = {}) {
  const stdout = capture();
  const stderr = capture();
  await run(args, {
    cwd: root,
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...(viewDependencies ? { viewDependencies } : {}),
    ...(modelDependencies ? { modelDependencies } : {}),
  });
  assert.equal(stderr.text(), "");
  return stdout.json();
}

async function runBinJson(root, args, { timeoutMs = 10_000, input } = {}) {
  const child = spawn(process.execPath, [BIN, ...args, "--json"], {
    cwd: PACKAGE_ROOT,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  if (input !== undefined) child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const { code, signal } = await new Promise((resolveExit) => {
    child.once("close", (exitCode, exitSignal) => {
      resolveExit({ code: exitCode, signal: exitSignal });
    });
  });
  clearTimeout(timer);
  assert.equal(signal, null, `CLI was terminated by ${signal}: ${stderr}`);
  assert.equal(code, 0, `CLI exited ${code}: ${stderr}`);
  assert.equal(stderr, "");
  return JSON.parse(stdout.trim());
}

function hostBoundApi(view, route, name) {
  const url = new URL(`api/${name}`, view.viewerUrl);
  url.searchParams.set("attend-host", route.attachmentId);
  url.searchParams.set("attend-generation", String(route.generation));
  return url;
}

async function installVerifiedLegacyService(t, root) {
  await setChatRoute({ root, route: { kind: "host" } });
  const current = await startService({ root, port: 0 });
  await stopService({ root });
  const paths = projectPaths(root);
  const config = await readJson(join(paths.local, "service.json"));
  const port = Number(new URL(current.url).port);
  const instanceId = "legacy_cli_instance_0001";
  const child = spawn(process.execPath, [
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
          protocolVersion: 2,
          packageVersion: "0.2.2",
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
      ATTEND_TEST_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  await once(child.stdout, "data");
  await writeJsonAtomic(join(paths.local, "service-runtime.json"), {
    schemaVersion: 1,
    protocolVersion: 2,
    packageVersion: "0.2.2",
    pid: child.pid,
    instanceId,
    host: config.host,
    port,
    url: current.url,
    startedAt: new Date().toISOString(),
  }, { root });
  return { child, current };
}

test("CLI setup → phrases → context → reply is a project-local round trip", async (t) => {
  const root = await projectFixture(t);

  const dryRun = await runJson(root, ["setup", "--dry-run", "--json"]);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  await assert.rejects(readFile(join(root, ".attend", "project.json")), /ENOENT/u);

  const setup = await runJson(root, ["setup", "--json"]);
  assert.equal(setup.ok, true);
  assert.deepEqual(setup.conflicts, []);
  const installedSkill = await readFile(
    join(root, ".agents", "skills", "attend-visualize", "SKILL.md"),
    "utf8",
  );
  assert.ok(installedSkill.startsWith("---\n"));
  assert.match(installedSkill, /attend-managed/u);
  assert.match(installedSkill, /## Run one silent opportunity checkpoint/u);
  assert.match(installedSkill, /## Keep one experiment inbox/u);
  assert.match(installedSkill, /## Ask before private enrichment/u);
  assert.match(installedSkill, /## Present an Attend card/u);
  assert.match(installedSkill, /\| Attend visualization \|/u);

  const repeatedSetup = await runJson(root, ["setup", "--json"]);
  assert.deepEqual(repeatedSetup.created, []);
  assert.deepEqual(repeatedSetup.updated, []);

  const analysis = await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "Which phrases recur across these notes?",
    "--target",
    "fixture notes",
    "--json",
  ]);
  assert.equal(analysis.ok, true);
  assert.ok(analysis.phraseCount > 0);
  assert.equal(analysis.sourceCount, 2);
  assert.match(analysis.analysisId, /^data_[a-f0-9]{16}$/u);
  assert.equal((await readJson(analysis.analysisPath)).hashes.data, analysis.dataHash);
  const privateEvidence = await readJson(evidenceStorePath({
    root,
    dataPackageId: analysis.analysisId,
  }));
  assert.equal(privateEvidence.dataHash, analysis.dataHash);
  assert.equal(privateEvidence.sources.length, analysis.sourceCount);
  assert.ok(privateEvidence.sources.every((source) => typeof source.text === "string"));

  const session = await loadSession({ root, sessionId: analysis.sessionId });
  assert.equal(session.dataPackage.config.minSources, 2);
  assert.deepEqual(session.state.sort, {
    by: "distinctSourceCount",
    direction: "desc",
  });
  const localInstrument = session.dataPackage.rows.find(
    (row) => row.phrase === "local instrument",
  );
  assert.ok(localInstrument);
  await updateSession({
    root,
    sessionId: session.id,
    expectedRevision: 0,
    patch: { selectedIds: [localInstrument.id] },
  });

  const context = await runJson(root, ["context", "--json"]);
  assert.equal(context.ok, true);
  assert.deepEqual(context.selection.selectedMarkIds, [localInstrument.id]);
  assert.equal(context.selection.marks[0].occurrenceCount, 3);
  assert.equal(context.selection.filters.minSources, 2);
  assert.equal(context.selection.sourceRefs.length, 3);
  assert.equal(context.evidenceExcerptsIncluded, false);
  assert.ok(context.selection.sourceRefs.every((reference) => !("excerpt" in reference)));

  const contextWithExcerpts = await runJson(root, [
    "context",
    "--include-excerpts",
    "--json",
  ]);
  assert.equal(contextWithExcerpts.selection.id, context.selection.id);
  assert.equal(contextWithExcerpts.evidenceExcerptsIncluded, true);
  assert.ok(contextWithExcerpts.selection.sourceRefs.every((reference) => reference.excerpt));

  const reply = await runJson(root, [
    "reply",
    "--message",
    "This phrase appears three times across both notes.",
    "--expected-revision",
    String(context.selection.stateRevision),
    "--selection-id",
    context.selection.id,
    "--json",
  ]);
  assert.equal(reply.ok, true);
  assert.equal(reply.stateRevision, 2);
  const after = await loadSession({ root, sessionId: analysis.sessionId });
  assert.equal(after.conversation.turns.length, 1);
  assert.deepEqual(after.conversation.turns[0].selection.selectedMarkIds, [localInstrument.id]);

  const doctor = await runJson(root, ["doctor", "--json"]);
  assert.equal(doctor.ok, false);
  assert.equal(doctor.readiness.core, true);
  assert.deepEqual(doctor.readiness.localModel, {
    model: "gpt-oss-20b",
    ready: false,
    required: true,
  });
  assert.equal(doctor.readiness.hostBridge, true);
  assert.ok(doctor.checks.some(
    (check) => check.id === "host-bridge" && check.status === "pass",
  ));
  assert.ok(doctor.checks.some(
    (check) => check.id === "adapter:codex-cli" && check.status === "info",
  ));
});

test("model install verifies gpt-oss-20b and makes local-first doctor ready", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  let closed = false;
  const installed = await runJson(root, ["model", "install", "--timeout", "3", "--json"], {
    modelDependencies: {
      createRunner(options) {
        assert.equal(options.allowDownload, true);
        assert.equal(options.startupTimeoutMs, 180_000);
        return {
          async start() {
            return {
              adapter: "gpt-oss-20b",
              available: true,
              authenticated: true,
              model: "gpt-oss-20b",
              runtime: "llama.cpp",
              privacy: "local-only",
            };
          },
          async close() {
            closed = true;
          },
        };
      },
    },
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.model.model, "gpt-oss-20b");
  assert.equal(closed, true);

  const doctor = await runJson(root, ["doctor", "--json"]);
  assert.equal(doctor.ok, true);
  assert.deepEqual(doctor.readiness.localModel, {
    model: "gpt-oss-20b",
    ready: true,
    required: true,
  });
});

test("bootstrap requires explicit model-download authorization before changing the project", async (t) => {
  const root = await projectFixture(t);

  await assert.rejects(
    runJson(root, ["bootstrap", "--json"]),
    /bootstrap requires --yes/u,
  );
  await assert.rejects(readFile(join(root, ".attend", "project.json")), /ENOENT/u);
});

test("bootstrap configures Attend once and converges without reloading a ready model", async (t) => {
  const root = await projectFixture(t);
  let starts = 0;
  let closes = 0;
  const modelDependencies = {
    createRunner(options) {
      assert.equal(options.allowDownload, true);
      assert.equal(options.startupTimeoutMs, 180_000);
      return {
        async start() {
          starts += 1;
          return {
            adapter: "gpt-oss-20b",
            available: true,
            authenticated: true,
            model: "gpt-oss-20b",
            runtime: "llama.cpp",
            privacy: "local-only",
          };
        },
        async close() {
          closes += 1;
        },
      };
    },
  };

  const first = await runJson(
    root,
    ["bootstrap", "--yes", "--timeout", "3", "--json"],
    { modelDependencies },
  );
  assert.equal(first.ok, true);
  assert.equal(first.model.status, "installed");
  assert.equal(first.doctor.ok, true);
  assert.equal(first.doctor.readiness.core, true);
  assert.equal(first.doctor.readiness.localModel.ready, true);
  assert.deepEqual(first.catalog.counts, CATALOG_COUNTS);
  assert.equal(starts, 1);
  assert.equal(closes, 1);
  const firstReceipt = await readFile(join(root, ".attend", "local", "model.json"), "utf8");

  const second = await runJson(
    root,
    ["bootstrap", "--yes", "--timeout", "3", "--json"],
    { modelDependencies },
  );
  assert.equal(second.ok, true);
  assert.equal(second.model.status, "already-ready");
  assert.deepEqual(second.setup.created, []);
  assert.deepEqual(second.setup.updated, []);
  assert.equal(starts, 1);
  assert.equal(closes, 1);
  assert.equal(
    await readFile(join(root, ".attend", "local", "model.json"), "utf8"),
    firstReceipt,
  );
});

test("doctor never probes Codex or Claude executables from the analyzed project", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  await setChatRoute({ root, route: { kind: "host" } });
  const localBin = join(root, "node_modules", ".bin");
  await mkdir(localBin, { recursive: true });
  const binaries = {
    codex: join(localBin, "codex"),
    claude: join(localBin, "claude"),
  };
  await Promise.all(Object.values(binaries).map((binary) =>
    writeFile(binary, '#!/bin/sh\nprintf invoked > "$0.ran"\nexit 99\n', { mode: 0o755 })));

  const originalPath = process.env.PATH;
  process.env.PATH = localBin;
  try {
    for (const adapter of ["codex", "claude"]) {
      const doctor = await runJson(root, ["doctor", "--adapter", adapter, "--json"]);
      assert.equal(doctor.ok, true);
      assert.deepEqual(doctor.readiness.detachedProvider, {
        adapter: `${adapter}-cli`,
        ready: false,
        optional: true,
      });
      assert.equal(
        doctor.checks.find((check) => check.id === `adapter:${adapter}-cli`)?.status,
        "warn",
      );
      await assert.rejects(readFile(`${binaries[adapter]}.ran`), /ENOENT/u);
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("browser opening ignores project PATH launchers and fails cleanly without a system launcher", async (t) => {
  const root = await projectFixture(t);
  const localBin = join(root, "node_modules", ".bin");
  const fakeOpen = join(localBin, "open");
  await mkdir(localBin, { recursive: true });
  await writeFile(fakeOpen, "#!/bin/sh\nexit 97\n", { mode: 0o755 });

  const launches = [];
  await openUrl("http://127.0.0.1:64157/v/token/", {
    root,
    platform: "darwin",
    env: {
      ...process.env,
      PATH: `${localBin}:/usr/bin:/bin`,
      BROWSER: fakeOpen,
    },
    async accessImpl(candidate) {
      assert.equal(candidate, "/usr/bin/open");
    },
    spawnImpl(executable, args, options) {
      launches.push({ executable, args, options });
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].executable, "/usr/bin/open");
  assert.deepEqual(launches[0].args, ["http://127.0.0.1:64157/v/token/"]);
  assert.equal(launches[0].options.cwd, "/usr/bin");
  assert.equal(launches[0].options.env.PATH.includes(localBin), false);
  assert.equal(Object.hasOwn(launches[0].options.env, "BROWSER"), false);
  assert.equal(launches[0].options.detached, false);

  await assert.rejects(
    openUrl("http://127.0.0.1:64157/v/token/", {
      root,
      platform: "darwin",
      async accessImpl() {},
      spawnImpl() {
        const child = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", 3, null));
        return child;
      },
    }),
    (error) => error.code === "BROWSER_LAUNCH_FAILED" && /status 3/u.test(error.message),
  );

  await assert.rejects(
    openUrl("http://127.0.0.1:64157/v/token/", {
      root,
      platform: "linux",
      async accessImpl() {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    }),
    (error) => error.code === "BROWSER_LAUNCHER_UNAVAILABLE",
  );
});

test("view returns its host ticket when automatic browser opening is unavailable", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  const analysis = await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "What language recurs?",
    "--json",
  ]);
  const service = {
    running: true,
    state: "running",
    url: `http://127.0.0.1:43125/v/${"c".repeat(32)}/`,
    instanceId: "instance_browser_unavailable",
    pid: 41_233,
    chat: { defaultRoute: "host", transport: "host-bridge" },
    reused: false,
  };
  let launchAttempts = 0;

  const view = await runJson(root, ["view", "--open", "--json"], {
    viewDependencies: {
      async startService() {
        return service;
      },
      registerHostAttachment,
      async serviceStatus() {
        return service;
      },
      async openUrl() {
        launchAttempts += 1;
        const error = new Error("no fixed system browser launcher");
        error.code = "BROWSER_LAUNCHER_UNAVAILABLE";
        throw error;
      },
    },
  });

  assert.equal(launchAttempts, 1);
  assert.equal(view.ok, true);
  assert.equal(view.sessionId, analysis.sessionId);
  assert.match(view.viewerUrl, /^http:\/\/127\.0\.0\.1:43125\/v\//u);
  assert.equal(view.chat.route.kind, "host");
  assert.match(view.chat.ticket, /^attend_host_v1\./u);
  assert.match(view.chat.waitCommand, /attend chat wait --ticket attend_host_v1\./u);
  assert.deepEqual(view.browser, {
    requested: true,
    opened: false,
    errorCode: "BROWSER_LAUNCHER_UNAVAILABLE",
    warning: "The browser did not open automatically. Open viewerUrl manually.",
  });
});

test("doctor rejects a stale managed visualization skill", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  await writeFile(
    join(root, ".agents", "skills", "attend-visualize", "SKILL.md"),
    "---\nname: attend-visualize\ndescription: Old managed copy.\n---\n<!-- attend-managed: generated by Attend setup -->\n\n# Old workflow\n",
  );

  try {
    const doctor = await runJson(root, ["doctor", "--json"]);
    assert.equal(doctor.ok, false);
    assert.equal(doctor.readiness.core, false);
    assert.match(
      doctor.checks.find((check) => check.id === "agent-skill-agents")?.detail ?? "",
      /stale|differs/u,
    );
    assert.equal(
      doctor.checks.find((check) => check.id === "agent-skill-agents")?.status,
      "fail",
    );
  } finally {
    process.exitCode = undefined;
  }
});

test("doctor fails host readiness when local service metadata is unreadable", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "What language recurs?",
    "--json",
  ]);
  await writeFile(join(projectPaths(root).local, "service.json"), "{invalid-json\n");

  const doctor = await runJson(root, ["doctor", "--json"]);
  assert.equal(doctor.ok, false);
  assert.equal(doctor.readiness.core, false);
  assert.equal(doctor.readiness.hostBridge, false);
  assert.equal(
    doctor.checks.find((check) => check.id === "service")?.status,
    "fail",
  );
  assert.equal(
    doctor.checks.find((check) => check.id === "host-bridge")?.status,
    "fail",
  );
  await assert.rejects(
    runJson(root, ["view", "--json"]),
    /JSON|Unexpected token|property name/u,
  );
});

test("doctor fails host readiness when the current analysis pointer is corrupt", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  await setChatRoute({ root, route: { kind: "host" } });
  await writeFile(join(projectPaths(root).local, "current.json"), "{invalid-json\n");

  const doctor = await runJson(root, ["doctor", "--json"]);
  assert.equal(doctor.ok, false);
  assert.equal(doctor.readiness.hostBridge, false);
  assert.equal(
    doctor.checks.find((check) => check.id === "host-bridge")?.status,
    "fail",
  );
});

test("doctor withholds host readiness until setup upgrades a verified 0.2 service", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  const legacy = await installVerifiedLegacyService(t, root);

  const liveStatus = await runJson(root, ["status", "--json"]);
  assert.equal(liveStatus.compatibility, "incompatible");
  assert.equal(liveStatus.hostBridgeActive, false);
  const statusOutput = capture();
  await run(["status"], { cwd: root, stdout: statusOutput.stream });
  assert.match(statusOutput.text(), /verified Attend 0\.2\.2 service is still running/u);
  assert.doesNotMatch(statusOutput.text(), /no process was trusted/u);

  try {
    const before = await runJson(root, ["doctor", "--json"]);
    assert.equal(before.ok, false);
    assert.equal(before.readiness.core, true);
    assert.equal(before.readiness.hostBridge, false);
    assert.equal(
      before.checks.find((check) => check.id === "host-bridge")?.status,
      "fail",
    );
    assert.match(
      before.checks.find((check) => check.id === "host-bridge")?.detail ?? "",
      /protocol 2|0\.2\.2/u,
    );
  } finally {
    process.exitCode = undefined;
  }

  const setup = await runJson(root, ["setup", "--json"]);
  assert.equal(setup.ok, true);
  assert.equal(setup.serviceMigration.status, "upgraded");
  assert.equal(setup.serviceMigration.from.protocolVersion, 2);
  assert.equal(setup.serviceMigration.from.packageVersion, "0.2.2");
  const upgraded = await serviceStatus({ root });
  assert.equal(upgraded.running, true);
  assert.notEqual(upgraded.pid, legacy.child.pid);
  assert.deepEqual(upgraded.chat, {
    defaultRoute: "host",
    transport: "host-bridge",
  });
  assert.equal(upgraded.compatibility, "current");
  assert.equal(upgraded.hostBridgeActive, true);
  const after = await runJson(root, ["doctor", "--json"]);
  assert.equal(after.ok, true);
  assert.equal(after.readiness.hostBridge, true);
});

test("setup leaves current and dead service states truthful", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  await setChatRoute({ root, route: { kind: "host" } });
  const current = await startService({ root, port: 0 });
  const repeated = await runJson(root, ["setup", "--json"]);
  assert.equal(repeated.serviceMigration.status, "current");
  const stillCurrent = await serviceStatus({ root });
  assert.equal(stillCurrent.instanceId, current.instanceId);
  assert.equal(stillCurrent.compatibility, "current");
  assert.equal(stillCurrent.hostBridgeActive, true);

  await stopService({ root });
  const paths = projectPaths(root);
  const config = await readJson(join(paths.local, "service.json"));
  await writeJsonAtomic(join(paths.local, "service-runtime.json"), {
    schemaVersion: 1,
    protocolVersion: 2,
    packageVersion: "0.2.2",
    pid: 2_147_483_647,
    instanceId: "legacy_dead_instance_0001",
    host: config.host,
    port: Number(new URL(current.url).port),
    url: current.url,
    startedAt: new Date().toISOString(),
  }, { root });

  const stopped = await runJson(root, ["setup", "--json"]);
  assert.equal(stopped.serviceMigration.status, "stopped");
  assert.equal(stopped.serviceMigration.staleRuntime, true);
  const dead = await serviceStatus({ root });
  assert.equal(dead.running, false);
  assert.equal(dead.compatibility, "not-running");
  assert.equal(dead.hostBridgeActive, false);
  const doctor = await runJson(root, ["doctor", "--json"]);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.readiness.hostBridge, true);
});

test("CLI families and map expose the strict atlas catalog and persist a compiled atlas package", async (t) => {
  const root = await projectFixture(t);
  await writeFile(join(root, "evidence.md"), "Alpha scored 8 points.\nBeta scored 5 points.\nGamma scored 3 points.\n");
  await runJson(root, ["setup", "--json"]);

  const families = await runJson(root, ["families", "--json"]);
  assert.equal(families.ok, true);
  assert.deepEqual(families.counts, CATALOG_COUNTS);

  await writeFile(join(root, "request.json"), JSON.stringify({
    version: 1,
    question: "How do Alpha and Beta compare?",
    family: "rank",
    member: "bar-list",
    sources: [{ path: "evidence.md" }],
    records: [
      { key: "alpha", label: "Alpha", value: 8 },
      { key: "beta", label: "Beta", value: 5 },
      { key: "gamma", label: "Gamma", value: 3 },
    ],
    evidence: [
      { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", recordKey: "alpha", field: "label" },
      { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", recordKey: "alpha", field: "value" },
      { source: { path: "evidence.md" }, quote: "Beta scored 5 points.", recordKey: "beta", field: "label" },
      { source: { path: "evidence.md" }, quote: "Beta scored 5 points.", recordKey: "beta", field: "value" },
      { source: { path: "evidence.md" }, quote: "Gamma scored 3 points.", recordKey: "gamma", field: "label" },
      { source: { path: "evidence.md" }, quote: "Gamma scored 3 points.", recordKey: "gamma", field: "value" },
    ],
  }, null, 2));

  const mapped = await runJson(root, ["map", "request.json", "--json"]);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.family, "rank");
  assert.equal(mapped.member, "bar-list");
  const analysis = await readJson(mapped.analysisPath);
  assert.equal(analysis.catalog.family, "rank");
  assert.equal(analysis.catalog.member, "bar-list");
  assert.equal(analysis.question.text, "How do Alpha and Beta compare?");
  assert.equal(analysis.marks.length, 3);
  assert.equal("rows" in analysis, false);
  const current = await readJson(join(root, ".attend", "local", "current.json"));
  assert.equal(current.analysisId, mapped.analysisId);
  assert.equal(current.sessionId, mapped.sessionId);
});

test("reply requires and enforces the exact context revision and selection id", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  const analysis = await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "Which phrases recur across these notes?",
    "--json",
  ]);
  const originalContext = await runJson(root, ["context", "--json"]);

  const missingOutput = capture();
  await assert.rejects(
    () => run(
      ["reply", "--message", "This must not be saved."],
      { cwd: root, stdout: missingOutput.stream, stderr: missingOutput.stream },
    ),
    /requires --expected-revision/u,
  );

  const session = await loadSession({ root, sessionId: analysis.sessionId });
  await updateSession({
    root,
    sessionId: session.id,
    expectedRevision: 0,
    patch: { selectedIds: [session.dataPackage.rows[0].id] },
  });

  const staleOutput = capture();
  await assert.rejects(
    () => run(
      [
        "reply",
        "--message",
        "This was reasoned from the older selection.",
        "--expected-revision",
        String(originalContext.selection.stateRevision),
        "--selection-id",
        originalContext.selection.id,
        "--json",
      ],
      { cwd: root, stdout: staleOutput.stream, stderr: staleOutput.stream },
    ),
    /Visualization state changed after context was read/u,
  );
  const after = await loadSession({ root, sessionId: analysis.sessionId });
  assert.deepEqual(after.conversation.turns, []);
});

test("CLI answers the oldest pending sidebar question against its stored selection", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  const analysis = await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "Which phrases recur across these notes?",
    "--json",
  ]);
  const initial = await loadSession({ root, sessionId: analysis.sessionId });
  const rowA = initial.dataPackage.rows.find(
    (row) => row.phrase === "local instrument",
  );
  const rowB = initial.dataPackage.rows.find((row) => row.id !== rowA.id);
  assert.ok(rowA && rowB);

  const selectedA = await updateSession({
    root,
    sessionId: initial.id,
    expectedRevision: 0,
    patch: { selectedIds: [rowA.id] },
  });
  const selectionA = buildSelection(selectedA.dataPackage, selectedA.state);
  const asked = await appendConversationTurn({
    root,
    sessionId: initial.id,
    expectedRevision: 1,
    turn: {
      id: "turn_browser_question_a",
      role: "user",
      content: "How is this phrase used across the notes?",
      selection: selectionA,
    },
  });
  await updateSession({
    root,
    sessionId: initial.id,
    expectedRevision: 2,
    patch: { selectedIds: [rowB.id] },
  });

  const context = await runJson(root, ["context", "--json"]);
  assert.equal(context.pendingQuestionPolicy, "oldest-unanswered");
  assert.equal(context.pendingQuestion.id, "turn_browser_question_a");
  assert.equal(
    context.pendingQuestion.content,
    "How is this phrase used across the notes?",
  );
  assert.equal(context.pendingQuestion.selection.id, selectionA.id);
  assert.deepEqual(
    context.pendingQuestion.selection.selectedMarkIds,
    [rowA.id],
  );
  assert.deepEqual(context.selection.selectedMarkIds, [rowB.id]);
  assert.equal(context.viewState.revision, 3);
  assert.ok(
    context.pendingQuestion.selection.sourceRefs.every(
      (reference) => !("excerpt" in reference),
    ),
  );

  const withExcerpts = await runJson(root, [
    "context",
    "--include-excerpts",
    "--json",
  ]);
  assert.ok(
    withExcerpts.pendingQuestion.selection.sourceRefs.every(
      (reference) => reference.excerpt,
    ),
  );

  await updateSession({
    root,
    sessionId: initial.id,
    expectedRevision: 3,
    patch: { query: "concurrent change" },
  });
  await assert.rejects(
    runJson(root, [
      "reply",
      "--question-id",
      context.pendingQuestion.id,
      "--message",
      "This stale answer must not attach.",
      "--expected-revision",
      String(context.viewState.revision),
      "--selection-id",
      context.pendingQuestion.selection.id,
      "--json",
    ]),
    /Visualization state changed after context was read/u,
  );
  assert.equal(
    (await loadSession({ root, sessionId: initial.id })).conversation.turns.length,
    1,
  );

  const fresh = await runJson(root, ["context", "--json"]);
  const reply = await runJson(root, [
    "reply",
    "--question-id",
    fresh.pendingQuestion.id,
    "--message",
    "It names a local analysis pattern repeated across the corpus.",
    "--expected-revision",
    String(fresh.viewState.revision),
    "--selection-id",
    fresh.pendingQuestion.selection.id,
    "--json",
  ]);
  assert.equal(reply.ok, true);
  assert.equal(reply.replyToTurnId, "turn_browser_question_a");
  assert.equal(reply.selectionId, selectionA.id);

  const stored = await loadSession({ root, sessionId: initial.id });
  assert.equal(stored.conversation.turns.length, 2);
  assert.equal(
    stored.conversation.turns[1].replyToTurnId,
    "turn_browser_question_a",
  );
  assert.deepEqual(
    stored.conversation.turns[1].selection,
    stored.conversation.turns[0].selection,
  );
  assert.deepEqual(stored.state.selectedIds, [rowB.id]);
  assert.equal((await runJson(root, ["context", "--json"])).pendingQuestion, null);
  assert.equal(asked.state.revision, 2);
});

test("CLI surfaces and answers a pending question in a non-current session", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  const analysis = await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "Which phrases recur across these notes?",
    "--json",
  ]);
  const current = await loadSession({ root, sessionId: analysis.sessionId });
  const selectedRow = current.dataPackage.rows[0];
  const librarySession = await createSession({
    root,
    id: "session_older_library_view",
    dataPackage: current.dataPackage,
    state: { selectedIds: [selectedRow.id] },
  });
  const questionSelection = buildSelection(
    librarySession.dataPackage,
    librarySession.state,
  );
  const asked = await appendConversationTurn({
    root,
    sessionId: librarySession.id,
    expectedRevision: 0,
    turn: {
      id: "turn_question_from_old_view",
      role: "user",
      content: "What is notable about this phrase?",
      createdAt: "2026-08-22T08:00:00.000Z",
      selection: questionSelection,
    },
  });

  const context = await runJson(root, ["context", "--json"]);
  assert.equal(context.currentSessionId, current.id);
  assert.equal(context.pendingQuestionScope, "all-sessions");
  assert.equal(context.pendingQuestion.sessionId, librarySession.id);
  assert.equal(context.pendingQuestion.id, "turn_question_from_old_view");
  assert.equal(context.pendingQuestion.selection.id, questionSelection.id);
  assert.equal(context.pendingQuestion.viewState.revision, 1);
  assert.equal(context.viewState.revision, 0);

  await updateSession({
    root,
    sessionId: librarySession.id,
    expectedRevision: asked.state.revision,
    patch: { query: "changed in the older view" },
  });
  await assert.rejects(
    runJson(root, [
      "reply",
      "--question-id",
      context.pendingQuestion.id,
      "--message",
      "This answer was reasoned from stale state.",
      "--expected-revision",
      String(context.pendingQuestion.viewState.revision),
      "--selection-id",
      context.pendingQuestion.selection.id,
      "--json",
    ]),
    /Visualization state changed after context was read/u,
  );

  const fresh = await runJson(root, ["context", "--json"]);
  await assert.rejects(
    runJson(root, [
      "reply",
      "--question-id",
      fresh.pendingQuestion.id,
      "--message",
      "This answer has the wrong selection.",
      "--expected-revision",
      String(fresh.pendingQuestion.viewState.revision),
      "--selection-id",
      "selection_wrong",
      "--json",
    ]),
    /Pending question selection does not match/u,
  );

  const reply = await runJson(root, [
    "reply",
    "--question-id",
    fresh.pendingQuestion.id,
    "--message",
    "It is the leading recurring phrase in that saved view.",
    "--expected-revision",
    String(fresh.pendingQuestion.viewState.revision),
    "--selection-id",
    fresh.pendingQuestion.selection.id,
    "--json",
  ]);
  assert.equal(reply.sessionId, librarySession.id);
  assert.equal(reply.replyToTurnId, fresh.pendingQuestion.id);

  const storedLibrary = await loadSession({
    root,
    sessionId: librarySession.id,
  });
  assert.equal(storedLibrary.conversation.turns.length, 2);
  assert.equal(
    storedLibrary.conversation.turns[1].replyToTurnId,
    "turn_question_from_old_view",
  );
  assert.deepEqual(
    storedLibrary.conversation.turns[1].selection,
    storedLibrary.conversation.turns[0].selection,
  );

  const storedCurrent = await loadSession({ root, sessionId: current.id });
  assert.deepEqual(storedCurrent.state, current.state);
  assert.deepEqual(storedCurrent.conversation.turns, []);
  assert.equal((await runJson(root, ["context", "--json"])).pendingQuestion, null);
});

test("installed binary keeps one detached library URL across view, stop, and restart", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  await setChatRoute({ root, route: { kind: "host" } });
  const analysis = await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "What language recurs?",
    "--json",
  ]);

  const before = await runBinJson(root, ["status", "--root", root]);
  assert.equal(before.running, false);
  assert.equal(before.configured, false);

  const startedAt = Date.now();
  const started = await runBinJson(root, ["view", "--root", root, "--port", "0"]);
  assert.ok(Date.now() - startedAt < 8_000, "view exits after health instead of owning the server lifetime");
  assert.equal(started.ok, true);
  assert.equal(started.reused, false);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/v\/[A-Za-z0-9_-]{32}\/$/u);
  assert.equal(started.libraryUrl, started.url);
  const startedViewer = new URL(started.viewerUrl);
  assert.equal(
    `${startedViewer.origin}${startedViewer.pathname}`,
    `${started.url}s/${analysis.sessionId}/`,
  );
  assert.match(startedViewer.hash, /^#attend-host=host_[a-f0-9]{16}&attend-generation=1$/u);

  const [library, health, viewer, state] = await Promise.all([
    fetch(started.url),
    fetch(new URL("api/health", started.url)),
    fetch(started.viewerUrl),
    fetch(new URL("api/state", started.viewerUrl)),
  ]);
  assert.equal(library.status, 200);
  assert.equal(viewer.status, 200);
  const serviceHealth = await health.json();
  assert.equal(serviceHealth.ok, true);
  assert.equal(serviceHealth.service, "attend-library");
  assert.equal((await state.json()).state.revision, 0);

  const reused = await runBinJson(root, ["view", "--root", root]);
  assert.equal(reused.reused, true);
  assert.equal(reused.url, started.url);
  assert.equal(
    new URL(reused.viewerUrl).pathname,
    new URL(started.viewerUrl).pathname,
  );
  assert.notEqual(new URL(reused.viewerUrl).hash, startedViewer.hash);
  const running = await runBinJson(root, ["status", "--root", root]);
  assert.equal(running.running, true);
  assert.equal(running.url, started.url);
  assert.equal(running.instanceId, serviceHealth.instanceId);

  const stopped = await runBinJson(root, ["stop", "--root", root]);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.url, started.url);
  await assert.rejects(fetch(started.url));

  const restarted = await runBinJson(root, ["view", "--root", root]);
  assert.equal(restarted.reused, false);
  assert.equal(restarted.url, started.url, "the persisted port and token keep the library URL stable");
  await runBinJson(root, ["stop", "--root", root]);

  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => runBinJson(root, ["view", "--root", root])),
  );
  assert.deepEqual(new Set(concurrent.map((result) => result.url)), new Set([started.url]));
  assert.equal(concurrent.filter((result) => result.reused === false).length, 1);
  assert.equal((await runBinJson(root, ["status", "--root", root])).running, true);
  assert.equal((await runBinJson(root, ["stop", "--root", root])).stopped, true);
});

test("view metadata is derived from the running service's explicit route", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "What language recurs?",
    "--json",
  ]);

  const selected = await runBinJson(root, [
    "chat",
    "route",
    "codex",
    "--root",
    root,
  ]);
  assert.deepEqual(selected.route, {
    kind: "detached",
    adapter: "codex-cli",
  });
  const detached = await runBinJson(root, ["view", "--root", root, "--port", "0"]);
  assert.deepEqual(detached.chat.route, {
    kind: "detached",
    adapter: "codex-cli",
  });
  assert.equal(detached.chat.ticket, null);
  assert.equal(new URL(detached.viewerUrl).hash, "");
  assert.deepEqual(
    (await runBinJson(root, ["status", "--root", root])).chat,
    {
      defaultRoute: "detached",
      transport: "detached-adapter",
      adapter: "codex-cli",
    },
  );

  const returned = await runBinJson(root, [
    "chat",
    "route",
    "host",
    "--root",
    root,
  ]);
  assert.deepEqual(returned.route, { kind: "host" });
  assert.equal(returned.serviceStoppedForRouteChange, true);
  const host = await runBinJson(root, ["view", "--root", root]);
  assert.equal(host.chat.route.kind, "host");
  assert.match(host.chat.ticket, /^attend_host_v1\./u);
  assert.match(new URL(host.viewerUrl).hash, /attend-host=/u);
});

test("view reloads its exact session after service startup and host attachment", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  const analysis = await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "What language recurs?",
    "--json",
  ]);
  const original = await loadSession({ root, sessionId: analysis.sessionId });
  const earlierHost = await registerHostAttachment({
    root,
    sessionId: original.id,
  });
  const service = {
    running: true,
    state: "running",
    url: `http://127.0.0.1:43123/v/${"a".repeat(32)}/`,
    instanceId: "instance_view_startup",
    pid: 41_231,
    chat: { defaultRoute: "host", transport: "host-bridge" },
    reused: false,
  };
  let started = false;
  let queued = false;

  const view = await runJson(root, ["view", "--json"], {
    viewDependencies: {
      async startService() {
        started = true;
        return service;
      },
      async registerHostAttachment(options) {
        assert.equal(started, true);
        const attachment = await registerHostAttachment(options);
        const latest = await loadSession({ root, sessionId: original.id });
        await appendQueuedQuestion({
          root,
          sessionId: latest.id,
          expectedRevision: latest.state.revision,
          consumeSelectedIds: false,
          route: earlierHost.route,
          turn: {
            id: "turn_queued_during_view_startup",
            role: "user",
            content: "What changed while the service started?",
            selection: buildSelection(latest.dataPackage, latest.state),
          },
        });
        queued = true;
        return attachment;
      },
      async serviceStatus() {
        assert.equal(queued, true);
        return service;
      },
    },
  });

  assert.equal(queued, true);
  assert.equal(view.sessionId, original.id);
  assert.equal(view.stateRevision, 1);
  assert.equal(view.chat.recovery.questionId, "turn_queued_during_view_startup");
  assert.equal(view.chat.recovery.expectedRevision, 1);
  assert.equal(view.chat.recovery.available, true);
});

test("view fails closed when its service instance or chat route changes during attachment", async (t) => {
  for (const scenario of [
    {
      name: "stopped",
      status(service) {
        return { ...service, running: false, state: "stopped" };
      },
    },
    {
      name: "replaced",
      status(service) {
        return { ...service, instanceId: "instance_replacement" };
      },
    },
    {
      name: "chat route changed",
      status(service) {
        return {
          ...service,
          chat: {
            defaultRoute: "detached",
            transport: "detached-adapter",
            adapter: "claude-cli",
          },
        };
      },
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const root = await projectFixture(t);
      await runJson(root, ["setup", "--json"]);
      await runJson(root, [
        "phrases",
        "notes",
        "--question",
        "What language recurs?",
        "--json",
      ]);
      const service = {
        running: true,
        state: "running",
        url: `http://127.0.0.1:43124/v/${"b".repeat(32)}/`,
        instanceId: "instance_original",
        pid: 41_232,
        chat: { defaultRoute: "host", transport: "host-bridge" },
        reused: true,
      };
      let attached = false;

      await assert.rejects(
        runJson(root, ["view", "--json"], {
          viewDependencies: {
            async startService() {
              return service;
            },
            async registerHostAttachment(options) {
              const attachment = await registerHostAttachment(options);
              attached = true;
              return attachment;
            },
            async serviceStatus() {
              assert.equal(attached, true, "view must recheck after attachment registration");
              return scenario.status(service);
            },
          },
        }),
        (error) => {
          assert.equal(error.code, "SERVICE_CHANGED_DURING_VIEW");
          assert.match(error.message, /changed while the view was being attached/u);
          return true;
        },
      );
    });
  }
});

test("explicit host sidebar chat returns to the opening CLI agent and commits through reply guards", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  await setChatRoute({ root, route: { kind: "host" } });
  const analysis = await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "What language recurs?",
    "--json",
  ]);
  let session = await loadSession({ root, sessionId: analysis.sessionId });
  const markId = session.dataPackage.rows[0].id;
  session = await updateSession({
    root,
    sessionId: session.id,
    expectedRevision: session.state.revision,
    patch: { selectedIds: [markId] },
  });
  const selected = buildSelection(session.dataPackage, session.state);

  const view = await runBinJson(root, ["view", "--root", root, "--port", "0"]);
  assert.equal(view.chat.route.kind, "host");
  assert.match(view.chat.ticket, /^attend_host_v1\.host_[a-f0-9]{16}\./u);
  assert.equal(Object.hasOwn(view, "agent"), false);
  const competingView = await runBinJson(root, ["view", "--root", root]);
  assert.notEqual(competingView.chat.route.attachmentId, view.chat.route.attachmentId);

  const listener = await beginHostListener({
    root,
    ticket: view.chat.ticket,
    waitExpiresAt: new Date(Date.now() + 2_000),
  });
  const [firstProjection, competingProjection] = await Promise.all([
    fetch(hostBoundApi(view, view.chat.route, "state")).then((response) => response.json()),
    fetch(hostBoundApi(competingView, competingView.chat.route, "state"))
      .then((response) => response.json()),
  ]);
  assert.equal(firstProjection.chat.active.listener, "listening");
  assert.equal(firstProjection.chat.active.ownership, "this-view");
  assert.equal(competingProjection.chat.active.listener, "not-listening");
  assert.equal(competingProjection.chat.active.ownership, "this-view");
  const unboundProjection = await fetch(
    new URL("api/state", view.viewerUrl),
  ).then((response) => response.json());
  assert.equal(unboundProjection.chat.active.registered, false);
  assert.equal(unboundProjection.chat.active.ownership, "unattached");
  await endHostListener({ root, listener });

  const origin = new URL(view.viewerUrl).origin;
  const chatUrl = hostBoundApi(view, view.chat.route, "chat");
  const queuedResponse = await fetch(chatUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      expectedRevision: session.state.revision,
      selectionId: selected.id,
      message: "What does the selected phrase show?",
    }),
  });
  assert.equal(queuedResponse.status, 200);
  const queued = await queuedResponse.json();
  assert.deepEqual(queued.question.response.route, { kind: "host" });

  const competingListener = await beginHostListener({
    root,
    ticket: competingView.chat.ticket,
    waitExpiresAt: new Date(Date.now() + 2_000),
  });
  const activeOwnerProjection = await fetch(
    hostBoundApi(competingView, competingView.chat.route, "state"),
  ).then((response) => response.json());
  assert.equal(
    activeOwnerProjection.chat.active.listener,
    "not-listening",
    "a listener on another tab must not be attributed to the queued question",
  );
  await endHostListener({ root, listener: competingListener });

  const owningListener = await beginHostListener({
    root,
    ticket: view.chat.ticket,
    waitExpiresAt: new Date(Date.now() + 2_000),
  });
  const projectedThroughOtherTab = await fetch(
    hostBoundApi(competingView, competingView.chat.route, "state"),
  ).then((response) => response.json());
  assert.equal(
    projectedThroughOtherTab.chat.active.listener,
    "listening",
    "active status follows the persisted question owner, not the querying tab",
  );
  assert.equal(projectedThroughOtherTab.chat.active.ownership, "another-host");
  assert.equal(projectedThroughOtherTab.chat.active.label, "Another coding agent");
  const protectedView = await runBinJson(root, ["view", "--root", root]);
  assert.deepEqual(protectedView.chat.recovery, {
    available: false,
    takeoverRequired: true,
    questionId: queued.question.id,
    expectedRevision: protectedView.stateRevision,
    reason: "earlier-host-listening",
    warning:
      "The earlier coding agent is listening for this question. Do not take it over.",
  });
  await endHostListener({ root, listener: owningListener });

  const packet = await runBinJson(root, [
    "chat",
    "wait",
    "--root",
    root,
    "--ticket",
    view.chat.ticket,
    "--timeout",
    "1",
  ]);
  assert.equal(packet.schema, "attend-host-question/1");
  assert.equal(packet.replyGuard.questionId, queued.question.id);
  assert.equal(packet.replyGuard.selectionId, selected.id);
  assert.deepEqual(packet.selection.selectedMarkIds, [markId]);
  assert.equal(packet.evidence.selectionId, selected.id);
  const deliveredProjection = await fetch(
    hostBoundApi(view, view.chat.route, "state"),
  ).then((response) => response.json());
  assert.equal(deliveredProjection.chat.active.listener, "delivered");
  const competingWait = await runBinJson(root, [
    "chat",
    "wait",
    "--root",
    root,
    "--ticket",
    competingView.chat.ticket,
    "--timeout",
    "0",
  ]);
  assert.equal(competingWait.event, "timeout");

  const recoveryView = await runBinJson(root, ["view", "--root", root]);
  assert.notEqual(
    recoveryView.chat.route.attachmentId,
    view.chat.route.attachmentId,
  );
  assert.deepEqual(recoveryView.chat.recovery, {
    available: true,
    takeoverRequired: true,
    questionId: queued.question.id,
    expectedRevision: recoveryView.stateRevision,
    warning:
      "This question was delivered to the earlier coding agent. Takeover revokes its reply guard; run it only with the user's approval.",
    command: `attend chat rebind --take-over --ticket ${recoveryView.chat.ticket} --question-id ${queued.question.id} --expected-revision ${recoveryView.stateRevision} --json`,
  });
  const rebindArgs = [
    "chat",
    "rebind",
    "--take-over",
    "--root",
    root,
    "--ticket",
    recoveryView.chat.ticket,
    "--question-id",
    queued.question.id,
    "--expected-revision",
    String(recoveryView.chat.recovery.expectedRevision),
  ];
  const rebound = await runBinJson(root, rebindArgs);
  assert.deepEqual(rebound, {
    ok: true,
    event: "rebound",
    sessionId: analysis.sessionId,
    questionId: queued.question.id,
    stateRevision: recoveryView.stateRevision + 1,
    route: { kind: "host" },
    repeated: false,
    waitCommand: `attend chat wait --ticket ${recoveryView.chat.ticket} --timeout 300 --json`,
  });
  const reboundAgain = await runBinJson(root, rebindArgs);
  assert.equal(reboundAgain.repeated, true);
  assert.equal(reboundAgain.stateRevision, rebound.stateRevision);

  const recoveryListener = await beginHostListener({
    root,
    ticket: recoveryView.chat.ticket,
    waitExpiresAt: new Date(Date.now() + 2_000),
  });
  const reboundProjection = await fetch(
    hostBoundApi(view, view.chat.route, "state"),
  ).then((response) => response.json());
  assert.equal(
    reboundProjection.chat.active.listener,
    "listening",
    "listener projection follows the rebound question owner",
  );
  await endHostListener({ root, listener: recoveryListener });

  const recoveredPacket = await runBinJson(root, [
    "chat",
    "wait",
    "--root",
    root,
    "--ticket",
    recoveryView.chat.ticket,
    "--timeout",
    "0",
  ]);
  assert.equal(recoveredPacket.replyGuard.questionId, queued.question.id);
  assert.equal(recoveredPacket.replyGuard.expectedRevision, rebound.stateRevision);
  assert.equal(recoveredPacket.replyGuard.selectionId, packet.replyGuard.selectionId);
  assert.deepEqual(recoveredPacket.evidence, packet.evidence);

  const replyArgs = [
    "reply",
    "--root",
    root,
    "--ticket",
    recoveryView.chat.ticket,
    "--question-id",
    recoveredPacket.replyGuard.questionId,
    "--expected-revision",
    String(recoveredPacket.replyGuard.expectedRevision),
    "--selection-id",
    recoveredPacket.replyGuard.selectionId,
    "--message-stdin",
  ];
  const answerText = "The phrase recurs across the selected evidence.";
  const reply = await runBinJson(root, replyArgs, { input: answerText });
  assert.equal(reply.ok, true);
  assert.equal(reply.route.kind, "host");
  assert.equal(reply.repeated, false);
  const repeated = await runBinJson(root, replyArgs, { input: answerText });
  assert.equal(repeated.repeated, true);

  const state = await fetch(new URL("api/state", view.viewerUrl)).then((response) => response.json());
  const answer = state.conversation.turns.find(
    (turn) => turn.replyToTurnId === recoveredPacket.replyGuard.questionId,
  );
  assert.equal(answer.content, "The phrase recurs across the selected evidence.");
  await runBinJson(root, ["stop", "--root", root]);
});

test("CLI exposes the fixed-root host bridge over stdio MCP", async (t) => {
  const root = await projectFixture(t);
  await runJson(root, ["setup", "--json"]);
  const stdin = new PassThrough();
  const stdout = capture();
  const stderr = capture();
  stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cli-test", version: "1.0.0" },
    },
  })}\n`);
  stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  })}\n`);
  stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })}\n`);
  stdin.end();

  await run(["mcp", "--root", root], {
    cwd: root,
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(stderr.text(), "");
  const messages = stdout.text().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.id), [1, 2]);
  assert.equal(messages[0].result.serverInfo.name, "@siunami/attend");
  assert.deepEqual(
    messages[1].result.tools.map((tool) => tool.name),
    ["attend_wait_for_question", "attend_rebind_question", "attend_reply"],
  );
});

test("an installed nested project wins over an enclosing Git root", async (t) => {
  const outer = await mkdtemp(join(tmpdir(), "attend-nested-test-"));
  const root = join(outer, "nested project");
  await mkdir(join(outer, ".git"));
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "note.md"), "Quiet maps help. Quiet maps endure.\n");
  t.after(() => rm(outer, { recursive: true, force: true }));

  await runJson(root, ["setup", "--root", root, "--json"]);
  const analysis = await runJson(root, [
    "phrases",
    "notes",
    "--question",
    "What recurs?",
    "--json",
  ]);
  assert.equal(analysis.ok, true);
  assert.ok(analysis.analysisPath.startsWith(join(root, ".attend")));
});
