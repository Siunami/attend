import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogReceiptForMember,
  executableCatalogMemberForFamily,
  requireCatalogFamily,
  requireCatalogMember,
} from "../src/catalog/index.js";
import { MAP_FAMILIES, requireMapFamily } from "../src/map-families/registry.js";
import {
  PipelineContractError,
  compileMap,
  compileMapPackage,
  validateNormalizedSourceBundle,
} from "../src/pipeline/compile.js";
import { verifyDataPackageHashes } from "../src/pipeline/data-package.js";

const SOURCE = {
  id: "src_fixture",
  displayPath: "fixtures/normalized.jsonl",
  sha256: "a".repeat(64),
  kind: "normalized-records",
  byteLength: 4_096,
};

const VALUES = {
  rank: [
    { label: "Alpha", value: 4 },
    { label: "Beta", value: 7 },
  ],
  distribution: [
    { label: "One", value: 1, group: "A" },
    { label: "Two", value: 2, group: "A" },
    { label: "Nine", value: 9, group: "B" },
  ],
  composition: [
    { part: "Product", value: 7, whole: "Budget" },
    { part: "Research", value: 3, whole: "Budget" },
  ],
  profile: [
    { entity: "A", dimension: "Speed", value: 7 },
    { entity: "A", dimension: "Cost", value: 3 },
    { entity: "B", dimension: "Speed", value: 5 },
  ],
  "passage-comparison": [
    { passage: "The first bounded passage.", version: "v1", label: "Opening", order: 1 },
    { passage: "The revised bounded passage.", version: "v2", label: "Opening", order: 2 },
  ],
  trend: [
    { time: "2026-01-01", value: 2, series: "A" },
    { time: "2026-02-01", value: 5, series: "A" },
  ],
  timeline: [
    { time: "2026-01-01", endTime: "2026-01-02", label: "Launch", lane: "Product" },
  ],
  sequence: [
    { order: 1, label: "Sketch", stage: "Explore" },
    { order: 2, label: "Prototype", stage: "Build" },
  ],
  relationship: [
    { x: 1, y: 4, label: "A" },
    { x: 2, y: 6, label: "B" },
    { x: 3, y: 5, label: "C" },
  ],
  matrix: [
    { row: "Need A", column: "Option 1", value: 3 },
    { row: "Need B", column: "Option 1", value: 5 },
  ],
  hierarchy: [
    { id: "root", label: "Root" },
    { id: "child", parentId: "root", label: "Child" },
  ],
  network: [
    { source: "A", target: "B", weight: 2, relation: "supports" },
  ],
  flow: [
    { source: "Inbox", target: "Review", value: 9, stage: "1" },
  ],
  mechanism: [
    { source: "Request", target: "Worker", relation: "dispatches to", stage: "Runtime" },
  ],
  "region-map": [
    { region: "06", value: 4, label: "California" },
  ],
  "point-map": [
    { latitude: -6.7924, longitude: 39.2083, label: "Dar es Salaam", value: 4 },
  ],
  field: [
    { x: 0, y: 0, value: 1 },
    { x: 1, y: 0, value: 2 },
    { x: 0, y: 1, value: 3 },
  ],
  "collection-atlas": [
    { x: -0.5, y: 0.2, label: "Specimen A", cluster: "North" },
    { x: 0.4, y: -0.1, label: "Specimen B", cluster: "South" },
  ],
  "annotated-specimen": [
    { specimen: "chart_one", label: "Inflection", x: 0.35, y: 0.6, layer: "Reading", width: 0.1, height: 0.08 },
  ],
};

function roleMapping(familyId) {
  const manifest = requireMapFamily(familyId);
  return Object.fromEntries(
    [...manifest.data.requiredRoles, ...manifest.data.optionalRoles]
      .filter((role) => VALUES[familyId].some((record) => record[role.id] !== undefined))
      .map((role) => [role.id, role.id]),
  );
}

