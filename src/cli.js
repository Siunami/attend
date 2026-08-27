import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { analyzePhrasesWithEvidence } from "./analyze.js";
import {
  createDetachedAgentRunner,
  trustedLauncherEnvironment,
} from "./agent-runner.js";
import { buildArtifactSelection, libraryMetadataForArtifact } from "./artifacts/index.js";
import { CATALOG_COUNTS, CATALOG_VERSION, listCatalogFamilies } from "./catalog/index.js";
import {
  hostListenerStatus,
  readChatRoute,
  registerHostAttachment,
  resolveChatRoute,
  sameChatRoute,
} from "./chat-route.js";
import {
  MANAGED_SKILL_BEHAVIOR_SCHEMA_VERSION,
  PACKAGE_VERSION,
} from "./constants.js";
import { writeEvidenceStore } from "./evidence.js";
import {
  EXPLORATION_SCHEMA_VERSION,
  FEEDBACK_KINDS,
  appendExperimentEvent,
  createExperiment,
  createExploration,
  explorationIdForCheckpoint,
  listExperiments,
  listExplorations,
  loadExperiment,
  loadExploration,
  publicExperiment,
  publicExploration,
  validateExperimentPlan,
  validateExplorationPlan,
  withExperimentExecutionLock,
} from "./exploration-store.js";
import { inspectSources } from "./inspect.js";
import { compileCatalogMapRequest } from "./map/index.js";
import {
  completeHostQuestion,
  hostBridgeCapability,
  rebindHostQuestion,
  waitForHostQuestion,
} from "./host-bridge.js";
import { runAttendMcpStdio } from "./mcp-server.js";
import {
  SKILL_TARGET_IDS,
  managedSkillMetadataContents,
  managedSkillContents,
  projectPaths,
  readJson,
  setupProject,
  writeJsonAtomic,
} from "./project.js";
import {
  changeServiceChatRoute,
  runForegroundService,
  serviceStatus,
  startService,
  stopService,
} from "./service.js";
import {
  appendConversationTurn,
  createSession,
  loadSession,
  oldestUnansweredQuestionAcrossSessions,
} from "./session-store.js";
import { PACKAGED_ATLAS_ASSET_FILES } from "./server.js";
import { createLlamaCppModelRunner, LOCAL_MODEL } from "./local-model.js";
import {
  OPPORTUNITY_SCHEMA_VERSION,
  createOpportunityCheck,
} from "./opportunity-store.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL_SOURCE = fileURLToPath(
  new URL("../agent-skill/attend-visualize/SKILL.md", import.meta.url),
);
const SKILL_METADATA_SOURCE = fileURLToPath(
  new URL("../agent-skill/attend-visualize/agents/openai.yaml", import.meta.url),
);
const VIEWER_ASSETS = fileURLToPath(new URL("../viewer", import.meta.url));

const HELP = `Attend ${PACKAGE_VERSION}

Usage:
  attend bootstrap --yes [--timeout <minutes>] [--json]
  attend setup [--root <path>] [--agent <agents|claude>]... [--dry-run] [--json]
  attend model install [--timeout <minutes>] [--json]
  attend phrases <path...> --question <text> [options]
  attend families [--json]
  attend inspect <request.json> [--root <path>] [--json]
  attend checkpoint <request.json> [--root <path>] [--json]
  attend explore <request.json> [--root <path>] [--json]
  attend map <request.json> [--stage --exploration <id> [--experiment <id>]] [--root <path>] [--json]
  attend assess <experiment-id> <assessment.json> [--root <path>] [--json]
  attend promote <experiment-id> [--rationale <text>] [--root <path>] [--json]
  attend feedback <experiment-id> --kind <reason> [--note <text>] [--root <path>] [--json]
  attend workspace [exploration-id] [--open] [--root <path>] [--json]
  attend view [--root <path>] [--host <loopback>] [--port <number>] [--open] [--json]
  attend status [--root <path>] [--json]
  attend stop [--root <path>] [--json]
  attend chat route [local|host|codex|claude] [--root <path>] [--json]
  attend chat wait --ticket <host-ticket> [--timeout <seconds>] [--root <path>] [--json]
  attend chat rebind --take-over --ticket <new-host-ticket> --question-id <turn-id> --expected-revision <n> [--root <path>] [--json]
  attend mcp [--root <path>]
  attend context [--root <path>] [--include-excerpts] [--json]
  attend reply (--message <text>|--message-stdin) --expected-revision <n> --selection-id <id> [--question-id <turn-id>] [--ticket <host-ticket>] [options]
  attend doctor [--root <path>] [--adapter <codex|claude>] [--json]

Governed local visualization for a bundled ${CATALOG_COUNTS.families}-family Atlas catalog plus the
recurring-phrases shortcut. This release exposes ${CATALOG_COUNTS.executable} executable bundled members
and ${CATALOG_COUNTS.unavailable} explicit capability abstention, with fixed renderers and strict map
request contracts backed by exact quote evidence.
`;

const COMMAND_HELP = {
  bootstrap: `Usage: attend bootstrap --yes [--timeout <minutes>] [--root <path>] [--json]

Configure Attend in the current project, install the private gpt-oss-20b model
when the selected route requires it, and require every readiness check to pass.
The --yes flag authorizes the project writes and the roughly 12 GB model
download when it is needed. Bootstrap is safe to rerun.
`,
  setup: `Usage: attend setup [--root <path>] [--agent <agents|claude>]... [--dry-run] [--json]

Create project-scoped configuration, local-state exclusions, and the managed
attend-visualize agent skill. Setup is safe to rerun and refuses to overwrite
unmanaged files. Without --agent, setup installs both the .agents and .claude
skill copies.
`,
  model: `Usage: attend model install [--timeout <minutes>] [--json]

Download and load the fixed gpt-oss-20b model through llama.cpp. This is the
only Attend command that permits the model runtime to use the network. Normal
viewer inference starts llama.cpp in offline mode.
`,
  phrases: `Usage: attend phrases <path...> --question <text> [options]

Options:
  --target <text>          Plain-language name for the corpus
  --min-words <number>     Shortest phrase length (default: 2)
  --max-words <number>     Longest phrase length (default: 4)
  --min-count <number>     Required exact occurrences (default: 2)
  --min-sources <number>   Required distinct sources (default: 2)
  --limit <number>         Maximum ranked rows (default: 60)
  --max-file-bytes <n>     Per-file read ceiling (default: 2000000)
  --root <path>            Project root (normally detected from .git)
  --json                   Emit machine-readable output
`,
  families: `Usage: attend families [--json]

Emit the governed ${CATALOG_COUNTS.families}-family Family Atlas catalog: ${CATALOG_COUNTS.executable} executable bundled
members, ${CATALOG_COUNTS.unavailable} explicit capability abstention, and every documented or rejected
alternative.
`,
  inspect: `Usage: attend inspect <request.json> [--root <path>] [--json]

Read an explicitly scoped corpus and return deterministic, content-free shape
observations for hypothesis formation. Attend reports counts, ISO-date coverage,
omissions, and source hashes. It does not choose a representation or persist an
experiment.

Request: {"version":1,"goal":"...","sources":[{"path":"notes"}],
"options":{"maxFileBytes":2000000}}
`,
  checkpoint: `Usage: attend checkpoint <request.json> [--root <path>] [--json]

Record one content-free OpportunityCheck at an eligible natural task boundary.
The active agent supplies a strict self-report and chooses abstain or proceed;
Attend hashes the raw boundary id with a private project salt and stores only
the digest. This command does not call a model, inspect sources, choose a
family, create an exploration or session, change current.json, or open a page.
`,
  explore: `Usage: attend explore <request.json> [--root <path>] [--json]

Create one durable exploration and admit every listed hypothesis before any
result is seen. The request records analytic intent, source scope, baselines,
comparison counts, intended family/member pairs, and parent branches. Every
returned experiment must be staged; no admitted hypothesis may vanish.

A new version-1 request has goal, analyticIntent, sourceScope, optional
inspectionHash, checkpointId, and limits, plus experiments. A checkpointId
marks a proactive exploration and must name an immutable proceed receipt.
Each experiment has key,
hypothesis, whyUseful, representation {family, member}, sourceScope, baseline
{name, description}, comparisonCount, origin, analysisMode, and timing. Use
parentKey for an earlier experiment in the request. To extend an exploration,
send explorationId and experiments without redefining its other fields.
`,
  map: `Usage: attend map <request.json> [--stage --exploration <id> [--experiment <id>]] [--root <path>] [--json]

Validate a strict Family Atlas map request, re-read and verify exact source
quotes inside the trusted project root, compile a canonical atlas-v2 package,
persist its public package and private evidence, create or reuse a session, and
update current.json last. With --stage, bind the attempt to its pre-result
experiment record and leave current.json unchanged. If --experiment is omitted,
the request must match exactly one queued experiment in the exploration.
`,
  assess: `Usage: attend assess <experiment-id> <assessment.json> [--root <path>] [--json]

Record what surfaced after an attempt, its outcome and evidence strength, an
inspectable eight-part interestingness vector, transformations, omissions, and
limitations. Assessment never promotes a result or rewrites its hypothesis.

The JSON object requires outcome, summary, rationale, evidenceStrength,
interestingness, transformations, omissions, and limitations. Interestingness
requires taskRelevance, evidenceSufficiency, surprise, novelty, actionability,
representationalDiversity, uncertainty, and interruptionCost scores from 0 to 1.
`,
  promote: `Usage: attend promote <experiment-id> [--rationale <text>] [--root <path>] [--json]

Record that the agent believes a completed experiment is worth attention. A
promotion changes workspace ordering and makes its artifact current; it never
copies the experiment or turns an exploratory result into truth.
`,
  feedback: `Usage: attend feedback <experiment-id> --kind <reason> [--note <text>] [--root <path>] [--json]

Append explicit project-local feedback. Reasons are useful, already-known,
wrong-question, wrong-data, wrong-representation, weak-evidence, misleading,
badly-timed, dismissed, or acted-upon. Feedback can guide later admission and
ordering when a person or future learner explicitly uses it; this release does
not learn automatically, and feedback never changes evidence validity.
`,
  workspace: `Usage: attend workspace [exploration-id] [--open] [--root <path>] [--json]

Start or reuse Attend's loopback service and open one canonical experiment
inbox. With no id, the newest exploration is selected. Filters and ordering
change the view of records; they never create promoted-result copies.
`,
  view: `Usage: attend view [--root <path>] [--host <loopback>] [--port <number>] [--open] [--json]

Start or reuse the project's detached, loopback-only Attend library. The
command exits after the service is healthy. Port 0 asks the operating system
for an available port on first start; the chosen URL is preserved afterward.

Options:
  --host <loopback>       Loopback bind name/address (default: 127.0.0.1)
  --port <number>         First-start port, or 0 for an available port
  --open                  Open the current visualization
  --root <path>           Project root (normally detected from .git)
  --json                  Emit machine-readable output
`,
  status: `Usage: attend status [--root <path>] [--json]

Report whether this project's detached local Attend library is running.
`,
  stop: `Usage: attend stop [--root <path>] [--json]

Stop this project's verified local Attend library without discarding its
stable URL configuration or analysis sessions.
`,
  chat: `Usage:
  attend chat route [local|host|codex|claude] [--root <path>] [--json]
  attend chat wait --ticket <host-ticket> [--timeout <seconds>] [--root <path>] [--json]
  attend chat rebind --take-over --ticket <new-host-ticket> --question-id <turn-id> --expected-revision <n> [--root <path>] [--json]

Private gpt-oss-20b inference is the default. The Attend service owns the model
worker, durable question queue, and viewer, so an unbound library URL can chat.

\`chat route host\` returns a private ticket to the coding agent that opened
the visualization. While that agent is
active, \`chat wait\` returns one bounded, verified question packet without
claiming it. A timeout leaves the question queued.

If a queued question belongs to an earlier host attachment, \`attend view
--json\` reports an explicit \`chat rebind --take-over\` recovery command.
Takeover may revoke an earlier coding agent, so it requires user authorization.
It changes only that queued question and never captures detached work.

\`chat route codex\` and \`chat route claude\` explicitly select an isolated
detached fallback for future questions. Attend never falls back automatically.
`,
  mcp: `Usage: attend mcp [--root <path>]

Run the host-attached wait/reply bridge as a newline-delimited JSON-RPC MCP
server over stdio. The process is fixed to the detected project root and
exposes attend_wait_for_question, attend_rebind_question, and attend_reply.
`,
  context: `Usage: attend context [--root <path>] [--include-excerpts] [--json]

Read the current visualization and the oldest unanswered sidebar question
across every saved visualization in this project. A pending question carries
its owning session, current owning-session revision, and exact historical
selection. Excerpts are omitted by default because command output read by a
hosted agent follows that agent's configured provider route.

Options:
  --include-excerpts       Include selected note excerpts in the output
  --root <path>            Project root (normally detected from .git)
  --json                   Emit machine-readable output
`,
  reply: `Usage: attend reply (--message <text>|--message-stdin) --expected-revision <n> --selection-id <id> [--question-id <turn-id>] [--ticket <host-ticket>] [options]

Answer the oldest pending sidebar question, or mirror a host-chat answer, only
if the exact context returned by \`attend context --json\` is still current.

Options:
  --message <text>         Short manually entered answer
  --message-stdin          Read the answer from stdin, bounded to 64 KiB
  --expected-revision <n>  pendingQuestion.viewState.revision when answering;
                           otherwise the current top-level viewState.revision
  --selection-id <id>      Pending-question selection id, or current selection id
  --question-id <turn-id>  pendingQuestion.id to answer and link explicitly
  --ticket <host-ticket>   Required for a host-routed browser question
  --root <path>            Project root (normally detected from .git)
  --json                   Emit machine-readable output
`,
  doctor: `Usage: attend doctor [--root <path>] [--adapter <codex|claude>] [--json]

Check the runtime, project setup, current analysis/session, installed skill,
packaged viewer assets, host bridge, selected chat route, and optional detached
provider capability. Core readiness never requires Codex or Claude.
`,
};

