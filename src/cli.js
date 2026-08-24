import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { analyzePhrasesWithEvidence } from "./analyze.js";
import { createCodexAgentRunner } from "./agent-runner.js";
import { PACKAGE_VERSION } from "./constants.js";
import { writeEvidenceStore } from "./evidence.js";
import {
  projectPaths,
  readJson,
  setupProject,
  SKILL_TARGET_IDS,
  writeJsonAtomic,
} from "./project.js";
import { buildSelection } from "./selection.js";
import {
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

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL_SOURCE = fileURLToPath(
  new URL("../agent-skill/attend-visualize/SKILL.md", import.meta.url),
);
const VIEWER_ASSETS = fileURLToPath(new URL("../viewer", import.meta.url));

const HELP = `Attend Local ${PACKAGE_VERSION}

Usage:
  attend setup [--root <path>] [--agent <id>] [--dry-run] [--json]
  attend phrases <path...> --question <text> [options]
  attend view [--root <path>] [--host <loopback>] [--port <number>] [--open] [--json]
  attend status [--root <path>] [--json]
  attend stop [--root <path>] [--json]
  attend context [--root <path>] [--include-excerpts] [--json]
  attend reply --message <text> --expected-revision <n> --selection-id <id> [--question-id <turn-id>] [options]
  attend doctor [--root <path>] [--json]

The alpha supports one deterministic visual question: recurring phrases across
explicitly named Markdown, text, or normalized JSONL sources.
`;

const COMMAND_HELP = {
  setup: `Usage: attend setup [--root <path>] [--agent <id>] [--dry-run] [--json]

Create project-scoped configuration, local-state exclusions, and the managed
attend-visualize agent skill. Setup is safe to rerun and refuses to overwrite
unmanaged files.

The skill is installed once per host-agent convention: \`agents\`
(.agents/skills/) for agents that read the cross-agent location, and \`claude\`
(.claude/skills/) for Claude Code, which reads only its own. Both are installed
by default; repeat --agent to install a subset.
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
  reply: `Usage: attend reply --message <text> --expected-revision <n> --selection-id <id> [--question-id <turn-id>] [options]

Answer the oldest pending sidebar question, or mirror a host-chat answer, only
if the exact context returned by \`attend context --json\` is still current.

Options:
  --expected-revision <n>  pendingQuestion.viewState.revision when answering;
                           otherwise the current top-level viewState.revision
  --selection-id <id>      Pending-question selection id, or current selection id
  --question-id <turn-id>  pendingQuestion.id to answer and link explicitly
  --root <path>            Project root (normally detected from .git)
  --json                   Emit machine-readable output
`,
  doctor: `Usage: attend doctor [--root <path>] [--json]

Check the runtime, project setup, current analysis/session, installed skill,
packaged viewer assets, and local Codex chat capability.
`,
};

function output(stream, value) {
  stream.write(`${value}\n`);
}

function jsonOutput(stream, value) {
  output(stream, JSON.stringify(value));
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
      throw new Error("No current analysis. Run `attend phrases <paths...>` first.");
    }
    throw error;
  });
  const sessionId = pointer.sessionId || pointer.analysisId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("The current Attend analysis pointer is invalid.");
  }
  return loadSession({ root, sessionId });
}