function sourceBundle(familyId, { medium = "structured", reverse = false, media = false } = {}) {
  const values = reverse ? [...VALUES[familyId]].reverse() : VALUES[familyId];
  return {
    kind: "attend-normalized-source-bundle",
    schemaVersion: 1,
    adapter: { id: "fixture-adapter", version: 1 },
    medium,
    requestedInputs: ["fixtures/normalized.jsonl"],
    sources: [{ ...SOURCE }],
    records: values.map((fields, index) => ({
      id: `record_${String(index + 1).padStart(2, "0")}_${familyId.replaceAll("-", "_")}`,
      sourceId: SOURCE.id,
      fields,
      evidenceRefs: [{
        sourceId: SOURCE.id,
        locator: { kind: medium === "structured" ? "row" : "span", index: index + 1 },
        excerpt: Object.values(fields).map(String).join(" · ").slice(0, 240),
      }],
      ...(media
        ? { media: { type: "image", mimeType: "image/png", preview: { kind: "thumbnail", src: `previews/${index + 1}.png`, alt: String(Object.values(fields)[0]) } } }
        : {}),
    })),
  };
}

test("all eighteen executable family transforms compile normalized records into canonical v2 packages", async () => {
  assert.equal(compileMapPackage, compileMap);
  const executableManifests = MAP_FAMILIES.filter(
    (manifest) => requireCatalogFamily(manifest.id).executableMemberId !== null,
  );
  const unavailableManifests = MAP_FAMILIES.filter(
    (manifest) => requireCatalogFamily(manifest.id).executableMemberId === null,
  );
  assert.equal(executableManifests.length, 18);
  assert.deepEqual(unavailableManifests.map((manifest) => manifest.id), ["annotated-specimen"]);

  for (const manifest of executableManifests) {
    const bundle = sourceBundle(manifest.id);
    assert.equal(validateNormalizedSourceBundle(bundle), bundle);
    const dataPackage = await compileMap({
      catalog: catalogReceiptForMember(manifest.id, executableCatalogMemberForFamily(manifest.id).id),
      familyId: manifest.id,
      question: { text: manifest.questions.examples[0], target: `${manifest.title} fixture` },
      sourceBundle: bundle,
      roleMapping: roleMapping(manifest.id),
    });

    assert.equal(dataPackage.schemaVersion, 2, manifest.id);
    assert.equal(dataPackage.kind, "attend-data-package", manifest.id);
    assert.equal(dataPackage.family.id, manifest.id, manifest.id);
    assert.equal(dataPackage.family.group, manifest.group, manifest.id);
    assert.equal(dataPackage.presentation.renderer.id, manifest.renderer.id, manifest.id);
    assert.equal(dataPackage.presentation.variant, manifest.variants[0].id, manifest.id);
    assert.equal(dataPackage.payload.kind, manifest.transformation.payload.kind, manifest.id);
    assert.equal(dataPackage.payload[manifest.transformation.payload.collection].length, VALUES[manifest.id].length, manifest.id);
    assert.equal(dataPackage.marks.length, VALUES[manifest.id].length, manifest.id);
    assert.ok(dataPackage.marks.every((mark) => mark.evidenceRefs.length >= 1), manifest.id);
    assert.ok(dataPackage.marks.every((mark) => mark.media?.type), manifest.id);
    assert.equal(dataPackage.quality.coverage.recordsCompiled, VALUES[manifest.id].length, manifest.id);
    assert.equal(dataPackage.provenance.inputs.mediaAdapterDecision, manifest.mediaAdapters.find((adapter) => adapter.medium === "structured").decision, manifest.id);
    assert.equal(await verifyDataPackageHashes(dataPackage), true, manifest.id);
  }
});

test("compilation is deterministic across repeated calls", async () => {
  const input = {
    catalog: catalogReceiptForMember("rank", "bar-list"),
    familyId: "rank",
    question: "Which items rank highest?",
    sourceBundle: sourceBundle("rank"),
    roleMapping: roleMapping("rank"),
  };
  const first = await compileMap(input);
  const second = await compileMap(input);
  assert.deepEqual(second, first);
  assert.deepEqual(first.payload.order, first.marks.map((mark) => mark.id));
  assert.deepEqual(first.marks.map((mark) => mark.label), ["Beta", "Alpha"]);
});

