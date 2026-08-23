import assert from "node:assert/strict";
import test from "node:test";

import { buildSelection } from "../src/selection.js";

const dataPackage = {
  id: "data_1",
  hashes: { data: "abc" },
  config: { minCount: 2, minSources: 2 },
  map: { id: "phrase-list", version: 1 },
  sources: [
    { id: "source_a", displayPath: "notes/a.md", sha256: "a".repeat(64) },
    { id: "source_b", displayPath: "notes/b.md", sha256: "b".repeat(64) },
  ],
  rows: [
    {
      id: "phrase_1",
      phrase: "local instrument",
      occurrenceCount: 3,
      distinctSourceCount: 2,
      occurrences: [
        { sourceId: "source_a", line: 4, excerpt: "a local instrument" },
        { sourceId: "source_b", line: 9, excerpt: "the local instrument" },
      ],
    },
  ],
};

test("buildSelection preserves view state and exact evidence refs", () => {
  const selection = buildSelection(dataPackage, {
    revision: 7,
    selectedIds: ["phrase_1"],
    query: "local",
    minCount: 3,
    sort: { by: "distinctSourceCount", direction: "desc" },
    sourceScope: ["source_a", "source_b"],
  });

  assert.equal(selection.kind, "attend-selection");
  assert.equal(selection.stateRevision, 7);
  assert.deepEqual(selection.selectedMarkIds, ["phrase_1"]);
  assert.deepEqual(selection.predicate, {
    field: "phrase",
    operator: "equals",
    value: "local instrument",
  });
  assert.equal(selection.sourceRefs.length, 2);
  assert.equal(selection.sourceRefCount, 2);
  assert.equal(selection.sourceRefsTruncated, false);
  assert.equal(selection.sourceRefs[0].displayPath, "notes/a.md");
  assert.equal(selection.sourceRefs[0].sourceSha256, "a".repeat(64));
  assert.equal(selection.marks[0].occurrenceCount, 3);
  assert.equal(selection.filters.minCount, 3);
  assert.equal(selection.filters.minSources, 2);
});

test("an empty selection has a neutral predicate and deterministic identity", () => {
  const state = {
    revision: 0,
    selectedIds: [],
    query: "",
    minCount: 2,
    sort: { by: "occurrenceCount", direction: "desc" },
    sourceScope: { mode: "all", sourceIds: [] },
  };
  const selection = buildSelection(dataPackage, state);

  assert.equal(selection.predicate, null);
  assert.deepEqual(selection.selectedMarkIds, []);
  assert.deepEqual(selection.marks, []);
  assert.equal(selection.sourceRefCount, 0);
  assert.deepEqual(selection.sourceRefs, []);
  assert.equal(selection.id, buildSelection(dataPackage, state).id);
});

test("multiple selected marks retain an explicit phrase-set predicate", () => {
  const multiPackage = {
    ...dataPackage,
    rows: [
      ...dataPackage.rows,
      {
        id: "phrase_2",
        phrase: "design system",
        occurrenceCount: 2,
        distinctSourceCount: 2,
        occurrences: [
          { sourceId: "source_a", line: 12, excerpt: "a design system" },
          { sourceId: "source_b", line: 18, excerpt: "the design system" },
        ],
      },
    ],
  };
  const state = {
    revision: 3,
    selectedIds: ["phrase_1", "phrase_2"],
    query: "",
    minCount: 2,
    sort: { by: "occurrenceCount", direction: "desc" },
    sourceScope: { mode: "all", sourceIds: [] },
  };
  const selection = buildSelection(multiPackage, state);

  assert.deepEqual(selection.predicate, {
    field: "phrase",
    operator: "in",
    value: ["local instrument", "design system"],
  });
  assert.deepEqual(selection.selectedMarkIds, ["phrase_1", "phrase_2"]);
  assert.equal(selection.id, buildSelection(multiPackage, state).id);
});

test("buildSelection bounds inline evidence without losing the exact count", () => {
  const selection = buildSelection(
    dataPackage,
    {
      revision: 1,
      selectedIds: ["phrase_1"],
      query: "",
      minCount: 2,
      sort: { by: "occurrenceCount", direction: "desc" },
      sourceScope: { mode: "all", sourceIds: ["source_a", "source_b"] },
    },
    { sourceRefLimit: 1 },
  );
  assert.equal(selection.sourceRefs.length, 1);
  assert.equal(selection.sourceRefCount, 2);
  assert.equal(selection.sourceRefsTruncated, true);
});

test("all-source selections stay compact and have canonical deterministic ids", () => {
  const sourceIds = Array.from(
    { length: 2_547 },
    (_, index) => `source_${String(index).padStart(4, "0")}`,
  );
  const largePackage = {
    ...dataPackage,
    sources: sourceIds.map((id) => ({
      id,
      displayPath: `notes/${id}.md`,
      sha256: id.padEnd(64, "0"),
    })),
    rows: [
      {
        ...dataPackage.rows[0],
        occurrences: [
          { sourceId: sourceIds[0], line: 4, excerpt: "a local instrument" },
          { sourceId: sourceIds.at(-1), line: 9, excerpt: "the local instrument" },
        ],
      },
    ],
  };
  const state = {
    revision: 7,
    selectedIds: ["phrase_1"],
    query: "local",
    minCount: 2,
    sort: { by: "occurrenceCount", direction: "desc" },
  };

  const legacy = buildSelection(largePackage, {
    ...state,
    sourceScope: { mode: "all", sourceIds },
  });
  const canonical = buildSelection(largePackage, {
    ...state,
    sourceScope: { mode: "all", sourceIds: [] },
  });

  assert.deepEqual(legacy.filters.sourceScope, { mode: "all", sourceIds: [] });
  assert.equal(legacy.id, canonical.id);
  assert.equal(legacy.id, buildSelection(largePackage, {
    ...state,
    sourceScope: { mode: "all", sourceIds },
  }).id);
  assert.equal(legacy.sourceRefCount, 2);
  assert.deepEqual(legacy.sourceRefs, canonical.sourceRefs);
  assert.ok(JSON.stringify(legacy).length < 2_500);
});

test("include-source selections retain their explicit validated ids", () => {
  const state = {
    revision: 1,
    selectedIds: ["phrase_1"],
    query: "",
    minCount: 2,
    sort: { by: "occurrenceCount", direction: "desc" },
    sourceScope: { mode: "include", sourceIds: ["source_b", "source_a", "source_b"] },
  };
  const selection = buildSelection(dataPackage, state);

  assert.deepEqual(selection.filters.sourceScope, {
    mode: "include",
    sourceIds: ["source_b", "source_a"],
  });
  assert.equal(selection.id, buildSelection(dataPackage, state).id);
  assert.throws(
    () => buildSelection(dataPackage, {
      ...state,
      sourceScope: { mode: "include", sourceIds: ["source_missing"] },
    }),
    /Unknown source id/,
  );
});
