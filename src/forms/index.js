import { canonicalUsStateFips } from "../geography.js";
import { requireMapFamily } from "../map-families/registry.js";
import { AUTHORED_FAMILY_ATLAS_CONTENT } from "../catalog/snapshot.js";
import { sha256HexSync } from "./sha256.js";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return sha256HexSync(typeof value === "string" ? value : canonicalJson(value));
}

function stableId(prefix, value) {
  return `${prefix}_${sha256Hex(value).slice(0, 16)}`;
}

export const FORM_REQUIREMENT_KINDS = Object.freeze([
  "absent-fields",
  "adapter-policy",
  "complete-cartesian",
  "directed-flow",
  "directed-graph",
  "distinct-count",
  "field-evidence",
  "geography-binding",
  "graph-node-count",
  "group-size",
  "hierarchy-depth",
  "hierarchy-leaf-count",
  "hierarchy-leaf-values",
  "hierarchy-tree",
  "media-policy",
  "nonconstant",
  "numeric-aggregate",
  "numeric-range",
  "one-to-one-mapping",
  "record-count",
  "regular-grid",
  "renderer-binding",
  "required-fields",
  "time-order",
  "unique-tuple",
]);
const FORM_REQUIREMENT_KIND_SET = new Set(FORM_REQUIREMENT_KINDS);

export function assertSupportedFormRequirement(requirement) {
  if (requirement && FORM_REQUIREMENT_KIND_SET.has(requirement.kind)) return requirement;
  const error = new RangeError(`Unknown form requirement kind: ${String(requirement?.kind)}`);
  error.code = "UNKNOWN_FORM_REQUIREMENT";
  throw error;
}

/**
 * Executable forms are deliberately finite. This registry is the only place
 * where an authored Atlas member becomes a compiler and renderer contract.
 */

const role = (id, types, description) => ({
  id,
  types: Array.isArray(types) ? types : [types],
  description,
});

const EXTRA_ROLES = Object.freeze({
  state: role("state", ["string", "time"], "One of the two complete ordered states."),
  stateOrder: role("stateOrder", "number", "Source-backed order shared by every observation in one state."),
  calendarGrain: role("calendarGrain", "string", "Explicit calendar grain shared by every period."),
  assetId: role("assetId", "identifier", "Opaque staged asset identifier."),
  previewRoute: role("previewRoute", "string", "Relative same-origin preview route."),
  captureTime: role("captureTime", "time", "Camera-local DateTimeOriginal in sortable ISO form."),
  width: role("width", "number", "Verified JPEG width in pixels."),
  height: role("height", "number", "Verified JPEG height in pixels."),
  orientation: role("orientation", "number", "Verified EXIF orientation value."),
  captureTimezone: role("captureTimezone", "string", "Capture timezone when evidenced."),
  tieDisclosure: role("tieDisclosure", "string", "Disclosure for tied camera-local timestamps."),
});

const LEGACY_REQUIREMENTS = Object.freeze({
  rank: [
    { id: "record-count", kind: "record-count", minimum: 3, maximum: 40 },
    { id: "unique-labels", kind: "unique-tuple", fields: ["label"] },
  ],
  distribution: [{ id: "record-count", kind: "record-count", minimum: 5, maximum: 400 }],
  composition: [
    { id: "record-count", kind: "record-count", minimum: 2, maximum: 6 },
    { id: "named-whole", kind: "required-fields", fields: ["whole"] },
    { id: "one-whole", kind: "distinct-count", field: "whole", minimum: 1, maximum: 1 },
    { id: "unique-parts", kind: "unique-tuple", fields: ["part"] },
    { id: "nonnegative-parts", kind: "numeric-range", field: "value", minimum: 0 },
    { id: "positive-total", kind: "numeric-aggregate", field: "value", operation: "sum", exclusiveMinimum: 0 },
  ],
  profile: [
    { id: "entity-count", kind: "distinct-count", field: "entity", minimum: 2, maximum: 12 },
    { id: "dimension-count", kind: "distinct-count", field: "dimension", minimum: 3, maximum: 8 },
    { id: "unique-entity-dimensions", kind: "unique-tuple", fields: ["entity", "dimension"] },
    { id: "complete-entity-dimension-grid", kind: "complete-cartesian", fields: ["entity", "dimension"] },
  ],
  "passage-comparison": [
    { id: "exactly-two-versions", kind: "distinct-count", field: "version", minimum: 2, maximum: 2 },
  ],
  trend: [
    { id: "record-count", kind: "record-count", minimum: 12, maximum: 5_000 },
    { id: "series-count", kind: "distinct-count", field: "series", minimum: 1, maximum: 4, missingValue: "implicit-series" },
    { id: "unique-series-times", kind: "unique-tuple", fields: ["series", "time"], missingValue: "implicit-series" },
  ],
  timeline: [
    { id: "record-count", kind: "record-count", minimum: 3, maximum: 60 },
    { id: "bounded-intervals", kind: "required-fields", fields: ["endTime"] },
    { id: "ordered-intervals", kind: "time-order", startField: "time", endField: "endTime" },
  ],
  sequence: [
    { id: "record-count", kind: "record-count", minimum: 3, maximum: 24 },
    { id: "unique-step-order", kind: "unique-tuple", fields: ["order"] },
  ],
  relationship: [{ id: "record-count", kind: "record-count", minimum: 10, maximum: 5_000 }],
  matrix: [
    { id: "row-count", kind: "distinct-count", field: "row", minimum: 2, maximum: 50 },
    { id: "column-count", kind: "distinct-count", field: "column", minimum: 2, maximum: 100 },
    { id: "unique-cells", kind: "unique-tuple", fields: ["row", "column"] },
    { id: "complete-matrix", kind: "complete-cartesian", fields: ["row", "column"] },
  ],
  hierarchy: [
    { id: "record-count", kind: "record-count", minimum: 5, maximum: 500 },
    { id: "one-rooted-tree", kind: "hierarchy-tree", idField: "id", parentField: "parentId", rootCount: 1 },
  ],
  network: [{
    id: "bounded-sparse-network",
    kind: "directed-graph",
    sourceField: "source",
    targetField: "target",
    minimumNodes: 5,
    maximumNodes: 100,
    connected: "weak",
    allowSelfEdges: false,
    allowDuplicateEdges: false,
    maximumEdgesPerNode: 3,
  }],
  flow: [{
    id: "bounded-directed-flow",
    kind: "directed-flow",
    sourceField: "source",
    targetField: "target",
    valueField: "value",
    minimumValue: 0,
    minimumStages: 2,
    maximumStages: 5,
    maximumNodes: 30,
    stageDerivation: "topological-depth",
    stageFieldPolicy: "evidenced-link-label-only",
    conservationGaps: "derive-and-render",
    allowSelfEdges: false,
    allowDuplicateEdges: false,
    acyclic: true,
  }],
  mechanism: [
    { id: "node-count", kind: "graph-node-count", sourceField: "source", targetField: "target", minimum: 3, maximum: 40 },
  ],
  "region-map": [
    { id: "record-count", kind: "record-count", minimum: 5, maximum: 56 },
    { id: "unique-regions", kind: "unique-tuple", fields: ["region"], canonical: "us-state-fips" },
    { id: "declared-denominator", kind: "required-fields", fields: ["baseline"] },
    { id: "positive-denominator", kind: "numeric-range", field: "baseline", exclusiveMinimum: 0 },
    { id: "normalized-value", kind: "numeric-range", field: "value", minimum: 0, maximum: 1 },
  ],
  "point-map": [
    { id: "record-count", kind: "record-count", minimum: 1, maximum: 2_000 },
    { id: "unique-coordinates", kind: "unique-tuple", fields: ["latitude", "longitude"] },
  ],
  field: [
    { id: "record-count", kind: "record-count", minimum: 20, maximum: 2_500 },
    { id: "unique-samples", kind: "unique-tuple", fields: ["x", "y"] },
  ],
  "collection-atlas": [{
    id: "bounded-clusters",
    kind: "group-size",
    field: "cluster",
    minimumGroups: 2,
    maximumGroups: 12,
    minimumItems: 5,
    maximumItems: 200,
  }],
});

