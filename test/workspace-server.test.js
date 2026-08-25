import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendExperimentEvent,
  createExperiment,
  createExploration,
} from "../src/exploration-store.js";
import { compileCatalogMapRequest } from "../src/map/index.js";
import { createViewerServer } from "../src/server.js";
import { createSession } from "../src/session-store.js";

const ASSETS = fileURLToPath(new URL("../viewer", import.meta.url));
const explorationId = "exploration_000000000000000000000011";
const experimentId = "experiment_000000000000000000000011";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-workspace-server-"));
  await mkdir(join(root, "notes"));
  await Promise.all([
    writeFile(join(root, "notes", "one.md"), "One: 2 repeated local signals. A repeated local signal.\n"),
    writeFile(join(root, "notes", "two.md"), "Two: 1 repeated local signal. A repeated local signal.\n"),
    writeFile(join(root, "notes", "three.md"), "Three: 0 repeated local signals.\n"),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function start(t, root) {
  const viewer = await createViewerServer({
    root,
    assetsDir: ASSETS,
    token: "workspace_test_token",
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => viewer.close());
  return viewer;
}

test("one workspace exposes every experiment once and keeps staged sessions out of the library", async (t) => {
  const root = await fixture(t);
  const sourceScope = [{ path: "notes", textProjection: "utf8" }];
  await createExploration({
    root,
    id: explorationId,
    plan: {
      goal: "Find repeated structure",
      analyticIntent: "Test a useful representation.",
      sourceScope,
    },
  });
  await createExperiment({
    root,
    explorationId,
    id: experimentId,
    plan: {
      key: "recurrence",
      hypothesis: "The same phrase appears across sources.",
      whyUseful: "It shows shared language.",
      representation: { family: "rank", member: "bar-list" },
      sourceScope,
      baseline: { name: "single source", description: "Compare against one-source repetition." },
      comparisonCount: 3,
      origin: "agent",
      analysisMode: "exploratory",
      timing: "pre-result",
    },
  });
  const { dataPackage } = await compileCatalogMapRequest({
    root,
    request: {
      version: 1,
      question: "How does recurrence differ between the notes?",
      family: "rank",
      member: "bar-list",
      sources: sourceScope,
      records: [
        { key: "one", label: "One", value: 2 },
        { key: "two", label: "Two", value: 1 },
        { key: "three", label: "Three", value: 0 },
      ],
      evidence: [
        { source: { path: "notes/one.md", textProjection: "utf8" }, quote: "One: 2 repeated local signals.", recordKey: "one", field: "label" },
        { source: { path: "notes/one.md", textProjection: "utf8" }, quote: "One: 2 repeated local signals.", recordKey: "one", field: "value" },
        { source: { path: "notes/two.md", textProjection: "utf8" }, quote: "Two: 1 repeated local signal.", recordKey: "two", field: "label" },
        { source: { path: "notes/two.md", textProjection: "utf8" }, quote: "Two: 1 repeated local signal.", recordKey: "two", field: "value" },
        { source: { path: "notes/three.md", textProjection: "utf8" }, quote: "Three: 0 repeated local signals.", recordKey: "three", field: "label" },
        { source: { path: "notes/three.md", textProjection: "utf8" }, quote: "Three: 0 repeated local signals.", recordKey: "three", field: "value" },
      ],
    },
  });
  await createSession({ root, id: "ordinary-session", dataPackage });
  await createSession({
    root,
    id: experimentId,
    dataPackage,
    exploration: { explorationId, experimentId },
  });
  await appendExperimentEvent({
    root,
    experimentId,
    kind: "execution-completed",
    payload: {
      analysisId: dataPackage.id,
      sessionId: experimentId,
      packageHash: dataPackage.hashes.data,
      comparisonCount: 3,
    },
  });
  await appendExperimentEvent({
    root,
    experimentId,
    kind: "assessment-recorded",
    payload: {
      outcome: "interesting",
      summary: "The phrase recurs across both notes.",
      rationale: "The shared wording is relevant.",
      evidenceStrength: "strong",
      interestingness: {
        taskRelevance: 1,
        evidenceSufficiency: 1,
        surprise: 0.4,
        novelty: 0.5,
        actionability: 0.5,
        representationalDiversity: 0.6,
        uncertainty: 0.1,
        interruptionCost: 0.1,
      },
      transformations: [],
      omissions: [],
      limitations: [],
    },
  });
  await appendExperimentEvent({
    root,
    experimentId,
    kind: "agent-promoted",
    payload: { rationale: "This is worth attention." },
  });

  const viewer = await start(t, root);
  const workspaceBase = new URL(`e/${explorationId}/`, viewer.url);
  const [page, api, library] = await Promise.all([
    fetch(workspaceBase),
    fetch(new URL("api/exploration", workspaceBase)),
    fetch(new URL("api/library", viewer.url)),
  ]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Experiment inbox/u);
  assert.equal(api.status, 200);
  const payload = await api.json();
  assert.equal(payload.experiments.length, 1);
  assert.equal(payload.experiments[0].id, experimentId);
  assert.equal(payload.experiments[0].promotion.rationale, "This is worth attention.");
  assert.equal(payload.experiments[0].comparisonCount, 3);
  assert.equal(payload.experiments[0].history.length, 3);
  assert.equal(payload.exploration.counts.attempted, 1);
  assert.equal(payload.exploration.counts.comparisonsAttempted, 3);
  assert.equal(payload.exploration.counts.comparisonsDeclared, 3);
  assert.ok(!JSON.stringify(payload).includes("A repeated local signal"));
  assert.deepEqual((await library.json()).sessions.map((session) => session.sessionId), [
    "ordinary-session",
  ]);
});

test("workspace mutations require same origin and keep stars separate from feedback", async (t) => {
  const root = await fixture(t);
  const sourceScope = [{ path: "notes" }];
  await createExploration({
    root,
    id: explorationId,
    plan: { goal: "Feedback", analyticIntent: "Collect signals.", sourceScope },
  });
  await createExperiment({
    root,
    explorationId,
    id: experimentId,
    plan: {
      key: "one",
      hypothesis: "One hypothesis.",
      whyUseful: "It may help.",
      representation: { family: "rank", member: "bar-list" },
      sourceScope,
      baseline: { name: "none", description: "No prior comparison." },
      comparisonCount: 1,
      origin: "agent",
      analysisMode: "exploratory",
      timing: "pre-result",
    },
  });
  const viewer = await start(t, root);
  const workspaceBase = new URL(`e/${explorationId}/`, viewer.url);
  const starUrl = new URL(`api/experiments/${experimentId}/star`, workspaceBase);
  const forbidden = await fetch(starUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ starred: true, mutationId: "mutation_star_forbidden_001" }),
  });
  assert.equal(forbidden.status, 403);

  const origin = new URL(viewer.url).origin;
  const starred = await fetch(starUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      starred: true,
      mutationId: "mutation_star_saved_001",
      expectedRevision: 0,
    }),
  });
  assert.equal(starred.status, 200);
  const firstStar = (await starred.json()).experiment;
  assert.equal(firstStar.human.starred, true);
  assert.equal(firstStar.revision, 1);

  const stale = await fetch(starUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      starred: false,
      mutationId: "mutation_star_stale_001",
      expectedRevision: 0,
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "revision_conflict");

  const feedback = await fetch(
    new URL(`api/experiments/${experimentId}/feedback`, workspaceBase),
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        kind: "wrong-representation",
        mutationId: "mutation_feedback_saved_001",
        expectedRevision: 1,
      }),
    },
  );
  const updated = (await feedback.json()).experiment;
  assert.equal(updated.human.starred, true);
  assert.equal(updated.revision, 2);
  assert.equal(updated.feedbackSummary["wrong-representation"], 1);
  assert.equal(updated.human.disposition, "starred");

  const retried = await fetch(
    new URL(`api/experiments/${experimentId}/feedback`, workspaceBase),
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        kind: "wrong-representation",
        mutationId: "mutation_feedback_saved_001",
        expectedRevision: 1,
      }),
    },
  );
  const retriedExperiment = (await retried.json()).experiment;
  assert.equal(retriedExperiment.feedbackSummary["wrong-representation"], 1);
  assert.equal(retriedExperiment.revision, 2);

  const unstarred = await fetch(starUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      starred: false,
      mutationId: "mutation_star_saved_002",
      expectedRevision: 2,
    }),
  });
  const unstarredExperiment = (await unstarred.json()).experiment;
  assert.equal(unstarredExperiment.human.starred, false);
  assert.equal(unstarredExperiment.revision, 3);

  const oldRetry = await fetch(starUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      starred: true,
      mutationId: "mutation_star_saved_001",
      expectedRevision: 0,
    }),
  });
  assert.equal(oldRetry.status, 200);
  const afterOldRetry = (await oldRetry.json()).experiment;
  assert.equal(afterOldRetry.human.starred, false);
  assert.equal(afterOldRetry.revision, 3);
  assert.equal(
    afterOldRetry.history.filter((event) => event.kind === "human-star-changed").length,
    2,
  );
});
