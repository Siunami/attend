import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executableCatalogMemberForFamily,
  listCatalogFamilies,
  requireCatalogFamily,
} from "../src/catalog/index.js";
import { compileCatalogMapRequest } from "../src/map/index.js";

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-map-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const FAMILY_REQUEST_RECORDS = Object.freeze({
  rank: [
    { key: "alpha", label: "Alpha", value: 4 },
    { key: "beta", label: "Beta", value: 7 },
    { key: "gamma", label: "Gamma", value: 2 },
  ],
  distribution: [
    { key: "one", label: "One", value: 1, group: "A" },
    { key: "two", label: "Two", value: 2, group: "A" },
    { key: "three", label: "Three", value: 3, group: "A" },
    { key: "five", label: "Five", value: 5, group: "B" },
    { key: "nine", label: "Nine", value: 9, group: "B" },
  ],
  composition: [
    { key: "product", part: "Product", value: 7, whole: "Budget" },
    { key: "research", part: "Research", value: 3, whole: "Budget" },
  ],
  profile: [
    { key: "a-speed", entity: "A", dimension: "Speed", value: 7 },
    { key: "a-cost", entity: "A", dimension: "Cost", value: 3 },
    { key: "a-quality", entity: "A", dimension: "Quality", value: 8 },
    { key: "b-speed", entity: "B", dimension: "Speed", value: 5 },
    { key: "b-cost", entity: "B", dimension: "Cost", value: 6 },
    { key: "b-quality", entity: "B", dimension: "Quality", value: 4 },
  ],
  "passage-comparison": [
    { key: "opening-v1", passage: "The first bounded passage.", version: "v1", label: "Opening", order: 1 },
    { key: "opening-v2", passage: "The revised bounded passage.", version: "v2", label: "Opening", order: 2 },
  ],
  trend: Array.from({ length: 12 }, (_, index) => ({
    key: `month-${index + 1}`,
    time: `2026-${String(index + 1).padStart(2, "0")}-01`,
    value: index + 2,
  })),
  timeline: [
    { key: "launch", time: "2026-01-01", endTime: "2026-01-02", label: "Launch", lane: "Product" },
    { key: "review", time: "2026-01-03", endTime: "2026-01-05", label: "Review", lane: "Product" },
    { key: "release", time: "2026-01-06", endTime: "2026-01-07", label: "Release", lane: "Product" },
  ],
  sequence: [
    { key: "sketch", order: 1, label: "Sketch", stage: "Explore" },
    { key: "prototype", order: 2, label: "Prototype", stage: "Build" },
    { key: "ship", order: 3, label: "Ship", stage: "Release" },
  ],
  relationship: Array.from({ length: 10 }, (_, index) => ({
    key: `point-${index + 1}`,
    x: index + 1,
    y: (index + 1) * 2,
    label: `Point ${index + 1}`,
  })),
  matrix: [
    { key: "need-a-option-1", row: "Need A", column: "Option 1", value: 3 },
    { key: "need-a-option-2", row: "Need A", column: "Option 2", value: 4 },
    { key: "need-b-option-1", row: "Need B", column: "Option 1", value: 5 },
    { key: "need-b-option-2", row: "Need B", column: "Option 2", value: 2 },
  ],
  hierarchy: [
    { key: "root", id: "root", label: "Root" },
    { key: "alpha", id: "alpha", parentId: "root", label: "Alpha" },
    { key: "beta", id: "beta", parentId: "root", label: "Beta" },
    { key: "alpha-one", id: "alpha-one", parentId: "alpha", label: "Alpha one" },
    { key: "beta-one", id: "beta-one", parentId: "beta", label: "Beta one" },
  ],
  network: [
    { key: "a-b", source: "A", target: "B", relation: "supports" },
    { key: "b-c", source: "B", target: "C", relation: "supports" },
    { key: "c-d", source: "C", target: "D", relation: "supports" },
    { key: "d-e", source: "D", target: "E", relation: "supports" },
  ],
  flow: [
    { key: "inbox-review", source: "Inbox", target: "Review", value: 9 },
    { key: "review-done", source: "Review", target: "Done", value: 9 },
  ],
  mechanism: [
    { key: "request-worker", source: "Request", target: "Worker", relation: "dispatches to", stage: "Runtime" },
    { key: "worker-response", source: "Worker", target: "Response", relation: "returns", stage: "Runtime" },
  ],
  "region-map": [
    { key: "california", region: "06", value: 0.4, label: "California", baseline: 10 },
    { key: "oregon", region: "41", value: 0.3, label: "Oregon", baseline: 10 },
    { key: "washington", region: "53", value: 0.5, label: "Washington", baseline: 10 },
    { key: "nevada", region: "32", value: 0.2, label: "Nevada", baseline: 10 },
    { key: "arizona", region: "04", value: 0.6, label: "Arizona", baseline: 10 },
  ],
  "point-map": [
    { key: "dar", latitude: -6.7924, longitude: 39.2083, label: "Dar es Salaam" },
  ],
  field: Array.from({ length: 20 }, (_, index) => ({
    key: `cell-${index + 1}`,
    x: index % 5,
    y: Math.floor(index / 5),
    value: index + 1,
  })),
  "collection-atlas": ["North", "South"].flatMap((cluster) =>
    Array.from({ length: 5 }, (_, index) => ({
      key: `${cluster.toLowerCase()}-${index + 1}`,
      label: `${cluster} specimen ${index + 1}`,
      cluster,
      order: index + 1,
    }))),
  "annotated-specimen": [
    { key: "chart-one", specimen: "chart_one", label: "Inflection", x: 0.35, y: 0.6, layer: "Reading", width: 0.1, height: 0.08 },
    { key: "chart-two", specimen: "chart_one", label: "Peak", x: 0.65, y: 0.3, layer: "Reading", width: 0.08, height: 0.06 },
  ],
});

