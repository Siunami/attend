import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { atlasV2Adapter, resolveArtifactVisualTarget } from "../src/artifacts/atlas-v2.js";
import { CATALOG_COUNTS, catalogReceiptForMember } from "../src/catalog/index.js";
import {
  FORM_DEFINITIONS,
  evaluateFormEligibility,
  evaluateFormRequirement,
  evaluateFormSourcePolicy,
  projectFormPayload,
  requireExecutableForm,
  resolveVisualTarget,
} from "../src/forms/index.js";
import { GOVERNED_FORM_MODULES } from "../src/forms/governed.js";
import { sha256HexSync } from "../src/forms/sha256.js";
import { PipelineContractError, compileMap } from "../src/pipeline/compile.js";
import { createDataPackage } from "../src/pipeline/data-package.js";

const SOURCE = Object.freeze({
  id: "source_fixture",
  displayPath: "fixtures/forms.jsonl",
  sha256: "a".repeat(64),
  kind: "normalized-records",
  byteLength: 16_384,
});

function inputFor(familyId, memberId, values, roleMapping) {
  return {
    familyId,
    catalog: catalogReceiptForMember(familyId, memberId),
    question: `Can ${memberId} answer this exact question?`,
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: { id: "evidenced-records-v1", version: 1 },
      medium: "structured",
      requestedInputs: [SOURCE.displayPath],
      sources: [SOURCE],
      records: values.map((fields, index) => ({
        id: `record_${String(index).padStart(5, "0")}`,
        sourceId: SOURCE.id,
        fields,
        evidenceRefs: [{
          sourceId: SOURCE.id,
          locator: { kind: "row", index },
          quote: Object.values(fields).join(" · "),
        }],
      })),
    },
    roleMapping,
  };
}

