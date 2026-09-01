import assert from "node:assert/strict";
import test from "node:test";

import { renderModelForArtifact } from "../src/artifacts/index.js";
import {
  catalogReceiptForMember,
  executableCatalogMembersForFamily,
  historicalCatalogReceiptForMember,
  requireCatalogFamily,
  requireCatalogMember,
} from "../src/catalog/index.js";
import { MAP_FAMILIES, requireMapFamily } from "../src/map-families/registry.js";
import { governedFormModule } from "../src/forms/governed.js";
import {
  compareCategoryValues,
  projectFormPayload,
  requireExecutableForm,
} from "../src/forms/index.js";
import {
  PipelineContractError,
  compileMap,
  compileMapPackage,
  validateNormalizedSourceBundle,
} from "../src/pipeline/compile.js";
import { createDataPackage, verifyDataPackageHashes } from "../src/pipeline/data-package.js";
import {
  HISTORICAL_PACKAGE_CONTRACTS,
  historicalPackageContractForMember,
} from "../src/pipeline/historical-package-contracts.js";

const SOURCE = {
  id: "src_fixture",
  displayPath: "fixtures/normalized.jsonl",
  sha256: "a".repeat(64),
  kind: "normalized-records",
  byteLength: 4_096,
};

const HISTORICAL_PRESENTATION_VARIANTS = Object.freeze({
  rank: "bar-list",
  distribution: "strip",
  composition: "absolute-stack",
  profile: "parallel-profile",
  "passage-comparison": "aligned-passages",
  trend: "observed-line",
  timeline: "event-strip",
  sequence: "storyboard",
  relationship: "scatter",
  matrix: "heat-matrix",
  hierarchy: "node-tree",
  network: "node-link",
  flow: "sankey",
  mechanism: "system-schematic",
  "region-map": "choropleth",
  "point-map": "dot-map",
  field: "contours",
  "collection-atlas": "semantic-field",
});

