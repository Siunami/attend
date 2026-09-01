function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function dated(index) {
  return `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}T12:00:00`;
}

function genericRecords(definition, count) {
  return Array.from({ length: count }, (_, index) => Object.fromEntries(
    definition.roles.required.map((role) => {
      if (role.types.includes("number")) return [role.id, index + 1];
      if (role.types.includes("time")) return [role.id, dated(index)];
      if (role.types.includes("identifier")) return [role.id, `${role.id}_${index + 1}`];
      return [role.id, `${role.id} ${index + 1}`];
    }),
  ));
}

function hierarchyRecords({ withOrder = false, withValues = false } = {}) {
  return [
    { id: "root", label: "Root", ...(withOrder ? { order: 0 } : {}) },
    { id: "branch_a", parentId: "root", label: "Branch A", ...(withOrder ? { order: 1 } : {}) },
    { id: "branch_b", parentId: "root", label: "Branch B", ...(withOrder ? { order: 2 } : {}), ...(withValues ? { value: 2 } : {}) },
    { id: "leaf_a1", parentId: "branch_a", label: "Leaf A1", ...(withOrder ? { order: 1 } : {}), ...(withValues ? { value: 3 } : {}) },
    { id: "leaf_a2", parentId: "branch_a", label: "Leaf A2", ...(withOrder ? { order: 2 } : {}), ...(withValues ? { value: 5 } : {}) },
  ];
}

function recordsFor(definition) {
  switch (definition.key) {
    case "rank/bar-list": return Array.from({ length: 3 }, (_, index) => ({ label: `Item ${index + 1}`, value: index + 1 }));
    case "rank/dot-plot": return Array.from({ length: 20 }, (_, index) => ({ label: `Item ${index + 1}`, value: index + 10 }));
    case "rank/slopegraph": return Array.from({ length: 5 }, (_, index) => [
      { label: `Item ${index + 1}`, state: "Before", stateOrder: 1, value: index + 1 },
      { label: `Item ${index + 1}`, state: "After", stateOrder: 2, value: 6 - index },
    ]).flat();
    case "distribution/strip": return Array.from({ length: 5 }, (_, value) => ({ value }));
    case "distribution/histogram": return Array.from({ length: 50 }, (_, value) => ({ value }));
    case "distribution/ecdf": return Array.from({ length: 20 }, (_, value) => ({ value }));
    case "composition/hundred-bar":
    case "composition/part-list": return [{ part: "A", value: 2, whole: "All" }, { part: "B", value: 3, whole: "All" }];
    case "profile/parallel": return ["A", "B"].flatMap((entity) => ["One", "Two", "Three"].map((dimension, index) => ({ entity, dimension, value: index + 1 })));
    case "profile/profile-table": return ["A", "B", "C"].flatMap((entity) => ["One", "Two"].map((dimension, index) => ({ entity, dimension, value: index + 1 })));
    case "passage-comparison/parallel-text": return [{ passage: "First text", version: "v1" }, { passage: "Second text", version: "v2" }];
    case "trend/line": return Array.from({ length: 12 }, (_, index) => ({ time: dated(index), value: index + 1, series: "All" }));
    case "trend/period-bars": return Array.from({ length: 6 }, (_, index) => ({ time: dated(index), value: index + 1, calendarGrain: "month", series: "All" }));
    case "timeline/interval": return Array.from({ length: 3 }, (_, index) => ({ time: dated(index), endTime: dated(index + 1), label: `Event ${index + 1}` }));
    case "timeline/event-strip": return Array.from({ length: 5 }, (_, index) => ({ time: dated(index), label: `Event ${index + 1}` }));
    case "sequence/step-strip": return Array.from({ length: 3 }, (_, index) => ({ order: index + 1, label: `Step ${index + 1}` }));
    case "sequence/state-ribbon": return Array.from({ length: 3 }, (_, index) => ({ order: index + 1, label: `State ${index + 1}`, duration: index + 1 }));
    case "relationship/scatter":
    case "relationship/marginals": return Array.from({ length: 10 }, (_, index) => ({ x: index, y: index * 2 }));
    case "matrix/heatmap": return ["A", "B"].flatMap((row) => ["X", "Y"].map((column, index) => ({ row, column, value: index + 1 })));
    case "hierarchy/tidy": return hierarchyRecords();
    case "hierarchy/outline": return hierarchyRecords({ withOrder: true });
    case "hierarchy/icicle":
    case "hierarchy/treemap": return hierarchyRecords({ withValues: true });
    case "network/local": return Array.from({ length: 5 }, (_, index) => ({ source: `Node ${index}`, target: `Node ${index + 1}` }));
    case "flow/sankey": return [{ source: "A", target: "B", value: 4 }, { source: "B", target: "C", value: 3 }];
    case "mechanism/flowchart": return [{ source: "A", target: "B", relation: "calls" }, { source: "B", target: "C", relation: "returns" }];
    case "region-map/choropleth": return ["01", "02", "04", "05", "06"].map((region, index) => ({ region, value: (index + 1) / 10, baseline: 100 }));
    case "region-map/region-symbols": return ["01", "02", "04", "05", "06"].map((region, index) => ({ region, value: index + 1 }));
    case "point-map/exact-points": return [{ latitude: 40.7, longitude: -74 }];
    case "field/sample-raster": return Array.from({ length: 20 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), value: index }));
    case "field/contours": return Array.from({ length: 10 }, (_, y) => Array.from({ length: 10 }, (_, x) => ({ x, y, value: x + y }))).flat();
    case "collection-atlas/faceted-atlas": return Array.from({ length: 10 }, (_, index) => ({
      label: `Item ${index + 1}`,
      cluster: index < 5 ? "A" : "B",
      order: index % 5,
    }));
    case "collection-atlas/contact-atlas": return Array.from({ length: 12 }, (_, index) => ({
      assetId: `asset_${String(index + 1).padStart(32, "0")}`,
      previewRoute: `assets/asset_${String(index + 1).padStart(32, "0")}`,
      label: `Image ${index + 1}`,
      captureTime: dated(index),
      order: index,
      width: 1_200,
      height: 800,
      orientation: 1,
    }));
    default: {
      const count = definition.requirements.find((requirement) => requirement.kind === "record-count")?.minimum ?? 1;
      return genericRecords(definition, count);
    }
  }
}

export function formFixture(definition) {
  const records = recordsFor(definition);
  const roleMapping = Object.fromEntries(
    [...definition.roles.required, ...definition.roles.optional]
      .filter((role) => records.some((record) => record[role.id] !== undefined))
      .map((role) => [role.id, role.id]),
  );
  return deepFreeze({
    id: definition.fixtureId,
    familyId: definition.familyId,
    memberId: definition.memberId,
    adapter: definition.key === "collection-atlas/contact-atlas" ? "local-image-set-v1" : "evidenced-records-v1",
    roleMapping,
    records,
  });
}
