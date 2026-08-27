import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const PACKAGE_ROOT = new URL("..", import.meta.url);
const STAGE_SCRIPT = new URL("../distribution/stage-release.mjs", import.meta.url);

function stageProcess(output, { retainFrom } = {}) {
  const args = [STAGE_SCRIPT.pathname, "--output", output];
  if (retainFrom) args.push("--retain-from", retainFrom);
  return spawnSync(
    process.execPath,
    args,
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: process.env,
    },
  );
}

function stage(output, options = {}) {
  const result = stageProcess(output, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function seedRetainedRelease(root, version = "0.1.0") {
  const directory = join(root, "releases", version);
  const filename = `attend-local-${version}.tgz`;
  const archive = Buffer.from("previous immutable Attend release\n", "utf8");
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  const baseUrl = "https://attend-cli.matthewwilsonsiu.workers.dev";
  const prompt = `Install Attend Local ${version} from its immutable release.\n`;
  const manifest = {
    schemaVersion: 1,
    kind: "attend-cli-release",
    package: "attend-local",
    version,
    engines: { node: ">=22.0.0" },
    tarball: {
      filename,
      url: `${baseUrl}/releases/${version}/${filename}`,
      sha256: archiveDigest,
      bytes: archive.length,
      integrity: "sha512-retained-test-fixture",
    },
    installPromptUrl: `${baseUrl}/releases/${version}/install-prompt.txt`,
    installScriptUrl: `${baseUrl}/releases/${version}/install.sh`,
  };
  const installer = "#!/bin/sh\nprintf '%s\\n' 'retained installer'\n";
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, filename), archive),
    writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n"),
    writeFile(join(directory, "SHA256SUMS"), `${archiveDigest}  ${filename}\n`),
    writeFile(join(directory, "install-prompt.txt"), prompt),
    writeFile(join(directory, "install.sh"), installer),
  ]);
  return { version, filename, archiveDigest, prompt, installer };
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

const EXPERIMENT_INBOX_CONTRACT = Object.freeze([
  /record(?:s|ed)? every admitted hypothesis before execution/iu,
  /run(?:s)? every admitted experiment/iu,
  /one canonical experiment inbox/iu,
  /interesting, uninteresting, null, inconclusive, invalid, and failed/iu,
  /(?:promote|promotion may emphasize) any number of interesting results/iu,
  /agent promotion, a human star, and structured feedback (?:as separate signals|remain separate)/iu,
  /(?:parent-child branches|child experiment linked to its parent)/iu,
  /exploratory or confirmatory/iu,
  /comparison count/iu,
  /mention(?:s)? at most one result/iu,
  /(?:link(?:s)? (?:to )?the experiment workspace|with a workspace link)/iu,
]);

const EXPERIMENT_INBOX_COMMANDS = Object.freeze([
  "attend inspect <request.json> --json",
  "attend explore <request.json> --json",
  "attend map <request.json> --stage --exploration <id> --experiment <id> --json",
  "attend assess <experiment-id> <assessment.json> --json",
  "attend promote <experiment-id> [--rationale <text>] --json",
  "attend feedback <experiment-id> --kind <reason> [--note <text>] --json",
  "attend workspace [exploration-id] --open --json",
]);

const OPPORTUNITY_CHECK_CONTRACT = Object.freeze([
  /attend checkpoint/iu,
  /OpportunityCheck/iu,
  /eligible natural task boundary/iu,
  /(?:abstain(?:s|tion)?[^.]{0,100}silent|abstention is completely silent)/iu,
  /\bproceed\b/iu,
  /(?:one linked exploration|exactly one exploration)/iu,
  /checkpointId/iu,
  /does not call a model/iu,
]);

function assertExperimentInboxContract(value, label) {
  for (const pattern of EXPERIMENT_INBOX_CONTRACT) {
    assert.match(value, pattern, `${label} must preserve ${pattern}`);
  }
  assert.doesNotMatch(
    value,
    /only surface candidate visualizations|do not mention or link discarded candidates|discarded candidates stay out/iu,
    `${label} must not restore the hide-discarded policy`,
  );
}

