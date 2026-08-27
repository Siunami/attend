import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Writable } from "node:stream";

import { run } from "../src/cli.js";
import { publicExploration } from "../src/exploration-store.js";
import { readJson } from "../src/project.js";

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

async function runJson(root, args, dependencies = {}) {
  const stdout = capture();
  const stderr = capture();
  await run([...args, "--json"], {
    cwd: root,
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...dependencies,
  });
  assert.equal(stderr.text(), "");
  return stdout.json();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-exploration-cli-"));
  await mkdir(join(root, ".git"));
  await writeFile(
    join(root, "evidence.md"),
    "Alpha scored 8 points on 2026-08-20.\nBeta scored 5 points on 2026-08-25.\nGamma scored 3 points.\n",
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function mapRequest() {
  return {
    version: 1,
    question: "How do Alpha, Beta, and Gamma compare?",
    family: "rank",
    member: "bar-list",
    sources: [{ path: "evidence.md" }],
    records: [
      { key: "alpha", label: "Alpha", value: 8 },
      { key: "beta", label: "Beta", value: 5 },
      { key: "gamma", label: "Gamma", value: 3 },
    ],
    evidence: [
      { source: { path: "evidence.md" }, quote: "Alpha scored 8 points on 2026-08-20.", recordKey: "alpha", field: "label" },
      { source: { path: "evidence.md" }, quote: "Alpha scored 8 points on 2026-08-20.", recordKey: "alpha", field: "value" },
      { source: { path: "evidence.md" }, quote: "Beta scored 5 points on 2026-08-25.", recordKey: "beta", field: "label" },
      { source: { path: "evidence.md" }, quote: "Beta scored 5 points on 2026-08-25.", recordKey: "beta", field: "value" },
      { source: { path: "evidence.md" }, quote: "Gamma scored 3 points.", recordKey: "gamma", field: "label" },
      { source: { path: "evidence.md" }, quote: "Gamma scored 3 points.", recordKey: "gamma", field: "value" },
    ],
  };
}

function assessment() {
  return {
    outcome: "interesting",
    summary: "Alpha is clearly highest in the named comparison.",
    rationale: "The ordering is relevant, visible, and supported by exact source claims.",
    evidenceStrength: "strong",
    interestingness: {
      taskRelevance: 1,
      evidenceSufficiency: 1,
      surprise: 0.4,
      novelty: 0.3,
      actionability: 0.6,
      representationalDiversity: 0.5,
      uncertainty: 0.1,
      interruptionCost: 0.1,
    },
    transformations: ["Sorted values descending."],
    omissions: [],
    limitations: ["Only three observations."],
  };
}

test("CLI preserves the complete admitted experiment lifecycle without duplicate promotion", async (t) => {
  const root = await fixture(t);
  await runJson(root, ["setup"]);
  await writeFile(join(root, "inspect.json"), JSON.stringify({
    version: 1,
    goal: "Find useful structure in the scores",
    sources: [{ path: "evidence.md" }],
  }));
  const inspection = await runJson(root, ["inspect", "inspect.json"]);
  assert.equal(inspection.summary.sourceCount, 1);
  assert.equal(inspection.summary.uniqueIsoDateCount, 2);
  assert.ok(!JSON.stringify(inspection).includes("Alpha scored"));

  await writeFile(join(root, "explore.json"), JSON.stringify({
    version: 1,
    goal: "Find useful structure in the scores",
    analyticIntent: "Compare a ranked view and one explicit follow-up.",
    sourceScope: [{ path: "evidence.md" }],
    inspectionHash: inspection.inspectionHash,
    experiments: [
      {
        key: "rank",
        hypothesis: "The score ordering contains a meaningful gap.",
        whyUseful: "A ranked view makes the relative gap inspectable.",
        representation: { family: "rank", member: "bar-list" },
        sourceScope: [{ path: "evidence.md" }],
        baseline: { name: "equal scores", description: "Compare with no gap between entities." },
        comparisonCount: 3,
        origin: "agent",
        analysisMode: "exploratory",
        timing: "pre-result",
      },
      {
        key: "invalid-follow-up",
        parentKey: "rank",
        hypothesis: "The same representation may expose a second defensible structure.",
        whyUseful: "It tests whether the first pattern survives a follow-up request.",
        representation: { family: "rank", member: "bar-list" },
        sourceScope: [{ path: "evidence.md" }],
        baseline: { name: "first attempt", description: "Compare with the admitted rank experiment." },
        comparisonCount: 3,
        origin: "agent",
        analysisMode: "exploratory",
        timing: "pre-result",
      },
    ],
  }));
  const explored = await runJson(root, ["explore", "explore.json"]);
  assert.equal(explored.admittedCount, 2);
  assert.equal(explored.experiments[1].parentExperimentId, explored.experiments[0].id);
  const [successfulId, failedId] = explored.experiments.map((experiment) => experiment.id);

  await writeFile(join(root, "map.json"), JSON.stringify(mapRequest()));
  const mapped = await runJson(root, [
    "map",
    "map.json",
    "--stage",
    "--exploration",
    explored.explorationId,
    "--experiment",
    successfulId,
  ]);
  assert.equal(mapped.staged, true);
  await assert.rejects(readFile(join(root, ".attend", "local", "current.json")), /ENOENT/u);

  const invalid = mapRequest();
  invalid.evidence = [];
  await writeFile(join(root, "invalid-map.json"), JSON.stringify(invalid));
  const failedOutput = capture();
  await assert.rejects(
    run([
      "map",
      "invalid-map.json",
      "--stage",
      "--exploration",
      explored.explorationId,
      "--experiment",
      failedId,
      "--json",
    ], { cwd: root, stdout: failedOutput.stream, stderr: failedOutput.stream }),
    /evidence must be a non-empty array/u,
  );

  await writeFile(join(root, "assessment.json"), JSON.stringify(assessment()));
  const assessed = await runJson(root, ["assess", successfulId, "assessment.json"]);
  assert.equal(assessed.experiment.outcome, "interesting");
  const promoted = await runJson(root, ["promote", successfulId]);
  assert.equal(promoted.alreadyPromoted, false);
  const promotedAgain = await runJson(root, ["promote", successfulId]);
  assert.equal(promotedAgain.alreadyPromoted, true);
  assert.equal(promotedAgain.eventId, null);
  const current = await readJson(join(root, ".attend", "local", "current.json"));
  assert.equal(current.sessionId, successfulId);
  const feedback = await runJson(root, [
    "feedback",
    successfulId,
    "--kind",
    "useful",
    "--note",
    "This changes the next comparison.",
  ]);
  assert.equal(feedback.alreadyRecorded, false);
  assert.equal(feedback.experiment.feedback[0].kind, "useful");
  const feedbackRetry = await runJson(root, [
    "feedback",
    successfulId,
    "--kind",
    "useful",
    "--note",
    "This changes the next comparison.",
  ]);
  assert.equal(feedbackRetry.alreadyRecorded, true);
  assert.equal(feedbackRetry.eventId, feedback.eventId);
  assert.equal(feedbackRetry.experiment.feedback.length, 1);

  const workspace = await publicExploration({ root, explorationId: explored.explorationId });
  assert.equal(workspace.experiments.length, 2);
  assert.equal(workspace.experiments.filter((experiment) => experiment.agentPromoted).length, 1);
  assert.equal(workspace.experiments.find((experiment) => experiment.id === successfulId).execution, "completed");
  const failedExperiment = workspace.experiments.find((experiment) => experiment.id === failedId);
  assert.equal(failedExperiment.execution, "failed");
  assert.equal(
    failedExperiment.failure.message,
    "The staged map request did not pass Attend's compiler. Re-run the command for private diagnostics.",
  );
  assert.doesNotMatch(JSON.stringify(failedExperiment.failure), /evidence must be a non-empty array/u);
  assert.equal(
    workspace.experiments.find((experiment) => experiment.id === successfulId)
      .events.filter((event) => event.kind === "agent-promoted").length,
    1,
  );

  let openedUrl = null;
  const workspaceResult = await runJson(root, ["workspace", explored.explorationId, "--open"], {
    viewDependencies: {
      async startService() {
        return {
          url: "http://127.0.0.1:41234/v/test-token/",
          state: "running",
          reused: false,
        };
      },
      async openUrl(url) {
        openedUrl = url;
      },
    },
  });
  assert.equal(workspaceResult.browser.opened, true);
  assert.equal(workspaceResult.workspaceUrl, openedUrl);
  assert.match(openedUrl, new RegExp(`/e/${explored.explorationId}/$`, "u"));
});

test("a staged map cannot discard an experiment's exact representation intent", async (t) => {
  const root = await fixture(t);
  await runJson(root, ["setup"]);
  await writeFile(join(root, "explore.json"), JSON.stringify({
    version: 1,
    goal: "Keep the requested ranked form",
    analyticIntent: "Test the exact requested bar-list form.",
    sourceScope: [{ path: "evidence.md" }],
    experiments: [{
      key: "exact-rank",
      hypothesis: "The exact bar-list form makes the score gap inspectable.",
      whyUseful: "The user requested this form rather than an interchangeable comparison.",
      representation: {
        family: "rank",
        member: "bar-list",
        representationIntent: {
          version: 1,
          mode: "exact",
          constraints: [{ kind: "form", value: "bar-list" }],
        },
      },
      sourceScope: [{ path: "evidence.md" }],
      baseline: { name: "equal scores", description: "Compare with no gap between entities." },
      comparisonCount: 3,
      origin: "user",
      analysisMode: "confirmatory",
      timing: "pre-result",
    }],
  }));
  const explored = await runJson(root, ["explore", "explore.json"]);
  const experimentId = explored.experiments[0].id;
  const request = mapRequest();
  request.version = 2;
  request.representationIntent = { version: 1, mode: "open", constraints: [] };
  await writeFile(join(root, "map.json"), JSON.stringify(request));

  const output = capture();
  await assert.rejects(
    run([
      "map",
      "map.json",
      "--stage",
      "--exploration",
      explored.explorationId,
      "--experiment",
      experimentId,
      "--json",
    ], { cwd: root, stdout: output.stream, stderr: output.stream }),
    (error) => error?.code === "STAGED_REPRESENTATION_INTENT_MISMATCH",
  );

  const experiment = (await publicExploration({ root, explorationId: explored.explorationId }))
    .experiments[0];
  assert.equal(experiment.execution, "queued");
  assert.deepEqual(experiment.events, []);
  await assert.rejects(readFile(join(root, ".attend", "local", "current.json")), /ENOENT/u);
});

test("exploration admission rejects an unsupported exact form before writing a plan", async (t) => {
  const root = await fixture(t);
  await runJson(root, ["setup"]);
  await writeFile(join(root, "explore.json"), JSON.stringify({
    version: 1,
    goal: "Use the explicitly requested radial network",
    analyticIntent: "Inspect the requested animated radial network without substituting a nearby form.",
    sourceScope: [{ path: "evidence.md" }],
    experiments: [{
      key: "exact-radial-network",
      hypothesis: "The requested radial network may make the relationships legible.",
      whyUseful: "It tests the specific form requested by the user.",
      representation: {
        family: "network",
        member: "local",
        representationIntent: {
          version: 1,
          mode: "exact",
          constraints: [
            { kind: "form", value: "radial-network" },
            { kind: "motion", value: "animated" },
          ],
        },
      },
      sourceScope: [{ path: "evidence.md" }],
      baseline: { name: "requested form", description: "Do not replace the named representation." },
      comparisonCount: 1,
      origin: "user",
      analysisMode: "confirmatory",
      timing: "pre-result",
    }],
  }));

  const output = capture();
  await assert.rejects(
    run(["explore", "explore.json", "--json"], {
      cwd: root,
      stdout: output.stream,
      stderr: output.stream,
    }),
    (error) => error?.code === "UNSUPPORTED_REQUESTED_REPRESENTATION",
  );
  await assert.rejects(
    readdir(join(root, ".attend", "local", "explorations")),
    (error) => error?.code === "ENOENT",
  );
});

test("an unsupported exact direct map request creates no visualization state", async (t) => {
  const root = await fixture(t);
  await runJson(root, ["setup"]);
  const request = mapRequest();
  request.version = 2;
  request.question = "Show the scores in a three-dimensional view with orbit controls.";
  request.representationIntent = {
    version: 1,
    mode: "exact",
    constraints: [
      { kind: "dimensionality", value: "3d" },
      { kind: "interaction", value: "orbit" },
    ],
  };
  await writeFile(join(root, "map.json"), JSON.stringify(request));

  const output = capture();
  await assert.rejects(
    run(["map", "map.json", "--json"], {
      cwd: root,
      stdout: output.stream,
      stderr: output.stream,
    }),
    (error) => error?.code === "UNSUPPORTED_REQUESTED_REPRESENTATION",
  );
  for (const path of ["analyses", "evidence", "sessions"]) {
    await assert.rejects(
      readdir(join(root, ".attend", "local", path)),
      (error) => error?.code === "ENOENT",
      path,
    );
  }
  await assert.rejects(readFile(join(root, ".attend", "local", "current.json")), /ENOENT/u);
});

test("concurrent staged maps execute an experiment exactly once", async (t) => {
  const root = await fixture(t);
  await runJson(root, ["setup"]);
  await writeFile(join(root, "explore.json"), JSON.stringify({
    version: 1,
    goal: "Test one ranked comparison",
    analyticIntent: "Ensure one admitted experiment has one execution owner.",
    sourceScope: [{ path: "evidence.md" }],
    experiments: [{
      key: "rank-once",
      hypothesis: "The score ordering contains a meaningful gap.",
      whyUseful: "A ranked view makes the relative gap inspectable.",
      representation: { family: "rank", member: "bar-list" },
      sourceScope: [{ path: "evidence.md" }],
      baseline: { name: "equal scores", description: "Compare with no gap between entities." },
      comparisonCount: 3,
      origin: "agent",
      analysisMode: "exploratory",
      timing: "pre-result",
    }],
  }));
  const explored = await runJson(root, ["explore", "explore.json"]);
  const experimentId = explored.experiments[0].id;
  await writeFile(join(root, "map.json"), JSON.stringify(mapRequest()));

  async function stage() {
    const stdout = capture();
    const stderr = capture();
    await run([
      "map",
      "map.json",
      "--stage",
      "--exploration",
      explored.explorationId,
      "--experiment",
      experimentId,
      "--json",
    ], { cwd: root, stdout: stdout.stream, stderr: stderr.stream });
    return stdout.json();
  }

  const attempts = await Promise.allSettled([stage(), stage()]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const projected = (await publicExploration({
    root,
    explorationId: explored.explorationId,
  })).experiments[0];
  assert.equal(projected.execution, "completed");
  assert.equal(projected.events.filter((event) => event.kind === "execution-started").length, 1);
  assert.equal(projected.events.filter((event) => event.kind === "execution-completed").length, 1);
  assert.equal(projected.events.filter((event) => event.kind === "execution-failed").length, 0);
});