function repackageWithPayload(dataPackage, payload) {
  return createDataPackage({
    family: dataPackage.family.id,
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

function formObservations(definition, records) {
  return records.map((roles, index) => ({
    markId: `mark_${String(index).padStart(5, "0")}`,
    roles: structuredClone(roles),
    evidenceRefs: ["evidence_0000000000000000"],
    media: definition.key === "collection-atlas/contact-atlas"
      ? { type: "image", mimeType: "image/jpeg" }
      : { type: "numeric-chart" },
  }));
}

function observationsWithDistinctValues(requirement, count) {
  return Array.from({ length: count }, (_, index) => ({
    markId: `mark_${index}`,
    roles: { [requirement.field]: `value_${index}` },
  }));
}

function hierarchyWithLeaves(count) {
  return [
    { markId: "mark_root", roles: { id: "root", label: "Root" } },
    ...Array.from({ length: count }, (_, index) => ({
      markId: `mark_leaf_${index}`,
      roles: { id: `leaf_${index}`, parentId: "root", label: `Leaf ${index}`, value: 1 },
    })),
  ];
}

function directedChain(requirement, nodeCount, value = 1) {
  if (nodeCount < 2) return [];
  return Array.from({ length: nodeCount - 1 }, (_, index) => ({
    markId: `mark_edge_${index}`,
    roles: {
      [requirement.sourceField]: `node_${index}`,
      [requirement.targetField]: `node_${index + 1}`,
      ...(requirement.valueField ? { [requirement.valueField]: value } : {}),
    },
  }));
}

function regularGrid(requirement, width, height) {
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => ({
    markId: `mark_${x}_${y}`,
    roles: { [requirement.xField]: x, [requirement.yField]: y },
  }))).flat();
}

function structuralFailure(requirement, observations, context) {
  const copy = structuredClone(observations);
  switch (requirement.kind) {
    case "unique-tuple":
      if (copy.length === 1) copy.push({ ...structuredClone(copy[0]), markId: "mark_duplicate_tuple" });
      for (const field of requirement.fields) copy[1].roles[field] = copy[0].roles[field];
      return { observations: copy, context };
    case "required-fields":
      delete copy[0].roles[requirement.fields[0]];
      return { observations: copy, context };
    case "numeric-range": {
      const invalid = requirement.exclusiveMinimum ?? (requirement.minimum === undefined
        ? (requirement.maximum === undefined ? Number.NaN : requirement.maximum + 1)
        : requirement.minimum - 1);
      copy[0].roles[requirement.field] = invalid;
      return { observations: copy, context };
    }
    case "numeric-aggregate":
      for (const item of copy) item.roles[requirement.field] = 0;
      return { observations: copy, context };
    case "complete-cartesian":
      copy.push({ ...structuredClone(copy[0]), markId: "mark_duplicate_cartesian_cell" });
      return { observations: copy, context };
    case "time-order":
      copy[0].roles[requirement.startField] = "2026-01-02T00:00:00Z";
      copy[0].roles[requirement.endField] = "2026-01-01T00:00:00Z";
      return { observations: copy, context };
    case "hierarchy-tree": {
      const child = copy.find((item) => item.roles[requirement.parentField ?? "parentId"] !== undefined);
      child.roles[requirement.parentField ?? "parentId"] = "missing_parent";
      return { observations: copy, context };
    }
    case "directed-graph":
      copy[0].roles[requirement.targetField] = copy[0].roles[requirement.sourceField];
      return { observations: copy, context };
    case "directed-flow":
      copy[0].roles[requirement.valueField] = requirement.minimumValue - 1;
      return { observations: copy, context };
    case "one-to-one-mapping": {
      const left = copy[0].roles[requirement.leftField];
      const duplicateLeft = copy.find((item, index) => index > 0 && item.roles[requirement.leftField] === left);
      duplicateLeft.roles[requirement.rightField] = "conflicting_order";
      return { observations: copy, context };
    }
    case "absent-fields":
      copy[0].roles[requirement.fields[0]] = "unexpected";
      return { observations: copy, context };
    case "hierarchy-depth":
      return {
        observations: Array.from({ length: requirement.maximum + 1 }, (_, index) => ({
          markId: `mark_depth_${index}`,
          roles: { id: `node_${index}`, label: `Node ${index}`, ...(index ? { parentId: `node_${index - 1}` } : {}) },
        })),
        context,
      };
    case "hierarchy-leaf-values": {
      const parents = new Set(copy.map((item) => item.roles.parentId).filter(Boolean).map(String));
      const leaf = copy.find((item) => !parents.has(String(item.roles.id)));
      leaf.roles.value = 0;
      return { observations: copy, context };
    }
    case "geography-binding":
      copy[0].roles[requirement.field] = "not-a-region";
      return { observations: copy, context };
    case "regular-grid":
      copy.pop();
      return { observations: copy, context };
    case "nonconstant":
      for (const item of copy) item.roles[requirement.field] = 1;
      return { observations: copy, context };
    case "adapter-policy":
      return { observations: copy, context: { ...context, adapter: { id: "wrong-adapter" } } };
    case "media-policy":
      copy[0].media.mimeType = "image/png";
      return { observations: copy, context };
    default:
      return null;
  }
}

test("universal synchronous SHA-256 matches node:crypto across encoding and block boundaries", () => {
  const inputs = [
    "",
    "Attend",
    "相机本地时间 · café · 📷",
    "multi-block-input:".repeat(64),
  ];
  for (const input of inputs) {
    const expected = createHash("sha256").update(input, "utf8").digest("hex");
    assert.equal(sha256HexSync(input), expected, JSON.stringify(input.slice(0, 32)));
  }
});

test("all 34 executable forms have exact governed contracts and separate authored/runtime bands", () => {
  assert.deepEqual(CATALOG_COUNTS, {
    families: 19,
    approved: 106,
    documented: 71,
    executable: 34,
    unavailable: 1,
    rejected: 38,
  });
  assert.equal(FORM_DEFINITIONS.length, 34);
  assert.equal(GOVERNED_FORM_MODULES.length, 34);
  assert.equal(new Set(GOVERNED_FORM_MODULES.map((module) => module.descriptor.key)).size, 34);
  for (const definition of FORM_DEFINITIONS) {
    assert.equal(typeof definition.quantityBands.authored, "string", definition.key);
    assert.ok(Array.isArray(definition.quantityBands.executable), definition.key);
    assert.match(definition.browserRendererModule, /^\.\/forms\//u, definition.key);
    assert.ok(definition.fixtureId.endsWith("fixture-v1"), definition.key);
    assert.equal(definition.renderer.variant.length > 0, true, definition.key);
    assert.ok(definition.guidance.preferWhen.length > 20, `${definition.key} preferWhen`);
    assert.ok(Array.isArray(definition.guidance.preferOver), `${definition.key} preferOver`);
    assert.ok(definition.guidance.avoidWhen.length > 20, `${definition.key} avoidWhen`);
    assert.ok(definition.guidance.abstainWhen.length > 20, `${definition.key} abstainWhen`);
    assert.notEqual(definition.guidance.preferWhen, `The question matches the fixed ${definition.memberId} instrument.`, definition.key);
    const governed = GOVERNED_FORM_MODULES.find((module) => module.descriptor.key === definition.key);
    assert.equal(governed.fixture.id, definition.fixtureId, definition.key);
    assert.ok(governed.fixture.records.length > 0, definition.key);
    const fixtureEligibility = evaluateFormEligibility(
      definition,
      governed.fixture.records.map((roles, index) => ({
        markId: `mark_${index}`,
        roles,
        media: definition.key === "collection-atlas/contact-atlas"
          ? { type: "image", mimeType: "image/jpeg" }
          : { type: "numeric-chart" },
      })),
      { adapter: { id: governed.fixture.adapter } },
    );
    assert.equal(fixtureEligibility.eligible, true, `${definition.key} fixture`);
  }
  assert.notEqual(
    requireExecutableForm("distribution", "ecdf").quantityBands.authored,
    JSON.stringify(requireExecutableForm("distribution", "ecdf").quantityBands.executable),
  );
  assert.throws(
    () => evaluateFormRequirement({ id: "misspelled", kind: "record-cont" }, []),
    (error) => error.code === "UNKNOWN_FORM_REQUIREMENT",
  );
});

test("all 34 form descriptors encode below, at, and above every declared quantity bound", () => {
  const countKinds = new Set([
    "record-count",
    "distinct-count",
    "hierarchy-leaf-count",
    "graph-node-count",
    "directed-graph",
    "directed-flow",
    "regular-grid",
    "group-size",
  ]);
  let checkedRequirements = 0;
  for (const definition of FORM_DEFINITIONS) {
    const requirements = definition.requirements.filter((requirement) => countKinds.has(requirement.kind));
    assert.ok(requirements.length > 0, `${definition.key} must declare an executable quantity gate`);
    for (const requirement of requirements) {
      checkedRequirements += 1;
      const pass = (observations) => evaluateFormRequirement(requirement, observations, {});
      if (requirement.kind === "record-count") {
        assert.equal(pass({ length: requirement.minimum - 1 }), false, `${definition.key}/${requirement.id} below minimum`);
        assert.equal(pass({ length: requirement.minimum }), true, `${definition.key}/${requirement.id} at minimum`);
        assert.equal(pass({ length: requirement.maximum }), true, `${definition.key}/${requirement.id} at maximum`);
        assert.equal(pass({ length: requirement.maximum + 1 }), false, `${definition.key}/${requirement.id} above maximum`);
      } else if (requirement.kind === "distinct-count") {
        assert.equal(pass(observationsWithDistinctValues(requirement, requirement.minimum - 1)), false, `${definition.key}/${requirement.id} below minimum`);
        assert.equal(pass(observationsWithDistinctValues(requirement, requirement.minimum)), true, `${definition.key}/${requirement.id} at minimum`);
        assert.equal(pass(observationsWithDistinctValues(requirement, requirement.maximum)), true, `${definition.key}/${requirement.id} at maximum`);
        assert.equal(pass(observationsWithDistinctValues(requirement, requirement.maximum + 1)), false, `${definition.key}/${requirement.id} above maximum`);
      } else if (requirement.kind === "hierarchy-leaf-count") {
        assert.equal(pass(hierarchyWithLeaves(requirement.minimum - 1)), false, `${definition.key}/${requirement.id} below minimum`);
        assert.equal(pass(hierarchyWithLeaves(requirement.minimum)), true, `${definition.key}/${requirement.id} at minimum`);
        assert.equal(pass(hierarchyWithLeaves(requirement.maximum)), true, `${definition.key}/${requirement.id} at maximum`);
        assert.equal(pass(hierarchyWithLeaves(requirement.maximum + 1)), false, `${definition.key}/${requirement.id} above maximum`);
      } else if (requirement.kind === "graph-node-count" || requirement.kind === "directed-graph") {
        const minimum = requirement.minimum ?? requirement.minimumNodes;
        const maximum = requirement.maximum ?? requirement.maximumNodes;
        assert.equal(pass(directedChain(requirement, minimum - 1)), false, `${definition.key}/${requirement.id} below minimum`);
        assert.equal(pass(directedChain(requirement, minimum)), true, `${definition.key}/${requirement.id} at minimum`);
        assert.equal(pass(directedChain(requirement, maximum)), true, `${definition.key}/${requirement.id} at maximum`);
        assert.equal(pass(directedChain(requirement, maximum + 1)), false, `${definition.key}/${requirement.id} above maximum`);
        if (requirement.kind === "directed-graph") {
          const atDegree = [
            ["root", "a"], ["root", "b"], ["root", "c"], ["c", "d"],
          ].map(([source, target], index) => ({ markId: `mark_degree_${index}`, roles: { [requirement.sourceField]: source, [requirement.targetField]: target } }));
          assert.equal(pass(atDegree), true, `${definition.key}/${requirement.id} at degree maximum`);
          const aboveDegree = atDegree.slice(0, 3).concat({ markId: "mark_degree_4", roles: { [requirement.sourceField]: "root", [requirement.targetField]: "d" } });
          assert.equal(pass(aboveDegree), false, `${definition.key}/${requirement.id} above degree maximum`);
        }
      } else if (requirement.kind === "directed-flow") {
        assert.equal(pass(directedChain(requirement, requirement.minimumStages, requirement.minimumValue)), true, `${definition.key}/${requirement.id} at minimum stage/value`);
        assert.equal(pass([{ markId: "mark_self", roles: { [requirement.sourceField]: "only", [requirement.targetField]: "only", [requirement.valueField]: requirement.minimumValue } }]), false, `${definition.key}/${requirement.id} below minimum stages`);
        assert.equal(pass(directedChain(requirement, requirement.maximumStages)), true, `${definition.key}/${requirement.id} at maximum stages`);
        assert.equal(pass(directedChain(requirement, requirement.maximumStages + 1)), false, `${definition.key}/${requirement.id} above maximum stages`);
        const atMaximumNodes = Array.from({ length: requirement.maximumNodes - 1 }, (_, index) => ({ markId: `mark_flow_${index}`, roles: { [requirement.sourceField]: "root", [requirement.targetField]: `leaf_${index}`, [requirement.valueField]: 1 } }));
        assert.equal(pass(atMaximumNodes), true, `${definition.key}/${requirement.id} at maximum nodes`);
        const aboveMaximumNodes = atMaximumNodes.concat({ markId: "mark_flow_above", roles: { [requirement.sourceField]: "root", [requirement.targetField]: "extra_leaf", [requirement.valueField]: 1 } });
        assert.equal(pass(aboveMaximumNodes), false, `${definition.key}/${requirement.id} above maximum nodes`);
        const belowValue = directedChain(requirement, requirement.minimumStages, requirement.minimumValue - 1);
        assert.equal(pass(belowValue), false, `${definition.key}/${requirement.id} below minimum value`);
      } else if (requirement.kind === "regular-grid") {
        assert.equal(pass(regularGrid(requirement, requirement.minimumWidth - 1, requirement.minimumHeight)), false, `${definition.key}/${requirement.id} below minimum width`);
        assert.equal(pass(regularGrid(requirement, requirement.minimumWidth, requirement.minimumHeight - 1)), false, `${definition.key}/${requirement.id} below minimum height`);
        assert.equal(pass(regularGrid(requirement, requirement.minimumWidth, requirement.minimumHeight)), true, `${definition.key}/${requirement.id} at minimum dimensions`);
        assert.equal(pass(regularGrid(requirement, 200, 250)), true, `${definition.key}/${requirement.id} at maximum samples`);
        assert.equal(pass(regularGrid(requirement, 201, 250)), false, `${definition.key}/${requirement.id} above maximum samples`);
      } else if (requirement.kind === "group-size") {
        const groups = (groupCount, itemCount) => Array.from({ length: groupCount }, (_, group) =>
          Array.from({ length: itemCount }, (_, item) => ({ markId: `mark_${group}_${item}`, roles: { [requirement.field]: `group_${group}` } }))).flat();
        assert.equal(pass(groups(requirement.minimumGroups - 1, requirement.minimumItems)), false);
        assert.equal(pass(groups(requirement.minimumGroups, requirement.minimumItems)), true);
        assert.equal(pass(groups(requirement.maximumGroups, requirement.minimumItems)), true);
        assert.equal(pass(groups(requirement.maximumGroups + 1, requirement.minimumItems)), false);
        assert.equal(pass(groups(requirement.minimumGroups, requirement.minimumItems - 1)), false);
        assert.equal(pass(groups(requirement.minimumGroups, requirement.maximumItems)), true);
        assert.equal(pass(groups(requirement.minimumGroups, requirement.maximumItems + 1)), false);
      }
    }
  }
  assert.ok(checkedRequirements >= FORM_DEFINITIONS.length);
});

test("every governed fixture demonstrates each applicable structural abstention gate", () => {
  const countKinds = new Set(["record-count", "distinct-count", "hierarchy-leaf-count", "graph-node-count", "group-size"]);
  let checkedRequirements = 0;
  for (const governed of GOVERNED_FORM_MODULES) {
    const { descriptor, fixture } = governed;
    const observations = formObservations(descriptor, fixture.records);
    const context = { adapter: { id: fixture.adapter } };
    for (const requirement of descriptor.requirements) {
      if (countKinds.has(requirement.kind) || ["field-evidence", "renderer-binding"].includes(requirement.kind)) continue;
      assert.equal(evaluateFormRequirement(requirement, observations, context), true, `${descriptor.key}/${requirement.id} fixture baseline`);
      const invalid = structuralFailure(requirement, observations, context);
      if (!invalid) continue;
      checkedRequirements += 1;
      assert.equal(
        evaluateFormRequirement(requirement, invalid.observations, invalid.context),
        false,
        `${descriptor.key}/${requirement.id} structural abstention`,
      );
    }
  }
  assert.ok(checkedRequirements >= 40);
});

test("every governed fixture uses its exact declared source adapter, version, and medium", () => {
  for (const governed of GOVERNED_FORM_MODULES) {
    const medium = governed.descriptor.key === "collection-atlas/contact-atlas" ? "image" : "structured";
    const result = evaluateFormSourcePolicy(governed.descriptor, {
      adapter: { id: governed.fixture.adapter, version: 1 },
      medium,
    });
    assert.deepEqual(result, { eligible: true, failedRequirements: [] }, governed.descriptor.key);
  }

  const form = requireExecutableForm("rank", "dot-plot");
  assert.deepEqual(
    evaluateFormSourcePolicy(form, { adapter: { id: "forged-adapter", version: 99 }, medium: "image" }),
    {
      eligible: false,
      failedRequirements: [
        { adapterIds: ["evidenced-records-v1"], id: "source-adapter-policy", kind: "adapter-policy" },
        { id: "source-medium-policy", kind: "media-policy", media: ["structured", "text"] },
      ],
    },
  );
  assert.equal(
    evaluateFormSourcePolicy(form, { adapter: { id: "evidenced-records-v1", version: 99 }, medium: "structured" }).eligible,
    false,
  );
});

test("histogram records deterministic FD/Sturges bins and aggregate selection recomputes membership", async () => {
  const values = Array.from({ length: 50 }, () => ({ value: 7 }));
  const dataPackage = await compileMap(inputFor(
    "distribution",
    "histogram",
    values,
    { value: "value" },
  ));
  assert.equal(dataPackage.presentation.variant, "histogram");
  assert.equal(dataPackage.payload.binning.method, "sturges");
  assert.equal(dataPackage.payload.bins.length >= 8, true);
  assert.equal(dataPackage.payload.bins.reduce((sum, bin) => sum + bin.count, 0), 50);
  assert.equal(dataPackage.payload.bins.filter((bin) => bin.count > 0).length, 1);

  const populated = dataPackage.payload.bins.find((bin) => bin.count > 0);
  const state = atlasV2Adapter.initialState(dataPackage, { targetId: populated.targetId });
  assert.deepEqual(state.markIds, []);
  assert.equal(state.targetId, populated.targetId);
  const selection = atlasV2Adapter.buildSelection(dataPackage, state);
  assert.equal(selection.target.count, 50);
  assert.equal(selection.marks.length, 12);
  assert.equal(selection.omissionCount, 38);
  assert.equal(selection.evidenceRefCount, 50);
  const page = await resolveArtifactVisualTarget(dataPackage, populated.targetId, { offset: 10, limit: 7 });
  assert.equal(page.count, 50);
  assert.equal(page.markIds.length, 7);
  assert.equal(page.page.nextOffset, 17);

  const forged = structuredClone(dataPackage.payload);
  forged.visualTargets.find((target) => target.id === populated.targetId).membershipHash = "0".repeat(64);
  assert.throws(
    () => resolveVisualTarget(
      requireExecutableForm("distribution", "histogram"),
      populated.targetId,
      dataPackage.marks.map((mark) => ({ markId: mark.id, roles: mark.values, evidenceRefs: mark.evidenceRefs, media: mark.media })),
      forged,
    ),
    (error) => error.code === "VISUAL_TARGET_MISMATCH",
  );
});

test("exact-form target validation rejects foreign and extra self-consistent predicates", async () => {
  const dataPackage = await compileMap(inputFor(
    "distribution",
    "histogram",
    Array.from({ length: 50 }, () => ({ value: 7 })),
    { value: "value" },
  ));
  const markIds = dataPackage.marks.map((mark) => mark.id).sort();
  const membershipHash = sha256HexSync(JSON.stringify(markIds));

  const foreign = structuredClone(dataPackage.payload);
  foreign.visualTargets.push({
    id: `target_${sha256HexSync("foreign-ecdf-target").slice(0, 16)}`,
    kind: "ecdf-step",
    label: "≤ 7",
    threshold: 7,
    operator: "lte",
    count: markIds.length,
    membershipHash,
  });
  await assert.rejects(
    repackageWithPayload(dataPackage, foreign),
    (error) => error.code === "INVALID_VISUAL_TARGET",
  );

  const extra = structuredClone(dataPackage.payload);
  const extraTarget = {
    id: `target_${sha256HexSync("extra-histogram-target").slice(0, 16)}`,
    kind: "histogram-bin",
    label: "7–7",
    index: 999,
    lower: 7,
    upper: 7,
    includeUpper: true,
    count: markIds.length,
    membershipHash,
  };
  extra.visualTargets.push(extraTarget);
  await assert.rejects(
    repackageWithPayload(dataPackage, extra),
    (error) => error.code === "INVALID_PAYLOAD"
      && error.path === "dataPackage.payload",
  );
  assert.throws(
    () => resolveVisualTarget(
      requireExecutableForm("distribution", "histogram"),
      extraTarget.id,
      dataPackage.marks.map((mark) => ({ markId: mark.id, roles: mark.values })),
      extra,
    ),
    (error) => error.code === "VISUAL_TARGET_MISMATCH",
  );
});

test("ECDF ties, state durations, hierarchy totals, and contour thresholds stay semantic", async () => {
  const ecdf = await compileMap(inputFor(
    "distribution",
    "ecdf",
    Array.from({ length: 20 }, (_, index) => ({ value: index < 5 ? 1 : index })),
    { value: "value" },
  ));
  assert.deepEqual(ecdf.payload.steps[0], {
    count: 5,
    share: 0.25,
    targetId: ecdf.payload.steps[0].targetId,
    value: 1,
  });

  const ribbon = await compileMap(inputFor(
    "sequence",
    "state-ribbon",
    [
      { order: 1, label: "Read", duration: 2 },
      { order: 2, label: "Edit", duration: 3 },
      { order: 3, label: "Publish", duration: 5 },
    ],
    { order: "order", label: "label", duration: "duration" },
  ));
  assert.deepEqual(ribbon.payload.states.map((state) => state.share), [0.2, 0.3, 0.5]);
  assert.equal(ribbon.payload.states.at(-1).endShare, 1);

  const hierarchy = await compileMap(inputFor(
    "hierarchy",
    "icicle",
    [
      { id: "root", label: "Root" },
      { id: "a", parentId: "root", label: "A" },
      { id: "b", parentId: "root", label: "B", value: 2 },
      { id: "a1", parentId: "a", label: "A1", value: 3 },
      { id: "a2", parentId: "a", label: "A2", value: 5 },
    ],
    { id: "id", label: "label", parentId: "parentId", value: "value" },
  ));
  const nodes = new Map(hierarchy.payload.nodes.map((node) => [node.id, node]));
  assert.equal(nodes.get("a").total, 8);
  assert.equal(nodes.get("root").total, 10);

  const grid = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => ({ x, y, value: x + y }))).flat();
  const contours = await compileMap(inputFor(
    "field",
    "contours",
    grid,
    { x: "x", y: "y", value: "value" },
  ));
  assert.equal(contours.payload.thresholds.length, 10);
  assert.equal(new Set(contours.payload.thresholds).size, 10);
  assert.equal(contours.payload.levels.length, 10);
});