function assertExperimentInboxCommands(value, label) {
  for (const command of EXPERIMENT_INBOX_COMMANDS) {
    assert.ok(value.includes(command), `${label} must document ${command}`);
  }
}

function assertOpportunityCheckContract(value, label) {
  for (const pattern of OPPORTUNITY_CHECK_CONTRACT) {
    assert.match(value, pattern, `${label} must preserve ${pattern}`);
  }
}

test("vendored browser assets match their pinned upstream files", async () => {
  const expected = {
    "d3.min.js": "f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539",
    "topojson-client.min.js": "25cd02ae486cc5063e0215a4e4cfb15de83700c87ac48bac4d57dc6aaf3ebb89",
    "us-states.json": "d76b391ccfa8bff601d51e3e3da5d43a89fa46cd5caca72ce731b383be5596d0",
    "us-counties.json": "145aaf5d1433352a6a1d8e86b5f149c7c653f9171baf14aaf75ee66575def1b0",
    "world-countries.json": "2516c915867c7baf18ddec727aec46c315541a07cfb3d79a6559b05d5e94eee8",
  };
  for (const [filename, expectedDigest] of Object.entries(expected)) {
    assert.equal(await digest(new URL(`viewer/vendor/${filename}`, PACKAGE_ROOT)), expectedDigest);
  }
  const notice = await readFile(new URL("viewer/vendor/THIRD_PARTY_NOTICES.md", PACKAGE_ROOT), "utf8");
  for (const expectedDigest of Object.values(expected)) assert.match(notice, new RegExp(expectedDigest, "u"));
});