const NEW_REQUIREMENTS = Object.freeze({
  "rank/dot-plot": [
    { id: "record-count", kind: "record-count", minimum: 20, maximum: 300 },
    { id: "unique-labels", kind: "unique-tuple", fields: ["label"] },
  ],
  "rank/slopegraph": [
    { id: "item-count", kind: "distinct-count", field: "label", minimum: 5, maximum: 40 },
    { id: "exactly-two-states", kind: "distinct-count", field: "state", minimum: 2, maximum: 2 },
    { id: "exactly-two-state-orders", kind: "distinct-count", field: "stateOrder", minimum: 2, maximum: 2 },
    { id: "finite-state-order", kind: "numeric-range", field: "stateOrder" },
    { id: "evidenced-state-order", kind: "one-to-one-mapping", leftField: "state", rightField: "stateOrder" },
    { id: "unique-item-states", kind: "unique-tuple", fields: ["label", "state"] },
    { id: "complete-item-state-grid", kind: "complete-cartesian", fields: ["label", "state"] },
  ],
  "distribution/histogram": [
    { id: "record-count", kind: "record-count", minimum: 50, maximum: 50_000 },
    { id: "unweighted", kind: "absent-fields", fields: ["weight"] },
  ],
  "distribution/ecdf": [
    { id: "record-count", kind: "record-count", minimum: 20, maximum: 50_000 },
    { id: "unweighted", kind: "absent-fields", fields: ["weight"] },
  ],
  "composition/part-list": [
    { id: "record-count", kind: "record-count", minimum: 2, maximum: 30 },
    { id: "named-whole", kind: "required-fields", fields: ["whole"] },
    { id: "one-whole", kind: "distinct-count", field: "whole", minimum: 1, maximum: 1 },
    { id: "unique-parts", kind: "unique-tuple", fields: ["part"] },
    { id: "nonnegative-parts", kind: "numeric-range", field: "value", minimum: 0 },
    { id: "positive-total", kind: "numeric-aggregate", field: "value", operation: "sum", exclusiveMinimum: 0 },
  ],
  "profile/profile-table": [
    { id: "entity-count", kind: "distinct-count", field: "entity", minimum: 3, maximum: 60 },
    { id: "dimension-count", kind: "distinct-count", field: "dimension", minimum: 2, maximum: 8 },
    { id: "unique-entity-dimensions", kind: "unique-tuple", fields: ["entity", "dimension"] },
  ],
  "trend/period-bars": [
    { id: "record-count", kind: "record-count", minimum: 6, maximum: 60 },
    { id: "one-series", kind: "distinct-count", field: "series", minimum: 1, maximum: 1, missingValue: "implicit-series" },
    { id: "explicit-calendar-grain", kind: "required-fields", fields: ["calendarGrain"] },
    { id: "one-calendar-grain", kind: "distinct-count", field: "calendarGrain", minimum: 1, maximum: 1 },
    { id: "unique-periods", kind: "unique-tuple", fields: ["time"] },
  ],
  "timeline/event-strip": [
    { id: "record-count", kind: "record-count", minimum: 5, maximum: 500 },
    { id: "instantaneous-events", kind: "absent-fields", fields: ["endTime"] },
    { id: "one-context", kind: "absent-fields", fields: ["lane"] },
  ],
  "sequence/state-ribbon": [
    { id: "record-count", kind: "record-count", minimum: 3, maximum: 60 },
    { id: "unique-order", kind: "unique-tuple", fields: ["order"] },
    { id: "observed-duration", kind: "required-fields", fields: ["duration"] },
    { id: "positive-duration", kind: "numeric-range", field: "duration", exclusiveMinimum: 0 },
  ],
  "relationship/marginals": [
    { id: "record-count", kind: "record-count", minimum: 10, maximum: 2_000 },
  ],
  "hierarchy/outline": [
    { id: "record-count", kind: "record-count", minimum: 5, maximum: 5_000 },
    { id: "one-rooted-tree", kind: "hierarchy-tree", idField: "id", parentField: "parentId", rootCount: 1 },
    { id: "evidenced-sibling-order", kind: "unique-tuple", fields: ["parentId", "order"] },
  ],
  "hierarchy/icicle": [
    { id: "record-count", kind: "record-count", minimum: 5, maximum: 300 },
    { id: "one-rooted-tree", kind: "hierarchy-tree", idField: "id", parentField: "parentId", rootCount: 1 },
    { id: "tree-depth", kind: "hierarchy-depth", minimum: 2, maximum: 5 },
    { id: "additive-leaf-values", kind: "hierarchy-leaf-values", positive: true },
  ],
  "hierarchy/treemap": [
    { id: "one-rooted-tree", kind: "hierarchy-tree", idField: "id", parentField: "parentId", rootCount: 1 },
    { id: "tree-depth", kind: "hierarchy-depth", minimum: 2, maximum: 3 },
    { id: "leaf-count", kind: "hierarchy-leaf-count", minimum: 2, maximum: 1_000 },
    { id: "positive-additive-leaves", kind: "hierarchy-leaf-values", positive: true },
  ],
  "region-map/region-symbols": [
    { id: "record-count", kind: "record-count", minimum: 5, maximum: 56 },
    { id: "unique-regions", kind: "unique-tuple", fields: ["region"], canonical: "us-state-fips" },
    { id: "nonnegative-totals", kind: "numeric-range", field: "value", minimum: 0 },
    { id: "bundled-us-centers", kind: "geography-binding", geography: "us-atlas/states-10m", field: "region" },
  ],
  "field/contours": [
    { id: "sample-count", kind: "record-count", minimum: 100, maximum: 50_000 },
    { id: "regular-grid", kind: "regular-grid", xField: "x", yField: "y", minimumWidth: 10, minimumHeight: 10, maximumSamples: 50_000 },
    { id: "nonconstant-field", kind: "nonconstant", field: "value" },
  ],
  "collection-atlas/contact-atlas": [
    { id: "record-count", kind: "record-count", minimum: 12, maximum: 200 },
    { id: "one-directory", kind: "adapter-policy", adapterId: "local-image-set-v1" },
    { id: "capture-time", kind: "required-fields", fields: ["captureTime"] },
    { id: "unique-assets", kind: "unique-tuple", fields: ["assetId"] },
    { id: "jpeg-only", kind: "media-policy", mimeTypes: ["image/jpeg"] },
  ],
});

const LEGACY_FORMS = Object.freeze([
  ["rank", "bar-list", "bar-list"],
  ["distribution", "strip", "strip"],
  ["composition", "hundred-bar", "normalized-parts"],
  ["profile", "parallel", "parallel-profile"],
  ["passage-comparison", "parallel-text", "aligned-passages"],
  ["trend", "line", "observed-line"],
  ["timeline", "interval", "lane-timeline"],
  ["sequence", "step-strip", "storyboard"],
  ["relationship", "scatter", "scatter"],
  ["matrix", "heatmap", "heat-matrix"],
  ["hierarchy", "tidy", "node-tree"],
  ["network", "local", "node-link"],
  ["flow", "sankey", "sankey"],
  ["mechanism", "flowchart", "system-schematic"],
  ["region-map", "choropleth", "choropleth"],
  ["point-map", "exact-points", "dot-map"],
  ["field", "sample-raster", "sample-raster"],
  ["collection-atlas", "faceted-atlas", "contact-atlas"],
]);

const NEW_FORMS = Object.freeze([
  ["rank", "dot-plot"],
  ["rank", "slopegraph"],
  ["distribution", "histogram"],
  ["distribution", "ecdf"],
  ["composition", "part-list"],
  ["profile", "profile-table"],
  ["trend", "period-bars"],
  ["timeline", "event-strip"],
  ["sequence", "state-ribbon"],
  ["relationship", "marginals"],
  ["hierarchy", "outline"],
  ["hierarchy", "icicle"],
  ["hierarchy", "treemap"],
  ["region-map", "region-symbols"],
  ["field", "contours"],
  ["collection-atlas", "contact-atlas"],
]);

const LEGACY_PAYLOAD_FIELDS = Object.freeze({
  rank: ["groups", "order", "valueExtent"],
  distribution: ["groups", "valueExtent"],
  composition: ["totals"],
  profile: ["dimensions", "entities", "missingCellCount"],
  "passage-comparison": ["labels", "versions"],
  trend: ["series", "timeExtent", "valueExtent"],
  timeline: ["lanes", "timeExtent"],
  sequence: ["stages"],
  relationship: ["domains", "groups"],
  matrix: ["columns", "missingCellCount", "rows", "valueExtent"],
  hierarchy: ["maximumDepth", "rootIds"],
  network: ["nodes", "relations"],
  flow: ["nodes", "stages", "totalFlow"],
  mechanism: ["nodes", "relations"],
  "region-map": ["regionIds", "valueExtent"],
  "point-map": ["extent", "groups"],
  field: ["domains"],
  "collection-atlas": ["clusters", "domains"],
});

const NEW_PAYLOAD_FIELDS = Object.freeze({
  "rank/dot-plot": ["groups", "order", "valueExtent"],
  "rank/slopegraph": ["segments", "states", "visualTargets"],
  "distribution/histogram": ["binning", "bins", "valueExtent", "visualTargets"],
  "distribution/ecdf": ["steps", "valueExtent", "visualTargets"],
  "composition/part-list": ["total", "whole"],
  "profile/profile-table": ["dimensions", "entities", "missingCellCount", "rows"],
  "trend/period-bars": ["calendarGrain", "timeExtent", "valueExtent"],
  "timeline/event-strip": ["timeExtent"],
  "sequence/state-ribbon": ["totalDuration"],
  "relationship/marginals": ["domains", "xBins", "yBins"],
  "hierarchy/outline": ["maximumDepth", "rootIds", "visualTargets"],
  "hierarchy/icicle": ["maximumDepth", "rootIds", "visualTargets"],
  "hierarchy/treemap": ["maximumDepth", "rootIds", "visualTargets"],
  "region-map/region-symbols": ["regionIds", "valueExtent"],
  "field/contours": ["domains", "levels", "thresholds", "visualTargets"],
  "collection-atlas/contact-atlas": ["captureOrder", "captureTimeDisclosure", "pageSize"],
});

const ROLE_OVERRIDES = Object.freeze({
  "collection-atlas/faceted-atlas": { required: ["label", "cluster"], optional: ["order"] },
  "rank/slopegraph": { required: ["label", "state", "stateOrder", "value"], optional: ["group", "baseline"] },
  "composition/part-list": { required: ["part", "value", "whole"], optional: [] },
  "trend/period-bars": { required: ["time", "value", "calendarGrain"], optional: ["series", "label"] },
  "sequence/state-ribbon": { required: ["order", "label", "duration"], optional: ["stage"] },
  "hierarchy/outline": { required: ["id", "label", "order"], optional: ["parentId", "value"] },
  "collection-atlas/contact-atlas": {
    required: ["assetId", "previewRoute", "label", "captureTime", "width", "height", "orientation"],
    optional: ["captureTimezone", "tieDisclosure", "order"],
  },
});

