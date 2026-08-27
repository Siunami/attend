import { createHash } from "node:crypto";

import { MAP_FAMILIES, requireMapFamily } from "../map-families/registry.js";
import { US_STATES_GEOGRAPHY } from "../geography.js";
import { representationCapabilitiesFor } from "../representation-intent.js";
import { AUTHORED_FAMILY_ATLAS_CONTENT } from "./snapshot.js";

const EXECUTABLE_SPECS = Object.freeze({
  rank: { memberId: "bar-list", rendererVariantId: "bar-list", mediaPolicy: "text-only" },
  distribution: { memberId: "strip", rendererVariantId: "strip", mediaPolicy: "text-only" },
  composition: { memberId: "hundred-bar", rendererVariantId: "normalized-parts", mediaPolicy: "text-only" },
  profile: { memberId: "parallel", rendererVariantId: "parallel-profile", mediaPolicy: "text-only" },
  "passage-comparison": { memberId: "parallel-text", rendererVariantId: "aligned-passages", mediaPolicy: "text-only" },
  trend: { memberId: "line", rendererVariantId: "observed-line", mediaPolicy: "text-only" },
  timeline: { memberId: "interval", rendererVariantId: "lane-timeline", mediaPolicy: "text-only" },
  sequence: { memberId: "step-strip", rendererVariantId: "storyboard", mediaPolicy: "text-only" },
  relationship: { memberId: "scatter", rendererVariantId: "scatter", mediaPolicy: "text-only" },
  matrix: { memberId: "heatmap", rendererVariantId: "heat-matrix", mediaPolicy: "text-only" },
  hierarchy: { memberId: "tidy", rendererVariantId: "node-tree", mediaPolicy: "text-only" },
  network: { memberId: "local", rendererVariantId: "node-link", mediaPolicy: "text-only" },
  flow: { memberId: "sankey", rendererVariantId: "sankey", mediaPolicy: "text-only" },
  mechanism: { memberId: "flowchart", rendererVariantId: "system-schematic", mediaPolicy: "text-only" },
  "region-map": { memberId: "choropleth", rendererVariantId: "choropleth", mediaPolicy: "text-only" },
  "point-map": { memberId: "exact-points", rendererVariantId: "dot-map", mediaPolicy: "text-only" },
  field: { memberId: "sample-raster", rendererVariantId: "sample-raster", mediaPolicy: "text-only" },
  "annotated-specimen": { memberId: "callout-overlay", rendererVariantId: "callout-overlay", mediaPolicy: "normalized-text" },
  "collection-atlas": { memberId: "faceted-atlas", rendererVariantId: "contact-atlas", mediaPolicy: "text-only" },
});

const COLLECTION_ATLAS_FIELDS = Object.freeze({
  required: ["label", "cluster"],
  optional: ["order"],
});

const COLLECTION_ATLAS_OUTPUT_ROLES = Object.freeze({
  required: [
    { id: "label", description: "Item label.", types: ["string"] },
    { id: "cluster", description: "Declared cluster or facet label.", types: ["string"] },
  ],
  optional: [
    { id: "order", description: "Optional local order within a cluster.", types: ["number"] },
  ],
});

