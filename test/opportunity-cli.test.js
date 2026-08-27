import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { run } from "../src/cli.js";
import {
  createExploration,
  explorationIdForCheckpoint,
  listExperiments,
  listExplorations,
  loadExploration,
} from "../src/exploration-store.js";
import {
  createOpportunityCheck,
  loadOpportunityCheck,
  opportunityPaths,
} from "../src/opportunity-store.js";

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
  const root = await mkdtemp(join(tmpdir(), "attend-opportunity-cli-"));
  await mkdir(join(root, ".git"));
  await writeFile(
    join(root, "evidence.md"),
    "Alpha scored 8 points.\nBeta scored 5 points.\nGamma scored 3 points.\n",
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function checkpointRequest({ boundaryId, decision, inspectionHash } = {}) {
  return {
    version: 1,
    boundary: {
      kind: "before-final-answer",
      id: boundaryId ?? "root-turn-001:final",
    },
    host: {
      kind: "codex",
      skillVersion: "attend-visualize/0.5.3",
    },
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
    decision: decision ?? {
      kind: "abstain",
      reason: "text-suffices",
      confidence: 0.9,
      interruptionCost: 0.1,
    },
    ...(inspectionHash === undefined ? {} : { inspectionHash }),
  };
}

function experimentPlan(overrides = {}) {
  return {
    key: "rank-gap",
    hypothesis: "The ordered scores contain a meaningful gap.",
    whyUseful: "A ranked view makes the gap inspectable.",
    representation: { family: "rank", member: "bar-list" },
    sourceScope: [{ path: "evidence.md" }],
    baseline: {
      name: "equal scores",
      description: "Compare against no gap between the three entities.",
    },
    comparisonCount: 3,
    origin: "agent",
    analysisMode: "exploratory",
    timing: "pre-result",
    ...overrides,
  };
}

function explorationRequest({ checkpointId, inspectionHash, ...overrides } = {}) {
  return {
    version: 1,
    goal: "Find useful structure in the scores.",
    analyticIntent: "Test whether a ranked representation exposes a meaningful gap.",
    sourceScope: [{ path: "evidence.md" }],
    ...(inspectionHash === undefined ? {} : { inspectionHash }),
    ...(checkpointId === undefined ? {} : { checkpointId }),
    experiments: [experimentPlan()],
    ...overrides,
  };
}

async function missing(path) {
  await assert.rejects(stat(path), (error) => error?.code === "ENOENT");
}

test("checkpoint receipts are silent, idempotent, and create no analysis side effects", async (t) => {
  const root = await fixture(t);
  await runJson(root, ["setup"]);
  const rawBoundaryId = "root-turn-private-001:final";
  const requestPath = join(root, "checkpoint.json");
  await writeFile(
    requestPath,
    JSON.stringify(checkpointRequest({ boundaryId: rawBoundaryId })),
  );

  const dependencies = {
    viewDependencies: new Proxy({}, {
      get() {
        throw new Error("checkpoint must not use browser or service dependencies");
      },
    }),
    modelDependencies: new Proxy({}, {
      get() {
        throw new Error("checkpoint must not use model dependencies");
      },
    }),
  };
  const first = await runJson(root, ["checkpoint", "checkpoint.json"], dependencies);
  const retry = await runJson(root, ["checkpoint", "checkpoint.json"], dependencies);
  assert.deepEqual(retry, first);
  assert.equal(first.decision, "abstain");
  assert.equal(first.nextAction, "continue without mentioning Attend");
  assert.deepEqual(Object.keys(first).sort(), [
    "checkpointId",
    "decision",
    "nextAction",
    "ok",
  ]);

  const stored = await loadOpportunityCheck({
    root,
    checkpointId: first.checkpointId,
  });
  assert.equal(stored.decision.kind, "abstain");
  assert.equal(JSON.stringify(stored).includes(rawBoundaryId), false);
  assert.equal(
    (await readFile(opportunityPaths(root, first.checkpointId).checkpoint, "utf8"))
      .includes(rawBoundaryId),
    false,
  );
  assert.equal((await readdir(opportunityPaths(root).directory)).length, 1);
  await missing(join(root, ".attend", "local", "current.json"));
  await missing(join(root, ".attend", "local", "sessions"));
  await missing(join(root, ".attend", "local", "explorations"));
});

test("only a proceed checkpoint links one convergent exploration", async (t) => {
  const root = await fixture(t);
  await runJson(root, ["setup"]);
  await writeFile(join(root, "inspect.json"), JSON.stringify({
    version: 1,
    goal: "Find useful structure in the scores.",
    sources: [{ path: "evidence.md" }],
  }));
  const inspection = await runJson(root, ["inspect", "inspect.json"]);

  await writeFile(
    join(root, "abstain.json"),
    JSON.stringify(checkpointRequest({ boundaryId: "root-turn-abstain:final" })),
  );
  const abstain = await runJson(root, ["checkpoint", "abstain.json"]);
  await writeFile(
    join(root, "abstain-explore.json"),
    JSON.stringify(explorationRequest({
      checkpointId: abstain.checkpointId,
      inspectionHash: inspection.inspectionHash,
    })),
  );
  await assert.rejects(
    runJson(root, ["explore", "abstain-explore.json"]),
    (error) => error?.code === "CHECKPOINT_NOT_PROCEEDING",
  );

  const missingCheckpoint = `checkpoint_${"0".repeat(24)}`;
  await writeFile(
    join(root, "missing-explore.json"),
    JSON.stringify(explorationRequest({
      checkpointId: missingCheckpoint,
      inspectionHash: inspection.inspectionHash,
    })),
  );
  await assert.rejects(
    runJson(root, ["explore", "missing-explore.json"]),
    (error) => error?.code === "OPPORTUNITY_NOT_FOUND",
  );

  await writeFile(
    join(root, "proceed.json"),
    JSON.stringify(checkpointRequest({
      boundaryId: "root-turn-proceed:final",
      inspectionHash: inspection.inspectionHash,
      decision: {
        kind: "proceed",
        reason: "visual-worth-testing",
        confidence: 0.92,
        interruptionCost: 0.15,
      },
    })),
  );
  const proceed = await runJson(root, ["checkpoint", "proceed.json"]);
  assert.equal(proceed.decision, "proceed");
  await writeFile(
    join(root, "proceed-explore.json"),
    JSON.stringify(explorationRequest({
      checkpointId: proceed.checkpointId,
      inspectionHash: inspection.inspectionHash,
    })),
  );
  const first = await runJson(root, ["explore", "proceed-explore.json"]);
  const retry = await runJson(root, ["explore", "proceed-explore.json"]);
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.explorationId, first.explorationId);
  assert.equal(retry.experiments[0].id, first.experiments[0].id);
  assert.equal(
    first.explorationId,
    explorationIdForCheckpoint(proceed.checkpointId),
  );

  const exploration = await loadExploration({
    root,
    explorationId: first.explorationId,
  });
  assert.equal(exploration.checkpointId, proceed.checkpointId);
  const experiments = await listExperiments({
    root,
    explorationId: first.explorationId,
  });
  assert.equal(experiments.length, 1);
  assert.equal(Object.hasOwn(experiments[0], "checkpointId"), false);
  assert.equal((await listExplorations({ root })).length, 1);

  await writeFile(
    join(root, "conflict-explore.json"),
    JSON.stringify(explorationRequest({
      checkpointId: proceed.checkpointId,
      inspectionHash: inspection.inspectionHash,
      goal: "A different goal cannot claim the same checkpoint.",
    })),
  );
  await assert.rejects(
    runJson(root, ["explore", "conflict-explore.json"]),
    (error) => error?.code === "CHECKPOINT_LINK_CONFLICT",
  );

  await writeFile(
    join(root, "direct-explore.json"),
    JSON.stringify(explorationRequest({
      inspectionHash: inspection.inspectionHash,
      experiments: [experimentPlan({ key: "user-rank", origin: "user" })],
    })),
  );
  const direct = await runJson(root, ["explore", "direct-explore.json"]);
  assert.notEqual(direct.explorationId, first.explorationId);
  assert.equal(
    Object.hasOwn(
      await loadExploration({ root, explorationId: direct.explorationId }),
      "checkpointId",
    ),
    false,
  );
});

test("concurrent linked exploration creation converges without duplicate records", async (t) => {
  const root = await fixture(t);
  const { version: _version, ...request } = checkpointRequest({
    boundaryId: "root-turn-concurrent:final",
    decision: {
      kind: "proceed",
      reason: "visual-worth-testing",
      confidence: 0.9,
      interruptionCost: 0.2,
    },
  });
  const checkpoint = await createOpportunityCheck({
    root,
    request,
  });
  const plan = {
    goal: "Find useful structure in the scores.",
    analyticIntent: "Test a ranked comparison.",
    sourceScope: [{ path: "evidence.md" }],
    checkpointId: checkpoint.id,
  };
  const now = () => new Date("2026-08-25T20:00:00.000Z");
  const records = await Promise.all(
    Array.from({ length: 16 }, () => createExploration({ root, plan, now })),
  );
  assert.equal(new Set(records.map((record) => record.id)).size, 1);
  assert.equal((await listExplorations({ root })).length, 1);
  await assert.rejects(
    createExploration({
      root,
      plan: { ...plan, goal: "A conflicting goal." },
      now,
    }),
    (error) => error?.code === "CHECKPOINT_LINK_CONFLICT",
  );
});