const GUIDANCE = Object.freeze({
  "rank/bar-list": { preferWhen: "Three to forty named values should be compared as lengths from an honest zero baseline.", preferOver: ["rank/dot-plot"], avoidWhen: "The domain is meaningfully non-zero or the labels would make a long bar list unwieldy.", abstainWhen: "Labels are duplicated or the list falls outside the executable row band." },
  "distribution/strip": { preferWhen: "Exact observations, pileups, gaps, and outliers should remain individually visible.", preferOver: ["distribution/histogram", "distribution/ecdf"], avoidWhen: "The question is about interval counts, percentiles, or threshold shares in a large sample.", abstainWhen: "There are fewer than five or more than four hundred evidenced observations." },
  "composition/hundred-bar": { preferWhen: "The proportional composition of one named whole can be read from two to six parts.", preferOver: ["composition/part-list"], avoidWhen: "Exact part values or more than one whole are the primary lookup task.", abstainWhen: "Parts are duplicated, negative, span multiple wholes, or sum to zero." },
  "profile/parallel": { preferWhen: "The shape of a few complete multivariate profiles matters across three to eight shared dimensions.", preferOver: ["profile/profile-table"], avoidWhen: "Lookup, missing cells, or many entities matter more than profile shape.", abstainWhen: "The entity-dimension grid is incomplete, duplicated, or outside the executable dimensions." },
  "passage-comparison/parallel-text": { preferWhen: "Exactly two evidenced text versions should be read side by side as aligned passages.", preferOver: [], avoidWhen: "There are more than two witnesses or alignment units cannot be kept legible.", abstainWhen: "The records do not resolve to exactly two source-backed versions." },
  "trend/line": { preferWhen: "Ordered observations form one to four continuous time series and the trajectory between observations is the question.", preferOver: ["trend/period-bars"], avoidWhen: "Values are discrete period totals or the implied continuity would be misleading.", abstainWhen: "Times repeat within a series or the series and record limits are exceeded." },
  "timeline/interval": { preferWhen: "Events have evidenced start and end times whose durations and overlaps matter.", preferOver: ["timeline/event-strip"], avoidWhen: "Events are instantaneous or duration is not meaningful.", abstainWhen: "Any interval is unbounded, reversed, or the timeline exceeds sixty records." },
  "sequence/step-strip": { preferWhen: "A short evidenced order of discrete steps should be read with equal visual weight.", preferOver: ["sequence/state-ribbon"], avoidWhen: "Observed duration should determine width or branching dominates a single sequence.", abstainWhen: "Step order is duplicated or the sequence falls outside three to twenty-four steps." },
  "relationship/scatter": { preferWhen: "Ten to five thousand finite paired observations should reveal association, clusters, and outliers.", preferOver: ["relationship/marginals"], avoidWhen: "The marginal distributions are as important as the joint pattern.", abstainWhen: "The finite x/y pairs fall outside the executable observation band." },
  "matrix/heatmap": { preferWhen: "A complete two-dimensional lookup grid should expose repeated high, low, and contrasting cells.", preferOver: [], avoidWhen: "Cells are sparse, row order is hierarchical, or exact tabular lookup dominates pattern reading.", abstainWhen: "The row-column grid is incomplete, duplicated, or exceeds its row or column limits." },
  "hierarchy/tidy": { preferWhen: "Parent-child topology and depth in a compact rooted tree matter more than additive size.", preferOver: ["hierarchy/outline", "hierarchy/icicle", "hierarchy/treemap"], avoidWhen: "Names require scrolling lookup or branch totals should control area.", abstainWhen: "The records do not form one acyclic rooted tree of five to five hundred nodes." },
  "network/local": { preferWhen: "A small weakly connected sparse network should reveal local neighborhoods and bridges.", preferOver: [], avoidWhen: "Direction encodes staged flow or dense global structure would overwhelm local inspection.", abstainWhen: "The graph is disconnected, duplicated, self-linked, over-degree, or outside five to one hundred nodes." },
  "flow/sankey": { preferWhen: "Non-negative quantities move through an evidenced acyclic system of two to five stages.", preferOver: ["mechanism/flowchart"], avoidWhen: "Relations have no additive magnitude or cycles are essential to the mechanism.", abstainWhen: "Links are negative, duplicated, cyclic, self-directed, or exceed the node and stage limits." },
  "mechanism/flowchart": { preferWhen: "A bounded set of directed relations explains how components act on one another.", preferOver: ["flow/sankey", "network/local"], avoidWhen: "Link magnitude, spatial position, or a large network is the primary evidence.", abstainWhen: "The relations resolve to fewer than three or more than forty named nodes." },
  "region-map/choropleth": { preferWhen: "Comparable rates or normalized shares should be read across five to fifty-six bundled US regions.", preferOver: ["region-map/region-symbols"], avoidWhen: "Values are totals whose region area would distort comparison.", abstainWhen: "A region is unknown, a denominator is absent or non-positive, or a value is outside zero to one." },
  "point-map/exact-points": { preferWhen: "One to two thousand evidenced latitude-longitude observations require exact geographic position.", preferOver: [], avoidWhen: "Only regional aggregation is defensible or point precision would disclose inappropriate detail.", abstainWhen: "Coordinates are invalid, duplicated, or outside the executable point band." },
  "field/sample-raster": { preferWhen: "Observed samples on stable x/y coordinates should remain visible as a bounded value field.", preferOver: ["field/contours"], avoidWhen: "Threshold topology is the question or interpolation would be mistaken for observation.", abstainWhen: "Sample coordinates repeat or the field falls outside twenty to 2,500 observations." },
  "collection-atlas/faceted-atlas": { preferWhen: "Two to twelve named facets organize a collection into comparable labeled strips of five to two hundred items each.", preferOver: ["collection-atlas/contact-atlas"], avoidWhen: "Spatial neighborhoods or camera capture order are the primary organizing evidence.", abstainWhen: "Facet labels are absent or any facet or item count falls outside the executable bounds." },
  "rank/dot-plot": { preferWhen: "Many named rows or a meaningful non-zero domain.", preferOver: ["rank/bar-list"], avoidWhen: "Values must be judged as lengths from zero.", abstainWhen: "Names are not unique or there are fewer than 20 or more than 300 rows." },
  "rank/slopegraph": { preferWhen: "Movement of the same ranked items across exactly two complete states matters.", preferOver: ["rank/bar-list", "rank/dot-plot"], avoidWhen: "There are more than two states or item membership changes.", abstainWhen: "The two-state item grid is incomplete." },
  "distribution/histogram": { preferWhen: "Counts by interval and distribution shape matter.", preferOver: ["distribution/strip"], avoidWhen: "Threshold shares or exact observed values matter more than bins.", abstainWhen: "There are fewer than 50 unweighted observations." },
  "distribution/ecdf": { preferWhen: "Percentiles or the share at or below a threshold matter.", preferOver: ["distribution/histogram"], avoidWhen: "Interval counts are the question.", abstainWhen: "Observations are weighted or fewer than 20." },
  "composition/part-list": { preferWhen: "Exact values and shares of one named whole must be read.", preferOver: ["composition/hundred-bar"], avoidWhen: "Many wholes must be compared.", abstainWhen: "Parts are negative, duplicated, or do not form one positive whole." },
  "profile/profile-table": { preferWhen: "Lookup or many entities across a small dimension set matters.", preferOver: ["profile/parallel"], avoidWhen: "The overall shape of a few complete profiles is primary.", abstainWhen: "There are fewer than 3 entities or more than 8 dimensions." },
  "trend/period-bars": { preferWhen: "Discrete evidenced period totals must be compared.", preferOver: ["trend/line"], avoidWhen: "The values are instantaneous observations or raw events.", abstainWhen: "Calendar grain is not explicit or periods were silently aggregated." },
  "timeline/event-strip": { preferWhen: "Instantaneous events in one context need temporal position.", preferOver: ["timeline/interval"], avoidWhen: "Events have meaningful duration or lanes.", abstainWhen: "Any end time or lane split is supplied." },
  "sequence/state-ribbon": { preferWhen: "Observed state duration should determine width.", preferOver: ["sequence/step-strip"], avoidWhen: "Duration is estimated or irrelevant.", abstainWhen: "Order is duplicated or duration is absent/non-positive." },
  "relationship/marginals": { preferWhen: "Both joint association and each marginal shape matter.", preferOver: ["relationship/scatter"], avoidWhen: "The scatter alone answers the question.", abstainWhen: "There are fewer than 10 finite pairs." },
  "hierarchy/outline": { preferWhen: "Names, paths, source order, and scrolling lookup matter.", preferOver: ["hierarchy/tidy"], avoidWhen: "Area comparisons dominate lookup.", abstainWhen: "The source does not evidence one rooted tree and sibling order." },
  "hierarchy/icicle": { preferWhen: "Depth and additive size both matter.", preferOver: ["hierarchy/tidy"], avoidWhen: "Lookup dominates size comparison.", abstainWhen: "Depth exceeds five or leaf values are not positive and additive." },
  "hierarchy/treemap": { preferWhen: "Branch totals dominate depth lookup.", preferOver: ["hierarchy/icicle"], avoidWhen: "Precise depth or paths matter.", abstainWhen: "Depth is outside 2–3 or values are not positive additive leaves." },
  "region-map/region-symbols": { preferWhen: "Non-negative regional totals, not rates, must be compared.", preferOver: ["region-map/choropleth"], avoidWhen: "The values are rates with meaningful region fill.", abstainWhen: "Regions are outside bundled US geography or projected centers are inseparable." },
  "field/contours": { preferWhen: "Threshold topology in a complete regular field matters.", preferOver: ["field/sample-raster"], avoidWhen: "Individual sample values or uncertainty dominate.", abstainWhen: "Samples are irregular, incomplete, constant, or outside grid limits." },
  "collection-atlas/contact-atlas": { preferWhen: "Capture order across one verified JPEG directory must remain visible.", preferOver: ["collection-atlas/faceted-atlas"], avoidWhen: "Items are not camera captures or need semantic clustering.", abstainWhen: "Any file, timestamp, path, format, size, or staged hash cannot be verified." },
});