test("ECDF keeps cumulative semantics linear at its 50,000-observation runtime bound", () => {
  const observations = Array.from({ length: 50_000 }, (_, value) => ({
    markId: `mark_${String(value).padStart(5, "0")}`,
    roles: { value },
    evidenceRefs: ["evidence_0000000000000000"],
    media: { type: "numeric-chart" },
  }));
  const started = performance.now();
  const forward = projectFormPayload(requireExecutableForm("distribution", "ecdf"), observations);
  const reverse = projectFormPayload(requireExecutableForm("distribution", "ecdf"), [...observations].reverse());
  const elapsed = performance.now() - started;

  assert.equal(forward.steps.length, 50_000);
  assert.equal(forward.visualTargets.length, 64);
  assert.ok(forward.steps.filter((step) => step.targetId).length <= 64);
  assert.equal(forward.steps.at(-1).count, 50_000);
  assert.equal(forward.steps.at(-1).share, 1);
  assert.equal(forward.visualTargets.at(-1).count, 50_000);
  assert.deepEqual(reverse.steps, forward.steps);
  assert.ok(elapsed < 5_000, `50k ECDF projections took ${Math.round(elapsed)} ms`);
});

test("outline validates and projects a 5,000-node chain without recursive or quadratic branch work", () => {
  const observations = Array.from({ length: 5_000 }, (_, index) => ({
    markId: `mark_${String(index).padStart(5, "0")}`,
    roles: {
      id: `node_${index}`,
      label: `Node ${index}`,
      order: 0,
      ...(index === 0 ? {} : { parentId: `node_${index - 1}` }),
    },
    evidenceRefs: ["evidence_0000000000000000"],
    media: { type: "numeric-chart" },
  }));
  const form = requireExecutableForm("hierarchy", "outline");
  const started = performance.now();
  const eligibility = evaluateFormEligibility(form, observations, {
    adapter: { id: "evidenced-records-v1" },
  });
  const payload = projectFormPayload(form, observations);
  const elapsed = performance.now() - started;

  assert.equal(eligibility.eligible, true);
  assert.equal(payload.nodes.length, 5_000);
  assert.equal(payload.maximumDepth, 4_999);
  assert.deepEqual(payload.visualTargets.map((target) => target.count), [5_000, 4_999]);
  assert.equal(payload.nodes[2].targetId, undefined);
  assert.ok(elapsed < 5_000, `5k outline projection took ${Math.round(elapsed)} ms`);
});

