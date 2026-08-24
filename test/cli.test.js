import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { run } from "../src/cli.js";
import { evidenceStorePath } from "../src/evidence.js";
import { readJson } from "../src/project.js";
import { buildSelection } from "../src/selection.js";
import { stopService } from "../src/service.js";
import {
  appendConversationTurn,
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

async function runJson(root, args) {
  const stdout = capture();
  const stderr = capture();
  await run(args, { cwd: root, stdout: stdout.stream, stderr: stderr.stream });
  assert.equal(stderr.text(), "");
  return stdout.json();
}

async function runBinJson(root, args, { timeoutMs = 10_000 } = {}) {
  const child = spawn(process.execPath, [BIN, ...args, "--json"], {
    cwd: PACKAGE_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
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
  assert.equal(doctor.ok, true);
  assert.ok(doctor.checks.every((check) => check.status !== "fail"));
  assert.ok(doctor.checks.some((check) => check.id === "codex-chat"));
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
  assert.equal(
    started.viewerUrl,
    `${started.url}s/${analysis.sessionId}/`,
  );

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
  assert.equal(reused.viewerUrl, started.viewerUrl);
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
