import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactAdapterFor,
  buildArtifactSelection,
  createArtifactState,
  evidenceReferenceIdsForSelection,
  evidenceSourceIdsForSelection,
  libraryMetadataForArtifact,
  patchArtifactState,
  selectableIdsForArtifact,
  verifyArtifactPackage,
  viewDescriptorForArtifact,
} from "../src/artifacts/index.js";
import { catalogReceiptForMember } from "../src/catalog/index.js";
import { compileMap } from "../src/pipeline/compile.js";

function phrasePackage() {
  return {
    schemaVersion: 1,
    kind: "attend-data-package",
    id: "data_0123456789abcdef",
    question: { text: "Which phrases recur?", target: "fixture notes" },
    hashes: { corpus: "corpus-hash", config: "config-hash", data: "data-hash" },
    config: {
      minCount: 2,
      minSources: 1,
      ranking: [{ by: "occurrenceCount", direction: "desc" }],
    },
    sources: [{
      id: "source_alpha",
      displayPath: "notes/alpha.md",
      sha256: "a".repeat(64),
      kind: "markdown",
    }],
    rows: [{
      id: "phrase_attention",
      phrase: "attention map",
      wordCount: 2,
      occurrenceCount: 3,
      distinctSourceCount: 1,
      occurrences: [{ sourceId: "source_alpha", line: 4, excerpt: "An attention map helps." }],
    }],
    map: { id: "phrase-list", version: 1, labelField: "phrase", valueField: "occurrenceCount" },
  };
}

async function atlasPackage() {
  return compileMap({
    familyId: "rank",
    catalog: catalogReceiptForMember("rank", "bar-list"),
    question: { text: "Which items rank highest?", target: "fixture records" },
    roleMapping: { label: "label", value: "value" },
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: { id: "fixture-adapter", version: 1 },
      medium: "structured",
      requestedInputs: ["fixtures/records.jsonl"],
      sources: [{
        id: "src_fixture",
        displayPath: "fixtures/records.jsonl",
        sha256: "b".repeat(64),
        kind: "normalized-records",
        byteLength: 800,
      }],
      records: [
        { id: "record_alpha", sourceId: "src_fixture", fields: { label: "Alpha", value: 8 } },
        { id: "record_beta", sourceId: "src_fixture", fields: { label: "Beta", value: 5 } },
      ],
    },
  });
}

test("phrase-v1 remains an adapter with its persisted phrase state and evidence semantics", async () => {
  const dataPackage = phrasePackage();
  const adapter = artifactAdapterFor(dataPackage);
  assert.equal(adapter.artifactKind, "phrase-v1");
  assert.deepEqual(viewDescriptorForArtifact(dataPackage), { id: "phrase-list", version: 1 });
  assert.deepEqual(createArtifactState(dataPackage), {
    revision: 0,
    selectedIds: [],
    query: "",
    minCount: 2,
    sort: { by: "occurrenceCount", direction: "desc" },
    sourceScope: { mode: "all", sourceIds: [] },
  });

  const state = patchArtifactState(dataPackage, createArtifactState(dataPackage), {
    selectedIds: ["phrase_attention"],
  });
  const selection = buildArtifactSelection(dataPackage, { ...state, revision: 3 });
  assert.deepEqual(selection.selectedMarkIds, ["phrase_attention"]);
  assert.deepEqual(evidenceSourceIdsForSelection(dataPackage, selection), ["source_alpha"]);
  assert.deepEqual(libraryMetadataForArtifact(dataPackage).counts, {
    phrases: 1,
    sources: 1,
  });
  assert.equal(await verifyArtifactPackage(dataPackage), dataPackage);
});

test("atlas-v2 validates hashes and derives mark selection and evidence solely from canonical marks", async () => {
  const dataPackage = await atlasPackage();
  const adapter = artifactAdapterFor(dataPackage);
  assert.equal(adapter.artifactKind, "atlas-v2");
  assert.equal(await verifyArtifactPackage(dataPackage), dataPackage);
  assert.deepEqual(selectableIdsForArtifact(dataPackage), dataPackage.marks.map((mark) => mark.id));
  assert.deepEqual(viewDescriptorForArtifact(dataPackage), {
    id: "rank",
    version: dataPackage.family.version,
    rendererId: dataPackage.presentation.renderer.id,
    rendererVersion: dataPackage.presentation.renderer.version,
  });

  const selected = dataPackage.marks[0];
  assert.throws(
    () => createArtifactState(dataPackage, { markIds: ["mark_invented"] }),
    /Unknown Atlas mark id/u,
  );
  const state = patchArtifactState(dataPackage, createArtifactState(dataPackage), {
    markIds: [selected.id],
  });
  const selection = buildArtifactSelection(dataPackage, { ...state, revision: 4 });
  assert.deepEqual(selection.selectedMarkIds, [selected.id]);
  assert.deepEqual(evidenceReferenceIdsForSelection(dataPackage, selection), selected.evidenceRefs);
  assert.deepEqual(selection.evidenceRefIds, selected.evidenceRefs);
  assert.equal("sourceRefs" in selection, false);
  assert.equal(JSON.stringify(selection).includes("src_fixture"), false);
  assert.equal(JSON.stringify(selection).includes("locator"), false);
  assert.throws(
    () => evidenceSourceIdsForSelection(dataPackage, selection),
    { code: "EVIDENCE_PRIVATE_LINK_REQUIRED" },
  );
  assert.deepEqual(libraryMetadataForArtifact(dataPackage).counts, {
    marks: 2,
    sources: 1,
    noun: "mark",
  });

  const tampered = structuredClone(dataPackage);
  tampered.question.text = "A changed question with stale hashes";
  await assert.rejects(verifyArtifactPackage(tampered), { code: "HASH_MISMATCH" });

  const inventedCatalog = structuredClone(dataPackage);
  inventedCatalog.catalog.version = "not-the-bundled-catalog";
  assert.throws(
    () => artifactAdapterFor(inventedCatalog).validatePublicPackage(inventedCatalog),
    { code: "ATLAS_CATALOG_UNAUTHORIZED" },
  );
});