test("hierarchy forms project shuffled input through their declared deterministic child order", () => {
  const outlineForm = requireExecutableForm("hierarchy", "outline");
  const outlineRecords = [
    { id: "branch_b", parentId: "root", label: "Branch B", order: 2 },
    { id: "leaf_a2", parentId: "branch_a", label: "Leaf A2", order: 2 },
    { id: "root", label: "Root", order: 0 },
    { id: "branch_a", parentId: "root", label: "Branch A", order: 1 },
    { id: "leaf_a1", parentId: "branch_a", label: "Leaf A1", order: 1 },
  ];
  const outlineObservations = formObservations(outlineForm, outlineRecords);
  const outline = projectFormPayload(outlineForm, outlineObservations);
  const reversedOutline = projectFormPayload(outlineForm, [...outlineObservations].reverse());
  assert.equal(outlineForm.projector.orderPolicy, "evidenced-sibling-order-preorder");
  assert.deepEqual(reversedOutline, outline);
  assert.deepEqual(outline.nodes.map((node) => node.id), ["root", "branch_a", "leaf_a1", "leaf_a2", "branch_b"]);
  assert.deepEqual(outline.nodes.map((node) => node.path), [
    "Root",
    "Root / Branch A",
    "Root / Branch A / Leaf A1",
    "Root / Branch A / Leaf A2",
    "Root / Branch B",
  ]);

  const areaRecords = [
    { id: "branch_b", parentId: "root", label: "Branch B", value: 2 },
    { id: "leaf_a1", parentId: "branch_a", label: "Leaf A1", value: 3 },
    { id: "root", label: "Root" },
    { id: "leaf_a2", parentId: "branch_a", label: "Leaf A2", value: 5 },
    { id: "branch_a", parentId: "root", label: "Branch A" },
  ];
  for (const memberId of ["icicle", "treemap"]) {
    const form = requireExecutableForm("hierarchy", memberId);
    const observations = formObservations(form, areaRecords);
    const projected = projectFormPayload(form, observations);
    assert.equal(form.projector.orderPolicy, "derived-total-descending-then-id");
    assert.deepEqual(projectFormPayload(form, [...observations].reverse()), projected, memberId);
    assert.deepEqual(projected.nodes.map((node) => node.id), ["root", "branch_a", "leaf_a2", "leaf_a1", "branch_b"], memberId);
  }
});