test("release staging produces a reproducible, private-data-free package and pinned prompt", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "attend-distribution-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  const first = stage(join(temporary, "first"));
  const second = stage(join(temporary, "second"));
  const version = first.manifest.version;
  const filename = first.manifest.tarball.filename;
  const firstArchive = join(temporary, "first", "releases", version, filename);
  const secondArchive = join(temporary, "second", "releases", version, filename);

  assert.equal(await digest(firstArchive), first.manifest.tarball.sha256);
  assert.equal(await digest(secondArchive), first.manifest.tarball.sha256);
  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(first.retainedVersions, []);
  assert.equal(
    first.manifest.installPromptUrl,
    `https://attend-cli.matthewwilsonsiu.workers.dev/releases/${version}/install-prompt.txt`,
  );
  assert.equal(
    first.manifest.installScriptUrl,
    `https://attend-cli.matthewwilsonsiu.workers.dev/releases/${version}/install.sh`,
  );
  assert.deepEqual(first.manifest.catalog.counts, {
    families: 19,
    approved: 106,
    documented: 87,
    executable: 18,
    unavailable: 1,
    rejected: 38,
  });
  assert.deepEqual(first.manifest.components.experimentInbox, { schemaVersion: 1 });
  assert.deepEqual(first.manifest.components.opportunityCheck, { schemaVersion: 1 });
  assert.equal(first.manifest.components.managedSkill.behaviorSchemaVersion, 2);
  assert.match(first.manifest.components.managedSkill.sha256, /^[a-f0-9]{64}$/u);
  assert.match(first.manifest.components.managedSkill.metadataSha256, /^[a-f0-9]{64}$/u);

  const prompt = await readFile(join(temporary, "first", "install-prompt.txt"), "utf8");
  assert.equal(
    await readFile(join(temporary, "first", "releases", version, "install-prompt.txt"), "utf8"),
    prompt,
  );
  assert.match(prompt, new RegExp(first.manifest.tarball.sha256, "u"));
  assert.ok(prompt.includes(`curl -fsSL ${first.manifest.installScriptUrl} | sh`));
  assert.doesNotMatch(prompt, /npm install --global/u);
  assert.doesNotMatch(prompt, /installing manually/u);
  assert.match(prompt, /attend setup --json/u);
  assert.match(prompt, /attend model install --json/u);
  assert.match(prompt, /attend doctor --json/u);
  assert.match(prompt, /attend families --json/u);
  assert.match(prompt, /19 families, 18 executable, 1 unavailable/u);
  assert.match(prompt, /\.agents\/skills\/ and \.claude\/skills\//u);
  assert.match(prompt, /chat-route, and local-model checks pass/u);
  assert.match(prompt, /readiness\.core and readiness\.localModel\.ready are true/u);
  assert.match(prompt, /Host routing, Codex CLI, and Claude CLI are optional fallbacks/u);
  assert.match(prompt, /follow its intentional-proactivity and experiment-inbox contracts/u);
  assert.match(prompt, /ask before reading a new private source/u);
  assertExperimentInboxContract(prompt, "install prompt");
  assertOpportunityCheckContract(prompt, "install prompt");
  assert.match(prompt, /Inspect doctor\.chat\.route/u);
  assert.match(prompt, /normal route to be local gpt-oss-20b/u);
  assert.match(prompt, /sidebar chat does not depend on this agent remaining active/u);
  assert.match(prompt, /view\.browser\.opened is false/u);
  assert.match(prompt, /open view\.viewerUrl manually/u);
  assert.match(prompt, /roughly a 12 GB download/u);
  assert.doesNotMatch(prompt, /codex --version|codex login status|developers\.openai\.com\/codex/u);
  assert.doesNotMatch(prompt, /claude auth|doctor --adapter/u);
  assert.match(prompt, /never generate custom chart code/iu);

  const installer = await readFile(join(temporary, "first", "install.sh"), "utf8");
  assert.equal(
    await readFile(join(temporary, "first", "releases", version, "install.sh"), "utf8"),
    installer,
  );
  assert.match(installer, /^#!\/bin\/sh\nset -eu\n/u);
  assert.doesNotMatch(installer, /\{\{[A-Z0-9_]+\}\}/u);
  assert.match(installer, new RegExp(first.manifest.tarball.sha256, "u"));
  assert.match(installer, /mktemp -d/u);
  assert.match(installer, /trap cleanup 0/u);
  assert.match(installer, /shasum -a 256/u);
  assert.match(installer, /sha256sum/u);
  assert.match(installer, /"\$ATTEND_NPM" install --global/u);
  assert.match(installer, /"\$ATTEND_NPM" config get prefix/u);
  assert.match(installer, /ATTEND_NPM_PREFIX="\$HOME\/\.local"/u);
  assert.match(installer, /"\$ATTEND_NODE" "\$ATTEND_BIN" setup --json/u);
  assert.match(installer, /"\$ATTEND_NODE" "\$ATTEND_BIN" model install --json/u);
  assert.match(installer, /"\$ATTEND_NODE" "\$ATTEND_BIN" doctor --json/u);
  assert.match(installer, /"\$ATTEND_NODE" "\$ATTEND_BIN" families --json/u);
  assert.match(installer, /"local-model"/u);
  assert.match(installer, /"chat-route"/u);
  assert.match(installer, /doctor\.readiness\?\.core !== true/u);
  assert.match(installer, /doctor\.readiness\?\.localModel\?\.ready !== true/u);
  assert.match(installer, /doctor\.chat\?\.route/u);
  assert.doesNotMatch(installer, /codex --version|codex login|claude auth|doctor --adapter/u);
  assert.doesNotMatch(installer, /\bjq\b/u);
  const shellCheck = spawnSync("sh", ["-n", join(temporary, "first", "install.sh")], {
    encoding: "utf8",
  });
  assert.equal(shellCheck.status, 0, shellCheck.stderr || shellCheck.stdout);

  const index = await readFile(join(temporary, "first", "index.html"), "utf8");
  assert.doesNotMatch(index, /\{\{[A-Z0-9_]+\}\}/u);
  assert.match(index, /Designed visualizations for a compatible coding agent/u);
  assert.match(index, /Private preview/u);
  assert.match(index, /invited collaborators/u);
  assert.match(index, /eighteen designs executable/u);
  assert.match(index, /one explicit capability abstention/u);
  assert.match(index, /data-copy-prompt/u);
  assert.match(index, /one canonical experiment inbox/u);
  assert.match(index, /one silent,\s+content-free opportunity checkpoint/u);
  assert.match(index, /records every admitted hypothesis before execution/u);
  assert.match(index, /keeps\s+every outcome in one trail/u);
  assert.match(index, /Promotion, human stars, and feedback stay\s+separate/u);
  assert.match(index, /agent chat mentions at most one result/u);
  assert.match(index, /workspace link/u);
  assert.match(index, /default gpt-oss-20b inference stay on this machine/u);
  assert.match(index, /Host-agent, Codex CLI, and Claude CLI responders are opt-in compatibility modes/u);
  assert.match(await readFile(join(temporary, "first", "copy.js"), "utf8"), /navigator\.clipboard\.writeText/u);
  const headers = await readFile(join(temporary, "first", "_headers"), "utf8");
  assert.match(headers, /\/releases\/:version\/install\.sh\n  Content-Type: text\/x-shellscript; charset=utf-8/u);
  assert.match(headers, /\/install\.sh\n  Cache-Control: no-store/u);

  const archive = spawnSync("tar", ["-tzf", firstArchive], { encoding: "utf8" });
  assert.equal(archive.status, 0, archive.stderr);
  assert.doesNotMatch(
    archive.stdout,
    /(^|\/)(?:\.attend|\.context|\.git|distribution|test|node_modules)(?:\/|$)/mu,
  );
  for (const required of [
    "package/bin/attend.js",
    "package/agent-skill/attend-visualize/SKILL.md",
    "package/agent-skill/attend-visualize/agents/openai.yaml",
    "package/src/opportunity-store.js",
    "package/viewer/index.html",
    "package/viewer/workspace.html",
    "package/viewer/workspace.js",
    "package/viewer/workspace.css",
    "package/viewer/vendor/d3.min.js",
    "package/viewer/vendor/topojson-client.min.js",
    "package/viewer/vendor/us-states.json",
    "package/viewer/vendor/us-counties.json",
    "package/viewer/vendor/world-countries.json",
    "package/viewer/vendor/THIRD_PARTY_NOTICES.md",
    "package/viewer/vendor/licenses/d3-7.9.0.txt",
    "package/viewer/vendor/licenses/topojson-client-3.1.0.txt",
    "package/viewer/vendor/licenses/us-atlas-3.0.1.txt",
    "package/viewer/vendor/licenses/world-atlas-2.0.2.txt",
  ]) {
    assert.match(archive.stdout, new RegExp("^" + required.replaceAll(".", "\\.") + "$", "mu"));
  }

  const extracted = join(temporary, "extracted");
  await mkdir(extracted);
  const unpack = spawnSync("tar", ["-xzf", firstArchive, "-C", extracted], {
    encoding: "utf8",
  });
  assert.equal(unpack.status, 0, unpack.stderr);
  const extractedPackage = join(extracted, "package");
  const [packedSkill, packedAgentMetadata, packedReadme] = await Promise.all([
    readFile(join(extractedPackage, "agent-skill", "attend-visualize", "SKILL.md"), "utf8"),
    readFile(
      join(extractedPackage, "agent-skill", "attend-visualize", "agents", "openai.yaml"),
      "utf8",
    ),
    readFile(join(extractedPackage, "README.md"), "utf8"),
  ]);
  assertExperimentInboxContract(packedSkill, "packed skill");
  assertExperimentInboxCommands(packedSkill, "packed skill");
  assertOpportunityCheckContract(packedSkill, "packed skill");
  assert.match(
    packedSkill,
    /Never paste credentials, raw source bodies, exact source quotes, absolute paths, prompts, or transcripts/iu,
  );
  assertExperimentInboxContract(packedReadme, "packed README");
  assertExperimentInboxCommands(packedReadme, "packed README");
  assertOpportunityCheckContract(packedReadme, "packed README");
  assert.match(packedAgentMetadata, /Keep an evidence-backed experiment inbox/u);
  assert.match(packedAgentMetadata, /record every admitted hypothesis before execution/u);
  assert.match(packedAgentMetadata, /run every admitted experiment/u);
  assert.match(packedAgentMetadata, /retain every outcome in one canonical inbox/u);
  assert.match(packedAgentMetadata, /mention at most one result with a workspace link/u);
  assert.match(packedAgentMetadata, /silent opportunity checkpoint/u);
  assert.doesNotMatch(packedAgentMetadata, /surface only evidence-backed insights/iu);
  const installedCatalog = spawnSync(
    process.execPath,
    [join(extracted, "package", "bin", "attend.js"), "families", "--json"],
    { cwd: extracted, encoding: "utf8", env: process.env },
  );
  assert.equal(
    installedCatalog.status,
    0,
    `The packed CLI must run without files from the source checkout.\n${installedCatalog.stderr || installedCatalog.stdout}`,
  );
  const catalog = JSON.parse(installedCatalog.stdout);
  assert.deepEqual(catalog.counts, {
    families: 19,
    approved: 106,
    documented: 87,
    executable: 18,
    unavailable: 1,
    rejected: 38,
  });

  const project = join(temporary, "packed-project");
  await mkdir(join(project, ".git"), { recursive: true });
  const fakeBin = join(temporary, "fake-bin");
  const familiesPath = join(temporary, "families.json");
  const doctorPath = join(temporary, "doctor.json");
  const npmLog = join(temporary, "npm.log");
  const fakeAttend = join(temporary, "fake-attend");
  const fakeHome = join(temporary, "home");
  const expectedPrefix = join(fakeHome, ".local");
  const unusablePrefix = join(temporary, "missing-prefix");
  await mkdir(fakeBin);
  await mkdir(fakeHome);
  await writeFile(familiesPath, installedCatalog.stdout);
  const readyDoctor = {
    ok: true,
    checks: [
      { id: "project", status: "pass", detail: "fixture" },
      { id: "agent-skill-agents", status: "pass", detail: "fixture" },
      { id: "agent-skill-claude", status: "pass", detail: "fixture" },
      { id: "host-bridge", status: "pass", detail: "fixture" },
      { id: "chat-route", status: "pass", detail: "fixture" },
      { id: "local-model", status: "pass", detail: "fixture" },
      { id: "adapter:codex-cli", status: "info", detail: "optional and not probed" },
      { id: "adapter:claude-cli", status: "info", detail: "optional and not probed" },
    ],
    readiness: {
      core: true,
      localModel: { model: "gpt-oss-20b", ready: true, required: true },
      hostBridge: true,
      detachedProvider: { adapter: null, ready: false, optional: true },
    },
    chat: { route: { kind: "local", model: "gpt-oss-20b" } },
  };
  await writeFile(doctorPath, JSON.stringify(readyDoctor));
  await Promise.all([
    writeExecutable(join(fakeBin, "node"), `#!/bin/sh
exec '${process.execPath}' "$@"
`),
    writeExecutable(join(fakeBin, "curl"), `#!/bin/sh
set -eu
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    output=$1
  fi
  shift
done
[ -n "$output" ]
cp "$ATTEND_TEST_ARCHIVE" "$output"
`),
    writeExecutable(join(fakeBin, "npm"), `#!/bin/sh
set -eu
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "get" ] && [ "\${3:-}" = "prefix" ]; then
  printf '%s\\n' "$ATTEND_TEST_SYSTEM_PREFIX"
  exit 0
fi
printf '%s\\n' "$*" >"$ATTEND_TEST_NPM_LOG"
[ "$1" = "install" ] || exit 73
[ "$2" = "--global" ] || exit 73
[ "$3" = "--prefix" ] || exit 73
[ "$4" = "$ATTEND_TEST_EXPECTED_PREFIX" ] || exit 73
case "$5" in
  */attend-local-\${ATTEND_TEST_VERSION}.tgz) ;;
  *) exit 73 ;;
esac
mkdir -p "$ATTEND_TEST_EXPECTED_PREFIX/bin"
cp "$ATTEND_TEST_ATTEND" "$ATTEND_TEST_EXPECTED_PREFIX/bin/attend"
chmod 755 "$ATTEND_TEST_EXPECTED_PREFIX/bin/attend"
`),
    writeExecutable(fakeAttend, `#!/usr/bin/env node
const fs = require("node:fs");
switch (process.argv[2]) {
  case "--version":
    console.log("${version}");
    break;
  case "setup":
    console.log('{"ok":true,"conflicts":[]}');
    break;
  case "model":
    console.log('{"ok":true,"model":{"model":"gpt-oss-20b"}}');
    break;
  case "doctor":
    process.stdout.write(fs.readFileSync(process.env.ATTEND_TEST_DOCTOR_JSON));
    break;
  case "families":
    process.stdout.write(fs.readFileSync(process.env.ATTEND_TEST_FAMILIES_JSON));
    break;
  default:
    process.exit(2);
}
`),
  ]);
  const installerEnvironment = {
    ...process.env,
    HOME: fakeHome,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    ATTEND_TEST_ARCHIVE: firstArchive,
    ATTEND_TEST_ATTEND: fakeAttend,
    ATTEND_TEST_EXPECTED_PREFIX: expectedPrefix,
    ATTEND_TEST_SYSTEM_PREFIX: unusablePrefix,
    ATTEND_TEST_VERSION: version,
    ATTEND_TEST_NPM_LOG: npmLog,
    ATTEND_TEST_DOCTOR_JSON: doctorPath,
    ATTEND_TEST_FAMILIES_JSON: familiesPath,
  };
  const installRun = spawnSync("sh", [join(temporary, "first", "install.sh")], {
    cwd: project,
    encoding: "utf8",
    env: installerEnvironment,
  });
  assert.equal(installRun.status, 0, installRun.stderr || installRun.stdout);
  assert.match(
    installRun.stdout,
    new RegExp(`Attend ${version.replaceAll(".", "\\.")} installed: 19 families, 18 executable, 1 unavailable`, "u"),
  );
  assert.match(installRun.stdout, /Chat route: private gpt-oss-20b on this machine/u);
  assert.match(
    installRun.stdout,
    /Optional detached fallbacks \(not required\): Codex CLI: not probed, Claude CLI: not probed\./u,
  );
  const npmInvocation = await readFile(npmLog, "utf8");
  assert.ok(npmInvocation.startsWith(`install --global --prefix ${expectedPrefix} `));
  assert.ok(npmInvocation.endsWith(`/attend-local-${version}.tgz\n`));

  const detachedDoctor = structuredClone(readyDoctor);
  detachedDoctor.chat.route = { kind: "detached", adapter: "codex-cli" };
  await writeFile(doctorPath, JSON.stringify(detachedDoctor));
  const detachedInstall = spawnSync("sh", [join(temporary, "first", "install.sh")], {
    cwd: project,
    encoding: "utf8",
    env: installerEnvironment,
  });
  assert.equal(detachedInstall.status, 0, detachedInstall.stderr || detachedInstall.stdout);
  assert.match(detachedInstall.stdout, /explicit detached fallback Codex CLI remains selected/u);
  assert.doesNotMatch(detachedInstall.stdout, /Chat route: private gpt-oss-20b/u);
  await writeFile(doctorPath, JSON.stringify(readyDoctor));

  for (const readiness of ["core", "localModel"]) {
    const failedDoctor = structuredClone(readyDoctor);
    if (readiness === "localModel") failedDoctor.readiness.localModel.ready = false;
    else failedDoctor.readiness[readiness] = false;
    await writeFile(doctorPath, JSON.stringify(failedDoctor));
    const rejectedReadiness = spawnSync("sh", [join(temporary, "first", "install.sh")], {
      cwd: project,
      encoding: "utf8",
      env: installerEnvironment,
    });
    assert.notEqual(rejectedReadiness.status, 0);
    assert.match(
      rejectedReadiness.stderr,
      readiness === "core" ? /core visualization readiness/u : /local-model readiness/u,
    );
  }

  const tamperedArchive = join(temporary, "tampered.tgz");
  await writeFile(tamperedArchive, "not the release archive\n");
  await writeFile(npmLog, "not-called\n");
  const rejectedInstall = spawnSync("sh", [join(temporary, "first", "install.sh")], {
    cwd: project,
    encoding: "utf8",
    env: { ...installerEnvironment, ATTEND_TEST_ARCHIVE: tamperedArchive },
  });
  assert.notEqual(rejectedInstall.status, 0);
  assert.match(rejectedInstall.stderr, /failed SHA-256 verification/u);
  assert.equal(await readFile(npmLog, "utf8"), "not-called\n");

  const packedPackage = JSON.parse(await readFile(join(extracted, "package", "package.json"), "utf8"));
  assert.equal(packedPackage.license, "UNLICENSED");
  assert.equal(packedPackage.dependencies, undefined);
  assert.deepEqual(packedPackage.repository, {
    type: "git",
    url: "git+https://github.com/Siunami/attend-local.git",
  });

  const packedBin = join(extracted, "package", "bin", "attend.js");
  const setup = spawnSync(process.execPath, [packedBin, "setup", "--root", project, "--json"], {
    cwd: project,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const packedProject = await import(pathToFileURL(join(extractedPackage, "src", "project.js")));
  const expectedManagedSkill = packedProject.managedSkillContents(packedSkill);
  const [agentsSkill, agentsMetadata, claudeSkill] = await Promise.all([
    readFile(join(project, ".agents", "skills", "attend-visualize", "SKILL.md"), "utf8"),
    readFile(
      join(project, ".agents", "skills", "attend-visualize", "agents", "openai.yaml"),
      "utf8",
    ),
    readFile(join(project, ".claude", "skills", "attend-visualize", "SKILL.md"), "utf8"),
  ]);
  assert.equal(agentsSkill, expectedManagedSkill);
  assert.equal(
    agentsMetadata,
    packedProject.managedSkillMetadataContents(packedAgentMetadata),
  );
  assert.equal(claudeSkill, expectedManagedSkill);
  assertExperimentInboxContract(agentsSkill, "fresh managed skill");
  assertExperimentInboxCommands(agentsSkill, "fresh managed skill");
  assertOpportunityCheckContract(agentsSkill, "fresh managed skill");
  const checkpointRequest = join(project, "checkpoint-request.json");
  await writeFile(checkpointRequest, JSON.stringify({
    version: 1,
    boundary: { kind: "before-final-answer", id: "packed-release-turn" },
    host: { kind: "codex", skillVersion: "attend-visualize/0.5.0" },
    taskShape: {
      action: "review",
      evidenceState: "derived-records",
      resultShape: "table",
      visualJobs: ["comparison"],
    },
    sourceShape: {
      origin: "self-report",
      sourceCount: 1,
      recordCount: 3,
      numericTokenCount: 3,
      isoDateCount: 0,
      omissionCount: 0,
    },
    decision: {
      kind: "abstain",
      reason: "text-suffices",
      confidence: 0.9,
      interruptionCost: 0.1,
    },
  }));
  const checkpoint = spawnSync(
    process.execPath,
    [packedBin, "checkpoint", checkpointRequest, "--root", project, "--json"],
    { cwd: project, encoding: "utf8", env: process.env },
  );
  assert.equal(checkpoint.status, 0, checkpoint.stderr || checkpoint.stdout);
  const checkpointResult = JSON.parse(checkpoint.stdout);
  assert.equal(checkpointResult.decision, "abstain");
  assert.match(checkpointResult.checkpointId, /^checkpoint_[a-f0-9]{24}$/u);
  const packedReceipt = await readFile(
    join(project, ".attend", "local", "checkpoints", `${checkpointResult.checkpointId}.json`),
    "utf8",
  );
  assert.doesNotMatch(packedReceipt, /packed-release-turn/u);
  const doctor = spawnSync(process.execPath, [packedBin, "doctor", "--root", project, "--json"], {
    cwd: project,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const doctorResult = JSON.parse(doctor.stdout);
  assert.deepEqual(doctorResult.components.opportunityCheck, { schemaVersion: 1 });
  assert.equal(doctorResult.components.managedSkill.behaviorSchemaVersion, 2);
  const viewerChecks = doctorResult.checks.filter((check) => check.id.startsWith("viewer-"));
  assert.ok(viewerChecks.length >= 20, "doctor must inspect every Atlas module and vendor asset");
  assert.ok(viewerChecks.every((check) => check.status === "pass"));
  for (const expected of ["d3.min.js", "topojson-client.min.js", "us-states.json", "us-counties.json", "world-countries.json"]) {
    assert.ok(viewerChecks.some((check) => check.detail.endsWith(expected)), `doctor must check ${expected}`);
  }

  const packedServer = await import(pathToFileURL(join(extracted, "package", "src", "server.js")));
  const library = await packedServer.createLibraryServer({
    root: project,
    assetsDir: join(extracted, "package", "viewer"),
    token: "packed-release-asset-test-token",
    instanceId: "packed-release-asset-test-instance",
  });
  t.after(() => library.close());
  for (const asset of [
    "d3.min.js",
    "topojson-client.min.js",
    "us-states.json",
    "us-counties.json",
    "world-countries.json",
  ]) {
    const response = await fetch(new URL(`families/vendor/${asset}`, library.url));
    assert.equal(response.status, 200, `packed server must serve ${asset} without node_modules`);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
});

test("release retention keeps two immutable versions and their versioned prompts", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "attend-retention-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  const previous = join(temporary, "previous");
  const old = await seedRetainedRelease(previous);
  const firstOutput = join(temporary, "first-output");
  const first = stage(firstOutput, { retainFrom: previous });
  assert.deepEqual(first.retainedVersions, [old.version]);

  const currentVersion = first.manifest.version;
  const currentPrompt = await readFile(
    join(firstOutput, "releases", currentVersion, "install-prompt.txt"),
    "utf8",
  );
  assert.equal(await readFile(join(firstOutput, "install-prompt.txt"), "utf8"), currentPrompt);
  assert.equal(
    await digest(join(firstOutput, "releases", old.version, old.filename)),
    old.archiveDigest,
  );
  assert.equal(
    await readFile(join(firstOutput, "releases", old.version, "install-prompt.txt"), "utf8"),
    old.prompt,
  );
  assert.equal(
    await readFile(join(firstOutput, "releases", old.version, "install.sh"), "utf8"),
    old.installer,
  );

  const secondOutput = join(temporary, "second-output");
  const second = stage(secondOutput, { retainFrom: firstOutput });
  assert.deepEqual(second.retainedVersions, [old.version, currentVersion]);
  assert.equal(
    await digest(join(secondOutput, "releases", old.version, old.filename)),
    old.archiveDigest,
  );
  assert.equal(
    await readFile(join(secondOutput, "releases", currentVersion, "install-prompt.txt"), "utf8"),
    currentPrompt,
  );
  assert.equal(
    await readFile(join(secondOutput, "releases", old.version, "install.sh"), "utf8"),
    old.installer,
  );

  await writeFile(
    join(secondOutput, "releases", currentVersion, "install-prompt.txt"),
    "mutated same-version prompt\n",
  );
  const rejected = stageProcess(join(temporary, "rejected-output"), {
    retainFrom: secondOutput,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /already exists with different contents; bump the package version/u);
});