const VALUES = Object.freeze(Object.fromEntries(MAP_FAMILIES.map((manifest) => {
  const incumbent = requireCatalogFamily(manifest.id).members.find((member) =>
    member.status === "executable" && member.payload?.kind === manifest.transformation.payload.kind);
  if (!incumbent) {
    return [manifest.id, [{ specimen: "chart_one", label: "Inflection", x: 0.35, y: 0.6, layer: "Reading", width: 0.1, height: 0.08 }]];
  }
  return [manifest.id, governedFormModule(manifest.id, incumbent.id).fixture.records];
})));

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
    adapter: { id: "evidenced-records-v1", version: 1 },
    medium,
    requestedInputs: ["fixtures/normalized.jsonl"],
    sources: [{ ...SOURCE }],
    records: values.map((fields, index) => ({
      id: `record_${String(index + 1).padStart(2, "0")}_${familyId.replaceAll("-", "_")}`,
      sourceId: SOURCE.id,
      fields: structuredClone(fields),
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
    (manifest) => requireCatalogFamily(manifest.id).executableMemberIds.length > 0,
  );
  const unavailableManifests = MAP_FAMILIES.filter(
    (manifest) => requireCatalogFamily(manifest.id).executableMemberIds.length === 0,
  );
  assert.equal(executableManifests.length, 18);
  assert.deepEqual(unavailableManifests.map((manifest) => manifest.id), ["annotated-specimen"]);

  for (const manifest of executableManifests) {
    const incumbent = requireCatalogFamily(manifest.id).members.find((member) =>
      member.status === "executable" && member.payload?.kind === manifest.transformation.payload.kind);
    assert.ok(incumbent, `${manifest.id} must retain its incumbent form`);
    const bundle = sourceBundle(manifest.id);
    assert.equal(validateNormalizedSourceBundle(bundle), bundle);
    const dataPackage = await compileMap({
      catalog: catalogReceiptForMember(manifest.id, incumbent.id),
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
    assert.equal(dataPackage.presentation.variant, incumbent.rendererVariantId, manifest.id);
    assert.equal(dataPackage.payload.kind, incumbent.payload.kind, manifest.id);
    assert.equal(dataPackage.payload[incumbent.payload.collection].length, VALUES[manifest.id].length, manifest.id);
    assert.equal(dataPackage.marks.length, VALUES[manifest.id].length, manifest.id);
    assert.ok(dataPackage.marks.every((mark) => mark.evidenceRefs.length >= 1), manifest.id);
    assert.ok(dataPackage.marks.every((mark) => mark.media?.type), manifest.id);
    assert.equal(dataPackage.quality.coverage.recordsCompiled, VALUES[manifest.id].length, manifest.id);
    assert.equal(dataPackage.provenance.inputs.mediaAdapterDecision, manifest.mediaAdapters.find((adapter) => adapter.medium === "structured").decision, manifest.id);
    assert.equal(await verifyDataPackageHashes(dataPackage), true, manifest.id);
  }
});

test("both frozen catalog versions expose 36 exact immutable package contracts", () => {
  const versions = ["3904c28aabcbc405", "3bcb588eaf291763"];
  assert.equal(Object.keys(HISTORICAL_PACKAGE_CONTRACTS).length, 36);
  for (const version of versions) {
    for (const manifest of MAP_FAMILIES.filter((family) => family.id !== "annotated-specimen")) {
      const incumbent = requireCatalogFamily(manifest.id).members.find((member) =>
        member.status === "executable" && member.payload?.kind === manifest.transformation.payload.kind);
      const key = `${version}/${manifest.id}/${incumbent.id}`;
      const contract = historicalPackageContractForMember(version, manifest.id, incumbent.id);
      assert.equal(HISTORICAL_PACKAGE_CONTRACTS[key], contract, key);
      assert.equal(Object.isFrozen(contract), true, key);
      assert.equal(contract.familyId, manifest.id, key);
      assert.equal(contract.memberId, incumbent.id, key);
      for (const role of [...contract.roles.required, ...contract.roles.optional]) {
        assert.ok(Array.isArray(role.types) && role.types.length > 0, `${key}/${role.id}`);
        assert.equal(Object.isFrozen(role.types), true, `${key}/${role.id}`);
      }
    }
  }
  assert.equal(
    historicalPackageContractForMember(versions[0], "rank", "bar-list"),
    historicalPackageContractForMember(versions[1], "rank", "bar-list"),
  );
  assert.throws(
    () => historicalPackageContractForMember(versions[0], "rank", "dot-plot"),
    (error) => error.code === "UNKNOWN_HISTORICAL_PACKAGE_CONTRACT",
  );
  assert.deepEqual(
    historicalPackageContractForMember(versions[0], "sequence", "step-strip")
      .roles.required.find((role) => role.id === "order").types,
    ["number", "time"],
  );
  assert.deepEqual(
    historicalPackageContractForMember(versions[0], "flow", "sankey")
      .roles.required.find((role) => role.id === "source").types,
    ["string"],
  );
});

test("both frozen catalog versions validate synthetic incumbent packages and the released faceted shape", async () => {
  const versions = ["3904c28aabcbc405", "3bcb588eaf291763"];
  const executableManifests = MAP_FAMILIES.filter(
    (manifest) => requireCatalogFamily(manifest.id).executableMemberIds.length > 0,
  );
  let verified = 0;
  for (const manifest of executableManifests) {
    const incumbent = requireCatalogFamily(manifest.id).members.find((member) =>
      member.status === "executable" && member.payload?.kind === manifest.transformation.payload.kind);
    const current = await compileMap({
      catalog: catalogReceiptForMember(manifest.id, incumbent.id),
      familyId: manifest.id,
      question: { text: manifest.questions.examples[0], target: `${manifest.title} historical fixture` },
      sourceBundle: sourceBundle(manifest.id),
      roleMapping: roleMapping(manifest.id),
    });
    const historicalContract = manifest.id === "collection-atlas"
      ? (() => {
          const marks = current.marks.map((mark, index) => ({
            ...mark,
            values: {
              x: index - 4.5,
              y: (index % 3) - 1,
              label: mark.values.label,
              similarity: index / current.marks.length,
            },
          }));
          return {
            roleMapping: { x: "x", y: "y", label: "label", similarity: "similarity" },
            marks,
            payload: {
              ...current.payload,
              items: marks.map((mark) => ({ markId: mark.id, ...mark.values })),
              clusters: [],
              domains: { x: [-4.5, 4.5], y: [-1, 1] },
            },
            provenance: {
              ...current.provenance,
              transformations: current.provenance.transformations.map((transformation) => ({
                ...transformation,
                roleMapping: { x: "x", y: "y", label: "label", similarity: "similarity" },
              })),
            },
          };
        })()
      : {
          roleMapping: current.roleMapping,
          marks: current.marks,
          payload: current.payload,
          provenance: current.provenance,
        };
    for (const version of versions) {
      const historical = await createDataPackage({
        family: manifest.id,
        catalog: historicalCatalogReceiptForMember(version, manifest.id, incumbent.id),
        question: current.question,
        scope: current.scope,
        sources: current.sources,
        roleMapping: historicalContract.roleMapping,
        marks: historicalContract.marks,
        payload: historicalContract.payload,
        presentation: {
          ...current.presentation,
          variant: HISTORICAL_PRESENTATION_VARIANTS[manifest.id],
        },
        provenance: historicalContract.provenance,
        quality: current.quality,
        execution: current.execution,
      });
      assert.equal(historical.catalog.version, version, `${version} ${manifest.id}`);
      assert.equal(
        historical.presentation.variant,
        HISTORICAL_PRESENTATION_VARIANTS[manifest.id],
        `${version} ${manifest.id}`,
      );
      assert.equal(await verifyDataPackageHashes(historical), true, `${version} ${manifest.id}`);
      const renderModel = renderModelForArtifact(historical);
      assert.equal(renderModel.renderer.familyId, manifest.id, `${version} ${manifest.id}`);
      assert.equal(renderModel.renderer.memberId, incumbent.id, `${version} ${manifest.id}`);
      if (manifest.id === "collection-atlas") {
        assert.deepEqual(historical.roleMapping, { label: "label", similarity: "similarity", x: "x", y: "y" });
        assert.ok(historical.marks.every((mark) => mark.values.cluster === undefined));
        assert.ok(historical.marks.every((mark) => Number.isFinite(mark.values.similarity)));
      }
      verified += 1;
    }
  }
  assert.equal(verified, 36);
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
  assert.deepEqual(first.marks.map((mark) => mark.label), ["Item 3", "Item 2", "Item 1"]);
});

test("faceted-atlas derives deterministic local placement from evidenced facets and order", async () => {
  const bundle = sourceBundle("collection-atlas");
  const mapping = roleMapping("collection-atlas");
  const dataPackage = await compileMap({
    catalog: catalogReceiptForMember("collection-atlas", "faceted-atlas"),
    familyId: "collection-atlas",
    question: "How is this collection arranged?",
    sourceBundle: bundle,
    roleMapping: mapping,
  });
  assert.deepEqual(dataPackage.payload.domains, { x: [10, 90], y: [12, 68] });
  assert.deepEqual(dataPackage.payload.clusters, ["A", "B"]);
  assert.deepEqual(
    dataPackage.payload.items.map(({ label, cluster, order, x, y }) => ({ label, cluster, order, x, y })),
    ["A", "B"].flatMap((cluster, clusterIndex) => Array.from({ length: 5 }, (_, itemIndex) => ({
      label: `Item ${clusterIndex * 5 + itemIndex + 1}`,
      cluster,
      order: itemIndex,
      x: clusterIndex === 0 ? 10 : 90,
      y: 12 + itemIndex * 14,
    }))),
  );
  assert.ok(dataPackage.marks.every((mark) => Object.keys(mark.values).every((role) => ["label", "cluster", "order"].includes(role))));

  const shuffled = await compileMap({
    catalog: catalogReceiptForMember("collection-atlas", "faceted-atlas"),
    familyId: "collection-atlas",
    question: "How is this collection arranged?",
    sourceBundle: { ...bundle, records: [...bundle.records].reverse() },
    roleMapping: mapping,
  });
  assert.deepEqual(shuffled.payload, dataPackage.payload);

  await assert.rejects(
    compileMap({
      catalog: catalogReceiptForMember("collection-atlas", "faceted-atlas"),
      familyId: "collection-atlas",
      question: "How is this collection arranged?",
      sourceBundle: bundle,
      roleMapping: { ...mapping, x: "x" },
    }),
    (error) => error.code === "UNKNOWN_ROLE" && error.path === "roleMapping.x",
  );
});

test("exact source media policy is enforced before broader family adaptation", async () => {
  const video = sourceBundle("passage-comparison", { medium: "video" });
  await assert.rejects(
    compileMap({
      catalog: catalogReceiptForMember("passage-comparison", "parallel-text"),
      familyId: "passage-comparison",
      question: "Compare these passages",
      sourceBundle: video,
      roleMapping: roleMapping("passage-comparison"),
    }),
    (error) => error instanceof PipelineContractError
      && error.code === "INELIGIBLE_REQUESTED_FORM"
      && error.failedRequirements.some((requirement) => requirement.id === "source-medium-policy"),
  );

  const annotatedMember = requireCatalogMember("annotated-specimen", "callout-overlay");
  assert.equal(annotatedMember.status, "unavailable");
  assert.match(annotatedMember.unavailableReason, /cannot bind and display the visible specimen/);
  assert.deepEqual(executableCatalogMembersForFamily("annotated-specimen"), []);
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
  cycle.records[0].fields.parentId = "branch_a";
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

const MATRIX_COLUMNS = ["Morning", "Midday", "Evening"];

function matrixBundle(rowValues) {
  return {
    kind: "attend-normalized-source-bundle",
    schemaVersion: 1,
    adapter: { id: "evidenced-records-v1", version: 1 },
    medium: "structured",
    requestedInputs: ["fixtures/normalized.jsonl"],
    sources: [{ ...SOURCE }],
    records: rowValues.flatMap((row, rowIndex) => MATRIX_COLUMNS.map((column, columnIndex) => ({
      id: `record_${String(rowIndex + 1).padStart(2, "0")}_${String(columnIndex + 1).padStart(2, "0")}`,
      sourceId: SOURCE.id,
      fields: { row, column, value: rowIndex * MATRIX_COLUMNS.length + columnIndex },
    }))),
  };
}

function compileMatrix(rowValues, options) {
  return compileMap({
    catalog: catalogReceiptForMember("matrix", "heatmap"),
    familyId: "matrix",
    question: { text: "When do sessions cluster?", target: "Matrix fixture" },
    sourceBundle: matrixBundle(rowValues),
    roleMapping: { row: "row", column: "column", value: "value" },
    ...(options ? { options } : {}),
  });
}

function matrixObservations(rowValues) {
  return rowValues.flatMap((row, rowIndex) => MATRIX_COLUMNS.map((column, columnIndex) => ({
    markId: `mark_${String(rowIndex).padStart(8, "0")}${String(columnIndex).padStart(8, "0")}`,
    roles: { row, column, value: rowIndex * MATRIX_COLUMNS.length + columnIndex },
    evidenceRefs: ["evidence_0000000000000000"],
    media: { type: "numeric-chart" },
  })));
}

test("ordinal category vocabularies order calendar, clock, quarter, and numeric values ahead of codepoints", () => {
  const sorted = (values) => [...values].sort(compareCategoryValues);

  assert.deepEqual(
    sorted(["Friday", "Monday", "Saturday", "Sunday", "Thursday", "Tuesday", "Wednesday"]),
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  );
  assert.deepEqual(sorted(["wed", "MON", "Fri"]), ["MON", "wed", "Fri"]);
  assert.deepEqual(sorted(["March", "February", "January"]), ["January", "February", "March"]);
  assert.deepEqual(sorted(["Dec", "Jan", "Jul"]), ["Jan", "Jul", "Dec"]);
  assert.deepEqual(sorted(["23:00", "09:30", "9:00"]), ["9:00", "09:30", "23:00"]);
  assert.deepEqual(sorted(["Q10", "Q9", "q2"]), ["q2", "Q9", "Q10"]);
  assert.deepEqual(sorted(["10", "2", "1"]), ["1", "2", "10"]);

  const weekdayAbbreviations = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const monthAbbreviations = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  assert.deepEqual(weekdayAbbreviations.filter((day) => monthAbbreviations.includes(day)), []);

  assert.deepEqual(sorted(["January", "Monday"]), ["Monday", "January"]);
  assert.deepEqual(sorted(["beta", "alpha"]), ["alpha", "beta"]);
  assert.equal(compareCategoryValues("Monday", "Monday"), 0);
  assert.ok(compareCategoryValues("Mon", "Monday") < 0);
});

test("category ordering is a total order, so a role sorts the same however its values arrive", () => {
  const permutations = (list) => (list.length <= 1 ? [list] : list.flatMap((item, index) =>
    permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])));

  for (const values of [
    ["Friday", "Monday", "Guess"],
    ["Sunday", "Someday", "Monday"],
    ["Q9", "Q10", "Q2", "zebra", "9:30"],
  ]) {
    const results = new Set(permutations(values)
      .map((order) => JSON.stringify([...order].sort(compareCategoryValues))));
    assert.equal(results.size, 1, `${values.join(", ")} must sort identically from every input order`);
  }
});

test("a weekday matrix compiles its rows in calendar order without configuration", async () => {
  const scrambled = ["Wednesday", "Sunday", "Friday", "Monday", "Thursday", "Saturday", "Tuesday"];
  const dataPackage = await compileMatrix(scrambled);

  assert.deepEqual(dataPackage.payload.rows, [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]);
  assert.deepEqual(dataPackage.payload.columns, ["Evening", "Midday", "Morning"]);
  assert.equal(dataPackage.payload.missingCellCount, 0);

  const markRows = [...new Set(dataPackage.marks.map((mark) => mark.values.row))];
  assert.deepEqual(markRows, dataPackage.payload.rows);
  assert.deepEqual([...new Set(dataPackage.payload.cells.map((cell) => cell.row))], dataPackage.payload.rows);
  assert.equal(await verifyDataPackageHashes(dataPackage), true);
});

test("declared categoryOrder drives compiled entry order and sorts undeclared values last", async () => {
  const rows = ["Small", "Large", "Medium", "Huge"];
  const dataPackage = await compileMatrix(rows, { categoryOrder: { row: ["Small", "Medium", "Large"] } });

  assert.deepEqual(
    [...new Set(dataPackage.marks.map((mark) => mark.values.row))],
    ["Small", "Medium", "Large", "Huge"],
  );
  assert.deepEqual(
    [...new Set(dataPackage.payload.cells.map((cell) => cell.row))],
    ["Small", "Medium", "Large", "Huge"],
  );
  assert.deepEqual(
    dataPackage.payload.rows,
    ["Small", "Medium", "Large", "Huge"],
    "the row header array must agree with the cell and mark order a renderer reads beside it",
  );
  assert.equal(await verifyDataPackageHashes(dataPackage), true);

  const unordered = await compileMatrix(rows);
  assert.deepEqual(
    [...new Set(unordered.marks.map((mark) => mark.values.row))],
    ["Huge", "Large", "Medium", "Small"],
  );
  assert.deepEqual(unordered.payload.rows, ["Huge", "Large", "Medium", "Small"]);
});

test("an absent categoryOrder leaves the compiled options hash untouched", async () => {
  const rows = ["Monday", "Tuesday", "Wednesday", "Thursday"];
  const optionsHash = (dataPackage) => dataPackage.provenance.transformations[0].optionsHash;
  const withoutOption = await compileMatrix(rows);
  const withEmptyOptions = await compileMatrix(rows, { availableWidth: 1_200 });
  const withOption = await compileMatrix(rows, { categoryOrder: { row: ["Thursday", "Monday"] } });

  assert.equal(optionsHash(withEmptyOptions), optionsHash(withoutOption));
  assert.notEqual(optionsHash(withOption), optionsHash(withoutOption));
});

test("matrix axis headers follow their observations so a package stays re-derivable from itself", () => {
  const form = requireExecutableForm("matrix", "heatmap");
  const declared = ["Small", "Medium", "Large", "Huge"];

  assert.deepEqual(projectFormPayload(form, matrixObservations(declared)).rows, declared);
  assert.deepEqual(
    projectFormPayload(form, matrixObservations([...declared].reverse())).rows,
    [...declared].reverse(),
    "the projector takes no ordering option of its own; whoever ordered the observations decides",
  );
});

test("malformed categoryOrder options fail closed at the pipeline boundary", async () => {
  const rows = ["Monday", "Tuesday", "Wednesday", "Thursday"];
  const rejects = (categoryOrder, path) => assert.rejects(
    compileMatrix(rows, { categoryOrder }),
    (error) => error instanceof PipelineContractError && error.code === "INVALID_OPTIONS" && error.path === path,
  );

  await rejects("Monday", "options.categoryOrder");
  await rejects(["Monday"], "options.categoryOrder");
  await rejects({ row: "Monday" }, "options.categoryOrder.row");
  await rejects({ row: [] }, "options.categoryOrder.row");
  await rejects({ row: ["Monday", 7] }, "options.categoryOrder.row[1]");
  await rejects({ row: ["Monday", "  "] }, "options.categoryOrder.row[1]");
  await rejects({ row: ["Monday", "Monday"] }, "options.categoryOrder.row[1]");
  await rejects({ "not a role": ["Monday"] }, "options.categoryOrder.not a role");
  await assert.rejects(
    compileMatrix(rows, { categoryOrder: { row: ["Monday"] }, unknownOption: 1 }),
    (error) => error.code === "INVALID_OPTIONS" && error.path === "options.unknownOption",
  );
});