test("slopegraph start and end follow source-backed state order", async () => {
  const values = Array.from({ length: 5 }, (_, index) => [
    { label: `Item ${index + 1}`, state: "Before", stateOrder: 1, value: index + 1 },
    { label: `Item ${index + 1}`, state: "After", stateOrder: 2, value: 6 - index },
  ]).flat();
  const dataPackage = await compileMap(inputFor(
    "rank",
    "slopegraph",
    values,
    { label: "label", state: "state", stateOrder: "stateOrder", value: "value" },
  ));
  assert.deepEqual(dataPackage.payload.states, [
    { label: "Before", order: 1 },
    { label: "After", order: 2 },
  ]);
  assert.equal(dataPackage.payload.segments[0].start.state, "Before");
  assert.equal(dataPackage.payload.segments[0].end.state, "After");

  const conflicting = values.map((value, index) => ({
    markId: `mark_${index}`,
    roles: { ...value, ...(value.state === "Before" && index === 2 ? { stateOrder: 3 } : {}) },
  }));
  const eligibility = evaluateFormEligibility(requireExecutableForm("rank", "slopegraph"), conflicting);
  assert.equal(eligibility.eligible, false);
  assert.ok(eligibility.failedRequirements.some((requirement) => requirement.id === "evidenced-state-order"));
});

