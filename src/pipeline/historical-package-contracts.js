const HISTORICAL_VERSIONS = Object.freeze([
  "3904c28aabcbc405",
  "3bcb588eaf291763",
]);

const PROFILE_ADAPTATIONS = Object.freeze({
  "3d-mixed": "enrich",
  audio: "deterministic",
  document: "deterministic",
  geography: "deterministic",
  image: "direct",
  "numeric-chart": "direct",
  text: "direct",
  video: "deterministic",
});

const ROLE_TYPES = Object.freeze({
  baseline: ["number"],
  cluster: ["string"],
  column: ["string"],
  dimension: ["string"],
  duration: ["number"],
  endTime: ["time"],
  entity: ["string"],
  group: ["string"],
  id: ["identifier"],
  label: ["string"],
  lane: ["string"],
  latitude: ["latitude"],
  longitude: ["longitude"],
  order: ["number"],
  parentId: ["identifier"],
  part: ["string"],
  passage: ["string"],
  region: ["identifier"],
  relation: ["string"],
  row: ["string"],
  series: ["string"],
  similarity: ["number"],
  size: ["number"],
  source: ["identifier"],
  stage: ["string"],
  status: ["string"],
  target: ["identifier"],
  time: ["time"],
  uncertainty: ["number"],
  value: ["number"],
  version: ["string", "time"],
  weight: ["number"],
  whole: ["string"],
  x: ["number"],
  y: ["number"],
});

const ROLE_TYPE_OVERRIDES = Object.freeze({
  "flow/sankey": Object.freeze({ source: ["string"], target: ["string"] }),
  "sequence/step-strip": Object.freeze({ order: ["number", "time"] }),
});

const FROZEN_GEOGRAPHY = Object.freeze({
  donor: "People Atlas",
  fixedProjectedComparison: Object.freeze({
    library: "d3-geo",
    useWhen: "Several maps must share a fixed projection, extent, and scale for reliable comparison.",
    version: "3",
  }),
  interactiveGlobal: Object.freeze({
    library: "MapLibre GL JS",
    useWhen: "The person must pan, zoom, inspect, or filter a global or multi-resolution geographic view.",
    version: "5.6.1",
  }),
});