const EXECUTABLE_DATA_REQUIREMENTS = Object.freeze({
  rank: [
    { id: "record-count", kind: "record-count", minimum: 3, maximum: 40 },
    { id: "unique-labels", kind: "unique-tuple", fields: ["label"] },
  ],
  distribution: [
    { id: "record-count", kind: "record-count", minimum: 5, maximum: 400 },
  ],
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
  relationship: [
    { id: "record-count", kind: "record-count", minimum: 10, maximum: 5_000 },
  ],
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
  network: [
    {
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
    },
  ],
  flow: [
    {
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
    },
  ],
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
    { id: "record-count", kind: "record-count", minimum: 20, maximum: 250_000 },
    { id: "unique-samples", kind: "unique-tuple", fields: ["x", "y"] },
  ],
  "annotated-specimen": [
    { id: "record-count", kind: "record-count", minimum: 2, maximum: 12 },
    { id: "one-visible-specimen", kind: "distinct-count", field: "specimen", minimum: 1, maximum: 1 },
    {
      id: "visible-specimen-unavailable",
      kind: "capability-blocker",
      capability: "visible-specimen-source",
      reason: "The v1 text-only map request cannot bind and display the visible specimen required by anchored callouts.",
    },
  ],
  "collection-atlas": [
    {
      id: "bounded-clusters",
      kind: "group-size",
      field: "cluster",
      minimumGroups: 2,
      maximumGroups: 12,
      minimumItems: 5,
      maximumItems: 200,
    },
  ],
});

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function roleJsonSchema(role) {
  if (role.types.includes("number") || role.types.includes("latitude") || role.types.includes("longitude") || role.types.includes("ratio")) {
    return { type: "number", description: role.description };
  }
  if (role.types.includes("identifier")) {
    return { anyOf: [{ type: "string" }, { type: "number" }], description: role.description };
  }
  return { type: "string", description: role.description };
}

function catalogRolesFor(familyId, manifest) {
  if (familyId === "collection-atlas") return COLLECTION_ATLAS_OUTPUT_ROLES;
  return {
    required: manifest.data.requiredRoles,
    optional: manifest.data.optionalRoles,
  };
}

function fieldListFor(familyId, manifest) {
  if (familyId === "collection-atlas") return COLLECTION_ATLAS_FIELDS;
  return {
    required: manifest.data.requiredRoles.map((role) => role.id),
    optional: manifest.data.optionalRoles.map((role) => role.id),
  };
}

function recordSchemaFor(familyId, manifest) {
  const fields = fieldListFor(familyId, manifest);
  const catalogRoles = catalogRolesFor(familyId, manifest);
  const rolesById = new Map(
    [...manifest.data.requiredRoles, ...manifest.data.optionalRoles, ...catalogRoles.required, ...catalogRoles.optional]
      .map((role) => [role.id, role]),
  );
  const properties = {};
  for (const field of [...fields.required, ...fields.optional]) {
    properties[field] = roleJsonSchema(rolesById.get(field) ?? {
      description: `${field} for ${familyId}`,
      types: ["string"],
    });
  }
  return {
    type: "object",
    additionalProperties: false,
    required: [...fields.required],
    properties,
  };
}

function roleSchemaFor(familyId, manifest) {
  const roles = catalogRolesFor(familyId, manifest);
  const properties = {};
  for (const role of [...roles.required, ...roles.optional]) {
    properties[role.id] = roleJsonSchema(role);
  }
  return {
    type: "object",
    additionalProperties: false,
    required: roles.required.map((role) => role.id),
    properties,
  };
}

function catalogSummaryFor(familyId, manifest) {
  if (familyId === "collection-atlas") {
    return "Navigate a complete collection through deterministic faceted atlas positions derived by the CLI.";
  }
  return manifest.summary;
}