function output(stream, value) {
  stream.write(`${value}\n`);
}

function jsonOutput(stream, value) {
  output(stream, JSON.stringify(value));
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function boundedStdinText(input, maximumBytes = 64 * 1024) {
  if (!input || typeof input[Symbol.asyncIterator] !== "function") {
    throw new TypeError("stdin must be a readable stream");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk, "utf8")
      : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBytes) {
      throw new Error(`--message-stdin must not exceed ${maximumBytes} bytes`);
    }
    chunks.push(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("--message-stdin must contain valid UTF-8 text");
  }
}

function positiveInteger(name, raw, fallback, { allowZero = false } = {}) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return value;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function detectedRoot(cwd, explicit) {
  if (explicit) return resolve(cwd, explicit);
  let candidate = resolve(cwd);
  while (true) {
    if (await exists(join(candidate, ".attend", "project.json"))) return candidate;
    if (await exists(join(candidate, ".git"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return resolve(cwd);
    candidate = parent;
  }
}

function parse(command, args, options) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      root: { type: "string" },
      json: { type: "boolean" },
      ...options,
    },
  });
  if (parsed.values.help) return { help: COMMAND_HELP[command] };
  return parsed;
}

function analysisPaths(root, analysisId) {
  const local = projectPaths(root).local;
  return {
    analyses: join(local, "analyses"),
    analysis: analysisId ? join(local, "analyses", `${analysisId}.json`) : null,
    current: join(local, "current.json"),
  };
}

function selectionNoun(selection) {
  return selection.artifactKind === "atlas-v2" ? "mark" : "phrase";
}

function selectionLabel(mark) {
  return typeof mark.phrase === "string"
    ? `“${mark.phrase}”`
    : typeof mark.label === "string"
      ? `${mark.kind ?? "mark"} “${mark.label}”`
      : mark.id;
}

async function requireSetup(root) {
  const paths = projectPaths(root);
  if (!(await exists(paths.project))) {
    throw new Error(`Attend is not set up at ${root}. Run \`attend setup\` first.`);
  }
  return paths;
}

async function currentSession(root) {
  await requireSetup(root);
  const pointer = await readJson(analysisPaths(root).current).catch((error) => {
    if (error?.code === "ENOENT") {
      const missing = new Error("No current analysis. Run `attend phrases <paths...>` first.");
      missing.code = "NO_CURRENT_ANALYSIS";
      throw missing;
    }
    throw error;
  });
  const sessionId = pointer.sessionId || pointer.analysisId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("The current Attend analysis pointer is invalid.");
  }
  return loadSession({ root, sessionId });
}

async function reconcileSetupService(root) {
  const before = await serviceStatus({ root });
  if (before.running) {
    return {
      status: "current",
      instanceId: before.instanceId,
      protocolVersion: before.health?.protocolVersion ?? null,
      packageVersion: before.health?.packageVersion ?? null,
    };
  }
  if (
    before.state === "stale" &&
    (before.pidAlive || before.verifiedStale)
  ) {
    const from = {
      protocolVersion: before.staleHealth?.protocolVersion ?? null,
      packageVersion: before.staleHealth?.packageVersion ?? null,
    };
    const upgraded = await startService({ root });
    return {
      status: "upgraded",
      from,
      instanceId: upgraded.instanceId,
      protocolVersion: upgraded.health?.protocolVersion ?? null,
      packageVersion: upgraded.health?.packageVersion ?? null,
    };
  }
  return {
    status: "stopped",
    configured: before.configured,
    staleRuntime: before.state === "stale",
  };
}

async function configureProject(root, { dryRun = false, agents = SKILL_TARGET_IDS } = {}) {
  const result = await setupProject({
    root,
    dryRun,
    skillSource: SKILL_SOURCE,
    skillMetadataSource: SKILL_METADATA_SOURCE,
    agents,
  });
  result.serviceMigration = result.dryRun
    ? { status: "not-run", reason: "dry-run" }
    : await reconcileSetupService(root);
  return result;
}