const SPECS = Object.freeze([
  { familyId: "rank", memberId: "bar-list", group: "compare", required: ["label", "value"], optional: ["group", "baseline"], payloadKind: "attend-rank-payload", collection: "items", payloadFields: ["groups", "order", "valueExtent"], projectorId: "rank/deterministic-v1", rendererId: "attend-rank", variant: "bar-list", minimumMarks: 2, profiles: ["numeric-chart", "image", "video", "audio", "text", "document"] },
  { familyId: "distribution", memberId: "strip", group: "compare", required: ["value"], optional: ["label", "group", "weight"], payloadKind: "attend-distribution-payload", collection: "observations", payloadFields: ["groups", "valueExtent"], projectorId: "distribution/deterministic-v1", rendererId: "attend-distribution", variant: "strip", minimumMarks: 3, profiles: ["numeric-chart"] },
  { familyId: "composition", memberId: "hundred-bar", group: "compare", required: ["part", "value"], optional: ["whole"], payloadKind: "attend-composition-payload", collection: "parts", payloadFields: ["totals"], projectorId: "composition/deterministic-v1", rendererId: "attend-composition", variant: "absolute-stack", minimumMarks: 2, profiles: ["numeric-chart"] },
  { familyId: "profile", memberId: "parallel", group: "compare", required: ["entity", "dimension", "value"], optional: ["baseline"], payloadKind: "attend-profile-payload", collection: "measurements", payloadFields: ["dimensions", "entities", "missingCellCount"], projectorId: "profile/deterministic-v1", rendererId: "attend-profile", variant: "parallel-profile", minimumMarks: 3, profiles: ["numeric-chart"] },
  { familyId: "passage-comparison", memberId: "parallel-text", group: "compare", required: ["passage", "version"], optional: ["label", "order"], payloadKind: "attend-passage-comparison-payload", collection: "passages", payloadFields: ["labels", "versions"], projectorId: "passage-comparison/deterministic-v1", rendererId: "attend-passage-comparison", variant: "aligned-passages", minimumMarks: 2, profiles: ["text", "document"] },
  { familyId: "trend", memberId: "line", group: "time", required: ["time", "value"], optional: ["series", "label"], payloadKind: "attend-trend-payload", collection: "points", payloadFields: ["series", "timeExtent", "valueExtent"], projectorId: "trend/deterministic-v1", rendererId: "attend-trend", variant: "observed-line", minimumMarks: 2, profiles: ["numeric-chart"] },
  { familyId: "timeline", memberId: "interval", group: "time", required: ["time", "label"], optional: ["endTime", "lane", "status"], payloadKind: "attend-timeline-payload", collection: "events", payloadFields: ["lanes", "timeExtent"], projectorId: "timeline/deterministic-v1", rendererId: "attend-timeline", variant: "event-strip", minimumMarks: 1, profiles: ["numeric-chart", "image", "video", "audio", "text", "document"] },
  { familyId: "sequence", memberId: "step-strip", group: "time", required: ["order", "label"], optional: ["stage", "duration"], payloadKind: "attend-sequence-payload", collection: "steps", payloadFields: ["stages"], projectorId: "sequence/deterministic-v1", rendererId: "attend-sequence", variant: "storyboard", minimumMarks: 2, profiles: ["image", "video", "audio", "text", "document", "3d-mixed"] },
  { familyId: "relationship", memberId: "scatter", group: "relate", required: ["x", "y"], optional: ["label", "group", "size"], payloadKind: "attend-relationship-payload", collection: "points", payloadFields: ["domains", "groups"], projectorId: "relationship/deterministic-v1", rendererId: "attend-relationship", variant: "scatter", minimumMarks: 3, profiles: ["numeric-chart"] },
  { familyId: "matrix", memberId: "heatmap", group: "relate", required: ["row", "column", "value"], optional: ["label"], payloadKind: "attend-matrix-payload", collection: "cells", payloadFields: ["columns", "missingCellCount", "rows", "valueExtent"], projectorId: "matrix/deterministic-v1", rendererId: "attend-matrix", variant: "heat-matrix", minimumMarks: 2, profiles: ["numeric-chart", "image", "text"] },
  { familyId: "hierarchy", memberId: "tidy", group: "relate", required: ["id", "label"], optional: ["parentId", "value"], payloadKind: "attend-hierarchy-payload", collection: "nodes", payloadFields: ["maximumDepth", "rootIds"], projectorId: "hierarchy/deterministic-v1", rendererId: "attend-hierarchy", variant: "node-tree", minimumMarks: 2, profiles: ["numeric-chart", "image", "text", "document"] },
  { familyId: "network", memberId: "local", group: "relate", required: ["source", "target"], optional: ["weight", "relation", "label"], payloadKind: "attend-network-payload", collection: "edges", payloadFields: ["nodes", "relations"], projectorId: "network/deterministic-v1", rendererId: "attend-network", variant: "node-link", minimumMarks: 1, profiles: ["numeric-chart", "text"] },
  { familyId: "flow", memberId: "sankey", group: "relate", required: ["source", "target", "value"], optional: ["stage", "label"], payloadKind: "attend-flow-payload", collection: "links", payloadFields: ["nodes", "stages", "totalFlow"], projectorId: "flow/deterministic-v1", rendererId: "attend-flow", variant: "sankey", minimumMarks: 1, profiles: ["numeric-chart"] },
  { familyId: "mechanism", memberId: "flowchart", group: "relate", required: ["source", "target", "relation"], optional: ["label", "stage", "weight"], payloadKind: "attend-mechanism-payload", collection: "links", payloadFields: ["nodes", "relations"], projectorId: "mechanism/deterministic-v1", rendererId: "attend-mechanism", variant: "system-schematic", minimumMarks: 1, profiles: ["text", "image", "document", "3d-mixed"] },
  { familyId: "region-map", memberId: "choropleth", group: "space", required: ["region", "value"], optional: ["label", "baseline"], payloadKind: "attend-region-map-payload", collection: "regions", payloadFields: ["regionIds", "valueExtent"], projectorId: "region-map/deterministic-v1", rendererId: "attend-region-map", variant: "choropleth", minimumMarks: 1, profiles: ["geography", "numeric-chart"], geography: FROZEN_GEOGRAPHY },
  { familyId: "point-map", memberId: "exact-points", group: "space", required: ["latitude", "longitude"], optional: ["label", "value", "group"], payloadKind: "attend-point-map-payload", collection: "points", payloadFields: ["extent", "groups"], projectorId: "point-map/deterministic-v1", rendererId: "attend-point-map", variant: "dot-map", minimumMarks: 1, profiles: ["geography", "image", "numeric-chart"], geography: FROZEN_GEOGRAPHY },
  { familyId: "field", memberId: "sample-raster", group: "space", required: ["x", "y", "value"], optional: ["label", "uncertainty"], payloadKind: "attend-field-payload", collection: "samples", payloadFields: ["domains"], projectorId: "field/deterministic-v1", rendererId: "attend-field", variant: "contours", minimumMarks: 3, profiles: ["numeric-chart", "image", "geography"] },
  { familyId: "collection-atlas", memberId: "faceted-atlas", group: "browse", required: ["x", "y", "label"], optional: ["cluster", "similarity", "order"], payloadKind: "attend-collection-atlas-payload", collection: "items", payloadFields: ["clusters", "domains"], projectorId: "collection-atlas/deterministic-v1", rendererId: "attend-collection-atlas", variant: "semantic-field", minimumMarks: 2, profiles: ["image", "video", "audio", "text", "document", "3d-mixed"] },
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function roleContracts(ids, key) {
  return ids.map((id) => ({
    id,
    types: [...(ROLE_TYPE_OVERRIDES[key]?.[id] ?? ROLE_TYPES[id])],
  }));
}

function contractFromSpec(spec) {
  const key = `${spec.familyId}/${spec.memberId}`;
  const renderer = {
    id: spec.rendererId,
    version: 1,
    variant: spec.variant,
  };
  return deepFreeze({
    schemaVersion: 1,
    familyId: spec.familyId,
    memberId: spec.memberId,
    key,
    family: {
      id: spec.familyId,
      version: 1,
      group: spec.group,
      dataSchemaVersion: 1,
      minimumMarks: spec.minimumMarks,
      maximumMarks: 50_000,
      maximumEnrichments: 48,
    },
    roles: {
      required: roleContracts(spec.required, key),
      optional: roleContracts(spec.optional, key),
    },
    payload: {
      schemaVersion: 1,
      kind: spec.payloadKind,
      collection: spec.collection,
      fields: [...spec.payloadFields],
      itemFields: [],
    },
    projector: { id: spec.projectorId, version: 1 },
    renderer,
    presentation: {
      renderer,
      multiples: {
        policy: { id: "attend-repeat-layout", version: 1 },
        supportedProfiles: [...spec.profiles],
        adaptationDecisions: Object.fromEntries(
          spec.profiles.map((profile) => [profile, PROFILE_ADAPTATIONS[profile]]),
        ),
      },
      geography: spec.geography ?? null,
    },
    selection: { targetKinds: [] },
  });
}

const SHARED_CONTRACTS = Object.freeze(Object.fromEntries(
  SPECS.map((spec) => [`${spec.familyId}/${spec.memberId}`, contractFromSpec(spec)]),
));

export const HISTORICAL_PACKAGE_CONTRACTS = Object.freeze(Object.fromEntries(
  HISTORICAL_VERSIONS.flatMap((version) => Object.entries(SHARED_CONTRACTS)
    .map(([key, contract]) => [`${version}/${key}`, contract])),
));

export function historicalPackageContractForMember(version, familyId, memberId) {
  const key = `${String(version)}/${String(familyId)}/${String(memberId)}`;
  const contract = HISTORICAL_PACKAGE_CONTRACTS[key];
  if (contract) return contract;
  const error = new RangeError(`Unknown historical package contract: ${key}`);
  error.code = "UNKNOWN_HISTORICAL_PACKAGE_CONTRACT";
  throw error;
}