function requirementsFor(manifest, executable) {
  const fields = fieldListFor(manifest.id, manifest);
  const evidenceFields = [...fields.required, ...fields.optional];
  const dataRequirements = EXECUTABLE_DATA_REQUIREMENTS[manifest.id];
  if (!dataRequirements) throw new Error(`Missing authored data requirements for ${manifest.id}`);
  const requirements = [
    ...dataRequirements,
    {
      id: "exact-quote-evidence",
      kind: "field-evidence",
      fields: evidenceFields,
      policy: "Every populated input field for every record must have at least one exact verified quote. This proves literal field coverage; transformed numeric meaning is only proven when the literal value appears in the quote.",
    },
  ];
  if (manifest.id === "collection-atlas") {
    requirements.push({
      id: "derived-layout",
      kind: "derived-layout",
      fields: ["x", "y"],
      policy: "Atlas coordinates are derived deterministically from cluster and order. Requests may not supply semantic coordinates.",
    });
  }
  if (manifest.id === "annotated-specimen") {
    requirements.push({
      id: "native-locator",
      kind: "native-locator",
      fields: ["x", "y", "width", "height"],
      policy: "Annotation anchors must remain normalized specimen coordinates derived and verified by the CLI.",
    });
  }
  if (manifest.id === "region-map") {
    requirements.push({
      id: "fixed-geography",
      kind: "geography-binding",
      geography: US_STATES_GEOGRAPHY,
      field: "region",
      policy: "Every region id must resolve to the bundled US state and territory geometry before a package can be persisted or rendered.",
    });
  }
  requirements.push({
    id: "renderer-binding",
    kind: "renderer-binding",
    rendererId: manifest.renderer.id,
    rendererVariantId: executable.rendererVariantId,
    policy: "The package records the catalog member and bundled renderer; callers never choose a renderer module directly.",
  });
  return requirements;
}

function buildMember(family, manifest, executable, member) {
  const base = {
    id: member.id,
    family: family.id,
    name: member.name,
    when: member.when,
    rationale: member.good,
    lineage: member.lineage,
    band: member.band,
  };
  if (member.status === "rejected") {
    return {
      ...base,
      status: "rejected",
      rejectionReason: member.good,
    };
  }
  if (member.id !== executable.memberId) {
    return {
      ...base,
      status: "documented",
    };
  }
  const requirements = requirementsFor(manifest, executable);
  const capabilityBlocker = requirements.find((requirement) => requirement.kind === "capability-blocker");
  return {
    ...base,
    status: capabilityBlocker ? "unavailable" : "executable",
    rendererId: manifest.renderer.id,
    rendererVersion: manifest.renderer.version,
    rendererVariantId: executable.rendererVariantId,
    roleSchema: roleSchemaFor(family.id, manifest),
    recordSchema: recordSchemaFor(family.id, manifest),
    requirements,
    representationCapabilities: representationCapabilitiesFor({
      family: manifest,
      member: {
        id: member.id,
        rendererVariantId: executable.rendererVariantId,
      },
    }),
    mediaPolicy: executable.mediaPolicy,
    ...(capabilityBlocker ? {
      unavailableReason: capabilityBlocker.reason,
    } : {}),
  };
}

function buildFamily(content) {
  const manifest = requireMapFamily(content.id);
  const executable = EXECUTABLE_SPECS[content.id];
  if (!executable) throw new Error(`Missing executable catalog mapping for ${content.id}`);
  if (!manifest.variants.some((variant) => variant.id === executable.rendererVariantId)) {
    throw new Error(
      `Executable catalog mapping ${content.id}/${executable.memberId} names undeclared variant ${executable.rendererVariantId}`,
    );
  }
  const roles = catalogRolesFor(content.id, manifest);
  const members = content.members.map((member) => buildMember(content, manifest, executable, member));
  const executableMember = members.find((member) => member.status === "executable");
  const unavailableMember = members.find((member) => member.status === "unavailable");
  if (!executableMember && !unavailableMember) throw new Error(`Catalog family ${content.id} has no governed member`);
  return {
    id: content.id,
    title: content.title,
    group: manifest.group,
    question: content.question,
    oneLine: content.oneLine,
    summary: catalogSummaryFor(content.id, manifest),
    executableMemberId: executableMember?.id ?? null,
    rendererId: manifest.renderer.id,
    requiredRoles: roles.required.map((role) => ({ id: role.id, description: role.description, types: [...role.types] })),
    optionalRoles: roles.optional.map((role) => ({ id: role.id, description: role.description, types: [...role.types] })),
    abstention: content.abstain
      ? {
          question: content.abstain.question,
          why: content.abstain.why,
          instead: content.abstain.instead,
          note: content.abstain.note,
        }
      : null,
    members,
  };
}