function rolesFor(familyId, memberId) {
  const key = `${familyId}/${memberId}`;
  const manifest = requireMapFamily(familyId);
  const all = new Map([
    ...manifest.data.requiredRoles,
    ...manifest.data.optionalRoles,
    ...Object.values(EXTRA_ROLES),
  ].map((item) => [item.id, item]));
  const override = ROLE_OVERRIDES[key];
  const requiredIds = override?.required ?? manifest.data.requiredRoles.map((item) => item.id);
  const optionalIds = override?.optional ?? manifest.data.optionalRoles.map((item) => item.id);
  return {
    required: requiredIds.map((id) => all.get(id) ?? role(id, "number", `${id} value.`)),
    optional: optionalIds.map((id) => all.get(id) ?? role(id, "number", `${id} value.`)),
  };
}

function formDefinition(familyId, memberId, rendererVariantId, requirements, isLegacy) {
  const manifest = requireMapFamily(familyId);
  const key = `${familyId}/${memberId}`;
  const roles = rolesFor(familyId, memberId);
  const collection = ({
    "rank/dot-plot": "items",
    "rank/slopegraph": "items",
    "distribution/histogram": "observations",
    "distribution/ecdf": "observations",
    "composition/part-list": "parts",
    "profile/profile-table": "measurements",
    "trend/period-bars": "periods",
    "timeline/event-strip": "events",
    "sequence/state-ribbon": "states",
    "relationship/marginals": "points",
    "hierarchy/outline": "nodes",
    "hierarchy/icicle": "nodes",
    "hierarchy/treemap": "nodes",
    "region-map/region-symbols": "regions",
    "field/contours": "cells",
    "collection-atlas/contact-atlas": "items",
  })[key] ?? manifest.transformation.payload.collection;
  const authoredBand = AUTHORED_FAMILY_ATLAS_CONTENT
    .find((family) => family.id === familyId)
    ?.members.find((member) => member.id === memberId)?.band ?? null;
  const representationProjection = ["region-map", "point-map"].includes(familyId)
    ? "geographic"
    : ["rank", "distribution", "composition", "profile", "trend", "timeline", "sequence", "relationship", "matrix", "field"].includes(familyId)
      ? "cartesian"
      : "none";
  return canonicalize({
    schemaVersion: 1,
    familyId,
    memberId,
    key,
    roles,
    requirements: [
      ...requirements,
      {
        id: "exact-quote-evidence",
        kind: "field-evidence",
        fields: [...roles.required, ...roles.optional].map((item) => item.id),
        policy: "Every populated source-backed role retains one or more opaque references to exact verified evidence.",
      },
      {
        id: "renderer-binding",
        kind: "renderer-binding",
        rendererId: manifest.renderer.id,
        rendererVariantId,
        policy: "The exact catalog receipt fixes the renderer and variant; callers cannot substitute either.",
      },
    ],
    guidance: GUIDANCE[key] ?? {
      preferWhen: `The question matches the fixed ${memberId} instrument.`,
      preferOver: [],
      avoidWhen: "Another form answers the question with fewer encodings.",
      abstainWhen: "Any hard runtime requirement fails.",
    },
    quantityBands: {
      authored: authoredBand,
      executable: requirements.filter((item) => ["record-count", "distinct-count", "hierarchy-leaf-count", "group-size"].includes(item.kind)),
    },
    sourcePolicy: key === "collection-atlas/contact-atlas"
      ? { adapters: ["local-image-set-v1"], media: ["image"], directoryCount: 1 }
      : { adapters: ["evidenced-records-v1"], media: ["structured", "text"] },
    mediaPolicy: key === "collection-atlas/contact-atlas"
      ? {
          id: "verified-jpeg-session-assets-v1",
          mimeTypes: ["image/jpeg"],
          minimumItems: 12,
          maximumItems: 200,
          maximumBytesPerAsset: 12 * 1024 * 1024,
          maximumPixelsPerAsset: 16 * 1024 * 1024,
          maximumTotalBytes: 256 * 1024 * 1024,
          maximumOriginalsPerPage: 8,
        }
      : { id: "source-backed-records-v1" },
    projector: {
      id: isLegacy
        ? manifest.transformation.id
        : key === "collection-atlas/contact-atlas"
          ? "attend-collection-atlas-contact-atlas-projector-v2"
          : `attend-${familyId}-${memberId}-projector`,
      version: key === "collection-atlas/contact-atlas" ? 2 : 1,
      ...({
        "hierarchy/outline": { orderPolicy: "evidenced-sibling-order-preorder" },
        "hierarchy/icicle": { orderPolicy: "derived-total-descending-then-id" },
        "hierarchy/treemap": { orderPolicy: "derived-total-descending-then-id" },
      })[key],
    },
    payload: {
      schemaVersion: 1,
      kind: isLegacy ? manifest.transformation.payload.kind : `attend-${familyId}-${memberId}-payload`,
      collection,
      fields: isLegacy ? LEGACY_PAYLOAD_FIELDS[familyId] : NEW_PAYLOAD_FIELDS[key],
    },
    renderer: { id: manifest.renderer.id, version: manifest.renderer.version, variant: rendererVariantId },
    browserRendererModule: `./forms/${familyId}/${memberId}.js`,
    fixtureId: `${familyId}/${memberId}/fixture-v1`,
    staticAssets: [],
    representation: {
      receiptVersion: 1,
      constraints: {
        dimensionality: ["2d"],
        form: [memberId],
        interaction: ["selection"],
        motion: ["static"],
        projection: [representationProjection],
      },
    },
    selection: {
      policy: ["histogram", "ecdf", "slopegraph", "outline", "icicle", "treemap", "contours"].includes(memberId)
        ? "direct-and-aggregate"
        : "direct",
      resolver: `attend-${familyId}-${memberId}-target-resolver-v1`,
      targetKinds: ({
        slopegraph: ["slope-segment"],
        histogram: ["histogram-bin"],
        ecdf: ["ecdf-threshold"],
        outline: ["hierarchy-branch"],
        icicle: ["hierarchy-branch"],
        treemap: ["hierarchy-branch"],
        contours: ["contour-level"],
      })[memberId] ?? [],
    },
  });
}

const FORM_LIST = [
  ...LEGACY_FORMS.map(([familyId, memberId, variant]) =>
    formDefinition(familyId, memberId, variant, LEGACY_REQUIREMENTS[familyId], true)),
  ...NEW_FORMS.map(([familyId, memberId]) =>
    formDefinition(familyId, memberId, memberId, NEW_REQUIREMENTS[`${familyId}/${memberId}`], false)),
];

export const FORM_DEFINITIONS = Object.freeze(FORM_LIST);
for (const definition of FORM_DEFINITIONS) {
  for (const requirement of definition.requirements) assertSupportedFormRequirement(requirement);
}
const FORM_BY_KEY = new Map(FORM_DEFINITIONS.map((definition) => [definition.key, definition]));

export function formKey(familyId, memberId) {
  return `${String(familyId)}/${String(memberId)}`;
}

export function getExecutableForm(familyId, memberId) {
  return FORM_BY_KEY.get(formKey(familyId, memberId)) ?? null;
}

export function requireExecutableForm(familyId, memberId) {
  const definition = getExecutableForm(familyId, memberId);
  if (definition) return definition;
  const error = new RangeError(`Unknown executable form: ${String(familyId)}/${String(memberId)}`);
  error.code = "UNKNOWN_EXECUTABLE_FORM";
  throw error;
}

export function isLegacyExecutableForm(formOrIdentity) {
  const form = formOrIdentity.key
    ? formOrIdentity
    : requireExecutableForm(formOrIdentity.familyId, formOrIdentity.memberId);
  return LEGACY_FORMS.some(([familyId, memberId]) => familyId === form.familyId && memberId === form.memberId);
}

function comparableTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function fieldValue(observation, field, missingValue) {
  return observation.roles[field] ?? missingValue;
}