test("contact atlas discloses unknown timezone and bounded timestamp tie counts", () => {
  const form = requireExecutableForm("collection-atlas", "contact-atlas");
  assert.deepEqual(form.projector, {
    id: "attend-collection-atlas-contact-atlas-projector-v2",
    version: 2,
  });
  const fixture = GOVERNED_FORM_MODULES.find((module) => module.descriptor.key === form.key).fixture;
  const untiedObservations = formObservations(form, fixture.records);
  const untied = projectFormPayload(form, untiedObservations);
  assert.deepEqual(untied.captureTimeDisclosure, {
    basis: "camera-local DateTimeOriginal",
    tieBreak: "verified source order; normalized relative-path values are not published",
    tieStatement: "No capture timestamps are tied.",
    tiedItemCount: 0,
    tiedTimestampGroupCount: 0,
    timezoneStatement: "Camera-local DateTimeOriginal values have no verified timezone.",
    timezoneStatus: "unknown",
    unknownTimezoneCount: 12,
  });

  const tiedObservations = structuredClone(untiedObservations);
  tiedObservations[1].roles.captureTime = tiedObservations[0].roles.captureTime;
  tiedObservations[3].roles.captureTime = tiedObservations[2].roles.captureTime;
  tiedObservations[4].roles.captureTime = tiedObservations[2].roles.captureTime;
  const tied = projectFormPayload(form, tiedObservations);
  assert.equal(tied.captureTimeDisclosure.tiedTimestampGroupCount, 2);
  assert.equal(tied.captureTimeDisclosure.tiedItemCount, 5);
  assert.equal(
    tied.captureTimeDisclosure.tieStatement,
    "5 images share 2 capture timestamps; verified source order resolves ties.",
  );
  assert.deepEqual(
    projectFormPayload(form, [...tiedObservations].reverse()),
    tied,
  );

  const dstBoundary = structuredClone(untiedObservations);
  dstBoundary.forEach((observation, index) => {
    observation.roles.captureTime = index === 0
      ? "2026-03-08T03:00:00"
      : index === 1
        ? "2026-03-08T02:30:00"
        : `2026-03-08T${String(index + 3).padStart(2, "0")}:00:00`;
  });
  const dstPayload = projectFormPayload(form, dstBoundary);
  assert.deepEqual(
    dstPayload.captureOrder.slice(0, 2),
    [dstBoundary[1].markId, dstBoundary[0].markId],
    "camera-local time sorts lexically without host-timezone DST coercion",
  );
});