test("input media adaptation is explicit and abstention fails closed", async () => {
  const video = sourceBundle("passage-comparison", { medium: "video" });
  await assert.rejects(
    compileMap({
      catalog: catalogReceiptForMember("passage-comparison", "parallel-text"),
      familyId: "passage-comparison",
      question: "Compare these passages",
      sourceBundle: video,
      roleMapping: roleMapping("passage-comparison"),
    }),
    (error) => error instanceof PipelineContractError && error.code === "FAMILY_ABSTAINS",
  );

  const annotatedMember = requireCatalogMember("annotated-specimen", "callout-overlay");
  assert.equal(annotatedMember.status, "unavailable");
  assert.match(annotatedMember.unavailableReason, /cannot bind and display the visible specimen/);
  assert.throws(
    () => executableCatalogMemberForFamily("annotated-specimen"),
    (error) => error.code === "NO_EXECUTABLE_CATALOG_MEMBER",
  );
  assert.throws(
    () => catalogReceiptForMember("annotated-specimen", "callout-overlay"),
    (error) => error.code === "UNAVAILABLE_CATALOG_MEMBER"
      && error.message.includes(annotatedMember.unavailableReason),
  );
});

test("bounded accepted enrichment changes presentation metadata but never role values", async () => {
  const input = {
    catalog: catalogReceiptForMember("rank", "bar-list"),
    familyId: "rank",
    question: "Which items rank highest?",
    sourceBundle: sourceBundle("rank"),
    roleMapping: roleMapping("rank"),
  };
  const base = await compileMap(input);
  const target = base.marks[0];
  const enriched = await compileMap({
    ...input,
    enrichments: [{
      id: "patch_label",
      markId: target.id,
      field: "label",
      value: "Highest ranked item",
      status: "accepted",
      method: { id: "fixture-model", version: 1, kind: "model" },
      inputEvidenceRefs: target.evidenceRefs,
      validation: { status: "accepted", rule: "Human checked against the selected record." },
    }],
  });
  assert.equal(enriched.marks[0].label, "Highest ranked item");
  assert.deepEqual(enriched.marks[0].values, base.marks[0].values);
  assert.equal(enriched.provenance.enrichments.length, 1);
  assert.equal(enriched.execution.modelCalls, 1);
  assert.equal("value" in enriched.provenance.enrichments[0], false);

  await assert.rejects(
    compileMap({
      ...input,
      enrichments: [{
        id: "patch_unchecked",
        markId: target.id,
        field: "label",
        value: "Unchecked",
        status: "proposed",
        method: { id: "fixture-model", version: 1 },
        inputEvidenceRefs: target.evidenceRefs,
        validation: { status: "pending", rule: "Not checked." },
      }],
    }),
    (error) => error.code === "UNVALIDATED_ENRICHMENT",
  );
});

test("role, family, and structural validation reject misleading packages", async () => {
  await assert.rejects(
    compileMap({
      catalog: catalogReceiptForMember("rank", "bar-list"),
      familyId: "rank",
      question: "Rank these",
      sourceBundle: sourceBundle("rank"),
      roleMapping: { label: "label" },
    }),
    (error) => error.code === "MISSING_REQUIRED_ROLE",
  );

  const badCoordinates = sourceBundle("point-map");
  badCoordinates.records[0].fields.latitude = 100;
  await assert.rejects(
    compileMap({
      catalog: catalogReceiptForMember("point-map", "exact-points"),
      familyId: "point-map",
      question: "Where?",
      sourceBundle: badCoordinates,
      roleMapping: roleMapping("point-map"),
    }),
    (error) => error.code === "INVALID_ROLE_VALUE",
  );

  const cycle = sourceBundle("hierarchy");
  cycle.records[0].fields.parentId = "child";
  await assert.rejects(
    compileMap({
      catalog: catalogReceiptForMember("hierarchy", "tidy"),
      familyId: "hierarchy",
      question: "How is this nested?",
      sourceBundle: cycle,
      roleMapping: roleMapping("hierarchy"),
    }),
    (error) => error.code === "HIERARCHY_CYCLE",
  );
});