function requestSourceLine(familyId, record) {
  return `${familyId} record ${record.key}: ${Object.entries(record)
    .filter(([field]) => field !== "key")
    .map(([field, value]) => `${field}=${String(value)}`)
    .join("; ")}.`;
}

function requestForRecords(familyId, records, sourcePath = `${familyId}.txt`) {
  const family = requireCatalogFamily(familyId);
  const member = family.members.find((candidate) =>
    candidate.status === "executable" || candidate.status === "unavailable");
  assert.ok(member, `${familyId} must expose a governed member`);
  const lines = records.map((record) => requestSourceLine(familyId, record));
  return {
    sourcePath,
    sourceText: `${lines.join("\n")}\n`,
    request: {
      version: 1,
      question: family.question,
      family: familyId,
      member: member.id,
      sources: [{ path: sourcePath }],
      records: records.map(({ key, ...fields }) => ({ key, ...fields })),
      evidence: records.flatMap((record, index) =>
        Object.keys(record)
          .filter((field) => field !== "key")
          .map((field) => ({
            source: { path: sourcePath },
            quote: lines[index],
            recordKey: record.key,
            field,
          }))),
    },
  };
}

function requestForFamily(familyId) {
  return requestForRecords(familyId, FAMILY_REQUEST_RECORDS[familyId]);
}

async function expectConstraintRejection(root, familyId, mutate, code, label) {
  const fixture = requestForFamily(familyId);
  await writeFile(join(root, fixture.sourcePath), fixture.sourceText);
  mutate(fixture.request);
  await assert.rejects(
    compileCatalogMapRequest({ root, request: fixture.request }),
    { code },
    label ?? familyId,
  );
}

test("catalog map compilation verifies exact quotes and derives a canonical atlas-v2 package", async (t) => {
  const root = await project(t);
  await writeFile(join(root, "evidence.md"), "Alpha scored 8 points.\nBeta scored 5 points.\nGamma scored 3 points.\n");
  const result = await compileCatalogMapRequest({
    root,
    request: {
      version: 1,
      question: "How do the scores compare?",
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
      options: { title: "Scoreboard" },
    },
  });
  assert.equal(result.dataPackage.catalog.member, "bar-list");
  assert.equal(result.dataPackage.catalog.family, "rank");
  assert.equal(result.dataPackage.question.text, "How do the scores compare?");
  assert.equal(result.dataPackage.question.target, "Scoreboard");
  assert.equal(result.dataPackage.marks.length, 3);
  assert.ok(result.dataPackage.marks.every((mark) => mark.evidenceRefs.every((reference) => /^evidence_[a-f0-9]{16}$/u.test(reference))));
  assert.ok(result.evidenceStore.references.every((reference) => reference.quote.length > 0));
  assert.equal(result.evidenceStore.sources[0].text.includes("Alpha scored 8 points."), true);
  assert.equal("rows" in result.dataPackage, false);
});

test("map requests require a bounded literal user question", async (t) => {
  const root = await project(t);
  const missingQuestion = requestForFamily("rank").request;
  delete missingQuestion.question;
  await assert.rejects(
    compileCatalogMapRequest({ root, request: missingQuestion }),
    { code: "INVALID_STRING", path: "request.question" },
  );

  const oversizedQuestion = requestForFamily("rank").request;
  oversizedQuestion.question = "q".repeat(4_001);
  await assert.rejects(
    compileCatalogMapRequest({ root, request: oversizedQuestion }),
    { code: "STRING_TOO_LONG", path: "request.question" },
  );
});

test("version 2 map requests require an explicit representation intent", async (t) => {
  const root = await project(t);
  const fixture = requestForFamily("mechanism");
  fixture.request.version = 2;
  await writeFile(join(root, fixture.sourcePath), fixture.sourceText);

  await assert.rejects(
    compileCatalogMapRequest({ root, request: fixture.request }),
    { code: "MISSING_REPRESENTATION_INTENT", path: "request.representationIntent" },
  );
});