test("exact incompatible forms and caller-controlled variants fail without substitution", async () => {
  const shortHistogram = inputFor(
    "distribution",
    "histogram",
    Array.from({ length: 49 }, (_, value) => ({ value })),
    { value: "value" },
  );
  await assert.rejects(
    compileMap(shortHistogram),
    (error) => error instanceof PipelineContractError
      && error.code === "INELIGIBLE_REQUESTED_FORM"
      && error.memberId === "histogram"
      && error.failedRequirements.some((requirement) => requirement.id === "record-count"),
  );
  await assert.rejects(
    compileMap({ ...shortHistogram, options: { variant: "strip" } }),
    (error) => error instanceof PipelineContractError && error.code === "CALLER_VARIANT_FORBIDDEN",
  );

  const contourForm = requireExecutableForm("field", "contours");
  const irregular = Array.from({ length: 100 }, (_, index) => ({
    markId: `mark_${String(index).padStart(4, "0")}`,
    roles: { x: index % 10 === 9 ? (index % 10) + 0.25 : index % 10, y: Math.floor(index / 10), value: index },
    media: { type: "numeric-chart" },
  }));
  const result = evaluateFormEligibility(contourForm, irregular, { adapter: { id: "evidenced-records-v1" } });
  assert.equal(result.eligible, false);
  assert.ok(result.failedRequirements.some((requirement) => requirement.id === "regular-grid"));
});