function hierarchyFacts(observations, requirement) {
  const idField = requirement.idField ?? "id";
  const parentField = requirement.parentField ?? "parentId";
  const byId = new Map(observations.map((item) => [String(item.roles[idField]), item]));
  const roots = observations.filter((item) => item.roles[parentField] === undefined);
  if (byId.size !== observations.length || roots.length !== (requirement.rootCount ?? 1)) return null;
  const children = new Map([...byId.keys()].map((id) => [id, []]));
  for (const item of observations) {
    const id = String(item.roles[idField]);
    const parent = item.roles[parentField];
    if (parent !== undefined && (!byId.has(String(parent)) || String(parent) === id)) return null;
    if (parent !== undefined) children.get(String(parent)).push(String(item.roles[idField]));
  }
  const depth = new Map();
  let maximumDepth = 0;
  const pending = [[String(roots[0]?.roles[idField]), 0]];
  while (pending.length > 0) {
    const [id, value] = pending.pop();
    if (depth.has(id)) return null;
    depth.set(id, value);
    maximumDepth = Math.max(maximumDepth, value);
    const descendants = children.get(id);
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      pending.push([descendants[index], value + 1]);
    }
  }
  if (depth.size !== observations.length) return null;
  return { byId, children, roots, maximumDepth, depth };
}

function requirementPasses(requirement, observations, context) {
  switch (requirement.kind) {
    case "record-count":
      return observations.length >= requirement.minimum && observations.length <= requirement.maximum;
    case "required-fields":
      return observations.every((item) => requirement.fields.every((field) => item.roles[field] !== undefined));
    case "absent-fields":
      return observations.every((item) => requirement.fields.every((field) => item.roles[field] === undefined));
    case "distinct-count": {
      const values = new Set(observations.map((item) => String(fieldValue(item, requirement.field, requirement.missingValue))));
      return values.size >= requirement.minimum && values.size <= requirement.maximum;
    }
    case "unique-tuple": {
      const keys = observations.map((item) => requirement.fields.map((field) => String(fieldValue(item, field, requirement.missingValue))).join("\u0000"));
      return new Set(keys).size === keys.length;
    }
    case "one-to-one-mapping": {
      const leftToRight = new Map();
      const rightToLeft = new Map();
      for (const item of observations) {
        const left = String(item.roles[requirement.leftField]);
        const right = String(item.roles[requirement.rightField]);
        if ((leftToRight.has(left) && leftToRight.get(left) !== right)
          || (rightToLeft.has(right) && rightToLeft.get(right) !== left)) return false;
        leftToRight.set(left, right);
        rightToLeft.set(right, left);
      }
      return leftToRight.size === rightToLeft.size;
    }
    case "numeric-range":
      return observations.every((item) => {
        const value = item.roles[requirement.field];
        return typeof value === "number" && Number.isFinite(value)
          && (requirement.minimum === undefined || value >= requirement.minimum)
          && (requirement.maximum === undefined || value <= requirement.maximum)
          && (requirement.exclusiveMinimum === undefined || value > requirement.exclusiveMinimum);
      });
    case "numeric-aggregate": {
      const value = observations.reduce((sum, item) => sum + item.roles[requirement.field], 0);
      return (requirement.exclusiveMinimum === undefined || value > requirement.exclusiveMinimum)
        && (requirement.minimum === undefined || value >= requirement.minimum);
    }
    case "complete-cartesian": {
      const dimensions = requirement.fields.map((field) => new Set(observations.map((item) => String(fieldValue(item, field, requirement.missingValue)))).size);
      return dimensions.reduce((product, size) => product * size, 1) === observations.length;
    }
    case "time-order":
      return observations.every((item) => comparableTime(item.roles[requirement.endField]) >= comparableTime(item.roles[requirement.startField]));
    case "hierarchy-tree":
      return hierarchyFacts(observations, requirement) !== null;
    case "hierarchy-depth": {
      const facts = hierarchyFacts(observations, { rootCount: 1 });
      const levels = facts ? facts.maximumDepth + 1 : 0;
      return levels >= requirement.minimum && levels <= requirement.maximum;
    }
    case "hierarchy-leaf-count": {
      const facts = hierarchyFacts(observations, { rootCount: 1 });
      const count = facts ? [...facts.children.values()].filter((children) => children.length === 0).length : 0;
      return count >= requirement.minimum && count <= requirement.maximum;
    }
    case "hierarchy-leaf-values": {
      const facts = hierarchyFacts(observations, { rootCount: 1 });
      if (!facts) return false;
      return [...facts.children].filter(([, children]) => children.length === 0).every(([id]) => {
        const value = facts.byId.get(id).roles.value;
        return typeof value === "number" && Number.isFinite(value) && (!requirement.positive || value > 0);
      });
    }
    case "nonconstant": {
      const values = new Set(observations.map((item) => item.roles[requirement.field]));
      return values.size > 1;
    }
    case "regular-grid": {
      if (requirement.maximumSamples !== undefined && observations.length > requirement.maximumSamples) return false;
      const xs = [...new Set(observations.map((item) => item.roles[requirement.xField]))].sort((a, b) => a - b);
      const ys = [...new Set(observations.map((item) => item.roles[requirement.yField]))].sort((a, b) => a - b);
      if (xs.length < requirement.minimumWidth || ys.length < requirement.minimumHeight || xs.length * ys.length !== observations.length) return false;
      const evenlySpaced = (values) => {
        if (values.length < 3) return true;
        const step = values[1] - values[0];
        const tolerance = Math.max(1, Math.abs(step)) * Number.EPSILON * 16;
        return step > 0 && values.slice(2).every((value, index) => Math.abs((value - values[index + 1]) - step) <= tolerance);
      };
      return evenlySpaced(xs) && evenlySpaced(ys)
        && new Set(observations.map((item) => `${item.roles[requirement.xField]}\u0000${item.roles[requirement.yField]}`)).size === observations.length;
    }
    case "geography-binding":
      return observations.every((item) => canonicalUsStateFips(item.roles[requirement.field]));
    case "media-policy":
      return observations.every((item) => requirement.mimeTypes.includes(item.media?.mimeType));
    case "adapter-policy":
      return context?.adapter?.id === requirement.adapterId;
    case "graph-node-count": {
      const nodes = new Set(observations.flatMap((item) => [String(item.roles[requirement.sourceField]), String(item.roles[requirement.targetField])]));
      return nodes.size >= requirement.minimum && nodes.size <= requirement.maximum;
    }
    case "group-size": {
      const groups = new Map();
      for (const item of observations) {
        const key = String(item.roles[requirement.field]);
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      return groups.size >= requirement.minimumGroups && groups.size <= requirement.maximumGroups
        && [...groups.values()].every((count) => count >= requirement.minimumItems && count <= requirement.maximumItems);
    }
    case "directed-graph": {
      const edges = observations.map((item) => [
        String(item.roles[requirement.sourceField]),
        String(item.roles[requirement.targetField]),
      ]);
      const nodes = new Set(edges.flat());
      if (nodes.size < requirement.minimumNodes || nodes.size > requirement.maximumNodes) return false;
      if (!requirement.allowSelfEdges && edges.some(([source, target]) => source === target)) return false;
      const edgeKeys = edges.map(([source, target]) => `${source}\u0000${target}`);
      if (!requirement.allowDuplicateEdges && new Set(edgeKeys).size !== edgeKeys.length) return false;
      const degree = new Map([...nodes].map((node) => [node, 0]));
      const neighbors = new Map([...nodes].map((node) => [node, []]));
      for (const [source, target] of edges) {
        degree.set(source, degree.get(source) + 1);
        degree.set(target, degree.get(target) + 1);
        neighbors.get(source).push(target);
        neighbors.get(target).push(source);
      }
      if ([...degree.values()].some((value) => value > requirement.maximumEdgesPerNode)) return false;
      if (requirement.connected === "weak" && nodes.size > 0) {
        const visited = new Set();
        const pending = [[...nodes][0]];
        while (pending.length > 0) {
          const node = pending.pop();
          if (visited.has(node)) continue;
          visited.add(node);
          pending.push(...neighbors.get(node));
        }
        if (visited.size !== nodes.size) return false;
      }
      return true;
    }
    case "directed-flow": {
      const edges = observations.map((item) => ({
        source: String(item.roles[requirement.sourceField]),
        target: String(item.roles[requirement.targetField]),
        value: item.roles[requirement.valueField],
      }));
      const nodes = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
      if (nodes.size > requirement.maximumNodes) return false;
      if (edges.some((edge) => edge.source === edge.target
        || typeof edge.value !== "number"
        || !Number.isFinite(edge.value)
        || edge.value < requirement.minimumValue)) return false;
      const edgeKeys = edges.map((edge) => `${edge.source}\u0000${edge.target}`);
      if (!requirement.allowDuplicateEdges && new Set(edgeKeys).size !== edgeKeys.length) return false;
      const outgoing = new Map([...nodes].map((node) => [node, []]));
      const indegree = new Map([...nodes].map((node) => [node, 0]));
      for (const edge of edges) {
        outgoing.get(edge.source).push(edge.target);
        indegree.set(edge.target, indegree.get(edge.target) + 1);
      }
      const depth = new Map([...nodes].map((node) => [node, 0]));
      const pending = [...nodes].filter((node) => indegree.get(node) === 0);
      let visited = 0;
      while (pending.length > 0) {
        const node = pending.pop();
        visited += 1;
        for (const targetId of outgoing.get(node)) {
          depth.set(targetId, Math.max(depth.get(targetId), depth.get(node) + 1));
          indegree.set(targetId, indegree.get(targetId) - 1);
          if (indegree.get(targetId) === 0) pending.push(targetId);
        }
      }
      if (requirement.acyclic && visited !== nodes.size) return false;
      const stageCount = nodes.size === 0 ? 0 : Math.max(...depth.values()) + 1;
      return stageCount >= requirement.minimumStages && stageCount <= requirement.maximumStages;
    }
    case "field-evidence":
    case "renderer-binding":
      return true;
    default: {
      const error = new RangeError(`Unknown form requirement kind: ${String(requirement.kind)}`);
      error.code = "UNKNOWN_FORM_REQUIREMENT";
      throw error;
    }
  }
}

export function evaluateFormRequirement(requirement, observations, context = {}) {
  assertSupportedFormRequirement(requirement);
  return requirementPasses(requirement, observations, context);
}

export function evaluateFormSourcePolicy(formOrIdentity, source = {}) {
  const form = typeof formOrIdentity === "string"
    ? requireExecutableForm(...formOrIdentity.split("/"))
    : formOrIdentity.memberId
      ? requireExecutableForm(formOrIdentity.familyId, formOrIdentity.memberId)
      : formOrIdentity;
  const adapterId = source.adapter?.id;
  const adapterVersion = source.adapter?.version;
  const adapterAllowed = form.sourcePolicy.adapters.includes(adapterId);
  const encodedVersion = typeof adapterId === "string"
    ? Number(adapterId.match(/-v([1-9][0-9]*)$/u)?.[1])
    : Number.NaN;
  const versionAllowed = adapterAllowed
    && (!Number.isSafeInteger(encodedVersion) || adapterVersion === encodedVersion);
  const mediumAllowed = form.sourcePolicy.media.includes(source.medium);
  const failedRequirements = [];
  if (!adapterAllowed || !versionAllowed) {
    failedRequirements.push({
      id: "source-adapter-policy",
      kind: "adapter-policy",
      adapterIds: form.sourcePolicy.adapters,
      ...(Number.isSafeInteger(encodedVersion) ? { expectedVersion: encodedVersion } : {}),
    });
  }
  if (!mediumAllowed) {
    failedRequirements.push({
      id: "source-medium-policy",
      kind: "media-policy",
      media: form.sourcePolicy.media,
    });
  }
  return canonicalize({
    eligible: failedRequirements.length === 0,
    failedRequirements,
  });
}

export function evaluateFormEligibility(formOrIdentity, observations, context = {}) {
  const form = typeof formOrIdentity === "string"
    ? requireExecutableForm(...formOrIdentity.split("/"))
    : formOrIdentity.memberId
      ? requireExecutableForm(formOrIdentity.familyId, formOrIdentity.memberId)
      : formOrIdentity;
  const evaluated = form.requirements
    .filter((requirement) => !["field-evidence", "renderer-binding"].includes(requirement.kind))
    .map((requirement) => ({ ...requirement, passed: requirementPasses(requirement, observations, context) }));
  return canonicalize({
    eligible: evaluated.every((requirement) => requirement.passed),
    failedRequirements: evaluated.filter((requirement) => !requirement.passed).map(({ passed, ...requirement }) => requirement),
    passedRequirements: evaluated.filter((requirement) => requirement.passed).map(({ passed, ...requirement }) => requirement),
  });
}

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function calendarRanks(names) {
  const ranks = new Map();
  names.forEach((name, index) => {
    ranks.set(name, index);
    ranks.set(name.slice(0, 3), index);
  });
  return (value) => ranks.get(value.toLowerCase()) ?? null;
}

const CATEGORY_VOCABULARIES = Object.freeze([
  calendarRanks(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
  calendarRanks(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]),
  (value) => {
    const clock = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/u.exec(value);
    return clock ? Number(clock[1]) * 60 + Number(clock[2]) : null;
  },
  (value) => {
    const quarter = /^[Qq]([0-9]{1,3})$/u.exec(value);
    return quarter ? Number(quarter[1]) : null;
  },
  (value) => (/^[0-9]{1,15}$/u.test(value) ? Number(value) : null),
]);

function categoryRank(value) {
  for (let index = 0; index < CATEGORY_VOCABULARIES.length; index += 1) {
    const rank = CATEGORY_VOCABULARIES[index](value);
    if (rank !== null) return [index, rank];
  }
  return [CATEGORY_VOCABULARIES.length, 0];
}

export function compareCategoryValues(left, right) {
  const [leftVocabulary, leftRank] = categoryRank(left);
  const [rightVocabulary, rightRank] = categoryRank(right);
  return leftVocabulary - rightVocabulary
    || leftRank - rightRank
    || codepointCompare(left, right);
}

// A payload must stay a pure function of its observations so any holder of the
// package can re-derive and verify it. Axis header arrays therefore inherit the
// entry order the compiler already settled rather than sorting a second time.
function encounterOrder(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null).map(String))];
}

