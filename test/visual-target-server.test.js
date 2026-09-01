import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { catalogReceiptForMember } from "../src/catalog/index.js";
import { atlasV2Adapter } from "../src/artifacts/atlas-v2.js";
import { buildEvidencePacket, buildEvidenceStore } from "../src/evidence.js";
import { compileMap, compileMapWithEvidence } from "../src/pipeline/compile.js";
import { createDataPackage } from "../src/pipeline/data-package.js";
import { createViewerServer } from "../src/server.js";
import { createSession, loadSession } from "../src/session-store.js";

const VIEWER_ASSETS = fileURLToPath(new URL("../viewer/", import.meta.url));
const TEST_TOKEN = "visual-target-test-token-0123456789";
const TEST_INSTANCE_ID = "visual-target-test-instance-0123456789";

function histogramInput(count = 120) {
  const source = {
    id: "source_histogram",
    displayPath: "fixtures/histogram.jsonl",
    sha256: "a".repeat(64),
    kind: "normalized-records",
    byteLength: 16_384,
  };
  return {
    familyId: "distribution",
    catalog: catalogReceiptForMember("distribution", "histogram"),
    question: {
      text: "How are the fixture measurements distributed?",
      target: "fixture measurements",
      analyticJob: "distribution:histogram",
    },
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: { id: "evidenced-records-v1", version: 1 },
      medium: "structured",
      requestedInputs: [source.displayPath],
      sources: [source],
      records: Array.from({ length: count }, (_, index) => ({
        id: `record_${String(index).padStart(5, "0")}`,
        sourceId: source.id,
        fields: { value: 7 },
        evidenceRefs: [{
          sourceId: source.id,
          recordId: `record_${String(index).padStart(5, "0")}`,
          locator: { kind: "row", index },
          quote: "7",
        }],
      })),
    },
    roleMapping: { value: "value" },
  };
}

function manySourceHistogramInput(count = 120) {
  const texts = Array.from({ length: count }, (_, index) => `Observed value 7 in source ${index}.\n`);
  const sources = texts.map((text, index) => ({
    id: `source_histogram_${String(index).padStart(3, "0")}`,
    displayPath: `fixtures/histogram-${String(index).padStart(3, "0")}.txt`,
    sha256: createHash("sha256").update(text).digest("hex"),
    kind: "normalized-records",
    byteLength: Buffer.byteLength(text),
  }));
  return {
    input: {
      familyId: "distribution",
      catalog: catalogReceiptForMember("distribution", "histogram"),
      question: {
        text: "How are the fixture measurements distributed?",
        target: "many-source fixture measurements",
        analyticJob: "distribution:histogram",
      },
      sourceBundle: {
        kind: "attend-normalized-source-bundle",
        schemaVersion: 1,
        adapter: { id: "evidenced-records-v1", version: 1 },
        medium: "structured",
        requestedInputs: sources.map((source) => source.displayPath),
        sources,
        records: sources.map((source, index) => ({
          id: `record_${String(index).padStart(5, "0")}`,
          sourceId: source.id,
          fields: { value: 7 },
          evidenceRefs: [{
            sourceId: source.id,
            recordId: `record_${String(index).padStart(5, "0")}`,
            locator: { kind: "row", index: 0 },
            quote: texts[index].trim(),
          }],
        })),
      },
      roleMapping: { value: "value" },
    },
    evidenceSources: sources.map((source, index) => ({ ...source, text: texts[index] })),
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-visual-target-server-"));
  const dataPackage = await compileMap(histogramInput());
  const populatedBin = dataPackage.payload.bins.find((bin) => bin.count > 0);
  const target = dataPackage.payload.visualTargets.find(
    (candidate) => candidate.id === populatedBin.targetId,
  );
  assert.equal(target.count, 120);

  const sessionId = "histogram_target_session";
  await createSession({ root, id: sessionId, dataPackage });
  const viewer = await createViewerServer({
    root,
    analysisId: sessionId,
    assetsDir: VIEWER_ASSETS,
    token: TEST_TOKEN,
    instanceId: TEST_INSTANCE_ID,
  });
  t.after(async () => {
    await viewer.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, sessionId, dataPackage, target, viewer };
}

function api(viewerUrl, route) {
  return new URL(`api/${route}`, viewerUrl);
}

async function responseJson(response) {
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/u);
  return response.json();
}

function postSelection(viewerUrl, body) {
  return fetch(api(viewerUrl, "selection"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(viewerUrl).origin,
    },
    body: JSON.stringify(body),
  });
}

function targetMembersUrl(viewerUrl, targetId, { offset = 0, limit = 50 } = {}) {
  const url = api(viewerUrl, "target-members");
  url.searchParams.set("targetId", targetId);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));
  return url;
}

async function repackage(dataPackage, payload) {
  return createDataPackage({
    family: dataPackage.family,
    catalog: dataPackage.catalog,
    question: dataPackage.question,
    scope: dataPackage.scope,
    sources: dataPackage.sources,
    roleMapping: dataPackage.roleMapping,
    marks: dataPackage.marks,
    payload,
    presentation: dataPackage.presentation,
    provenance: dataPackage.provenance,
    quality: dataPackage.quality,
    execution: dataPackage.execution,
  });
}

