import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileCatalogMapRequest } from "../src/map/index.js";

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-map-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function evidencedRequest() {
  return {
    version: 3,
    question: "How do the values compare?",
    family: "rank",
    member: "bar-list",
    representationIntent: { version: 1, mode: "open", constraints: [] },
    input: {
      adapter: "evidenced-records-v1",
      sources: [{ path: "values.txt" }],
      records: [
        { key: "alpha", label: "Alpha", value: 8 },
        { key: "beta", label: "Beta", value: 5 },
        { key: "gamma", label: "Gamma", value: 3 },
      ],
      evidence: [
        { source: { path: "values.txt" }, quote: "Alpha: 8", recordKey: "alpha", field: "label" },
        { source: { path: "values.txt" }, quote: "Alpha: 8", recordKey: "alpha", field: "value" },
        { source: { path: "values.txt" }, quote: "Beta: 5", recordKey: "beta", field: "label" },
        { source: { path: "values.txt" }, quote: "Beta: 5", recordKey: "beta", field: "value" },
        { source: { path: "values.txt" }, quote: "Gamma: 3", recordKey: "gamma", field: "label" },
        { source: { path: "values.txt" }, quote: "Gamma: 3", recordKey: "gamma", field: "value" },
      ],
    },
  };
}

test("version 3 evidenced-records input preserves the version 2 compiler path", async (t) => {
  const root = await project(t);
  await writeFile(join(root, "values.txt"), "Alpha: 8\nBeta: 5\nGamma: 3\n");

  const compiled = await compileCatalogMapRequest({ root, request: evidencedRequest() });

  assert.equal(compiled.dataPackage.catalog.family, "rank");
  assert.equal(compiled.dataPackage.catalog.member, "bar-list");
  assert.deepEqual(compiled.dataPackage.scope.adapter, { id: "evidenced-records-v1", version: 1 });
  assert.equal(compiled.dataPackage.marks.length, 3);
});

test("version 3 requires exactly one declared input adapter boundary", async (t) => {
  const root = await project(t);
  const flattened = evidencedRequest();
  flattened.sources = flattened.input.sources;
  await assert.rejects(
    compileCatalogMapRequest({ root, request: flattened }),
    { code: "INVALID_REQUEST", path: "request.input" },
  );

  const unknown = evidencedRequest();
  unknown.input = { adapter: "invent-a-chart-v1" };
  await assert.rejects(
    compileCatalogMapRequest({ root, request: unknown }),
    { code: "UNKNOWN_INPUT_ADAPTER", path: "request.input.adapter" },
  );
});

test("request options cannot choose a renderer variant", async (t) => {
  const root = await project(t);
  const request = evidencedRequest();
  request.options = { variant: "dot-plot" };
  await assert.rejects(
    compileCatalogMapRequest({ root, request }),
    { code: "UNKNOWN_OPTIONS_KEY", path: "request.options.variant" },
  );
});

test("an incompatible exact form reports its failed form requirements", async (t) => {
  const root = await project(t);
  const rows = Array.from({ length: 49 }, (_, index) => `value-${index + 1}: ${index + 1}`);
  await writeFile(join(root, "values.txt"), `${rows.join("\n")}\n`);
  const request = {
    version: 3,
    question: "How are these values distributed?",
    family: "distribution",
    member: "histogram",
    representationIntent: {
      version: 1,
      mode: "exact",
      constraints: [{ kind: "form", value: "histogram" }],
    },
    input: {
      adapter: "evidenced-records-v1",
      sources: [{ path: "values.txt" }],
      records: rows.map((_, index) => ({ key: `value-${index + 1}`, value: index + 1 })),
      evidence: rows.map((quote, index) => ({
        source: { path: "values.txt" },
        quote,
        recordKey: `value-${index + 1}`,
        field: "value",
      })),
    },
  };

  await assert.rejects(
    compileCatalogMapRequest({ root, request }),
    (error) => {
      assert.equal(error.code, "INELIGIBLE_REQUESTED_FORM");
      assert.equal(error.familyId, "distribution");
      assert.equal(error.memberId, "histogram");
      assert.ok(error.failedRequirements.some((requirement) => requirement.id === "record-count"));
      return true;
    },
  );
});

test("version 3 exact requests normalize incumbent constraint failures", async (t) => {
  const root = await project(t);
  await writeFile(join(root, "values.txt"), "Alpha: 8\nBeta: 5\n");
  const request = evidencedRequest();
  request.representationIntent = {
    version: 1,
    mode: "exact",
    constraints: [{ kind: "form", value: "bar-list" }],
  };
  request.input.records.splice(2);
  request.input.evidence = request.input.evidence.filter((claim) => claim.recordKey !== "gamma");

  await assert.rejects(
    compileCatalogMapRequest({ root, request }),
    (error) => {
      assert.equal(error.code, "INELIGIBLE_REQUESTED_FORM");
      assert.equal(error.familyId, "rank");
      assert.equal(error.memberId, "bar-list");
      assert.ok(error.failedRequirements.some((requirement) => requirement.id === "record-count"));
      return true;
    },
  );
});