function unique(values) {
  return encounterOrder(values).sort(compareCategoryValues);
}

function numericExtent(observations, field) {
  const values = observations.map((item) => item.roles[field]).filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

function baseItems(observations) {
  return observations.map((item) => ({ markId: item.markId, ...item.roles }));
}

function contactCaptureTimeDisclosure(observations) {
  const countsByCaptureTime = new Map();
  let unknownTimezoneCount = 0;
  for (const observation of observations) {
    const captureTime = String(observation.roles.captureTime);
    countsByCaptureTime.set(captureTime, (countsByCaptureTime.get(captureTime) ?? 0) + 1);
    if (observation.roles.captureTimezone === undefined || observation.roles.captureTimezone === "") {
      unknownTimezoneCount += 1;
    }
  }
  const tiedCounts = [...countsByCaptureTime.values()].filter((count) => count > 1);
  const tiedTimestampGroupCount = tiedCounts.length;
  const tiedItemCount = tiedCounts.reduce((total, count) => total + count, 0);
  const timezoneStatus = unknownTimezoneCount === observations.length
    ? "unknown"
    : unknownTimezoneCount === 0
      ? "declared"
      : "partial";
  const timezoneStatement = timezoneStatus === "unknown"
    ? "Camera-local DateTimeOriginal values have no verified timezone."
    : timezoneStatus === "declared"
      ? "Every capture time has a source-backed timezone."
      : `${unknownTimezoneCount} of ${observations.length} capture times have no verified timezone.`;
  const tieStatement = tiedTimestampGroupCount === 0
    ? "No capture timestamps are tied."
    : `${tiedItemCount} images share ${tiedTimestampGroupCount} capture ${tiedTimestampGroupCount === 1 ? "timestamp" : "timestamps"}; verified source order resolves ties.`;
  return {
    basis: "camera-local DateTimeOriginal",
    timezoneStatus,
    unknownTimezoneCount,
    timezoneStatement,
    tiedTimestampGroupCount,
    tiedItemCount,
    tieStatement,
    tieBreak: "verified source order; normalized relative-path values are not published",
  };
}

function target(kind, label, memberMarkIds, semantics = {}) {
  const markIds = [...new Set(memberMarkIds)].sort();
  const membershipHash = sha256Hex(canonicalJson(markIds));
  return canonicalize({
    id: stableId("target", { kind, semantics, membershipHash }),
    kind,
    label,
    count: markIds.length,
    membershipHash,
    ...semantics,
  });
}

function quantile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function histogramProjection(observations) {
  const values = observations.map((item) => item.roles.value).sort((a, b) => a - b);
  const minimum = values[0];
  const maximum = values.at(-1);
  const iqr = quantile(values, 0.75) - quantile(values, 0.25);
  const fdWidth = 2 * iqr / Math.cbrt(values.length);
  const fallback = !Number.isFinite(fdWidth) || fdWidth <= 0;
  const rawCount = fallback ? Math.ceil(Math.log2(values.length) + 1) : Math.ceil((maximum - minimum) / fdWidth);
  const binCount = Math.max(8, Math.min(40, rawCount || 8));
  const span = maximum - minimum;
  const width = span === 0 ? 1 : span / binCount;
  const bins = [];
  const targets = [];
  for (let index = 0; index < binCount; index += 1) {
    const constantBin = span === 0 ? Math.floor(binCount / 2) : -1;
    const lower = span === 0 ? minimum + (index - constantBin) * width : minimum + index * width;
    const upper = span === 0 ? lower + width : index === binCount - 1 ? maximum : minimum + (index + 1) * width;
    const members = observations.filter((item) => item.roles.value >= lower && (index === binCount - 1 ? item.roles.value <= upper : item.roles.value < upper));
    if (members.length === 0) {
      bins.push({ index, lower, upper, count: 0 });
      continue;
    }
    const visualTarget = target("histogram-bin", `${lower}–${upper}`, members.map((item) => item.markId), { index, lower, upper, includeUpper: index === binCount - 1 });
    targets.push(visualTarget);
    bins.push({ targetId: visualTarget.id, index, lower, upper, count: members.length });
  }
  return { bins, binning: { method: fallback ? "sturges" : "freedman-diaconis", binCount, iqr, width }, visualTargets: targets };
}

function hierarchyProjection(form, observations) {
  const facts = hierarchyFacts(observations, { rootCount: 1 });
  const totals = new Map();
  const unorderedPreorder = [];
  const pending = [String(facts.roots[0].roles.id)];
  while (pending.length > 0) {
    const id = pending.pop();
    unorderedPreorder.push(id);
    const children = facts.children.get(id);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  for (let index = unorderedPreorder.length - 1; index >= 0; index -= 1) {
    const id = unorderedPreorder[index];
    const children = facts.children.get(id);
    const item = facts.byId.get(id);
    totals.set(
      id,
      children.length === 0
        ? (item.roles.value ?? 1)
        : children.reduce((sum, childId) => sum + totals.get(childId), 0),
    );
  }

  const outline = form.key === "hierarchy/outline";
  const orderedChildren = new Map([...facts.children].map(([parentId, childIds]) => [
    parentId,
    [...childIds].sort((leftId, rightId) => {
      if (outline) {
        const leftOrder = facts.byId.get(leftId).roles.order;
        const rightOrder = facts.byId.get(rightId).roles.order;
        const compared = typeof leftOrder === "number" && typeof rightOrder === "number"
          ? leftOrder - rightOrder
          : String(leftOrder).localeCompare(String(rightOrder));
        if (compared !== 0) return compared;
      } else {
        const compared = totals.get(rightId) - totals.get(leftId);
        if (compared !== 0) return compared;
      }
      return leftId.localeCompare(rightId);
    }),
  ]));
  const orderedFacts = { ...facts, children: orderedChildren };
  const preorder = [];
  const paths = new Map();
  const orderedPending = [{ id: String(facts.roots[0].roles.id), labels: [] }];
  while (orderedPending.length > 0) {
    const { id, labels } = orderedPending.pop();
    const item = facts.byId.get(id);
    const pathLabels = [...labels, String(item.roles.label)];
    preorder.push(id);
    paths.set(id, pathLabels.join(" / "));
    const children = orderedChildren.get(id);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      orderedPending.push({ id: children[index], labels: pathLabels });
    }
  }
  return { facts: orderedFacts, totals, preorder, paths };
}

function hierarchyBranchMarkIds(facts, rootId) {
  const markIds = [];
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop();
    markIds.push(facts.byId.get(id).markId);
    const children = facts.children.get(id);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
  }
  return markIds;
}