test("aggregate selection persists only targetId and target membership paginates from canonical marks", async (t) => {
  const { root, sessionId, dataPackage, target, viewer } = await fixture(t);

  const selectedResponse = await postSelection(viewer.url, {
    sessionId,
    revision: 0,
    targetId: target.id,
  });
  assert.equal(selectedResponse.status, 200);
  const selected = await responseJson(selectedResponse);
  assert.deepEqual(selected.state, {
    revision: 1,
    markIds: [],
    targetId: target.id,
  });
  assert.deepEqual(selected.selection.selectedMarkIds, []);
  assert.equal(selected.selection.target.id, target.id);
  assert.equal(selected.selection.target.count, 120);
  assert.equal(selected.selection.marks.length, 12);
  assert.equal(selected.selection.omissionCount, 108);

  const stored = await loadSession({ root, sessionId });
  assert.deepEqual(stored.state, selected.state);
  assert.equal(JSON.stringify(stored.state).includes(dataPackage.marks[0].id), false);

  const expectedMarkIds = dataPackage.marks.map((mark) => mark.id).sort();
  const collected = [];
  let offset = 0;
  while (offset !== null) {
    const response = await fetch(targetMembersUrl(viewer.url, target.id, {
      offset,
      limit: 17,
    }));
    assert.equal(response.status, 200);
    const page = await responseJson(response);
    assert.equal(page.target.id, target.id);
    assert.equal(page.count, 120);
    assert.equal(page.membershipHash, target.membershipHash);
    assert.equal(page.page.offset, offset);
    assert.equal(page.page.limit, 17);
    assert.equal(page.page.returned, page.markIds.length);
    assert.equal(page.evidenceRefIds.length, page.markIds.length);
    collected.push(...page.markIds);
    offset = page.page.nextOffset;
  }
  assert.deepEqual(collected, expectedMarkIds);
  assert.equal(new Set(collected).size, 120);

  const lastResponse = await fetch(targetMembersUrl(viewer.url, target.id, {
    offset: 119,
    limit: 17,
  }));
  assert.equal(lastResponse.status, 200);
  const last = await responseJson(lastResponse);
  assert.equal(last.markIds.length, 1);
  assert.equal(last.page.nextOffset, null);

  const clearedResponse = await postSelection(viewer.url, {
    sessionId,
    revision: 1,
    markId: null,
  });
  assert.equal(clearedResponse.status, 200);
  const cleared = await responseJson(clearedResponse);
  assert.deepEqual(cleared.state, { revision: 2, markIds: [] });
  assert.equal(cleared.selection.target, undefined);
});

test("aggregate target APIs reject unknown ids and refuse forged count/hash receipts before session creation", async (t) => {
  const { root, sessionId, dataPackage, target, viewer } = await fixture(t);
  const unknownTargetId = target.id === "target_0000000000000000"
    ? "target_1111111111111111"
    : "target_0000000000000000";

  const unknownSelection = await postSelection(viewer.url, {
    sessionId,
    revision: 0,
    targetId: unknownTargetId,
  });
  assert.equal(unknownSelection.status, 400);
  assert.equal((await responseJson(unknownSelection)).error.code, "invalid_selection");
  assert.deepEqual((await loadSession({ root, sessionId })).state, {
    revision: 0,
    markIds: [],
  });

  const unknownPage = await fetch(targetMembersUrl(viewer.url, unknownTargetId));
  assert.equal(unknownPage.status, 400);
  assert.equal((await responseJson(unknownPage)).error.code, "invalid_visual_target");

  for (const forgedField of ["count", "membershipHash"]) {
    const payload = structuredClone(dataPackage.payload);
    const forgedTarget = payload.visualTargets.find((candidate) => candidate.id === target.id);
    if (forgedField === "count") forgedTarget.count += 1;
    else forgedTarget.membershipHash = forgedTarget.membershipHash.startsWith("0")
      ? `1${forgedTarget.membershipHash.slice(1)}`
      : `0${forgedTarget.membershipHash.slice(1)}`;

    await assert.rejects(
      repackage(dataPackage, payload),
      (error) => error.code === "INVALID_PAYLOAD"
        && error.path === "dataPackage.payload",
      forgedField,
    );
  }
});

test("aggregate chat evidence uses the bounded canonical preview across many distinct sources", async () => {
  const fixtureValue = manySourceHistogramInput();
  const compiled = await compileMapWithEvidence(fixtureValue.input);
  const dataPackage = compiled.dataPackage;
  const evidenceStore = buildEvidenceStore({
    dataPackage,
    sources: fixtureValue.evidenceSources,
    evidenceReferences: compiled.evidenceReferences,
  });
  const populatedBin = dataPackage.payload.bins.find((bin) => bin.count > 0);
  const selection = atlasV2Adapter.buildSelection(dataPackage, {
    revision: 1,
    markIds: [],
    targetId: populatedBin.targetId,
  });

  assert.equal(selection.target.count, 120);
  assert.equal(selection.evidenceRefCount, 120);
  assert.equal(selection.evidenceRefIds.length, 12);
  assert.equal(selection.omissionCount, 108);
  assert.equal(selection.predicate.kind, "visual-target");

  const packet = buildEvidencePacket({ dataPackage, evidenceStore, selection });
  assert.equal(packet.selectionId, selection.id);
  assert.equal(packet.coverage.selectedSourceCount, 12);
  assert.equal(packet.sources.length, 12);
  assert.deepEqual(
    packet.sources.map((source) => source.sourceId),
    dataPackage.sources.map((source) => source.id).filter((sourceId) =>
      selection.evidenceRefIds.some((referenceId) =>
        evidenceStore.references.some((reference) =>
          reference.id === referenceId && reference.sourceId === sourceId))),
  );
});