export const CATALOG_FAMILIES = Object.freeze(
  AUTHORED_FAMILY_ATLAS_CONTENT
    .map(buildFamily)
    .sort((left, right) => compareText(left.id, right.id)),
);

export const CATALOG_COUNTS = Object.freeze(CATALOG_FAMILIES.reduce((totals, family) => {
  totals.families += 1;
  for (const member of family.members) {
    if (member.status === "rejected") totals.rejected += 1;
    else {
      totals.approved += 1;
      if (member.status === "executable") totals.executable += 1;
      if (member.status === "documented") totals.documented += 1;
      if (member.status === "unavailable") totals.unavailable += 1;
    }
  }
  return totals;
}, {
  families: 0,
  approved: 0,
  documented: 0,
  executable: 0,
  unavailable: 0,
  rejected: 0,
}));

export const CATALOG_VERSION = createHash("sha256")
  .update(canonicalJson({
    families: CATALOG_FAMILIES,
    counts: CATALOG_COUNTS,
    manifests: MAP_FAMILIES.map((family) => ({ id: family.id, version: family.version, renderer: family.renderer })),
  }))
  .digest("hex")
  .slice(0, 16);

const FAMILY_BY_ID = new Map(CATALOG_FAMILIES.map((family) => [family.id, family]));
const MEMBER_BY_KEY = new Map(CATALOG_FAMILIES.flatMap((family) =>
  family.members.map((member) => [`${family.id}:${member.id}`, member]),
));

export function listCatalogFamilies() {
  return [...CATALOG_FAMILIES];
}

export function getCatalogFamily(id) {
  return FAMILY_BY_ID.get(id) ?? null;
}

export function requireCatalogFamily(id) {
  const family = getCatalogFamily(id);
  if (family) return family;
  const error = new RangeError(`Unknown catalog family: ${String(id)}`);
  error.code = "UNKNOWN_CATALOG_FAMILY";
  throw error;
}

export function getCatalogMember(familyId, memberId) {
  return MEMBER_BY_KEY.get(`${familyId}:${memberId}`) ?? null;
}

export function requireCatalogMember(familyId, memberId) {
  const member = getCatalogMember(familyId, memberId);
  if (member) return member;
  const error = new RangeError(`Unknown catalog member: ${String(familyId)}/${String(memberId)}`);
  error.code = "UNKNOWN_CATALOG_MEMBER";
  throw error;
}

export function requireExecutableCatalogMember(familyId, memberId) {
  const member = requireCatalogMember(familyId, memberId);
  if (member.status === "executable") return member;
  const error = new RangeError(
    member.status === "rejected"
      ? `${familyId}/${memberId} is explicitly rejected by the Family Atlas.`
      : member.status === "unavailable"
        ? `${familyId}/${memberId} is governed but unavailable: ${member.unavailableReason}`
        : `${familyId}/${memberId} is documented but not executable in this release.`,
  );
  error.code = member.status === "rejected"
    ? "REJECTED_CATALOG_MEMBER"
    : member.status === "unavailable"
      ? "UNAVAILABLE_CATALOG_MEMBER"
      : "NON_EXECUTABLE_CATALOG_MEMBER";
  throw error;
}

export function executableCatalogMemberForFamily(familyId) {
  const family = requireCatalogFamily(familyId);
  if (!family.executableMemberId) {
    const error = new RangeError(`${familyId} has no executable member in this release.`);
    error.code = "NO_EXECUTABLE_CATALOG_MEMBER";
    throw error;
  }
  return requireExecutableCatalogMember(familyId, family.executableMemberId);
}

export function catalogReceiptForMember(familyId, memberId) {
  const family = requireCatalogFamily(familyId);
  const member = requireExecutableCatalogMember(familyId, memberId);
  return {
    version: CATALOG_VERSION,
    family: family.id,
    member: member.id,
    rendererId: family.rendererId,
    rendererVersion: member.rendererVersion,
    rendererVariantId: member.rendererVariantId,
  };
}
