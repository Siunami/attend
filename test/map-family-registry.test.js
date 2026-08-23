import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CANONICAL_INPUT_MEDIA,
  GEOGRAPHY_RENDERER_POLICY,
  MAP_FAMILIES,
  MAP_FAMILY_GROUPS,
  REPEAT_LAYOUT_PROFILES,
  classifyRepeatMedia,
  getMapFamily,
  listMapFamilies,
  multiplesPolicy,
  requireMapFamily,
  validateMapFamilyManifest,
  validateMapFamilyRegistry,
} from "../src/map-families/registry.js";

const EXPECTED = {
  compare: ["rank", "distribution", "composition", "profile", "passage-comparison"],
  time: ["trend", "timeline", "sequence"],
  relate: ["relationship", "matrix", "hierarchy", "network", "flow", "mechanism"],
  space: ["region-map", "point-map", "field", "annotated-specimen"],
  browse: ["collection-atlas"],
};

test("registry covers the nineteen semantic families in five explicit groups", () => {
  assert.equal(MAP_FAMILIES.length, 19);
  assert.deepEqual(MAP_FAMILY_GROUPS.map((group) => group.id), Object.keys(EXPECTED));
  for (const [group, ids] of Object.entries(EXPECTED)) {
    assert.deepEqual(listMapFamilies({ group }).map((family) => family.id), ids);
  }
  assert.equal(new Set(MAP_FAMILIES.map((family) => family.id)).size, 19);
  assert.equal(getMapFamily("collection-atlas")?.group, "browse");
  assert.equal(getMapFamily("missing"), null);
  assert.throws(() => requireMapFamily("missing"), { code: "UNKNOWN_MAP_FAMILY" });
  assert.equal(validateMapFamilyRegistry(), MAP_FAMILIES);
});

test("every family is a complete question, data, evidence, grammar, and interaction contract", () => {
  for (const manifest of MAP_FAMILIES) {
    assert.equal(validateMapFamilyManifest(manifest), manifest);
    assert.ok(manifest.questions.answersWell.length >= 2, manifest.id);
    assert.ok(manifest.questions.abstainsWhen.length >= 2, manifest.id);
    assert.ok(manifest.data.requiredRoles.length >= 1, manifest.id);
    assert.equal(manifest.transformation.deterministic, true, manifest.id);
    assert.match(manifest.transformation.payload.kind, new RegExp(manifest.id));
    assert.equal(manifest.enrichment.mode, "optional-bounded", manifest.id);
    assert.equal(manifest.enrichment.requiresInputEvidence, true, manifest.id);
    assert.equal(manifest.validation.mode, "fail-closed", manifest.id);
    assert.equal(manifest.evidence.required, true, manifest.id);
    assert.ok(manifest.grammar.invariants.length >= 3, manifest.id);
    assert.ok(manifest.controls.length >= 2, manifest.id);
    assert.ok(manifest.selections.length >= 1, manifest.id);
    assert.ok(manifest.followUps.length >= 3, manifest.id);
    assert.ok(manifest.variants.length >= 2, manifest.id);
    assert.equal(manifest.renderer.version, 1, manifest.id);
    assert.equal(manifest.renderer.maturity, "specified", manifest.id);
    assert.equal(manifest.maturity, "pipeline", manifest.id);
    assert.ok(Object.isFrozen(manifest), manifest.id);
  }
});

test("every family accounts explicitly for every canonical input medium", () => {
  assert.deepEqual(CANONICAL_INPUT_MEDIA, [
    "structured", "text", "image", "video", "audio", "document", "geography", "mixed",
  ]);
  for (const manifest of MAP_FAMILIES) {
    assert.deepEqual(manifest.mediaAdapters.map((adapter) => adapter.medium), CANONICAL_INPUT_MEDIA, manifest.id);
    for (const adapter of manifest.mediaAdapters) {
      assert.ok(["direct", "deterministic", "enrich", "abstain"].includes(adapter.decision), `${manifest.id}/${adapter.medium}`);
      assert.ok(Array.isArray(adapter.fieldsExtracted), `${manifest.id}/${adapter.medium}`);
      assert.ok(adapter.evidenceLocatorKind, `${manifest.id}/${adapter.medium}`);
      assert.ok(adapter.previewTreatment, `${manifest.id}/${adapter.medium}`);
      assert.ok(adapter.reason, `${manifest.id}/${adapter.medium}`);
      if (adapter.decision === "abstain") {
        assert.deepEqual(adapter.fieldsExtracted, []);
        assert.equal(adapter.evidenceLocatorKind, "none");
        assert.equal(adapter.previewTreatment, "none");
      }
    }
  }
});