test("exact representation intent compiles only when every requested capability matches", async (t) => {
  const root = await project(t);
  const fixture = requestForFamily("mechanism");
  fixture.request.version = 2;
  fixture.request.representationIntent = {
    version: 1,
    mode: "exact",
    constraints: [
      { kind: "form", value: "flowchart" },
      { kind: "dimensionality", value: "2d" },
      { kind: "interaction", value: "selection" },
      { kind: "motion", value: "static" },
    ],
  };
  await writeFile(join(root, fixture.sourcePath), fixture.sourceText);

  const compiled = await compileCatalogMapRequest({ root, request: fixture.request });
  assert.deepEqual(compiled.representationIntent, fixture.request.representationIntent);
  assert.ok(compiled.member.representationCapabilities.constraints.form.includes("flowchart"));

  for (const constraint of [
    { kind: "dimensionality", value: "3d" },
    { kind: "interaction", value: "orbit" },
    { kind: "form", value: "custom" },
  ]) {
    const unsupported = structuredClone(fixture.request);
    unsupported.representationIntent.constraints = [constraint];
    await assert.rejects(
      compileCatalogMapRequest({ root, request: unsupported }),
      {
        code: "UNSUPPORTED_REQUESTED_REPRESENTATION",
        path: "request.representationIntent.constraints[0]",
      },
      `${constraint.kind}:${constraint.value}`,
    );
  }
});

test("legacy version 1 map requests remain explicit open-intent compatibility requests", async (t) => {
  const root = await project(t);
  const fixture = requestForFamily("mechanism");
  await writeFile(join(root, fixture.sourcePath), fixture.sourceText);

  const compiled = await compileCatalogMapRequest({ root, request: fixture.request });
  assert.deepEqual(compiled.representationIntent, {
    version: 1,
    mode: "open",
    constraints: [],
  });
});