function newFormProjection(form, observations) {
  const key = form.key;
  const items = baseItems(observations);
  if (key === "rank/dot-plot") return { items, order: items.map((item) => item.markId), valueExtent: numericExtent(observations, "value"), groups: unique(observations.map((item) => item.roles.group)) };
  if (key === "rank/slopegraph") {
    const states = [...new Map(observations.map((item) => [String(item.roles.state), {
      label: String(item.roles.state),
      order: item.roles.stateOrder,
    }])).values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
    const labels = unique(observations.map((item) => item.roles.label));
    const rankByState = new Map(states.flatMap((state) => observations.filter((item) => String(item.roles.state) === state.label).sort((a, b) => b.roles.value - a.roles.value || String(a.roles.label).localeCompare(String(b.roles.label))).map((item, index) => [`${state.label}\u0000${item.roles.label}`, index + 1])));
    const segments = [];
    const visualTargets = [];
    for (const label of labels) {
      const pair = states.map((state) => observations.find((item) => String(item.roles.state) === state.label && String(item.roles.label) === label));
      const stateLabels = states.map((state) => state.label);
      const visualTarget = target("slope-segment", label, pair.map((item) => item.markId), { item: label, states: stateLabels });
      visualTargets.push(visualTarget);
      segments.push({ targetId: visualTarget.id, item: label, label, start: { state: states[0].label, stateOrder: states[0].order, value: pair[0].roles.value, rank: rankByState.get(`${states[0].label}\u0000${label}`) }, end: { state: states[1].label, stateOrder: states[1].order, value: pair[1].roles.value, rank: rankByState.get(`${states[1].label}\u0000${label}`) } });
    }
    return { items, states, segments, visualTargets };
  }
  if (key === "distribution/histogram") return { observations: items, valueExtent: numericExtent(observations, "value"), ...histogramProjection(observations) };
  if (key === "distribution/ecdf") {
    const ordered = [...observations].sort((left, right) => left.roles.value - right.roles.value || left.markId.localeCompare(right.markId));
    const groups = [];
    for (let start = 0; start < ordered.length;) {
      const value = ordered[start].roles.value;
      let end = start + 1;
      while (end < ordered.length && ordered[end].roles.value === value) end += 1;
      groups.push({ value, end });
      start = end;
    }
    const anchorCount = Math.min(64, groups.length);
    const anchorIndices = new Set(Array.from({ length: anchorCount }, (_, index) =>
      anchorCount === 1 ? 0 : Math.round((index * (groups.length - 1)) / (anchorCount - 1))));
    const steps = [];
    const visualTargets = [];
    groups.forEach(({ value, end }, index) => {
      if (anchorIndices.has(index)) {
        const visualTarget = target("ecdf-threshold", `≤ ${value}`, ordered.slice(0, end).map((item) => item.markId), { threshold: value, operator: "lte" });
        visualTargets.push(visualTarget);
        steps.push({ targetId: visualTarget.id, value, count: end, share: end / observations.length });
      } else {
        steps.push({ value, count: end, share: end / observations.length });
      }
    });
    return { observations: items, valueExtent: numericExtent(observations, "value"), steps, visualTargets };
  }
  if (key === "composition/part-list") {
    const total = observations.reduce((sum, item) => sum + item.roles.value, 0);
    return { parts: items.map((item) => ({ ...item, share: item.value / total })), whole: String(observations[0].roles.whole), total };
  }
  if (key === "profile/profile-table") {
    const entities = unique(observations.map((item) => item.roles.entity));
    const dimensions = unique(observations.map((item) => item.roles.dimension));
    const cells = new Map(items.map((item) => [`${item.entity}\u0000${item.dimension}`, item]));
    const rows = entities.map((entity) => ({ entity, cells: dimensions.map((dimension) => cells.get(`${entity}\u0000${dimension}`) ?? { dimension, missing: true }) }));
    return { measurements: items, entities, dimensions, rows, missingCellCount: entities.length * dimensions.length - observations.length };
  }
  if (key === "trend/period-bars") return { periods: items, calendarGrain: String(observations[0].roles.calendarGrain), timeExtent: [Math.min(...observations.map((item) => comparableTime(item.roles.time))), Math.max(...observations.map((item) => comparableTime(item.roles.time)))], valueExtent: numericExtent(observations, "value") };
  if (key === "timeline/event-strip") return { events: items, timeExtent: [Math.min(...observations.map((item) => comparableTime(item.roles.time))), Math.max(...observations.map((item) => comparableTime(item.roles.time)))] };
  if (key === "sequence/state-ribbon") {
    const totalDuration = observations.reduce((sum, item) => sum + item.roles.duration, 0);
    let offset = 0;
    return { states: items.map((item) => { const startShare = offset / totalDuration; offset += item.duration; return { ...item, startShare, endShare: offset / totalDuration, share: item.duration / totalDuration }; }), totalDuration };
  }
  if (key === "relationship/marginals") {
    const sortedX = [...items].sort((a, b) => a.x - b.x || a.markId.localeCompare(b.markId));
    const sortedY = [...items].sort((a, b) => a.y - b.y || a.markId.localeCompare(b.markId));
    return { points: items, xBins: sortedX.map((item) => ({ markId: item.markId, value: item.x })), yBins: sortedY.map((item) => ({ markId: item.markId, value: item.y })), domains: { x: numericExtent(observations, "x"), y: numericExtent(observations, "y") } };
  }
  if (["hierarchy/outline", "hierarchy/icicle", "hierarchy/treemap"].includes(key)) {
    const { facts, totals, preorder, paths } = hierarchyProjection(form, observations);
    const nodes = [];
    const visualTargets = [];
    for (const id of preorder) {
      const item = facts.byId.get(id);
      const depth = facts.depth.get(id);
      const aggregateBranch = key !== "hierarchy/outline" || depth <= 1;
      let targetId;
      if (aggregateBranch) {
        const visualTarget = target("hierarchy-branch", item.roles.label, hierarchyBranchMarkIds(facts, id), { nodeId: id });
        visualTargets.push(visualTarget);
        targetId = visualTarget.id;
      }
      nodes.push({
        ...item.roles,
        markId: item.markId,
        ...(targetId ? { targetId } : {}),
        ...(key === "hierarchy/outline" ? { path: paths.get(id) } : {}),
        depth,
        total: totals.get(id),
        leaf: facts.children.get(id).length === 0,
      });
    }
    return { nodes, rootIds: facts.roots.map((item) => String(item.roles.id)), maximumDepth: facts.maximumDepth, visualTargets };
  }
  if (key === "region-map/region-symbols") return { regions: items.map((item) => ({ ...item, region: canonicalUsStateFips(item.region) })), regionIds: unique(observations.map((item) => canonicalUsStateFips(item.roles.region))), valueExtent: numericExtent(observations, "value") };
  if (key === "field/contours") {
    const values = observations.map((item) => item.roles.value).sort((a, b) => a - b);
    const minimum = values[0];
    const maximum = values.at(-1);
    const thresholdCount = 10;
    const thresholds = Array.from({ length: thresholdCount }, (_, index) => minimum + ((maximum - minimum) * (index + 1)) / (thresholdCount + 1));
    const levels = [];
    const visualTargets = [];
    for (let index = 0; index < thresholds.length; index += 1) {
      const threshold = thresholds[index];
      const members = observations.filter((item) => item.roles.value >= threshold);
      const visualTarget = target("contour-level", `≥ ${threshold}`, members.map((item) => item.markId), { index, threshold, operator: "gte" });
      visualTargets.push(visualTarget);
      levels.push({ targetId: visualTarget.id, index, threshold, count: members.length });
    }
    return { cells: items, domains: { x: numericExtent(observations, "x"), y: numericExtent(observations, "y"), value: numericExtent(observations, "value") }, thresholds, levels, visualTargets };
  }
  if (key === "collection-atlas/contact-atlas") {
    const ordered = [...observations].sort((left, right) =>
      String(left.roles.captureTime).localeCompare(String(right.roles.captureTime))
      || (left.roles.order ?? 0) - (right.roles.order ?? 0)
      || String(left.roles.label).localeCompare(String(right.roles.label))
      || left.markId.localeCompare(right.markId));
    const orderedItems = baseItems(ordered);
    return {
      items: orderedItems,
      captureOrder: orderedItems.map((item) => item.markId),
      captureTimeDisclosure: contactCaptureTimeDisclosure(ordered),
      pageSize: 8,
    };
  }
  throw new RangeError(`No projector for ${key}`);
}

function legacyProjection(form, observations) {
  const manifest = requireMapFamily(form.familyId);
  const collection = manifest.transformation.payload.collection;
  const payload = { schemaVersion: 1, kind: form.payload.kind, [collection]: baseItems(observations) };
  switch (form.familyId) {
    case "rank": payload.order = observations.map((item) => item.markId); payload.valueExtent = numericExtent(observations, "value"); payload.groups = unique(observations.map((item) => item.roles.group)); break;
    case "distribution": payload.valueExtent = numericExtent(observations, "value"); payload.groups = unique(observations.map((item) => item.roles.group)); break;
    case "composition": { const totals = new Map(); for (const item of observations) { const whole = String(item.roles.whole ?? "all"); totals.set(whole, (totals.get(whole) ?? 0) + item.roles.value); } payload.totals = [...totals].sort().map(([whole, value]) => ({ whole, value })); break; }
    case "profile": payload.entities = unique(observations.map((item) => item.roles.entity)); payload.dimensions = unique(observations.map((item) => item.roles.dimension)); payload.missingCellCount = payload.entities.length * payload.dimensions.length - observations.length; break;
    case "passage-comparison": payload.versions = unique(observations.map((item) => item.roles.version)); payload.labels = unique(observations.map((item) => item.roles.label)); break;
    case "trend": payload.timeExtent = [Math.min(...observations.map((item) => comparableTime(item.roles.time))), Math.max(...observations.map((item) => comparableTime(item.roles.time)))]; payload.valueExtent = numericExtent(observations, "value"); payload.series = unique(observations.map((item) => item.roles.series ?? "all")); break;
    case "timeline": {
      const times = observations
        .flatMap((item) => [comparableTime(item.roles.time), comparableTime(item.roles.endTime)])
        .filter(Number.isFinite);
      payload.timeExtent = [Math.min(...times), Math.max(...times)];
      payload.lanes = unique(observations.map((item) => item.roles.lane));
      break;
    }
    case "sequence": payload.stages = unique(observations.map((item) => item.roles.stage)); break;
    case "relationship": payload.domains = { x: numericExtent(observations, "x"), y: numericExtent(observations, "y"), size: numericExtent(observations, "size") }; payload.groups = unique(observations.map((item) => item.roles.group)); break;
    case "matrix": payload.rows = encounterOrder(observations.map((item) => item.roles.row)); payload.columns = encounterOrder(observations.map((item) => item.roles.column)); payload.missingCellCount = payload.rows.length * payload.columns.length - observations.length; payload.valueExtent = numericExtent(observations, "value"); break;
    case "hierarchy": { const facts = hierarchyFacts(observations, { rootCount: 1 }); payload.rootIds = facts.roots.map((item) => String(item.roles.id)).sort(); payload.maximumDepth = facts.maximumDepth; break; }
    case "network": case "mechanism": payload.nodes = unique(observations.flatMap((item) => [item.roles.source, item.roles.target])); payload.relations = unique(observations.map((item) => item.roles.relation)); break;
    case "flow": payload.nodes = unique(observations.flatMap((item) => [item.roles.source, item.roles.target])); payload.totalFlow = observations.reduce((sum, item) => sum + item.roles.value, 0); payload.stages = unique(observations.map((item) => item.roles.stage)); break;
    case "region-map": payload.regionIds = unique(observations.map((item) => item.roles.region)); payload.valueExtent = numericExtent(observations, "value"); break;
    case "point-map": payload.extent = { latitude: numericExtent(observations, "latitude"), longitude: numericExtent(observations, "longitude"), value: numericExtent(observations, "value") }; payload.groups = unique(observations.map((item) => item.roles.group)); break;
    case "field": payload.domains = { x: numericExtent(observations, "x"), y: numericExtent(observations, "y"), value: numericExtent(observations, "value"), uncertainty: numericExtent(observations, "uncertainty") }; break;
    case "collection-atlas": {
      const clusters = unique(observations.map((item) => item.roles.cluster));
      const groups = new Map(clusters.map((cluster) => [cluster, []]));
      for (const item of observations) groups.get(String(item.roles.cluster)).push(item);
      for (const group of groups.values()) {
        group.sort((left, right) =>
          (left.roles.order ?? 0) - (right.roles.order ?? 0)
          || String(left.roles.label).localeCompare(String(right.roles.label))
          || left.markId.localeCompare(right.markId));
      }
      payload[collection] = clusters.flatMap((cluster, groupIndex) =>
        groups.get(cluster).map((item, itemIndex) => ({
          markId: item.markId,
          ...item.roles,
          x: 10 + (groupIndex * 80) / Math.max(clusters.length - 1, 1),
          y: 12 + itemIndex * 14,
        })));
      payload.domains = {
        x: numericExtent(payload[collection].map((item) => ({ roles: item })), "x"),
        y: numericExtent(payload[collection].map((item) => ({ roles: item })), "y"),
      };
      payload.clusters = clusters;
      break;
    }
    default: throw new RangeError(`No legacy projector for ${form.familyId}`);
  }
  return payload;
}

export function projectFormPayload(formOrIdentity, observations) {
  const form = formOrIdentity.key ? formOrIdentity : requireExecutableForm(formOrIdentity.familyId, formOrIdentity.memberId);
  const legacy = isLegacyExecutableForm(form);
  const projected = legacy ? legacyProjection(form, observations) : {
    schemaVersion: form.payload.schemaVersion,
    kind: form.payload.kind,
    ...newFormProjection(form, observations),
  };
  return canonicalize(projected);
}

function resolveTargetMembers(form, targetValue, observations) {
  switch (`${form.key}:${targetValue.kind}`) {
    case "distribution/histogram:histogram-bin": return observations.filter((item) => item.roles.value >= targetValue.lower && (targetValue.includeUpper ? item.roles.value <= targetValue.upper : item.roles.value < targetValue.upper));
    case "distribution/ecdf:ecdf-threshold": return observations.filter((item) => item.roles.value <= targetValue.threshold);
    case "rank/slopegraph:slope-segment": return observations.filter((item) => String(item.roles.label) === String(targetValue.item));
    case "field/contours:contour-level": return observations.filter((item) => item.roles.value >= targetValue.threshold);
    case "hierarchy/outline:hierarchy-branch":
    case "hierarchy/icicle:hierarchy-branch":
    case "hierarchy/treemap:hierarchy-branch": {
      const facts = hierarchyFacts(observations, { rootCount: 1 });
      const members = [];
      const pending = [String(targetValue.nodeId)];
      while (pending.length > 0) {
        const id = pending.pop();
        const item = facts?.byId.get(id);
        if (!item) return [];
        members.push(item);
        const children = facts.children.get(id);
        for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
      }
      return members;
    }
    default: return null;
  }
}

export function resolveVisualTarget(formOrIdentity, targetId, observations, payload) {
  const form = formOrIdentity.key ? formOrIdentity : requireExecutableForm(formOrIdentity.familyId, formOrIdentity.memberId);
  const targetValue = payload?.visualTargets?.find((candidate) => candidate.id === targetId);
  if (!targetValue) {
    const error = new RangeError(`Unknown visual target: ${String(targetId)}`);
    error.code = "UNKNOWN_VISUAL_TARGET";
    throw error;
  }
  if (!form.selection.targetKinds.includes(targetValue.kind)) {
    const error = new TypeError(`${targetValue.kind} is not an allowed target kind for ${form.key}`);
    error.code = "UNSUPPORTED_VISUAL_TARGET";
    throw error;
  }
  const projectedTarget = projectFormPayload(form, observations).visualTargets
    ?.find((candidate) => candidate.id === targetId);
  if (!projectedTarget || canonicalJson(projectedTarget) !== canonicalJson(targetValue)) {
    const error = new TypeError(`Visual target ${targetId} is not emitted by the exact form projector`);
    error.code = "VISUAL_TARGET_MISMATCH";
    throw error;
  }
  const members = resolveTargetMembers(form, targetValue, observations);
  if (!members) {
    const error = new TypeError(`${form.key} does not resolve aggregate targets`);
    error.code = "UNSUPPORTED_VISUAL_TARGET";
    throw error;
  }
  const markIds = members.map((item) => item.markId).sort();
  const membershipHash = sha256Hex(canonicalJson(markIds));
  if (markIds.length !== targetValue.count || membershipHash !== targetValue.membershipHash) {
    const error = new TypeError(`Visual target ${targetId} failed count/hash verification`);
    error.code = "VISUAL_TARGET_MISMATCH";
    throw error;
  }
  return canonicalize({ target: targetValue, markIds, count: markIds.length, membershipHash });
}

export function canonicalObservationsFromPackage(dataPackage) {
  const sourceId = dataPackage.sources?.length === 1 ? dataPackage.sources[0].id : undefined;
  return dataPackage.marks.map((mark) => canonicalize({
    id: mark.id,
    markId: mark.id,
    ...(sourceId ? { sourceId } : {}),
    roles: mark.values,
    evidenceRefs: mark.evidenceRefs,
    media: mark.media,
  }));
}