test("version 3 exact requests abstain structurally for non-executable catalog forms", async (t) => {
  const root = await project(t);
  const request = evidencedRequest();
  request.member = "ranked-table";
  request.representationIntent = {
    version: 1,
    mode: "exact",
    constraints: [{ kind: "form", value: "ranked-table" }],
  };

  await assert.rejects(
    compileCatalogMapRequest({ root, request }),
    (error) => {
      assert.equal(error.code, "INELIGIBLE_REQUESTED_FORM");
      assert.equal(error.familyId, "rank");
      assert.equal(error.memberId, "ranked-table");
      assert.deepEqual(error.failedRequirements, [{
        id: "executable-status",
        kind: "catalog-status",
        expected: "executable",
        actual: "documented",
      }]);
      return true;
    },
  );
});

test("version 3 exact requests reject another form, an internal variant, and an unimplemented interaction", async (t) => {
  const root = await project(t);
  const cases = [
    { family: "rank", member: "bar-list", constraint: { kind: "form", value: "dot-plot" } },
    { family: "composition", member: "hundred-bar", constraint: { kind: "form", value: "normalized-parts" } },
    { family: "point-map", member: "exact-points", constraint: { kind: "interaction", value: "pan-zoom" } },
  ];

  for (const entry of cases) {
    const request = evidencedRequest();
    request.family = entry.family;
    request.member = entry.member;
    request.representationIntent = {
      version: 1,
      mode: "exact",
      constraints: [entry.constraint],
    };
    await assert.rejects(
      compileCatalogMapRequest({ root, request }),
      (error) => {
        assert.equal(error.code, "INELIGIBLE_REQUESTED_FORM");
        assert.equal(error.familyId, entry.family);
        assert.equal(error.memberId, entry.member);
        assert.deepEqual(error.failedRequirements, [{
          id: `representation-${entry.constraint.kind}`,
          kind: "representation-capability",
          constraintKind: entry.constraint.kind,
          expected: entry.constraint.kind === "form" ? [entry.member] : ["selection"],
          actual: entry.constraint.value,
        }]);
        return true;
      },
      `${entry.family}/${entry.member}`,
    );
  }
});

test("version 3 exact contact-atlas normalizes media abstention as requested-form ineligibility", async (t) => {
  const root = await project(t);
  await assert.rejects(
    compileCatalogMapRequest({
      root,
      request: {
        version: 3,
        question: "What does capture order reveal?",
        family: "collection-atlas",
        member: "contact-atlas",
        representationIntent: {
          version: 1,
          mode: "exact",
          constraints: [{ kind: "form", value: "contact-atlas" }],
        },
        input: { adapter: "local-image-set-v1", directory: "missing-jpegs" },
      },
    }),
    (error) => {
      assert.equal(error.code, "INELIGIBLE_REQUESTED_FORM");
      assert.equal(error.familyId, "collection-atlas");
      assert.equal(error.memberId, "contact-atlas");
      assert.deepEqual(error.failedRequirements, [{
        id: "one-explicit-directory",
        kind: "media-eligibility",
        message: "The authorized image directory does not exist.",
      }]);
      return true;
    },
  );
});

test("version 3 faceted-atlas requires bounded facets and derives local placement", async (t) => {
  const root = await project(t);
  const fields = ["A", "B"].flatMap((cluster) => Array.from({ length: 5 }, (_, order) => ({
    key: `${cluster.toLowerCase()}-${order}`,
    label: `${cluster} item ${order + 1}`,
    cluster,
    order,
  })));
  const lines = fields.map((record) => `${record.label}; cluster=${record.cluster}; order=${record.order}`);
  await writeFile(join(root, "atlas.txt"), `${lines.join("\n")}\n`);
  const request = {
    version: 3,
    question: "How is this collection arranged?",
    family: "collection-atlas",
    member: "faceted-atlas",
    representationIntent: {
      version: 1,
      mode: "exact",
      constraints: [{ kind: "form", value: "faceted-atlas" }],
    },
    input: {
      adapter: "evidenced-records-v1",
      sources: [{ path: "atlas.txt" }],
      records: fields,
      evidence: fields.flatMap((record, index) => ["label", "cluster", "order"].map((field) => ({
        source: { path: "atlas.txt" },
        quote: lines[index],
        recordKey: record.key,
        field,
      }))),
    },
  };

  const compiled = await compileCatalogMapRequest({ root, request });

  assert.deepEqual(compiled.dataPackage.payload.domains, { x: [10, 90], y: [12, 68] });
  assert.deepEqual(compiled.dataPackage.payload.clusters, ["A", "B"]);
  assert.deepEqual(
    compiled.dataPackage.payload.items.map(({ label, cluster, order, x, y }) => ({ label, cluster, order, x, y })),
    fields.map((record, index) => ({
      label: record.label,
      cluster: record.cluster,
      order: record.order,
      x: index < 5 ? 10 : 90,
      y: 12 + (index % 5) * 14,
    })),
  );
  assert.ok(compiled.dataPackage.marks.every((mark) => Object.keys(mark.values).every((role) => ["label", "cluster", "order"].includes(role))));
});