test("ambiguous quotes fail closed unless occurrence is supplied", async (t) => {
  const root = await project(t);
  await writeFile(join(root, "evidence.md"), "Alpha scored 8 points.\nAlpha scored 8 points.\nGamma scored 3 points.\n");
  await assert.rejects(
    compileCatalogMapRequest({
      root,
      request: {
        version: 1,
        question: "How do the scores compare?",
        family: "rank",
        member: "bar-list",
        sources: [{ path: "evidence.md" }],
        records: [
          { key: "alpha", label: "Alpha", value: 8 },
          { key: "beta", label: "Beta", value: 7 },
          { key: "gamma", label: "Gamma", value: 3 },
        ],
        evidence: [
          { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", recordKey: "alpha", field: "label" },
          { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", recordKey: "alpha", field: "value" },
          { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", occurrence: 2, recordKey: "beta", field: "label" },
          { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", occurrence: 2, recordKey: "beta", field: "value" },
          { source: { path: "evidence.md" }, quote: "Gamma scored 3 points.", recordKey: "gamma", field: "label" },
          { source: { path: "evidence.md" }, quote: "Gamma scored 3 points.", recordKey: "gamma", field: "value" },
        ],
      },
    }),
    { code: "AMBIGUOUS_QUOTE" },
  );
});

test("unknown request keys fail closed at the boundary", async (t) => {
  const root = await project(t);
  await writeFile(join(root, "evidence.md"), "Alpha scored 8 points.\nBeta scored 5 points.\n");
  await assert.rejects(
    compileCatalogMapRequest({
      root,
      request: {
        version: 1,
        question: "How do the scores compare?",
        family: "rank",
        member: "bar-list",
        sources: [{ path: "evidence.md", mediaType: "image/png" }],
        records: [
          { key: "alpha", label: "Alpha", value: 8 },
          { key: "beta", label: "Beta", value: 5 },
        ],
        evidence: [
          { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", recordKey: "alpha", field: "label" },
          { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", recordKey: "alpha", field: "value" },
          { source: { path: "evidence.md" }, quote: "Beta scored 5 points.", recordKey: "beta", field: "label" },
          { source: { path: "evidence.md" }, quote: "Beta scored 5 points.", recordKey: "beta", field: "value" },
        ],
        options: { title: "Scoreboard" },
        extra: true,
      },
    }),
    { code: "UNKNOWN_REQUEST_KEY" },
  );
});

test("authored record-count lower and upper bounds fail closed before compilation", async (t) => {
  const root = await project(t);
  await writeFile(join(root, "evidence.md"), "Alpha scored 8 points.\n");
  const request = {
    version: 1,
    question: "How do the scores compare?",
    family: "rank",
    member: "bar-list",
    sources: [{ path: "evidence.md" }],
    records: [{ key: "alpha", label: "Alpha", value: 8 }],
    evidence: [
      { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", recordKey: "alpha", field: "label" },
      { source: { path: "evidence.md" }, quote: "Alpha scored 8 points.", recordKey: "alpha", field: "value" },
    ],
  };
  await assert.rejects(compileCatalogMapRequest({ root, request }), { code: "RECORD_COUNT_OUT_OF_RANGE" });

  const upperFixture = requestForRecords("rank", Array.from({ length: 40 }, (_, index) => ({
    key: `item-${index}`,
    label: `Item ${index}`,
    value: index,
  })), "rank-upper.txt");
  await writeFile(join(root, upperFixture.sourcePath), upperFixture.sourceText);
  const compiled = await compileCatalogMapRequest({ root, request: upperFixture.request });
  assert.equal(compiled.dataPackage.marks.length, 40);

  upperFixture.request.records.push({ key: "item-40", label: "Item 40", value: 40 });
  await assert.rejects(
    compileCatalogMapRequest({ root, request: upperFixture.request }),
    { code: "RECORD_COUNT_OUT_OF_RANGE" },
  );
});

test("family-specific record floors and unique keys fail closed", async (t) => {
  const root = await project(t);
  for (const [familyId, count] of [
    ["distribution", 4],
    ["trend", 11],
    ["timeline", 2],
    ["sequence", 2],
    ["relationship", 9],
    ["region-map", 4],
    ["field", 19],
  ]) {
    await expectConstraintRejection(
      root,
      familyId,
      (request) => request.records.splice(count),
      "RECORD_COUNT_OUT_OF_RANGE",
      `${familyId} lower bound`,
    );
  }
  await expectConstraintRejection(
    root,
    "rank",
    (request) => {
      request.records[1].label = request.records[0].label;
    },
    "DUPLICATE_CONSTRAINT_TUPLE",
    "rank labels",
  );
});

test("comparison, time, and matrix shape contracts fail closed", async (t) => {
  const root = await project(t);
  const cases = [
    ["composition", (request) => { delete request.records[0].whole; }, "MISSING_CONSTRAINT_FIELD", "composition whole"],
    ["composition", (request) => { request.records[1].whole = "Other"; }, "DISTINCT_COUNT_OUT_OF_RANGE", "composition one whole"],
    ["composition", (request) => { request.records[1].part = request.records[0].part; }, "DUPLICATE_CONSTRAINT_TUPLE", "composition parts"],
    ["composition", (request) => { request.records[0].value = -1; }, "NUMERIC_CONSTRAINT_VIOLATION", "composition nonnegative"],
    ["composition", (request) => { request.records.forEach((record) => { record.value = 0; }); }, "NUMERIC_AGGREGATE_VIOLATION", "composition total"],
    ["profile", (request) => { request.records.splice(-1); }, "INCOMPLETE_CARTESIAN", "profile complete pairs"],
    ["profile", (request) => { request.records = request.records.filter((record) => record.entity === "A"); }, "DISTINCT_COUNT_OUT_OF_RANGE", "profile entities"],
    ["passage-comparison", (request) => { request.records[1].version = request.records[0].version; }, "DISTINCT_COUNT_OUT_OF_RANGE", "passage versions"],
    ["trend", (request) => { request.records.forEach((record, index) => { record.series = `Series ${index % 5}`; }); }, "DISTINCT_COUNT_OUT_OF_RANGE", "trend series"],
    ["trend", (request) => { request.records[1].time = request.records[0].time; }, "DUPLICATE_CONSTRAINT_TUPLE", "trend series/time"],
    ["timeline", (request) => { delete request.records[0].endTime; }, "MISSING_CONSTRAINT_FIELD", "timeline end"],
    ["timeline", (request) => { request.records[0].endTime = "2025-12-31"; }, "INVALID_CONSTRAINT_TIME_ORDER", "timeline order"],
    ["sequence", (request) => { request.records[1].order = request.records[0].order; }, "DUPLICATE_CONSTRAINT_TUPLE", "sequence order"],
    ["matrix", (request) => { request.records.splice(-1); }, "INCOMPLETE_CARTESIAN", "matrix Cartesian"],
    ["matrix", (request) => { request.records[1].column = request.records[0].column; }, "DUPLICATE_CONSTRAINT_TUPLE", "matrix cell"],
  ];
  for (const [familyId, mutate, code, label] of cases) {
    await expectConstraintRejection(root, familyId, mutate, code, label);
  }
});

test("tree, network, flow, and mechanism shape contracts fail closed", async (t) => {
  const root = await project(t);
  await expectConstraintRejection(
    root,
    "hierarchy",
    (request) => { delete request.records[1].parentId; },
    "INVALID_HIERARCHY",
    "hierarchy root count",
  );
  await expectConstraintRejection(
    root,
    "hierarchy",
    (request) => { request.records[1].parentId = "missing"; },
    "INVALID_HIERARCHY",
    "hierarchy parent",
  );
  await expectConstraintRejection(
    root,
    "network",
    (request) => { request.records[0].target = request.records[0].source; },
    "INVALID_DIRECTED_GRAPH",
    "network self edge",
  );
  await expectConstraintRejection(
    root,
    "network",
    (request) => {
      request.records[1].source = request.records[0].source;
      request.records[1].target = request.records[0].target;
    },
    "INVALID_DIRECTED_GRAPH",
    "network duplicate edge",
  );
  await expectConstraintRejection(
    root,
    "network",
    (request) => {
      request.records = [
        { key: "a-b", source: "A", target: "B" },
        { key: "b-a", source: "B", target: "A" },
        { key: "c-d", source: "C", target: "D" },
        { key: "d-e", source: "D", target: "E" },
      ];
    },
    "INVALID_DIRECTED_GRAPH",
    "network connectivity",
  );
  await expectConstraintRejection(
    root,
    "network",
    (request) => {
      const nodes = ["A", "B", "C", "D", "E"];
      request.records = nodes.flatMap((source) =>
        nodes.filter((target) => target !== source).map((target) => ({
          key: `${source}-${target}`,
          source,
          target,
        }))).slice(0, 16);
    },
    "INVALID_DIRECTED_GRAPH",
    "network edge cap",
  );
  await expectConstraintRejection(
    root,
    "flow",
    (request) => { request.records[1].target = request.records[0].source; },
    "INVALID_DIRECTED_FLOW",
    "flow cycle",
  );
  await expectConstraintRejection(
    root,
    "flow",
    (request) => { request.records[0].target = request.records[0].source; },
    "INVALID_DIRECTED_FLOW",
    "flow self edge",
  );
  await expectConstraintRejection(
    root,
    "flow",
    (request) => {
      request.records[1].source = request.records[0].source;
      request.records[1].target = request.records[0].target;
    },
    "INVALID_DIRECTED_FLOW",
    "flow duplicate edge",
  );
  await expectConstraintRejection(
    root,
    "flow",
    (request) => {
      request.records = Array.from({ length: 5 }, (_, index) => ({
        key: `flow-${index}`,
        source: `Node ${index}`,
        target: `Node ${index + 1}`,
        value: 1,
      }));
    },
    "FLOW_STAGE_COUNT_OUT_OF_RANGE",
    "flow topological stages",
  );
  await expectConstraintRejection(
    root,
    "flow",
    (request) => {
      request.records = Array.from({ length: 16 }, (_, index) => ({
        key: `flow-${index}`,
        source: `Source ${index}`,
        target: `Target ${index}`,
        value: 1,
      }));
    },
    "GRAPH_NODE_COUNT_OUT_OF_RANGE",
    "flow nodes",
  );
  await expectConstraintRejection(
    root,
    "mechanism",
    (request) => {
      request.records = [{ key: "a-b", source: "A", target: "B", relation: "sends" }];
    },
    "GRAPH_NODE_COUNT_OUT_OF_RANGE",
    "mechanism nodes",
  );
});

test("space and collection shape contracts fail closed", async (t) => {
  const root = await project(t);
  const cases = [
    ["region-map", (request) => { request.records[1].region = "6"; }, "DUPLICATE_CONSTRAINT_TUPLE", "canonical FIPS uniqueness"],
    ["region-map", (request) => { request.records[0].baseline = 0; }, "NUMERIC_CONSTRAINT_VIOLATION", "positive denominator"],
    ["region-map", (request) => { request.records[0].value = 1.1; }, "NUMERIC_CONSTRAINT_VIOLATION", "normalized region value"],
    ["point-map", (request) => { request.records.push({ ...request.records[0], key: "duplicate", label: "Duplicate" }); }, "DUPLICATE_CONSTRAINT_TUPLE", "point coordinates"],
    ["field", (request) => { request.records[1].x = request.records[0].x; request.records[1].y = request.records[0].y; }, "DUPLICATE_CONSTRAINT_TUPLE", "field coordinates"],
    ["collection-atlas", (request) => { request.records.splice(0, 1); }, "GROUP_SIZE_OUT_OF_RANGE", "collection cluster size"],
  ];
  for (const [familyId, mutate, code, label] of cases) {
    await expectConstraintRejection(root, familyId, mutate, code, label);
  }
});

test("public atlas packages do not persist exact claim quotes", async (t) => {
  const root = await project(t);
  const alphaQuote = "Alpha scored 8 points.";
  const betaQuote = "Beta scored 5 points.";
  const gammaQuote = "Gamma scored 3 points.";
  await writeFile(join(root, "evidence.md"), `${alphaQuote}\n${betaQuote}\n${gammaQuote}\n`);
  const result = await compileCatalogMapRequest({
    root,
    request: {
      version: 1,
      question: "How do the scores compare?",
      family: "rank",
      member: "bar-list",
      sources: [{ path: "evidence.md" }],
      records: [
        { key: "alpha", label: "Alpha", value: 8 },
        { key: "beta", label: "Beta", value: 5 },
        { key: "gamma", label: "Gamma", value: 3 },
      ],
      evidence: [
        { source: { path: "evidence.md" }, quote: alphaQuote, recordKey: "alpha", field: "label" },
        { source: { path: "evidence.md" }, quote: alphaQuote, recordKey: "alpha", field: "value" },
        { source: { path: "evidence.md" }, quote: betaQuote, recordKey: "beta", field: "label" },
        { source: { path: "evidence.md" }, quote: betaQuote, recordKey: "beta", field: "value" },
        { source: { path: "evidence.md" }, quote: gammaQuote, recordKey: "gamma", field: "label" },
        { source: { path: "evidence.md" }, quote: gammaQuote, recordKey: "gamma", field: "value" },
      ],
    },
  });
  const publicJson = JSON.stringify(result.dataPackage);
  assert.equal(publicJson.includes(alphaQuote), false);
  assert.equal(publicJson.includes(betaQuote), false);
  assert.equal(publicJson.includes(gammaQuote), false);
  assert.match(result.dataPackage.marks[0].evidenceRefs[0], /^evidence_[a-f0-9]{16}$/u);
  assert.equal("recordId" in result.dataPackage.marks[0], false);
  assert.equal(JSON.stringify(result.dataPackage).includes("\"recordId\""), false);
  assert.equal(JSON.stringify(result.dataPackage.marks).includes("sourceId"), false);
  assert.equal(JSON.stringify(result.dataPackage.marks).includes("locator"), false);
  assert.equal(JSON.stringify(result.dataPackage.marks).includes("excerpt"), false);
  assert.equal(JSON.stringify(result.dataPackage.marks).includes("quote"), false);
  assert.equal(result.evidenceStore.references[0].quote, alphaQuote);
  assert.equal(result.evidenceStore.sources[0].text.includes(alphaQuote), true);
});

test("invented optional scalar roles fail closed without exact evidence", async (t) => {
  const root = await project(t);
  const quoteA = "Alpha scored 8 points.";
  const quoteB = "Beta scored 5 points.";
  const quoteC = "Gamma scored 3 points.";
  await writeFile(join(root, "rank-optional.md"), `${quoteA}\n${quoteB}\n${quoteC}\n`);
  await assert.rejects(
    compileCatalogMapRequest({
      root,
      request: {
        version: 1,
        question: "How do the scores compare across groups?",
        family: "rank",
        member: "bar-list",
        sources: [{ path: "rank-optional.md" }],
        records: [
          { key: "alpha", label: "Alpha", value: 8, group: "North" },
          { key: "beta", label: "Beta", value: 5, group: "South" },
          { key: "gamma", label: "Gamma", value: 3, group: "East" },
        ],
        evidence: [
          { source: { path: "rank-optional.md" }, quote: quoteA, recordKey: "alpha", field: "label" },
          { source: { path: "rank-optional.md" }, quote: quoteA, recordKey: "alpha", field: "value" },
          { source: { path: "rank-optional.md" }, quote: quoteB, recordKey: "beta", field: "label" },
          { source: { path: "rank-optional.md" }, quote: quoteB, recordKey: "beta", field: "value" },
          { source: { path: "rank-optional.md" }, quote: quoteC, recordKey: "gamma", field: "label" },
          { source: { path: "rank-optional.md" }, quote: quoteC, recordKey: "gamma", field: "value" },
        ],
      },
    }),
    { code: "MISSING_FIELD_EVIDENCE" },
  );
});

test("invented optional time roles fail closed without exact evidence", async (t) => {
  const root = await project(t);
  const quote = "Launch begins on 2026-01-01.";
  await writeFile(join(root, "timeline-optional.md"), `${quote}\n`);
  await assert.rejects(
    compileCatalogMapRequest({
      root,
      request: {
        version: 1,
        question: "When does the launch begin and end?",
        family: "timeline",
        member: "interval",
        sources: [{ path: "timeline-optional.md" }],
        records: [
          { key: "launch", time: "2026-01-01", endTime: "2026-01-02", label: "Launch", lane: "Product" },
          { key: "review", time: "2026-01-03", endTime: "2026-01-04", label: "Review" },
          { key: "release", time: "2026-01-05", endTime: "2026-01-06", label: "Release" },
        ],
        evidence: [
          { source: { path: "timeline-optional.md" }, quote, recordKey: "launch", field: "time" },
          { source: { path: "timeline-optional.md" }, quote, recordKey: "launch", field: "label" },
        ],
      },
    }),
    { code: "MISSING_FIELD_EVIDENCE" },
  );
});

test("invented optional graph roles fail closed without exact evidence", async (t) => {
  const root = await project(t);
  const quote = "A connects to B.";
  await writeFile(join(root, "network-optional.md"), `${quote}\n`);
  await assert.rejects(
    compileCatalogMapRequest({
      root,
      request: {
        version: 1,
        question: "How are A and B connected?",
        family: "network",
        member: "local",
        sources: [{ path: "network-optional.md" }],
        records: [
          { key: "edge", source: "A", target: "B", weight: 2, relation: "supports" },
          { key: "b-c", source: "B", target: "C" },
          { key: "c-d", source: "C", target: "D" },
          { key: "d-e", source: "D", target: "E" },
        ],
        evidence: [
          { source: { path: "network-optional.md" }, quote, recordKey: "edge", field: "source" },
          { source: { path: "network-optional.md" }, quote, recordKey: "edge", field: "target" },
        ],
      },
    }),
    { code: "MISSING_FIELD_EVIDENCE" },
  );
});

test("field evidence binds exact scalar tokens rather than substrings", async (t) => {
  const cases = [
    { value: 4, observed: "42" },
    { value: 4, observed: "4.2" },
    { value: "North", observed: "Northwest" },
  ];
  for (const [index, item] of cases.entries()) {
    const root = await project(t);
    const alpha = `Alpha ${item.observed}`;
    const beta = "Beta 7";
    const gamma = "Gamma 3";
    const sourcePath = `literal-${index}.md`;
    await writeFile(join(root, sourcePath), `${alpha}\n${beta}\n${gamma}\n`);
    const alphaRecord = typeof item.value === "number"
      ? { key: "alpha", label: "Alpha", value: item.value }
      : { key: "alpha", label: item.value, value: 4 };
    await assert.rejects(
      compileCatalogMapRequest({
        root,
        request: {
          version: 1,
          question: "How do the scores compare?",
          family: "rank",
          member: "bar-list",
          sources: [{ path: sourcePath }],
          records: [alphaRecord, { key: "beta", label: "Beta", value: 7 }, { key: "gamma", label: "Gamma", value: 3 }],
          evidence: [
            { source: { path: sourcePath }, quote: alpha, recordKey: "alpha", field: "label" },
            { source: { path: sourcePath }, quote: alpha, recordKey: "alpha", field: "value" },
            { source: { path: sourcePath }, quote: beta, recordKey: "beta", field: "label" },
            { source: { path: sourcePath }, quote: beta, recordKey: "beta", field: "value" },
            { source: { path: sourcePath }, quote: gamma, recordKey: "gamma", field: "label" },
            { source: { path: sourcePath }, quote: gamma, recordKey: "gamma", field: "value" },
          ],
        },
      }),
      { code: "UNBOUND_FIELD_EVIDENCE" },
      `${String(item.value)} must not bind to ${item.observed}`,
    );
  }
});

test("map source paths are canonical project-relative paths", async (t) => {
  const root = await project(t);
  const fixture = requestForFamily("rank");
  await writeFile(join(root, fixture.sourcePath), fixture.sourceText);

  fixture.request.sources[0].path = `./${fixture.sourcePath}`;
  fixture.request.evidence.forEach((claim) => {
    claim.source.path = `./${fixture.sourcePath}`;
  });
  const compiled = await compileCatalogMapRequest({ root, request: fixture.request });
  assert.deepEqual(compiled.dataPackage.scope.requestedInputs, [fixture.sourcePath]);

  for (const unsafe of [join(root, fixture.sourcePath), `../${fixture.sourcePath}`, `~/${fixture.sourcePath}`]) {
    const rejected = requestForFamily("rank").request;
    rejected.sources[0].path = unsafe;
    rejected.evidence.forEach((claim) => {
      claim.source.path = unsafe;
    });
    await assert.rejects(
      compileCatalogMapRequest({ root, request: rejected }),
      { code: "UNSAFE_SOURCE_PATH" },
      unsafe,
    );
  }
});

test("normalized-text is a recorded deterministic source projection", async (t) => {
  const root = await project(t);
  const sourcePath = "normalized.md";
  await writeFile(join(root, sourcePath), "Cafe\u0301 scored 8 points.\r\nBeta scored 5 points.\r\nGamma scored 3 points.\r\n");
  const alphaQuote = "Café scored 8 points.";
  const betaQuote = "Beta scored 5 points.";
  const gammaQuote = "Gamma scored 3 points.";
  const request = {
    version: 1,
    question: "How do the scores compare?",
    family: "rank",
    member: "bar-list",
    sources: [{ path: sourcePath, textProjection: "normalized-text" }],
    records: [
      { key: "alpha", label: "Café", value: 8 },
      { key: "beta", label: "Beta", value: 5 },
      { key: "gamma", label: "Gamma", value: 3 },
    ],
    evidence: [
      { source: { path: sourcePath, textProjection: "normalized-text" }, quote: alphaQuote, recordKey: "alpha", field: "label" },
      { source: { path: sourcePath, textProjection: "normalized-text" }, quote: alphaQuote, recordKey: "alpha", field: "value" },
      { source: { path: sourcePath, textProjection: "normalized-text" }, quote: betaQuote, recordKey: "beta", field: "label" },
      { source: { path: sourcePath, textProjection: "normalized-text" }, quote: betaQuote, recordKey: "beta", field: "value" },
      { source: { path: sourcePath, textProjection: "normalized-text" }, quote: gammaQuote, recordKey: "gamma", field: "label" },
      { source: { path: sourcePath, textProjection: "normalized-text" }, quote: gammaQuote, recordKey: "gamma", field: "value" },
    ],
  };
  const result = await compileCatalogMapRequest({ root, request });
  assert.equal(result.dataPackage.sources[0].textProjection, "normalized-text");
  assert.equal(result.evidenceStore.sources[0].text, `${alphaQuote}\n${betaQuote}\n${gammaQuote}\n`);
  assert.equal(result.evidenceStore.sources[0].text.includes("\r"), false);

  request.evidence[0].source.textProjection = "utf8";
  await assert.rejects(
    compileCatalogMapRequest({ root, request }),
    { code: "TEXT_PROJECTION_MISMATCH" },
  );
});

test("JSONL logical sources retain private container metadata without leaking it publicly", async (t) => {
  const root = await project(t);
  const containerPath = "records.jsonl";
  const alphaQuote = "Alpha scored 8 points.";
  const betaQuote = "Beta scored 5 points.";
  const gammaQuote = "Gamma scored 3 points.";
  await writeFile(join(root, containerPath), [
    JSON.stringify({ id: "alpha-source", text: alphaQuote }),
    JSON.stringify({ id: "beta-source", text: betaQuote }),
    JSON.stringify({ id: "gamma-source", text: gammaQuote }),
    "",
  ].join("\n"));
  const result = await compileCatalogMapRequest({
    root,
    request: {
      version: 1,
      question: "How do the scores compare?",
      family: "rank",
      member: "bar-list",
      sources: [{ path: containerPath }],
      records: [
        { key: "alpha", label: "Alpha", value: 8 },
        { key: "beta", label: "Beta", value: 5 },
        { key: "gamma", label: "Gamma", value: 3 },
      ],
      evidence: [
        { source: { path: `${containerPath}#1` }, quote: alphaQuote, recordKey: "alpha", field: "label" },
        { source: { path: `${containerPath}#1` }, quote: alphaQuote, recordKey: "alpha", field: "value" },
        { source: { path: `${containerPath}#2` }, quote: betaQuote, recordKey: "beta", field: "label" },
        { source: { path: `${containerPath}#2` }, quote: betaQuote, recordKey: "beta", field: "value" },
        { source: { path: `${containerPath}#3` }, quote: gammaQuote, recordKey: "gamma", field: "label" },
        { source: { path: `${containerPath}#3` }, quote: gammaQuote, recordKey: "gamma", field: "value" },
      ],
    },
  });
  assert.equal(result.dataPackage.sources.every((source) => !("containerPath" in source)), true);
  assert.equal(result.evidenceStore.sources.every((source) => source.containerPath === containerPath), true);
});

test("region maps reject ids absent from their fixed bundled geography", async (t) => {
  const root = await project(t);
  const fixture = requestForFamily("region-map");
  fixture.request.records[0].region = "TZ-01";
  await writeFile(join(root, fixture.sourcePath), fixture.sourceText);
  await assert.rejects(
    compileCatalogMapRequest({ root, request: fixture.request }),
    { code: "UNKNOWN_GEOGRAPHIC_REGION" },
  );
});

test("all available families compile with private-only quotes and unavailable specimen mapping abstains", async (t) => {
  const root = await project(t);
  for (const family of listCatalogFamilies()) {
    const fixture = requestForFamily(family.id);
    await writeFile(join(root, fixture.sourcePath), fixture.sourceText);
    if (!family.executableMemberId) {
      await assert.rejects(
        compileCatalogMapRequest({ root, request: fixture.request }),
        { code: "UNAVAILABLE_CATALOG_MEMBER" },
        family.id,
      );
      continue;
    }
    const member = executableCatalogMemberForFamily(family.id);

    const result = await compileCatalogMapRequest({
      root,
      request: fixture.request,
    });

    assert.equal(result.dataPackage.catalog.family, family.id, family.id);
    assert.equal(result.dataPackage.catalog.member, member.id, family.id);
    assert.ok(result.dataPackage.marks.length >= 1, family.id);
    assert.equal(result.dataPackage.marks.every((mark) => mark.evidenceRefs.length >= 1), true, family.id);
    const publicJson = JSON.stringify(result.dataPackage);
    for (const quote of fixture.request.evidence.map((claim) => claim.quote)) {
      assert.equal(publicJson.includes(quote), false, `${family.id} leaked a claim quote`);
    }
    assert.equal(result.evidenceStore.sources[0].text, fixture.sourceText, family.id);
    assert.equal(result.evidenceStore.sources[0].text.includes(fixture.request.evidence[0].quote), true, family.id);
  }
});