async function bootstrapCommand(args, context) {
  const parsed = parse("bootstrap", args, {
    yes: { type: "boolean" },
    timeout: { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("bootstrap does not accept positional arguments");
  if (parsed.values.yes !== true) {
    throw new Error(
      "bootstrap requires --yes to authorize project setup and the roughly 12 GB model download when needed",
    );
  }

  const root = await detectedRoot(context.cwd, parsed.values.root);
  const timeoutMinutes = positiveInteger("--timeout", parsed.values.timeout, 120);
  const setup = await configureProject(root);
  const before = await doctorReport(root);
  let model;
  if (before.readiness.localModel.required && !before.readiness.localModel.ready) {
    if (!parsed.values.json) {
      output(
        context.stdout,
        `Installing ${LOCAL_MODEL.id}. The model download is about 12 GB and may take a while.`,
      );
    }
    const installed = await installLocalModel(root, {
      timeoutMinutes,
      createRunner: context.modelDependencies?.createRunner ?? createLlamaCppModelRunner,
    });
    model = {
      status: "installed",
      receipt: installed.model,
      capability: installed.capability,
    };
  } else {
    model = {
      status: before.readiness.localModel.required ? "already-ready" : "not-required",
    };
  }

  const doctor = model.status === "installed" ? await doctorReport(root) : before;
  if (!doctor.ok) {
    const failed = doctor.checks
      .filter((check) => check.status === "fail")
      .map((check) => check.id);
    throw new Error(
      `Attend bootstrap failed readiness checks${failed.length ? `: ${failed.join(", ")}` : ""}`,
    );
  }
  const catalog = catalogResult();
  const result = {
    ok: true,
    packageVersion: PACKAGE_VERSION,
    root,
    setup: { ok: true, ...setup },
    model,
    doctor,
    catalog: {
      catalogVersion: catalog.catalogVersion,
      counts: catalog.counts,
    },
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(context.stdout, `Attend ${PACKAGE_VERSION} is configured at ${root}.`);
  output(
    context.stdout,
    model.status === "installed"
      ? `${LOCAL_MODEL.id} is installed and ready for private local chat.`
      : model.status === "already-ready"
        ? `${LOCAL_MODEL.id} was already ready.`
        : "The selected chat route does not require the local model.",
  );
  output(
    context.stdout,
    `Catalog ${catalog.catalogVersion}: ${catalog.counts.families} families, ${catalog.counts.executable} executable, ${catalog.counts.unavailable} unavailable.`,
  );
  output(context.stdout, "Attend is ready.");
}

async function setupCommand(args, context) {
  const parsed = parse("setup", args, {
    "dry-run": { type: "boolean" },
    agent: { type: "string", multiple: true },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("setup does not accept positional arguments");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  const result = await configureProject(root, {
    dryRun: parsed.values["dry-run"] || false,
    agents: parsed.values.agent ?? SKILL_TARGET_IDS,
  });
  if (parsed.values.json) return jsonOutput(context.stdout, { ok: true, ...result });

  const changed = [...result.created, ...result.updated];
  output(
    context.stdout,
    result.dryRun
      ? `Attend would change ${result.planned.filter((item) => item.action !== "unchanged").length} file(s) in ${root}.`
      : changed.length
        ? `Attend is set up in ${root}. Changed ${changed.length} file(s).`
        : `Attend is already set up in ${root}; nothing changed.`,
  );
  for (const item of result.planned) output(context.stdout, `  ${item.action.padEnd(9)} ${item.path}`);
  if (result.serviceMigration.status === "upgraded") {
    output(
      context.stdout,
      `Upgraded the running Attend service to ${result.serviceMigration.packageVersion}.`,
    );
  }
}

async function installLocalModel(root, { timeoutMinutes, createRunner }) {
  await requireSetup(root);
  const runner = createRunner({
    allowDownload: true,
    startupTimeoutMs: timeoutMinutes * 60 * 1_000,
  });
  let installed;
  try {
    installed = await runner.start();
  } finally {
    await runner.close().catch(() => {});
  }
  if (
    installed?.available !== true ||
    installed.authenticated !== true ||
    installed.model !== LOCAL_MODEL.id ||
    installed.runtime !== LOCAL_MODEL.runtime ||
    installed.privacy !== "local-only"
  ) {
    throw new Error(`llama.cpp did not report ${LOCAL_MODEL.id} ready for private local inference`);
  }
  const receipt = {
    schemaVersion: 1,
    model: LOCAL_MODEL.id,
    repository: LOCAL_MODEL.repository,
    file: LOCAL_MODEL.file,
    runtime: LOCAL_MODEL.runtime,
    installedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(projectPaths(root).local, "model.json"), receipt, { root });
  return { ok: true, root, model: receipt, capability: installed };
}

async function modelCommand(args, context) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return output(context.stdout, COMMAND_HELP.model.trimEnd());
  }
  if (subcommand !== "install") {
    throw new Error(`Unknown model command: ${subcommand}. Run \`attend model --help\`.`);
  }
  const parsed = parse("model", rest, { timeout: { type: "string" } });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("model install does not accept positional arguments");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  const timeoutMinutes = positiveInteger("--timeout", parsed.values.timeout, 120);
  const createRunner = context.modelDependencies?.createRunner ?? createLlamaCppModelRunner;
  if (!parsed.values.json) {
    output(
      context.stdout,
      `Installing ${LOCAL_MODEL.id}. The model download is about 12 GB and may take a while.`,
    );
  }
  const result = await installLocalModel(root, { timeoutMinutes, createRunner });
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(context.stdout, `${LOCAL_MODEL.id} is installed and ready for private local chat.`);
}

function catalogResult() {
  return {
    ok: true,
    catalogVersion: CATALOG_VERSION,
    counts: CATALOG_COUNTS,
    families: listCatalogFamilies(),
  };
}

async function familiesCommand(args, context) {
  const parsed = parse("families", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("families does not accept positional arguments");
  const result = catalogResult();
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(
    context.stdout,
    `Catalog ${CATALOG_VERSION}: ${CATALOG_COUNTS.families} families, ${CATALOG_COUNTS.executable} executable, ${CATALOG_COUNTS.documented} documented, ${CATALOG_COUNTS.rejected} rejected.`,
  );
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectRequestKeys(value, allowed, label) {
  if (!plainObject(value)) throw new Error(`${label} must be a JSON object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${label} has unknown field ${unexpected[0]}`);
}

async function inspectCommand(args, context) {
  const parsed = parse("inspect", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length !== 1) throw new Error("inspect requires exactly one request.json path");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const inspection = await inspectSources({
    root,
    request: await readJson(resolve(context.cwd, parsed.positionals[0])),
  });
  const inspectionPath = join(
    projectPaths(root).local,
    "inspections",
    `${inspection.inspectionHash}.json`,
  );
  await writeJsonAtomic(inspectionPath, inspection, { root });
  const result = { ok: true, ...inspection, inspectionPath };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(
    context.stdout,
    `Inspected ${inspection.summary.sourceCount} source${inspection.summary.sourceCount === 1 ? "" : "s"} without returning source text.`,
  );
  output(context.stdout, `Inspection ${inspection.inspectionHash}`);
}

async function verifiedInspection(root, plan) {
  if (!plan.inspectionHash) return null;
  const path = join(
    projectPaths(root).local,
    "inspections",
    `${plan.inspectionHash}.json`,
  );
  const inspection = await readJson(path).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`inspection receipt not found: ${plan.inspectionHash}`);
    }
    throw error;
  });
  const { inspectionHash, ...receipt } = inspection ?? {};
  if (
    inspectionHash !== plan.inspectionHash
    || inspection?.kind !== "attend-inspection"
    || sha256Text(JSON.stringify(receipt)) !== plan.inspectionHash
  ) {
    throw new Error(`inspection receipt is invalid: ${plan.inspectionHash}`);
  }
  if (sourceScopeSignature(inspection.sourceScope) !== sourceScopeSignature(plan.sourceScope)) {
    throw new Error("exploration source scope must match its inspection receipt");
  }
  return inspection;
}

function normalizeCheckpointRequest(request) {
  rejectRequestKeys(request, new Set([
    "version",
    "boundary",
    "host",
    "taskShape",
    "sourceShape",
    "decision",
    "inspectionHash",
  ]), "checkpoint request");
  if (request.version !== 1) throw new Error("checkpoint request version must be 1");
  const { version: _version, ...storeRequest } = request;
  return storeRequest;
}

async function checkpointCommand(args, context) {
  const parsed = parse("checkpoint", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length !== 1) {
    throw new Error("checkpoint requires exactly one request.json path");
  }
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const checkpoint = await createOpportunityCheck({
    root,
    request: normalizeCheckpointRequest(
      await readJson(resolve(context.cwd, parsed.positionals[0])),
    ),
  });
  const result = {
    ok: true,
    checkpointId: checkpoint.id,
    decision: checkpoint.decision.kind,
    nextAction: checkpoint.decision.kind === "proceed"
      ? "create a linked exploration with this checkpointId"
      : "continue without mentioning Attend",
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(context.stdout, `${checkpoint.id}: ${checkpoint.decision.kind}`);
}

function normalizeExplorationRequest(request) {
  rejectRequestKeys(request, new Set([
    "version",
    "explorationId",
    "goal",
    "analyticIntent",
    "sourceScope",
    "inspectionHash",
    "checkpointId",
    "limits",
    "experiments",
  ]), "exploration request");
  if (request.version !== 1) throw new Error("exploration request version must be 1");
  if (!Array.isArray(request.experiments) || request.experiments.length === 0) {
    throw new Error("exploration request must admit at least one experiment");
  }
  const appending = request.explorationId !== undefined;
  if (appending) {
    const unexpectedPlanField = [
      "goal",
      "analyticIntent",
      "sourceScope",
      "inspectionHash",
      "checkpointId",
      "limits",
    ].find((key) => request[key] !== undefined);
    if (unexpectedPlanField) {
      throw new Error(`an existing exploration cannot redefine ${unexpectedPlanField}`);
    }
  }
  const explorationPlan = appending ? null : validateExplorationPlan({
    goal: request.goal,
    analyticIntent: request.analyticIntent,
    sourceScope: request.sourceScope,
    ...(request.inspectionHash === undefined ? {} : { inspectionHash: request.inspectionHash }),
    ...(request.checkpointId === undefined ? {} : { checkpointId: request.checkpointId }),
    ...(request.limits === undefined ? {} : { limits: request.limits }),
  });
  const experiments = request.experiments.map((candidate, index) => {
    rejectRequestKeys(candidate, new Set([
      "key",
      "hypothesis",
      "whyUseful",
      "representation",
      "sourceScope",
      "baseline",
      "comparisonCount",
      "origin",
      "analysisMode",
      "timing",
      "parentExperimentId",
      "parentKey",
    ]), `exploration request experiments[${index}]`);
    if (candidate.parentKey !== undefined && candidate.parentExperimentId !== undefined) {
      throw new Error(`exploration request experiments[${index}] cannot name both parentKey and parentExperimentId`);
    }
    const { parentKey, ...plan } = candidate;
    return {
      plan: validateExperimentPlan(plan),
      ...(parentKey === undefined ? {} : { parentKey: String(parentKey) }),
    };
  });
  return {
    appending,
    explorationId: request.explorationId,
    explorationPlan,
    experiments,
  };
}

async function exploreCommand(args, context) {
  const parsed = parse("explore", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length !== 1) throw new Error("explore requires exactly one request.json path");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const request = normalizeExplorationRequest(
    await readJson(resolve(context.cwd, parsed.positionals[0])),
  );
  if (!request.appending) await verifiedInspection(root, request.explorationPlan);
  let exploration = request.appending
    ? await loadExploration({ root, explorationId: request.explorationId })
    : null;
  if (!request.appending && request.explorationPlan.checkpointId !== undefined) {
    const linkedId = explorationIdForCheckpoint(request.explorationPlan.checkpointId);
    exploration = await loadExploration({ root, explorationId: linkedId }).catch((error) => {
      if (error?.code === "EXPLORATION_NOT_FOUND") return null;
      throw error;
    });
  }
  const explorationExisted = exploration !== null;
  const existing = exploration === null
    ? []
    : await listExperiments({ root, explorationId: exploration.id });
  const linkedRetry = !request.appending
    && request.explorationPlan.checkpointId !== undefined
    && existing.length > 0;
  const knownByKey = new Map(existing.map((experiment) => [experiment.key, experiment]));
  const knownById = new Map(existing.map((experiment) => [experiment.id, experiment]));
  const requestKeys = new Set();
  for (const candidate of request.experiments) {
    if (requestKeys.has(candidate.plan.key)) {
      throw new Error(`exploration request repeats experiment key: ${candidate.plan.key}`);
    }
    requestKeys.add(candidate.plan.key);
    if (knownByKey.has(candidate.plan.key) && !linkedRetry) {
      throw new Error(`experiment key already exists: ${candidate.plan.key}`);
    }
    if (candidate.parentKey !== undefined && !knownByKey.has(candidate.parentKey)) {
      throw new Error(`parentKey must name an earlier or existing experiment: ${candidate.parentKey}`);
    }
    if (
      candidate.plan.parentExperimentId !== undefined
      && !knownById.has(candidate.plan.parentExperimentId)
    ) {
      throw new Error(
        `parentExperimentId must name an experiment in this exploration: ${candidate.plan.parentExperimentId}`,
      );
    }
    if (!knownByKey.has(candidate.plan.key)) knownByKey.set(candidate.plan.key, null);
  }
  const limits = exploration?.limits ?? request.explorationPlan?.limits;
  const newCandidates = request.experiments.filter(
    (candidate) => !existing.some((experiment) => experiment.key === candidate.plan.key),
  );
  if (limits?.maxExperiments && existing.length + newCandidates.length > limits.maxExperiments) {
    throw new Error(`exploration admits at most ${limits.maxExperiments} experiments`);
  }
  const comparisonTotal = [...existing, ...newCandidates.map((candidate) => candidate.plan)]
    .reduce((total, experiment) => total + experiment.comparisonCount, 0);
  if (limits?.maxComparisons && comparisonTotal > limits.maxComparisons) {
    throw new Error(`exploration admits at most ${limits.maxComparisons} comparisons`);
  }
  if (!request.appending) {
    exploration = await createExploration({ root, plan: request.explorationPlan });
  }
  const admitted = [];
  const admittedByKey = new Map(existing.map((experiment) => [experiment.key, experiment]));
  for (const candidate of request.experiments) {
    const parent = candidate.parentKey === undefined
      ? null
      : admittedByKey.get(candidate.parentKey);
    const desiredPlan = {
      ...candidate.plan,
      ...(parent === null || parent === undefined
        ? {}
        : { parentExperimentId: parent.id }),
    };
    let experiment = admittedByKey.get(candidate.plan.key);
    if (experiment) {
      const storedPlan = validateExperimentPlan({
        key: experiment.key,
        hypothesis: experiment.hypothesis,
        whyUseful: experiment.whyUseful,
        representation: experiment.representation,
        sourceScope: experiment.sourceScope,
        baseline: experiment.baseline,
        comparisonCount: experiment.comparisonCount,
        origin: experiment.origin,
        analysisMode: experiment.analysisMode,
        timing: experiment.timing,
        ...(experiment.parentExperimentId === undefined
          ? {}
          : { parentExperimentId: experiment.parentExperimentId }),
      });
      if (JSON.stringify(storedPlan) !== JSON.stringify(desiredPlan)) {
        throw new Error(
          `checkpoint retry conflicts with existing experiment plan: ${candidate.plan.key}`,
        );
      }
    } else {
      experiment = await createExperiment({
        root,
        explorationId: exploration.id,
        plan: desiredPlan,
      });
    }
    admitted.push(experiment);
    admittedByKey.set(experiment.key, experiment);
  }
  const result = {
    ok: true,
    explorationId: exploration.id,
    created: !request.appending && !explorationExisted,
    admittedCount: admitted.length,
    experiments: admitted,
    next: admitted.map((experiment) =>
      `attend map <request.json> --stage --exploration ${exploration.id} --experiment ${experiment.id} --json`),
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(
    context.stdout,
    `Admitted ${admitted.length} experiment${admitted.length === 1 ? "" : "s"} to ${exploration.id}.`,
  );
  output(context.stdout, "Stage every admitted experiment; failed and null attempts remain in the inbox.");
}

async function phrasesCommand(args, context) {
  const parsed = parse("phrases", args, {
    question: { type: "string" },
    target: { type: "string" },
    "min-words": { type: "string" },
    "max-words": { type: "string" },
    "min-count": { type: "string" },
    "min-sources": { type: "string" },
    limit: { type: "string" },
    "max-file-bytes": { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (!parsed.positionals.length) throw new Error("phrases requires at least one input path");
  if (!parsed.values.question?.trim()) throw new Error("phrases requires --question <text>");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);

  const { dataPackage, evidenceStore } = await analyzePhrasesWithEvidence({
    root,
    inputPaths: parsed.positionals,
    question: parsed.values.question,
    target: parsed.values.target || "",
    minWords: positiveInteger("--min-words", parsed.values["min-words"], 2),
    maxWords: positiveInteger("--max-words", parsed.values["max-words"], 4),
    minCount: positiveInteger("--min-count", parsed.values["min-count"], 2),
    minSources: positiveInteger("--min-sources", parsed.values["min-sources"], 2),
    limit: positiveInteger("--limit", parsed.values.limit, 60),
    maxFileBytes: positiveInteger(
      "--max-file-bytes",
      parsed.values["max-file-bytes"],
      2_000_000,
    ),
  });

  const paths = analysisPaths(root, dataPackage.id);
  await writeJsonAtomic(paths.analysis, dataPackage);
  await writeEvidenceStore({ root, dataPackage, evidenceStore });

  let session;
  try {
    session = await createSession({ root, id: dataPackage.id, dataPackage });
  } catch (error) {
    if (error?.code !== "SESSION_EXISTS") throw error;
    session = await loadSession({ root, sessionId: dataPackage.id });
  }
  await writeJsonAtomic(paths.current, {
    schemaVersion: 1,
    analysisId: dataPackage.id,
    sessionId: session.id,
    dataHash: dataPackage.hashes.data,
  });

  const result = {
    ok: true,
    analysisId: dataPackage.id,
    sessionId: session.id,
    dataHash: dataPackage.hashes.data,
    corpusHash: dataPackage.hashes.corpus,
    phraseCount: dataPackage.rows.length,
    sourceCount: dataPackage.sources.length,
    skippedInputCount: dataPackage.knownOmissions.filter(
      (omission) => omission.skipped === true,
    ).length,
    analysisPath: paths.analysis,
    next: "attend view",
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(
    context.stdout,
    `Found ${result.phraseCount} recurring phrase${result.phraseCount === 1 ? "" : "s"} across ${result.sourceCount} source${result.sourceCount === 1 ? "" : "s"}.`,
  );
  if (result.skippedInputCount) {
    output(
      context.stdout,
      `Skipped ${result.skippedInputCount} input${result.skippedInputCount === 1 ? "" : "s"}; inspect knownOmissions in the analysis for exact paths and reasons.`,
    );
  }
  output(context.stdout, `Analysis: ${paths.analysis}`);
  output(context.stdout, "Next: attend view");
}

function sourceScopeSignature(sources) {
  return (Array.isArray(sources) ? sources : [])
    .map((source) => `${source.path}\u0000${source.textProjection ?? "utf8"}`)
    .sort()
    .join("\u0001");
}

function experimentMatchesMapRequest(experiment, request) {
  return experiment.representation.family === request.family
    && experiment.representation.member === request.member
    && sourceScopeSignature(experiment.sourceScope) === sourceScopeSignature(request.sources);
}

async function stagedExperimentFor({ root, explorationId, experimentId, request }) {
  await loadExploration({ root, explorationId });
  if (experimentId !== undefined) {
    const experiment = await loadExperiment({ root, experimentId });
    if (experiment.explorationId !== explorationId) {
      throw new Error(`experiment ${experimentId} does not belong to ${explorationId}`);
    }
    if (!experimentMatchesMapRequest(experiment, request)) {
      throw new Error("staged map family, member, and source scope must match the pre-result experiment plan");
    }
    const state = await publicExperiment({ root, experimentId });
    if (state.execution === "completed") {
      throw new Error(`experiment ${experimentId} is already completed`);
    }
    if (state.execution === "failed") {
      throw new Error(`experiment ${experimentId} already failed; admit a child experiment for a revised test`);
    }
    return experiment;
  }
  const candidates = [];
  for (const experiment of await listExperiments({ root, explorationId })) {
    const projected = await publicExperiment({ root, experimentId: experiment.id });
    if (projected.execution === "queued" && experimentMatchesMapRequest(experiment, request)) {
      candidates.push(experiment);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `staged map matched ${candidates.length} queued experiments; pass --experiment with the exact id`,
    );
  }
  return candidates[0];
}

function publicExecutionFailure(error, fallbackCode, message) {
  const candidate = typeof error?.code === "string" ? error.code : "";
  return {
    code: /^[A-Z][A-Z0-9_]{0,127}$/u.test(candidate) ? candidate : fallbackCode,
    message,
  };
}

async function mapCommand(args, context) {
  const parsed = parse("map", args, {
    stage: { type: "boolean" },
    exploration: { type: "string" },
    experiment: { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length !== 1) throw new Error("map requires exactly one request.json path");
  if (parsed.values.stage !== true && (parsed.values.exploration || parsed.values.experiment)) {
    throw new Error("--exploration and --experiment require --stage");
  }
  if (parsed.values.stage === true && !parsed.values.exploration) {
    throw new Error("--stage requires --exploration <id>");
  }
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const request = await readJson(resolve(context.cwd, parsed.positionals[0]));
  let staged = parsed.values.stage === true
    ? await stagedExperimentFor({
        root,
        explorationId: parsed.values.exploration,
        experimentId: parsed.values.experiment,
        request,
      })
    : null;
  const execute = async () => {
    if (staged) {
      await appendExperimentEvent({
        root,
        experimentId: staged.id,
        kind: "execution-started",
        payload: {},
        actor: "agent",
        idempotencyKey: "execution-v1-started",
      });
    }

    let compiled;
    try {
      compiled = await compileCatalogMapRequest({ root, request });
      const paths = analysisPaths(root, compiled.dataPackage.id);
      await writeJsonAtomic(paths.analysis, compiled.dataPackage);
      await writeEvidenceStore({
        root,
        dataPackage: compiled.dataPackage,
        evidenceStore: compiled.evidenceStore,
      });
    } catch (error) {
      if (staged) {
        await appendExperimentEvent({
          root,
          experimentId: staged.id,
          kind: "execution-failed",
          payload: publicExecutionFailure(
            error,
            "MAP_EXECUTION_FAILED",
            "The staged map request did not pass Attend's compiler. Re-run the command for private diagnostics.",
          ),
          actor: "agent",
        }).catch(() => {});
      }
      throw error;
    }
    const { dataPackage, family, member } = compiled;
    const paths = analysisPaths(root, dataPackage.id);

    let session;
    const sessionId = staged?.id ?? dataPackage.id;
    try {
      try {
        session = await createSession({
          root,
          id: sessionId,
          dataPackage,
          ...(staged === null ? {} : {
            exploration: {
              explorationId: staged.explorationId,
              experimentId: staged.id,
            },
          }),
        });
      } catch (error) {
        if (error?.code !== "SESSION_EXISTS") throw error;
        session = await loadSession({ root, sessionId });
        if (
          staged
          && (
            session.exploration?.explorationId !== staged.explorationId
            || session.exploration?.experimentId !== staged.id
            || session.dataPackage?.hashes?.data !== dataPackage.hashes.data
          )
        ) {
          const conflict = new Error(`staged session ${sessionId} already exists with different provenance`);
          conflict.code = "STAGED_SESSION_CONFLICT";
          throw conflict;
        }
      }
    } catch (error) {
      if (staged) {
        await appendExperimentEvent({
          root,
          experimentId: staged.id,
          kind: "execution-failed",
          payload: publicExecutionFailure(
            error,
            "SESSION_EXECUTION_FAILED",
            "Attend could not create the staged render session. Re-run the command for private diagnostics.",
          ),
          actor: "agent",
        }).catch(() => {});
      }
      throw error;
    }
    if (staged) {
      await appendExperimentEvent({
        root,
        experimentId: staged.id,
        kind: "execution-completed",
        payload: {
          analysisId: dataPackage.id,
          sessionId: session.id,
          packageHash: dataPackage.hashes.data,
          comparisonCount: staged.comparisonCount,
        },
        actor: "agent",
        idempotencyKey: "execution-v1-completed",
      });
    } else {
      await writeJsonAtomic(paths.current, {
        schemaVersion: 1,
        analysisId: dataPackage.id,
        sessionId: session.id,
        dataHash: dataPackage.hashes.data,
      });
    }

    const result = {
      ok: true,
      analysisId: dataPackage.id,
      sessionId: session.id,
      catalogVersion: dataPackage.catalog.version,
      family: family.id,
      member: member.id,
      dataHash: dataPackage.hashes.data,
      corpusHash: dataPackage.hashes.corpus,
      markCount: dataPackage.marks.length,
      sourceCount: dataPackage.sources.length,
      analysisPath: paths.analysis,
      ...(staged === null ? {} : {
        explorationId: staged.explorationId,
        experimentId: staged.id,
        staged: true,
      }),
      next: staged === null
        ? "attend view"
        : `attend assess ${staged.id} <assessment.json> --json`,
    };
    if (parsed.values.json) return jsonOutput(context.stdout, result);
    output(
      context.stdout,
      `Compiled ${family.title} / ${member.name} into ${dataPackage.marks.length} evidence-backed mark${dataPackage.marks.length === 1 ? "" : "s"}.`,
    );
    output(context.stdout, `Analysis: ${paths.analysis}`);
    output(context.stdout, `Next: ${result.next}`);
  };

  if (staged === null) return execute();
  return withExperimentExecutionLock({
    root,
    experimentId: staged.id,
    operation: async () => {
      staged = await stagedExperimentFor({
        root,
        explorationId: parsed.values.exploration,
        experimentId: staged.id,
        request,
      });
      return execute();
    },
  });
}

async function assessCommand(args, context) {
  const parsed = parse("assess", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length !== 2) {
    throw new Error("assess requires an experiment id and one assessment.json path");
  }
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const [experimentId, assessmentPath] = parsed.positionals;
  const before = await publicExperiment({ root, experimentId });
  if (before.execution !== "completed" && before.execution !== "failed") {
    throw new Error(`experiment ${experimentId} must finish before it can be assessed`);
  }
  const event = await appendExperimentEvent({
    root,
    experimentId,
    kind: "assessment-recorded",
    payload: await readJson(resolve(context.cwd, assessmentPath)),
    actor: "agent",
  });
  const experiment = await publicExperiment({ root, experimentId });
  const result = { ok: true, eventId: event.id, experiment };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(context.stdout, `Assessed ${experimentId} as ${experiment.outcome}.`);
}

async function promoteCommand(args, context) {
  const parsed = parse("promote", args, {
    rationale: { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length !== 1) throw new Error("promote requires exactly one experiment id");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const experimentId = parsed.positionals[0];
  const before = await publicExperiment({ root, experimentId });
  if (before.execution !== "completed" || !before.result) {
    throw new Error(`experiment ${experimentId} has no completed artifact to promote`);
  }
  if (before.outcome !== "interesting") {
    throw new Error(`experiment ${experimentId} must be assessed as interesting before promotion`);
  }
  const rationale = parsed.values.rationale?.trim() || before.assessment?.rationale;
  if (!rationale) throw new Error("promote requires --rationale or a recorded assessment rationale");
  let eventId = null;
  if (!before.agentPromoted) {
    const event = await appendExperimentEvent({
      root,
      experimentId,
      kind: "agent-promoted",
      payload: { rationale },
      actor: "agent",
      idempotencyKey: "promotion-v1",
    });
    eventId = event.id;
  }
  await writeJsonAtomic(analysisPaths(root).current, {
    schemaVersion: 1,
    analysisId: before.result.analysisId,
    sessionId: before.result.sessionId,
    dataHash: before.result.packageHash,
  });
  const experiment = await publicExperiment({ root, experimentId });
  const result = {
    ok: true,
    eventId,
    alreadyPromoted: before.agentPromoted,
    experiment,
    next: `attend workspace ${experiment.explorationId} --open --json`,
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(
    context.stdout,
    before.agentPromoted
      ? `${experimentId} was already promoted; no duplicate record was created.`
      : `Promoted ${experimentId} without copying it.`,
  );
}

async function feedbackCommand(args, context) {
  const parsed = parse("feedback", args, {
    kind: { type: "string" },
    note: { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length !== 1) throw new Error("feedback requires exactly one experiment id");
  if (!parsed.values.kind) throw new Error("feedback requires --kind <reason>");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const experimentId = parsed.positionals[0];
  const kind = parsed.values.kind;
  const disposition = ["dismissed", "acted-upon"].includes(kind);
  if (!disposition && !FEEDBACK_KINDS.includes(kind)) {
    throw new Error(`feedback kind must be one of ${[...FEEDBACK_KINDS, "dismissed", "acted-upon"].join(", ")}`);
  }
  if (disposition && parsed.values.note !== undefined) {
    throw new Error("dismissed and acted-upon dispositions do not accept --note");
  }
  const note = parsed.values.note?.trim();
  if (!disposition && parsed.values.note !== undefined && !note) {
    throw new Error("feedback --note must be a non-empty string");
  }
  const eventKind = disposition ? "human-disposition-recorded" : "feedback-recorded";
  const payload = disposition
    ? { disposition: kind }
    : {
        kind,
        ...(note === undefined ? {} : { note }),
      };
  const before = await publicExperiment({ root, experimentId });
  const previous = [...before.events].reverse().find((candidate) =>
    candidate.kind === eventKind && candidate.actor === "human");
  const alreadyRecorded = previous !== undefined
    && JSON.stringify(previous.payload) === JSON.stringify(payload);
  const feedbackKey = sha256Text(JSON.stringify({
    eventKind,
    payload,
    predecessor: previous?.id ?? null,
  }));
  const event = await appendExperimentEvent({
    root,
    experimentId,
    kind: eventKind,
    payload,
    actor: "human",
    idempotencyKey: `cli-feedback-v1-${feedbackKey}`,
    expectedRevision: before.events.length,
    dedupeConsecutive: true,
  });
  const experiment = await publicExperiment({ root, experimentId });
  const result = {
    ok: true,
    eventId: event?.id ?? previous?.id ?? null,
    alreadyRecorded,
    experiment,
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(
    context.stdout,
    alreadyRecorded
      ? `${kind} was already the latest ${disposition ? "disposition" : "feedback"}; no duplicate record was created.`
      : `Recorded ${kind} for ${experimentId}.`,
  );
}

async function workspaceCommand(args, context) {
  const parsed = parse("workspace", args, {
    open: { type: "boolean" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length > 1) throw new Error("workspace accepts at most one exploration id");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  let exploration;
  if (parsed.positionals[0]) {
    exploration = await loadExploration({ root, explorationId: parsed.positionals[0] });
  } else {
    exploration = (await listExplorations({ root }))[0];
    if (!exploration) throw new Error("No exploration exists. Run `attend explore <request.json>` first.");
  }
  const startWorkspaceService = context.viewDependencies?.startService ?? startService;
  const openWorkspaceUrl = context.viewDependencies?.openUrl ?? openUrl;
  const service = await startWorkspaceService({ root });
  const workspaceUrl = new URL(`e/${encodeURIComponent(exploration.id)}/`, service.url).href;
  const result = {
    ok: true,
    explorationId: exploration.id,
    url: service.url,
    libraryUrl: service.url,
    workspaceUrl,
    serviceState: service.state,
    reused: service.reused,
    browser: { requested: parsed.values.open === true, opened: false },
  };
  if (parsed.values.open) {
    try {
      await openWorkspaceUrl(workspaceUrl, { root });
      result.browser.opened = true;
    } catch (error) {
      result.browser.errorCode = [
        "BROWSER_LAUNCHER_UNAVAILABLE",
        "BROWSER_LAUNCH_FAILED",
        "BROWSER_LAUNCH_TIMEOUT",
      ].includes(error?.code)
        ? error.code
        : "BROWSER_LAUNCH_FAILED";
      result.browser.warning = "The browser did not open automatically. Open workspaceUrl manually.";
    }
  }
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(context.stdout, `Experiment workspace ${workspaceUrl}`);
  if (result.browser.warning) output(context.stdout, result.browser.warning);
}

export async function openUrl(url, {
  root,
  platform = process.platform,
  env = process.env,
  spawnImpl = spawn,
  accessImpl = access,
  timeoutMs = 10_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("browser launcher timeout must be an integer between 1 and 60000");
  }
  const candidates = platform === "darwin"
    ? ["/usr/bin/open"]
    : platform === "win32"
      ? [join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")]
      : ["/usr/bin/xdg-open", "/bin/xdg-open"];
  let executable = null;
  for (const candidate of candidates) {
    try {
      await accessImpl(candidate, fsConstants.X_OK);
      executable = candidate;
      break;
    } catch {}
  }
  if (!executable) {
    const error = new Error(
      `Attend could not find a supported system browser launcher. Open ${url} manually.`,
    );
    error.code = "BROWSER_LAUNCHER_UNAVAILABLE";
    throw error;
  }
  const safeEnv = await trustedLauncherEnvironment({ root, env });
  const args = platform === "win32"
    ? ["/c", "start", "", url]
    : [url];
  await new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawnImpl(executable, args, {
      cwd: dirname(executable),
      detached: false,
      env: safeEnv,
      stdio: "ignore",
    });
    let timer;
    const finish = (operation) => {
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      operation();
    };
    const onError = (error) => {
      finish(() => rejectSpawn(error));
    };
    const onClose = (code, signal) => {
      if (code === 0) {
        finish(resolveSpawn);
        return;
      }
      const error = new Error(
        `Attend's system browser launcher failed${signal ? ` with signal ${signal}` : ` with status ${code}`}. Open ${url} manually.`,
      );
      error.code = "BROWSER_LAUNCH_FAILED";
      finish(() => rejectSpawn(error));
    };
    child.once("error", onError);
    child.once("close", onClose);
    timer = setTimeout(() => {
      child.kill?.("SIGTERM");
      const error = new Error(
        `Attend's system browser launcher did not finish within ${timeoutMs} ms. Open ${url} manually.`,
      );
      error.code = "BROWSER_LAUNCH_TIMEOUT";
      finish(() => rejectSpawn(error));
    }, timeoutMs);
  });
}

function detachedAdapterId(value, name = "adapter") {
  if (value === "codex" || value === "codex-cli") return "codex-cli";
  if (value === "claude" || value === "claude-cli") return "claude-cli";
  throw new Error(`${name} must be codex or claude`);
}

function configuredRouteFromName(value) {
  if (value === "local" || value === LOCAL_MODEL.id) {
    return { kind: "local", model: LOCAL_MODEL.id };
  }
  if (value === "host") return { kind: "host" };
  return { kind: "detached", adapter: detachedAdapterId(value, "chat route") };
}

async function hostRecoveryDescriptor({ root, session, chatAttachment }) {
  if (chatAttachment?.route?.kind !== "host" || !chatAttachment.ticket) return null;
  const turns = Array.isArray(session?.conversation)
    ? session.conversation
    : session?.conversation?.turns ?? [];
  const answered = new Set(
    turns
      .filter((turn) => turn?.role === "assistant" && turn.replyToTurnId)
      .map((turn) => turn.replyToTurnId),
  );
  const pending = turns.find((turn) =>
    turn?.role === "user" &&
    typeof turn.id === "string" &&
    !answered.has(turn.id) &&
    turn.response?.status === "queued" &&
    turn.response.route?.kind === "host");
  if (
    !pending ||
    sameChatRoute(pending.response.route, chatAttachment.route)
  ) {
    return null;
  }
  const expectedRevision = session.state.revision;
  const ownerStatus = await hostListenerStatus({
    root,
    route: pending.response.route,
    questionId: pending.id,
  });
  if (ownerStatus.phase === "waiting") {
    return Object.freeze({
      available: false,
      takeoverRequired: true,
      questionId: pending.id,
      expectedRevision,
      reason: "earlier-host-listening",
      warning:
        "The earlier coding agent is listening for this question. Do not take it over.",
    });
  }
  return Object.freeze({
    available: true,
    takeoverRequired: true,
    questionId: pending.id,
    expectedRevision,
    warning: ownerStatus.phase === "delivered"
      ? "This question was delivered to the earlier coding agent. Takeover revokes its reply guard; run it only with the user's approval."
      : "This explicitly revokes the queued question's earlier host attachment. Run it only with the user's approval.",
    command: `attend chat rebind --take-over --ticket ${chatAttachment.ticket} --question-id ${pending.id} --expected-revision ${expectedRevision} --json`,
  });
}

async function chatRouteCommand(args, context) {
  const parsed = parse("chat", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length > 1) {
    throw new Error("chat route accepts at most one of local, host, codex, or claude");
  }
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const requested = parsed.positionals[0];
  let stopped = false;
  if (requested !== undefined) {
    const route = configuredRouteFromName(requested);
    const changed = await changeServiceChatRoute({ root, route });
    stopped = changed.serviceStopped;
  }
  const route = await readChatRoute({ root });
  const result = {
    ok: true,
    route,
    default: route.kind === "local",
    explicitDetachedFallback: route.kind === "detached",
    serviceStoppedForRouteChange: stopped,
    nextStep: route.kind === "local"
      ? "Run `attend model install` once, then `attend view --json`."
      : route.kind === "host"
        ? "Run `attend view --json`, then wait with the returned host ticket."
        : `Run \`attend view --json\` to start the explicitly selected ${route.adapter} fallback.`,
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(
    context.stdout,
    route.kind === "local"
      ? `Chat route: private ${LOCAL_MODEL.id} on this Mac (default).`
      : route.kind === "host"
        ? "Chat route: host-attached coding agent."
        : `Chat route: detached fallback ${route.adapter}.`,
  );
  output(context.stdout, result.nextStep);
}

async function chatWaitCommand(args, context) {
  const parsed = parse("chat", args, {
    ticket: { type: "string" },
    timeout: { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("chat wait does not accept positional arguments");
  const ticket = parsed.values.ticket?.trim();
  if (!ticket) throw new Error("chat wait requires --ticket from `attend view --json`");
  const timeoutSeconds = positiveInteger(
    "--timeout",
    parsed.values.timeout,
    300,
    { allowZero: true },
  );
  if (timeoutSeconds > 600) throw new Error("--timeout must not exceed 600 seconds");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const packet = await waitForHostQuestion({
    root,
    ticket,
    timeoutMs: timeoutSeconds * 1_000,
  });
  if (!packet) {
    const result = { ok: true, event: "timeout", timeoutSeconds };
    if (parsed.values.json) return jsonOutput(context.stdout, result);
    return output(
      context.stdout,
      "No question arrived before the wait ended. Attend did not wake another agent or provider.",
    );
  }
  if (parsed.values.json) return jsonOutput(context.stdout, packet);
  output(context.stdout, `Question ${packet.replyGuard.questionId}: ${packet.question.content}`);
  output(
    context.stdout,
    `Reply with revision ${packet.replyGuard.expectedRevision} and selection ${packet.replyGuard.selectionId}.`,
  );
}

async function chatRebindCommand(args, context) {
  const parsed = parse("chat", args, {
    "take-over": { type: "boolean" },
    ticket: { type: "string" },
    "question-id": { type: "string" },
    "expected-revision": { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) {
    throw new Error("chat rebind does not accept positional arguments");
  }
  if (!parsed.values["take-over"]) {
    throw new Error(
      "chat rebind requires --take-over and explicit user approval because it revokes an earlier host attachment",
    );
  }
  const ticket = parsed.values.ticket?.trim();
  if (!ticket) {
    throw new Error("chat rebind requires --ticket from a replacement `attend view --json`");
  }
  const questionId = parsed.values["question-id"]?.trim();
  if (!questionId) {
    throw new Error("chat rebind requires --question-id from view.chat.recovery");
  }
  if (parsed.values["expected-revision"] === undefined) {
    throw new Error("chat rebind requires --expected-revision from view.chat.recovery");
  }
  const expectedRevision = positiveInteger(
    "--expected-revision",
    parsed.values["expected-revision"],
    undefined,
    { allowZero: true },
  );
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const rebound = await rebindHostQuestion({
    root,
    ticket,
    questionId,
    expectedRevision,
    confirmTakeover: true,
  });
  const result = {
    ok: true,
    event: "rebound",
    sessionId: rebound.session.id,
    questionId,
    stateRevision: rebound.session.state.revision,
    route: { kind: "host" },
    repeated: rebound.repeated === true,
    waitCommand: `attend chat wait --ticket ${ticket} --timeout 300 --json`,
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(
    context.stdout,
    result.repeated
      ? `Question ${questionId} is already attached to this coding agent.`
      : `Reattached queued question ${questionId} to this coding agent.`,
  );
  output(context.stdout, result.waitCommand);
}

async function chatCommand(args, context) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return output(context.stdout, COMMAND_HELP.chat.trimEnd());
  }
  if (subcommand === "route") return chatRouteCommand(rest, context);
  if (subcommand === "wait") return chatWaitCommand(rest, context);
  if (subcommand === "rebind") return chatRebindCommand(rest, context);
  throw new Error(`Unknown chat command: ${subcommand}. Run \`attend chat --help\`.`);
}

async function mcpCommand(args, context) {
  const parsed = parse("mcp", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("mcp does not accept positional arguments");
  if (parsed.values.json) throw new Error("mcp uses JSON-RPC over stdio and does not accept --json");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  return runAttendMcpStdio({
    root,
    input: context.stdin,
    output: context.stdout,
  });
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

function assertViewServiceUnchanged(started, current) {
  if (
    current?.running === true &&
    current.instanceId === started.instanceId &&
    current.pid === started.pid &&
    current.url === started.url &&
    sameServiceChat(current.chat, started.chat)
  ) {
    return;
  }
  const error = new Error(
    "Attend's service instance or chat route changed while the view was being attached. No view URL was returned; run `attend view` again.",
  );
  error.code = "SERVICE_CHANGED_DURING_VIEW";
  throw error;
}

async function viewCommand(args, context) {
  const parsed = parse("view", args, {
    port: { type: "string" },
    host: { type: "string" },
    open: { type: "boolean" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("view does not accept positional arguments yet");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  const initialSession = await currentSession(root);
  const startViewService = context.viewDependencies?.startService ?? startService;
  const registerViewHost =
    context.viewDependencies?.registerHostAttachment ?? registerHostAttachment;
  const viewServiceStatus = context.viewDependencies?.serviceStatus ?? serviceStatus;
  const openViewUrl = context.viewDependencies?.openUrl ?? openUrl;
  const service = await startViewService({
    root,
    host: parsed.values.host,
    port: parsed.values.port === undefined
      ? undefined
      : positiveInteger("--port", parsed.values.port, 0, { allowZero: true }),
  });
  let chatAttachment;
  if (
    service.chat?.defaultRoute === "local" &&
    service.chat.transport === "owned-local-model" &&
    service.chat.model === LOCAL_MODEL.id
  ) {
    chatAttachment = {
      route: { kind: "local", model: LOCAL_MODEL.id },
      ticket: null,
      attachment: null,
    };
  } else if (
    service.chat?.defaultRoute === "host" &&
    service.chat.transport === "host-bridge"
  ) {
    chatAttachment = await registerViewHost({
      root,
      sessionId: initialSession.id,
    });
  } else if (
    service.chat?.defaultRoute === "detached" &&
    service.chat.transport === "detached-adapter" &&
    (service.chat.adapter === "codex-cli" || service.chat.adapter === "claude-cli")
  ) {
    chatAttachment = {
      route: { kind: "detached", adapter: service.chat.adapter },
      ticket: null,
      attachment: null,
    };
  } else {
    throw new Error("Attend's running service did not report a supported chat route");
  }
  const session = await loadSession({
    root,
    sessionId: initialSession.id,
  });
  const currentService = await viewServiceStatus({ root });
  assertViewServiceUnchanged(service, currentService);
  const chatRecovery = await hostRecoveryDescriptor({
    root,
    session,
    chatAttachment,
  });
  const viewer = new URL(`s/${encodeURIComponent(session.id)}/`, service.url);
  if (chatAttachment.route.kind === "host") {
    viewer.hash = new URLSearchParams({
      "attend-host": chatAttachment.route.attachmentId,
      "attend-generation": String(chatAttachment.route.generation),
    }).toString();
  }
  const viewerUrl = viewer.href;

  const result = {
    ok: true,
    sessionId: session.id,
    dataPackageId: session.dataPackage.id,
    dataHash: session.dataPackage.hashes.data,
    url: service.url,
    libraryUrl: service.url,
    viewerUrl,
    serviceState: service.state,
    reused: service.reused,
    view: session.view,
    stateRevision: session.state.revision,
    analysisCompute: "deterministic-local",
    browser: {
      requested: parsed.values.open === true,
      opened: false,
    },
    chat: chatAttachment.route.kind === "local"
      ? {
          route: chatAttachment.route,
          ticket: null,
          model: service.agent ?? null,
          disclosure: "Questions and selected evidence stay on this Mac.",
        }
      : chatAttachment.route.kind === "host"
      ? {
          route: chatAttachment.route,
          ticket: chatAttachment.ticket,
          attachment: chatAttachment.attachment,
          waitCommand: `attend chat wait --ticket ${chatAttachment.ticket} --timeout 300 --json`,
          ...(chatRecovery === null ? {} : { recovery: chatRecovery }),
          disclosure:
            "Selected evidence is returned to this coding agent through its configured provider route while it is waiting.",
        }
      : {
          route: chatAttachment.route,
          ticket: null,
          adapter: service.agent ?? null,
          disclosure: `Selected evidence is sent only to the explicitly selected detached ${chatAttachment.route.adapter} fallback.`,
        },
  };
  if (parsed.values.open) {
    try {
      await openViewUrl(viewerUrl, { root });
      result.browser.opened = true;
    } catch (error) {
      result.browser.errorCode = [
        "BROWSER_LAUNCHER_UNAVAILABLE",
        "BROWSER_LAUNCH_FAILED",
        "BROWSER_LAUNCH_TIMEOUT",
      ].includes(error?.code)
        ? error.code
        : "BROWSER_LAUNCH_FAILED";
      result.browser.warning =
        "The browser did not open automatically. Open viewerUrl manually.";
    }
  }
  if (parsed.values.json) jsonOutput(context.stdout, result);
  else {
    output(context.stdout, `Library ${service.url}`);
    output(context.stdout, `Current visualization ${viewerUrl}`);
    output(context.stdout, service.reused ? "Reused the running local service." : "Started the local service.");
    if (chatAttachment.route.kind === "local") {
      output(context.stdout, `Private ${LOCAL_MODEL.id} chat is ready on this Mac.`);
    } else if (chatAttachment.route.kind === "host") {
      output(context.stdout, "Chat is attached to this coding agent while it waits.");
      output(context.stdout, result.chat.waitCommand);
    } else {
      const label = chatAttachment.route.adapter === "claude-cli" ? "Claude CLI" : "Codex CLI";
      output(
        context.stdout,
        service.agent?.available && service.agent?.authenticated
          ? `Detached fallback ${label} is ready.`
          : `Detached fallback ${label} is selected but unavailable; run \`attend doctor --adapter ${chatAttachment.route.adapter}\`.`,
      );
    }
    if (result.browser.warning) output(context.stdout, result.browser.warning);
  }
}

async function statusCommand(args, context) {
  const parsed = parse("status", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("status does not accept positional arguments");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const result = await serviceStatus({ root });
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  if (result.running) {
    output(context.stdout, `Attend is running at ${result.url}`);
    if (result.chat?.defaultRoute === "local") {
      return output(
        context.stdout,
        result.agent?.available
          ? `Private ${LOCAL_MODEL.id} chat is ready on this Mac.`
          : "Private chat is restarting. If it does not recover, run `attend model install`.",
      );
    }
    if (result.chat?.defaultRoute === "host") {
      return output(
        context.stdout,
        "Chat route is host-attached. The opening agent must run `attend chat wait`.",
      );
    }
    const label = result.chat?.adapter === "claude-cli" ? "Claude CLI" : "Codex CLI";
    return output(
      context.stdout,
      result.agent?.available && result.agent?.authenticated
        ? `Detached fallback ${label} is ready.`
        : `Detached fallback ${label} is unavailable; run \`attend doctor --adapter ${result.chat?.adapter}\` for details.`,
    );
  }
  if (result.state === "stale") {
    if (result.verifiedStale) {
      const version = typeof result.staleHealth?.packageVersion === "string"
        ? ` ${result.staleHealth.packageVersion}`
        : "";
      return output(
        context.stdout,
        `A verified Attend${version} service is still running, but it is incompatible with this CLI and the host bridge is inactive. Run \`attend setup\` to upgrade it.`,
      );
    }
    if (result.pidAlive) {
      return output(
        context.stdout,
        "Attend found a live process in its runtime record but could not verify its service identity. The host bridge is inactive.",
      );
    }
    return output(context.stdout, "Attend is stopped; stale runtime metadata was found and no process was trusted.");
  }
  output(context.stdout, result.url
    ? `Attend is stopped. Its stable URL is ${result.url}`
    : "Attend is stopped and has not been started in this project.");
}

async function stopCommand(args, context) {
  const parsed = parse("stop", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("stop does not accept positional arguments");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  const result = await stopService({ root });
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(context.stdout, result.stopped
    ? `Stopped Attend. The next start will reuse ${result.url}`
    : "Attend was already stopped.");
}

async function foregroundServiceCommand(args, context) {
  const parsed = parse("_serve", args, {
    "instance-id": { type: "string" },
  });
  if (parsed.positionals.length) throw new Error("_serve does not accept positional arguments");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  await requireSetup(root);
  return runForegroundService({
    root,
    assetsDir: VIEWER_ASSETS,
    instanceId: parsed.values["instance-id"],
  });
}

async function contextCommand(args, context) {
  const parsed = parse("context", args, {
    "include-excerpts": { type: "boolean" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("context does not accept positional arguments");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  const session = await currentSession(root);
  const selection = buildArtifactSelection(session.dataPackage, session.state);
  const includeExcerpts = parsed.values["include-excerpts"] || false;
  const redactSelection = (value) => includeExcerpts
    ? value
    : {
        ...value,
        sourceRefs: (value.sourceRefs ?? []).map(
          ({ excerpt: _excerpt, ...reference }) => reference,
        ),
      };
  const pending = await oldestUnansweredQuestionAcrossSessions({ root });
  const pendingQuestion = pending?.question ?? null;
  const outputPendingQuestion = pending
    ? {
        sessionId: pending.sessionId,
        id: pendingQuestion.id,
        content: pendingQuestion.content,
        createdAt: pendingQuestion.createdAt,
        selection: redactSelection(pendingQuestion.selection),
        viewState: pending.session.state,
        analysisQuestion: pending.session.dataPackage.question,
        dataPackagePath: analysisPaths(
          root,
          pending.session.dataPackage.id,
        ).analysis,
        conversationTurns: pending.session.conversation?.turns?.length || 0,
      }
    : null;
  const result = {
    ok: true,
    currentSessionId: session.id,
    question: session.dataPackage.question,
    selection: redactSelection(selection),
    viewState: session.state,
    pendingQuestionPolicy: "oldest-unanswered",
    pendingQuestionScope: "all-sessions",
    pendingQuestion: outputPendingQuestion,
    dataPackagePath: analysisPaths(root, session.dataPackage.id).analysis,
    evidenceExcerptsIncluded: includeExcerpts,
    conversationTurns: session.conversation?.turns?.length || 0,
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  if (pendingQuestion) {
    output(
      context.stdout,
      `Pending question ${pendingQuestion.id} in session ${pending.sessionId}: ${pendingQuestion.content}`,
    );
    output(
      context.stdout,
      `Owning view is state v${pending.session.state.revision}; question context is historical state v${pendingQuestion.selection.stateRevision} (${pendingQuestion.selection.id}).`,
    );
  }
  if (!selection.selectedMarkIds.length) {
    output(context.stdout, `No ${selectionNoun(selection)} is selected (state v${selection.stateRevision}).`);
    return;
  }
  const noun = selectionNoun(selection);
  output(
    context.stdout,
    `Selected ${selection.marks.map(selectionLabel).join(", ")} at state v${selection.stateRevision}.`,
  );
  output(context.stdout, `${selection.sourceRefs.length} exact evidence reference(s) for the selected ${noun}${selection.marks.length === 1 ? "" : "s"}.`);
}

async function replyCommand(args, context) {
  const parsed = parse("reply", args, {
    message: { type: "string" },
    "message-stdin": { type: "boolean" },
    "expected-revision": { type: "string" },
    "selection-id": { type: "string" },
    "question-id": { type: "string" },
    ticket: { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("reply does not accept positional arguments");
  if (parsed.values.message !== undefined && parsed.values["message-stdin"]) {
    throw new Error("reply accepts exactly one of --message or --message-stdin");
  }
  const message = (
    parsed.values["message-stdin"]
      ? await boundedStdinText(context.stdin)
      : parsed.values.message ?? ""
  ).trim();
  if (!message) throw new Error("reply requires --message <text> or --message-stdin");
  if (message.includes("\0") || Buffer.byteLength(message, "utf8") > 64 * 1024) {
    throw new Error("reply message must be valid text of at most 64 KiB");
  }
  if (parsed.values["expected-revision"] === undefined) {
    throw new Error("reply requires --expected-revision <number> from `attend context --json`");
  }
  const expectedRevision = positiveInteger(
    "--expected-revision",
    parsed.values["expected-revision"],
    undefined,
    { allowZero: true },
  );
  const expectedSelectionId = parsed.values["selection-id"]?.trim();
  if (!expectedSelectionId) {
    throw new Error("reply requires --selection-id <id> from `attend context --json`");
  }
  const questionId = parsed.values["question-id"]?.trim();
  if (parsed.values["question-id"] !== undefined && !questionId) {
    throw new Error("--question-id must be a non-empty pendingQuestion.id");
  }
  const root = await detectedRoot(context.cwd, parsed.values.root);
  const ticket = parsed.values.ticket?.trim();
  if (parsed.values.ticket !== undefined && !ticket) {
    throw new Error("--ticket must be a non-empty host ticket");
  }
  if (ticket) {
    if (!questionId) {
      throw new Error("A host-ticket reply requires --question-id from `attend chat wait --json`");
    }
    const completed = await completeHostQuestion({
      root,
      ticket,
      questionId,
      expectedRevision,
      selectionId: expectedSelectionId,
      message,
    });
    const result = {
      ok: true,
      sessionId: completed.session.id,
      stateRevision: completed.session.state.revision,
      selectionId: completed.answer.selection.id,
      replyToTurnId: questionId,
      repeated: completed.repeated,
      route: { kind: "host" },
    };
    if (parsed.values.json) return jsonOutput(context.stdout, result);
    return output(
      context.stdout,
      completed.repeated
        ? `Host answer for ${questionId} was already committed exactly.`
        : `Answered ${questionId} from its attachment-bound host context.`,
    );
  }
  const current = await currentSession(root);
  let session = current;
  let replySelection;
  if (questionId) {
    const pending = await oldestUnansweredQuestionAcrossSessions({ root });
    const pendingQuestion = pending?.question ?? null;
    if (!pendingQuestion || pendingQuestion.id !== questionId) {
      throw new Error(
        `Pending question changed after context was read (expected ${questionId}; current ${pendingQuestion ? `${pendingQuestion.id} in session ${pending.sessionId}` : "none"}). Run \`attend context --json\` again before replying.`,
      );
    }
    if (pendingQuestion.response?.route?.kind === "host") {
      throw new Error(
        "This question is bound to the coding agent that opened the view. Reply with the --ticket returned by `attend view --json`.",
      );
    }
    session = pending.session;
    if (session.state.revision !== expectedRevision) {
      throw new Error(
        `Visualization state changed after context was read (expected v${expectedRevision}; current v${session.state.revision}). Run \`attend context --json\` again before replying.`,
      );
    }
    if (pendingQuestion.selection.id !== expectedSelectionId) {
      throw new Error(
        `Pending question selection does not match the context read for ${questionId} (expected ${expectedSelectionId}; stored ${pendingQuestion.selection.id}). Run \`attend context --json\` again before replying.`,
      );
    }
    replySelection = pendingQuestion.selection;
  } else {
    const currentSelection = buildArtifactSelection(session.dataPackage, session.state);
    if (
      session.state.revision !== expectedRevision ||
      currentSelection.id !== expectedSelectionId
    ) {
      throw new Error(
        `Visualization state changed after context was read (expected v${expectedRevision} / ${expectedSelectionId}; current v${session.state.revision} / ${currentSelection.id}). Run \`attend context --json\` again before replying.`,
      );
    }
    replySelection = currentSelection;
  }
  let updated;
  try {
    updated = await appendConversationTurn({
      root,
      sessionId: session.id,
      expectedRevision,
      turn: {
        role: "assistant",
        content: message,
        selection: replySelection,
        ...(questionId ? { replyToTurnId: questionId } : {}),
      },
    });
  } catch (error) {
    if (error?.code === "CONFLICT") {
      throw new Error(
        "Visualization state changed while the note was being saved. Run `attend context --json` again before replying.",
      );
    }
    throw error;
  }
  const result = {
    ok: true,
    sessionId: updated.id,
    stateRevision: updated.state.revision,
    selectionId: replySelection.id,
    ...(questionId ? { replyToTurnId: questionId } : {}),
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  output(
    context.stdout,
    questionId
      ? `Answered pending question ${questionId} from its exact stored selection.`
      : `Saved the agent note from state v${expectedRevision}.`,
  );
}

async function doctorReport(root, adapter) {
  const paths = projectPaths(root);
  const checks = [];
  const add = (id, status, detail, group = "core") => checks.push({
    id,
    status,
    detail,
    group,
  });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("node", nodeMajor >= 22 ? "pass" : "fail", `Node ${process.versions.node}`);

  let inspectedService = null;
  let serviceInspectionError = null;
  try {
    inspectedService = await serviceStatus({ root });
  } catch (error) {
    serviceInspectionError = error;
  }

  let configuredRoute;
  try {
    configuredRoute = await readChatRoute({ root });
    add(
      "chat-route",
      "pass",
      configuredRoute.kind === "local"
        ? `Private ${LOCAL_MODEL.id} inference is the default.`
        : configuredRoute.kind === "host"
          ? "Host-attached coding agent is explicitly selected."
          : `Explicit detached fallback ${configuredRoute.adapter} is selected.`,
      "chat",
    );
  } catch (error) {
    add("chat-route", "fail", error.message, "chat");
  }

  const blockingRuntime = inspectedService?.compatibility === "incompatible" ||
    inspectedService?.compatibility === "unverified";
  if (serviceInspectionError) {
    add(
      "host-bridge",
      "fail",
      "Attend could not inspect its local service state, so host delivery is not ready. Repair `.attend/local/service.json`, then run `attend setup`.",
      "host-bridge",
    );
  } else if (blockingRuntime) {
    const protocol = inspectedService.staleHealth?.protocolVersion;
    const version = inspectedService.staleHealth?.packageVersion;
    const identity = inspectedService.verifiedStale
      ? [
          Number.isSafeInteger(protocol) ? `protocol ${protocol}` : null,
          typeof version === "string" ? version : null,
        ].filter(Boolean).join(", ") || "an older version"
      : "an unverified runtime";
    add(
      "host-bridge",
      "fail",
      `A live ${identity} service still owns Attend's local URL, so the host bridge is not active. Run \`attend setup\` to upgrade it. Resolve any reported legacy question first.`,
      "host-bridge",
    );
  } else {
    try {
      let currentRoute = null;
      try {
        const session = await currentSession(root);
        currentRoute = await resolveChatRoute({ root, sessionId: session.id });
      } catch (error) {
        if (error?.code !== "NO_CURRENT_ANALYSIS") throw error;
      }
      const capability = await hostBridgeCapability({ root, route: currentRoute });
      add(
        "host-bridge",
        "pass",
        capability.listening
          ? "CLI bridge attend-host-question/1 is supported and a host is listening."
          : "CLI bridge attend-host-question/1 is supported; no active listener is required for core readiness.",
        "host-bridge",
      );
    } catch (error) {
      add("host-bridge", "fail", error.message, "host-bridge");
    }
  }

  let requestedAdapter = null;
  if (adapter !== undefined) {
    requestedAdapter = detachedAdapterId(adapter, "--adapter");
  }
  for (const adapter of ["codex-cli", "claude-cli"]) {
    if (adapter !== requestedAdapter) {
      add(
        `adapter:${adapter}`,
        "info",
        "Optional detached fallback not probed. Select it explicitly or pass --adapter.",
        "detached-provider",
      );
      continue;
    }
    try {
      const capability = await createDetachedAgentRunner(adapter, {
        projectRoot: root,
      }).capability();
      const ready = capability.available === true && capability.authenticated === true;
      add(
        `adapter:${adapter}`,
        ready ? "pass" : "warn",
        ready
          ? `${adapter}${capability.version ? ` ${capability.version}` : ""} is available and authenticated.`
          : capability.available === false
            ? `${adapter} is unavailable. Core visualization and host chat remain ready.`
            : `${adapter} is installed but not authenticated. Core visualization and host chat remain ready.`,
        "detached-provider",
      );
    } catch (error) {
      add(`adapter:${adapter}`, "warn", error.message, "detached-provider");
    }
  }

  if (await exists(paths.project)) {
    try {
      const project = await readJson(paths.project);
      add(
        "project",
        project.managedBy === "attend-managed" ? "pass" : "fail",
        paths.project,
      );
    } catch (error) {
      add("project", "fail", error.message);
    }
  } else add("project", "fail", "Run `attend setup`.");

  let expectedSkillText = null;
  try {
    expectedSkillText = managedSkillContents(await readFile(SKILL_SOURCE, "utf8"));
  } catch (error) {
    add("agent-skill-source", "fail", error.message);
  }
  for (const skillPath of paths.skills) {
    const skillText = await readFile(skillPath.path, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    const matches = expectedSkillText !== null && skillText === expectedSkillText;
    add(
      `agent-skill-${skillPath.agent}`,
      matches ? "pass" : "fail",
      matches
        ? skillPath.path
        : skillText === null
          ? `Managed ${skillPath.agent} skill is missing. Run \`attend setup\`.`
          : `Managed ${skillPath.agent} skill is stale or differs from this Attend release. Run \`attend setup\`.`,
    );
  }

  let expectedSkillMetadata = null;
  try {
    expectedSkillMetadata = managedSkillMetadataContents(
      await readFile(SKILL_METADATA_SOURCE, "utf8"),
    );
  } catch (error) {
    add("agent-skill-metadata-source", "fail", error.message);
  }
  const installedSkillMetadata = await readFile(paths.skillMetadata.path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const metadataMatches = expectedSkillMetadata !== null && installedSkillMetadata === expectedSkillMetadata;
  add(
    "agent-skill-agents-metadata",
    metadataMatches ? "pass" : "fail",
    metadataMatches
      ? paths.skillMetadata.path
      : installedSkillMetadata === null
        ? "Managed agents skill metadata is missing. Run `attend setup`."
        : "Managed agents skill metadata is stale or differs from this Attend release. Run `attend setup`.",
  );

  for (const asset of PACKAGED_ATLAS_ASSET_FILES) {
    const assetPath = resolve(VIEWER_ASSETS, asset);
    const assetId = asset.replace(/^\.\.\/src\//u, "core/").replaceAll("/", "-");
    add(
      `viewer-${assetId}`,
      await exists(assetPath) ? "pass" : "fail",
      assetPath,
    );
  }

  try {
    const session = await currentSession(root);
    const metadata = libraryMetadataForArtifact(session.dataPackage);
    const count = metadata.counts?.phrases
      ?? metadata.counts?.marks
      ?? metadata.counts?.rows
      ?? session.dataPackage.rows?.length
      ?? session.dataPackage.marks?.length
      ?? 0;
    add("analysis", "pass", `${count} items; ${session.dataPackage.id}`);
    add("session", "pass", `${session.id} at revision ${session.state.revision}`);
  } catch (error) {
    add("analysis", "warn", error.message);
  }

  if (inspectedService) {
    const service = inspectedService;
    add(
      "service",
      service.running ? "pass" : "warn",
      service.running
        ? `running at ${service.url}`
        : service.state === "stale" && service.pidAlive && service.verifiedStale
          ? `verified older service still running at ${service.url}; run \`attend setup\` to upgrade it`
          : service.state === "stale" && service.pidAlive
            ? "live runtime could not be verified and was left untouched"
        : service.state === "stale"
          ? "stopped; stale runtime metadata will not be trusted"
          : "stopped; run `attend view` to start it",
    );
  } else {
    add(
      "service",
      "fail",
      "Attend could not inspect its local service state. Repair `.attend/local/service.json`, then run `attend setup`.",
    );
  }

  const coreOk = !checks.some(
    (check) => check.group === "core" && check.status === "fail",
  );
  const hostBridgeReady = checks.some(
    (check) => check.id === "host-bridge" && check.status === "pass",
  );
  let localModelReady = configuredRoute?.kind !== "local";
  if (configuredRoute?.kind === "local") {
    const receipt = await readJson(join(paths.local, "model.json")).catch((error) => {
      if (error?.code === "ENOENT") return null;
      add(
        "local-model-receipt",
        "fail",
        "The local model receipt is unreadable. Run `attend model install` again.",
        "chat",
      );
      return null;
    });
    localModelReady = Boolean(
      inspectedService?.running &&
      inspectedService.chat?.defaultRoute === "local" &&
      inspectedService.agent?.available === true,
    ) || Boolean(
      receipt?.schemaVersion === 1 &&
      receipt.model === LOCAL_MODEL.id &&
      receipt.repository === LOCAL_MODEL.repository &&
      receipt.file === LOCAL_MODEL.file,
    );
    add(
      "local-model",
      localModelReady ? "pass" : "fail",
      localModelReady
        ? `${LOCAL_MODEL.id} has a local installation receipt.`
        : `Run \`attend model install\` before opening a visualization.`,
      "chat",
    );
  }
  const selectedAdapter = requestedAdapter
    ? checks.find((check) => check.id === `adapter:${requestedAdapter}`)
    : null;
  const result = {
    ok: coreOk && localModelReady &&
      (configuredRoute?.kind === "host" ? hostBridgeReady : true) && !checks.some(
      (check) => check.group === "chat" && check.status === "fail",
    ),
    root,
    packageRoot: PACKAGE_ROOT,
    components: {
      opportunityCheck: { schemaVersion: OPPORTUNITY_SCHEMA_VERSION },
      experimentInbox: { schemaVersion: EXPLORATION_SCHEMA_VERSION },
      managedSkill: {
        behaviorSchemaVersion: MANAGED_SKILL_BEHAVIOR_SCHEMA_VERSION,
        sha256: expectedSkillText === null ? null : sha256Text(expectedSkillText),
        metadataSha256: expectedSkillMetadata === null
          ? null
          : sha256Text(expectedSkillMetadata),
      },
    },
    chat: { route: configuredRoute ?? null },
    readiness: {
      core: coreOk,
      localModel: {
        model: configuredRoute?.kind === "local" ? LOCAL_MODEL.id : null,
        ready: localModelReady,
        required: configuredRoute?.kind === "local",
      },
      hostBridge: hostBridgeReady,
      detachedProvider: selectedAdapter
        ? {
            adapter: requestedAdapter,
            ready: selectedAdapter.status === "pass",
            optional: true,
          }
        : { adapter: null, ready: false, optional: true },
    },
    checks,
  };
  return result;
}

async function doctorCommand(args, context) {
  const parsed = parse("doctor", args, {
    adapter: { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("doctor does not accept positional arguments");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  const result = await doctorReport(root, parsed.values.adapter);
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  for (const check of result.checks) {
    output(context.stdout, `${check.status.padEnd(5)} ${check.id}: ${check.detail}`);
  }
  output(context.stdout, result.ok ? "Attend is ready." : "Attend needs attention.");
  if (!result.ok) process.exitCode = 1;
}

export async function run(
  argv,
  {
    cwd = process.cwd(),
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    viewDependencies,
    modelDependencies,
  } = {},
) {
  const [command, ...args] = argv;
  const context = { cwd, stdin, stdout, stderr, viewDependencies, modelDependencies };
  if (!command || command === "help" || command === "--help" || command === "-h") {
    output(stdout, HELP.trimEnd());
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    output(stdout, PACKAGE_VERSION);
    return;
  }
  if (command === "bootstrap") return bootstrapCommand(args, context);
  if (command === "setup") return setupCommand(args, context);
  if (command === "model") return modelCommand(args, context);
  if (command === "phrases") return phrasesCommand(args, context);
  if (command === "families") return familiesCommand(args, context);
  if (command === "inspect") return inspectCommand(args, context);
  if (command === "checkpoint") return checkpointCommand(args, context);
  if (command === "explore") return exploreCommand(args, context);
  if (command === "map") return mapCommand(args, context);
  if (command === "assess") return assessCommand(args, context);
  if (command === "promote") return promoteCommand(args, context);
  if (command === "feedback") return feedbackCommand(args, context);
  if (command === "workspace") return workspaceCommand(args, context);
  if (command === "view") return viewCommand(args, context);
  if (command === "status") return statusCommand(args, context);
  if (command === "stop") return stopCommand(args, context);
  if (command === "chat") return chatCommand(args, context);
  if (command === "mcp") return mcpCommand(args, context);
  if (command === "_serve") return foregroundServiceCommand(args, context);
  if (command === "context") return contextCommand(args, context);
  if (command === "reply") return replyCommand(args, context);
  if (command === "doctor") return doctorCommand(args, context);
  throw new Error(`Unknown command: ${command}. Run \`attend --help\`.`);
}