async function setupCommand(args, context) {
  const parsed = parse("setup", args, {
    "dry-run": { type: "boolean" },
    agent: { type: "string", multiple: true },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("setup does not accept positional arguments");
  const agents = parsed.values.agent;
  if (agents) {
    const unknown = agents.filter((id) => !SKILL_TARGET_IDS.includes(id));
    if (unknown.length) {
      throw new Error(
        `Unknown --agent value(s): ${unknown.join(", ")}. Known values: ${SKILL_TARGET_IDS.join(", ")}.`,
      );
    }
  }
  const root = await detectedRoot(context.cwd, parsed.values.root);
  const result = await setupProject({
    root,
    dryRun: parsed.values["dry-run"] || false,
    skillSource: SKILL_SOURCE,
    agents,
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

function openUrl(url) {
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
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
  const session = await currentSession(root);
  const service = await startService({
    root,
    host: parsed.values.host,
    port: parsed.values.port === undefined
      ? undefined
      : positiveInteger("--port", parsed.values.port, 0, { allowZero: true }),
  });
  const viewerUrl = new URL(`s/${encodeURIComponent(session.id)}/`, service.url).href;

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
    agent: service.agent ?? null,
  };
  if (parsed.values.json) jsonOutput(context.stdout, result);
  else {
    output(context.stdout, `Library ${service.url}`);
    output(context.stdout, `Current visualization ${viewerUrl}`);
    output(context.stdout, service.reused ? "Reused the running local service." : "Started the local service.");
    output(
      context.stdout,
      service.agent?.available && service.agent?.authenticated
        ? `Chat is ready through Codex${service.agent.version ? ` ${service.agent.version}` : ""}.`
        : "Chat needs an installed, signed-in Codex CLI; run `attend doctor` for details.",
    );
  }
  if (parsed.values.open) openUrl(viewerUrl);
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
    return output(
      context.stdout,
      result.agent?.available && result.agent?.authenticated
        ? `Codex chat is ready${result.agent.version ? ` (${result.agent.version})` : ""}.`
        : "Codex chat is unavailable; run `attend doctor` for details.",
    );
  }
  if (result.state === "stale") {
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
  const selection = buildSelection(session.dataPackage, session.state);
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
    output(context.stdout, `No phrase is selected (state v${selection.stateRevision}).`);
    return;
  }
  output(
    context.stdout,
    `Selected ${selection.marks.map((mark) => `“${mark.phrase}”`).join(", ")} at state v${selection.stateRevision}.`,
  );
  output(context.stdout, `${selection.sourceRefs.length} exact evidence reference(s).`);
}

async function replyCommand(args, context) {
  const parsed = parse("reply", args, {
    message: { type: "string" },
    "expected-revision": { type: "string" },
    "selection-id": { type: "string" },
    "question-id": { type: "string" },
  });
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("reply does not accept positional arguments");
  const message = parsed.values.message?.trim();
  if (!message) throw new Error("reply requires --message <text>");
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
    const currentSelection = buildSelection(session.dataPackage, session.state);
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

async function doctorCommand(args, context) {
  const parsed = parse("doctor", args, {});
  if (parsed.help) return output(context.stdout, parsed.help.trimEnd());
  if (parsed.positionals.length) throw new Error("doctor does not accept positional arguments");
  const root = await detectedRoot(context.cwd, parsed.values.root);
  const paths = projectPaths(root);
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("node", nodeMajor >= 22 ? "pass" : "fail", `Node ${process.versions.node}`);

  try {
    const capability = await createCodexAgentRunner().capability();
    const ready = capability.available === true && capability.authenticated === true;
    add(
      "codex-chat",
      ready ? "pass" : "warn",
      ready
        ? `Codex CLI${capability.version ? ` ${capability.version}` : ""}; existing sign-in ready`
        : capability.available === false
          ? "Codex CLI is unavailable; install it to answer sidebar questions."
          : "Codex CLI is installed but not signed in; run `codex login`."
    );
  } catch (error) {
    add("codex-chat", "warn", error.message);
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

  const { readFile: readSkill } = await import("node:fs/promises");
  const installedSkills = [];
  const missingSkills = [];
  for (const target of paths.skills) {
    const skillText = await readSkill(target.path, "utf8").catch(() => null);
    const valid = skillText?.startsWith("---\n") && skillText.includes("attend-managed");
    (valid ? installedSkills : missingSkills).push(target);
  }
  add(
    "agent-skill",
    installedSkills.length ? "pass" : "fail",
    installedSkills.length
      ? `${installedSkills.map((target) => target.relativePath).join(", ")}${
          missingSkills.length
            ? `; not installed for ${missingSkills.map((target) => target.agent).join(", ")}`
            : ""
        }`
      : "Managed skill is missing. Run `attend setup`.",
  );

  for (const asset of ["index.html", "app.js", "styles.css"]) {
    add(
      `viewer-${asset}`,
      await exists(join(VIEWER_ASSETS, asset)) ? "pass" : "fail",
      join(VIEWER_ASSETS, asset),
    );
  }

  try {
    const session = await currentSession(root);
    add("analysis", "pass", `${session.dataPackage.rows.length} rows; ${session.dataPackage.id}`);
    add("session", "pass", `${session.id} at revision ${session.state.revision}`);
  } catch (error) {
    add("analysis", "warn", error.message);
  }

  try {
    const service = await serviceStatus({ root });
    add(
      "service",
      service.running ? "pass" : "warn",
      service.running
        ? `running at ${service.url}`
        : service.state === "stale"
          ? "stopped; stale runtime metadata will not be trusted"
          : "stopped; run `attend view` to start it",
    );
  } catch (error) {
    add("service", "warn", error.message);
  }

  const result = {
    ok: !checks.some((check) => check.status === "fail"),
    root,
    packageRoot: PACKAGE_ROOT,
    checks,
  };
  if (parsed.values.json) return jsonOutput(context.stdout, result);
  for (const check of checks) output(context.stdout, `${check.status.padEnd(5)} ${check.id}: ${check.detail}`);
  output(context.stdout, result.ok ? "Attend is ready." : "Attend needs attention.");
  if (!result.ok) process.exitCode = 1;
}

export async function run(
  argv,
  {
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const [command, ...args] = argv;
  const context = { cwd, stdout, stderr };
  if (!command || command === "help" || command === "--help" || command === "-h") {
    output(stdout, HELP.trimEnd());
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    output(stdout, PACKAGE_VERSION);
    return;
  }
  if (command === "setup") return setupCommand(args, context);
  if (command === "phrases") return phrasesCommand(args, context);
  if (command === "view") return viewCommand(args, context);
  if (command === "status") return statusCommand(args, context);
  if (command === "stop") return stopCommand(args, context);
  if (command === "_serve") return foregroundServiceCommand(args, context);
  if (command === "context") return contextCommand(args, context);
  if (command === "reply") return replyCommand(args, context);
  if (command === "doctor") return doctorCommand(args, context);
  throw new Error(`Unknown command: ${command}. Run \`attend --help\`.`);
}