test("the compiler and current package validator reject source-policy cross-wiring", async () => {
  const valid = inputFor(
    "rank",
    "dot-plot",
    Array.from({ length: 20 }, (_, value) => ({ label: `Item ${value}`, value })),
    { label: "label", value: "value" },
  );
  const cases = [
    {
      label: "adapter id",
      mutate(bundle) { bundle.adapter = { id: "forged-adapter", version: 99 }; },
      failedId: "source-adapter-policy",
    },
    {
      label: "adapter version",
      mutate(bundle) { bundle.adapter.version = 99; },
      failedId: "source-adapter-policy",
    },
    {
      label: "medium",
      mutate(bundle) { bundle.medium = "image"; },
      failedId: "source-medium-policy",
    },
  ];
  for (const item of cases) {
    const incompatible = structuredClone(valid);
    item.mutate(incompatible.sourceBundle);
    await assert.rejects(
      compileMap(incompatible),
      (error) => error instanceof PipelineContractError
        && error.code === "INELIGIBLE_REQUESTED_FORM"
        && error.memberId === "dot-plot"
        && error.failedRequirements.some((requirement) => requirement.id === item.failedId),
      item.label,
    );
  }

  const dataPackage = await compileMap(valid);
  await assert.rejects(
    createDataPackage({
      family: dataPackage.family.id,
      catalog: dataPackage.catalog,
      question: dataPackage.question,
      scope: { ...dataPackage.scope, adapter: { id: "forged-adapter", version: 99 } },
      sources: dataPackage.sources,
      roleMapping: dataPackage.roleMapping,
      marks: dataPackage.marks,
      payload: dataPackage.payload,
      presentation: dataPackage.presentation,
      provenance: dataPackage.provenance,
      quality: dataPackage.quality,
      execution: dataPackage.execution,
    }),
    (error) => error.code === "INELIGIBLE_REQUESTED_FORM" && error.path === "dataPackage.scope",
  );
});