test("repeat layout is cross-family, media-aware, and deterministic", () => {
  assert.deepEqual(Object.keys(REPEAT_LAYOUT_PROFILES), [
    "numeric-chart", "image", "video", "audio", "text", "document", "geography", "3d-mixed",
  ]);
  for (const [id, profile] of Object.entries(REPEAT_LAYOUT_PROFILES)) {
    assert.ok(["direct", "deterministic", "enrich", "abstain"].includes(profile.adaptationDecision), id);
    assert.ok(profile.minimumReadableUnit.width > 0, id);
    assert.ok(profile.minimumReadableUnit.height > 0, id);
    assert.equal(profile.quantityBands.at(-1).maxCount, null, id);
    assert.ok(profile.quantityBands.every((band) => band.layout && band.fallback), id);
  }

  const numeric = multiplesPolicy({ mediaType: "structured", count: 10, availableWidth: 900 });
  const images = multiplesPolicy({ mediaType: "image/jpeg", count: 10, availableWidth: 900 });
  const video = multiplesPolicy({ mediaType: "video/mp4", count: 10, availableWidth: 900 });
  const text = multiplesPolicy({ mediaType: "text/plain", count: 10, availableWidth: 900 });
  assert.equal(numeric.profile, "numeric-chart");
  assert.equal(numeric.adaptationDecision, "direct");
  assert.equal(images.profile, "image");
  assert.equal(video.adaptationDecision, "deterministic");
  assert.equal(text.columns, 1);
  assert.equal(text.layout, "paged-passage-index");
  assert.doesNotMatch(text.layout, /column|grid/u);
  assert.equal(REPEAT_LAYOUT_PROFILES.text.maximumColumns, 1);
  assert.ok(REPEAT_LAYOUT_PROFILES.text.quantityBands.every((band) => !/aligned-columns|passage-grid/u.test(band.layout)));
  assert.equal(classifyRepeatMedia("application/pdf"), "document");
  assert.equal(classifyRepeatMedia("model/gltf+json"), "3d-mixed");
  assert.notEqual(numeric.columns, video.columns);
  assert.notEqual(images.minimumReadableUnit.width, text.minimumReadableUnit.width);
  assert.deepEqual(numeric, multiplesPolicy({ mediaType: "structured", count: 10, availableWidth: 900 }));
  assert.throws(() => multiplesPolicy({ mediaType: "image", count: -1, availableWidth: 900 }));
});

test("geography choices pin interactive and fixed-comparison renderers", () => {
  assert.deepEqual(GEOGRAPHY_RENDERER_POLICY, {
    interactiveGlobal: {
      library: "MapLibre GL JS",
      version: "5.6.1",
      useWhen: "The person must pan, zoom, inspect, or filter a global or multi-resolution geographic view.",
    },
    fixedProjectedComparison: {
      library: "d3-geo",
      version: "3",
      useWhen: "Several maps must share a fixed projection, extent, and scale for reliable comparison.",
    },
    donor: "People Atlas",
  });
  assert.deepEqual(getMapFamily("region-map").renderer.geography, GEOGRAPHY_RENDERER_POLICY);
  assert.deepEqual(getMapFamily("point-map").renderer.geography, GEOGRAPHY_RENDERER_POLICY);
});

test("the exact registry stays browser-safe", async () => {
  const source = await readFile(new URL("../src/map-families/registry.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:|require\s*\(|\bBuffer\b|\bprocess\./u);
});
