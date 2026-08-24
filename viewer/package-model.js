// The browser consumes the compiler's public v2 package directly. This module
// is the closed adapter from that canonical package to the fixed family
// grammars; it does not define or serialize a second package shape.

export const ATLAS_SCHEMA_VERSION = 2;
export const ATLAS_CATALOG_VERSION = "3bcb588eaf291763";

export const ATLAS_FAMILY_IDS = Object.freeze([
  "rank",
  "distribution",
  "composition",
  "profile",
  "passage-comparison",
  "trend",
  "timeline",
  "sequence",
  "relationship",
  "matrix",
  "hierarchy",
  "network",
  "flow",
  "mechanism",
  "region-map",
  "point-map",
  "field",
  "annotated-specimen",
  "collection-atlas",
]);

const FAMILY_SET = new Set(ATLAS_FAMILY_IDS);
const OPAQUE_EVIDENCE_REF = /^evidence_[a-f0-9]{16}$/u;

// This is a generated-at-release catalog snapshot. The browser may audit a
// receipt against it, but it never uses the package to choose a module or URL.
const CATALOG_ALLOWLIST = Object.freeze({
  rank: { member: "bar-list", rendererId: "attend-rank", rendererVariantId: "bar-list", rendererVersion: 1 },
  distribution: { member: "strip", rendererId: "attend-distribution", rendererVariantId: "strip", rendererVersion: 1 },
  composition: { member: "hundred-bar", rendererId: "attend-composition", rendererVariantId: "normalized-parts", rendererVersion: 1 },
  profile: { member: "parallel", rendererId: "attend-profile", rendererVariantId: "parallel-profile", rendererVersion: 1 },
  "passage-comparison": { member: "parallel-text", rendererId: "attend-passage-comparison", rendererVariantId: "aligned-passages", rendererVersion: 1 },
  trend: { member: "line", rendererId: "attend-trend", rendererVariantId: "observed-line", rendererVersion: 1 },
  timeline: { member: "interval", rendererId: "attend-timeline", rendererVariantId: "lane-timeline", rendererVersion: 1 },
  sequence: { member: "step-strip", rendererId: "attend-sequence", rendererVariantId: "storyboard", rendererVersion: 1 },
  relationship: { member: "scatter", rendererId: "attend-relationship", rendererVariantId: "scatter", rendererVersion: 1 },
  matrix: { member: "heatmap", rendererId: "attend-matrix", rendererVariantId: "heat-matrix", rendererVersion: 1 },
  hierarchy: { member: "tidy", rendererId: "attend-hierarchy", rendererVariantId: "node-tree", rendererVersion: 1 },
  network: { member: "local", rendererId: "attend-network", rendererVariantId: "node-link", rendererVersion: 1 },
  flow: { member: "sankey", rendererId: "attend-flow", rendererVariantId: "sankey", rendererVersion: 1 },
  mechanism: { member: "flowchart", rendererId: "attend-mechanism", rendererVariantId: "system-schematic", rendererVersion: 1 },
  "region-map": { member: "choropleth", rendererId: "attend-region-map", rendererVariantId: "choropleth", rendererVersion: 1 },
  "point-map": { member: "exact-points", rendererId: "attend-point-map", rendererVariantId: "dot-map", rendererVersion: 1 },
  field: { member: "sample-raster", rendererId: "attend-field", rendererVariantId: "sample-raster", rendererVersion: 1 },
  "annotated-specimen": { member: "callout-overlay", rendererId: "attend-annotated-specimen", rendererVariantId: "callout-overlay", rendererVersion: 1 },
  "collection-atlas": { member: "faceted-atlas", rendererId: "attend-collection-atlas", rendererVariantId: "contact-atlas", rendererVersion: 1 },
});

const PAYLOAD_COLLECTIONS = Object.freeze({
  rank: "items",
  distribution: "observations",
  composition: "parts",
  profile: "measurements",
  "passage-comparison": "passages",
  trend: "points",
  timeline: "events",
  sequence: "steps",
  relationship: "points",
  matrix: "cells",
  hierarchy: "nodes",
  network: "edges",
  flow: "links",
  mechanism: "links",
  "region-map": "regions",
  "point-map": "points",
  field: "samples",
  "annotated-specimen": "annotations",
  "collection-atlas": "items",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableCopy(value) {
  if (Array.isArray(value)) return value.map(immutableCopy);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, immutableCopy(child)]));
}

function packageFamily(packageValue) {
  return isObject(packageValue?.family) ? packageValue.family.id : null;
}

function packagePayload(packageValue) {
  return isObject(packageValue?.payload) ? packageValue.payload : {};
}

function packageMarks(packageValue) {
  return array(packageValue?.marks).filter((mark) => isObject(mark) && nonEmpty(mark.id));
}

function catalogAuthority(familyId) {
  return CATALOG_ALLOWLIST[familyId] ?? null;
}

// The family lab is served as an ES-module graph. Keep this receipt factory
// beside the browser allowlist so the lab never needs to import the Node-only
// catalog implementation just to compile a fixture package.
export function catalogReceiptForFamily(familyId) {
  const authority = catalogAuthority(familyId);
  if (!authority || !FAMILY_SET.has(familyId)) throw new TypeError(`Unknown Atlas family: ${String(familyId)}`);
  return {
    version: ATLAS_CATALOG_VERSION,
    family: familyId,
    member: authority.member,
    rendererId: authority.rendererId,
    rendererVariantId: authority.rendererVariantId,
    rendererVersion: authority.rendererVersion,
  };
}

export function executableMemberIdForFamily(familyId) {
  return catalogReceiptForFamily(familyId).member;
}

export function isCatalogReceiptAllowlisted(catalog) {
  const familyId = catalog?.family;
  const authority = catalogAuthority(familyId);
  return isObject(catalog)
    && catalog.version === ATLAS_CATALOG_VERSION
    && FAMILY_SET.has(familyId)
    && authority !== null
    && catalog.member === authority.member
    && catalog.rendererId === authority.rendererId
    && catalog.rendererVariantId === authority.rendererVariantId
    && catalog.rendererVersion === authority.rendererVersion;
}

function catalogIsAllowlisted(packageValue, familyId) {
  return packageValue?.catalog?.family === familyId
    && isCatalogReceiptAllowlisted(packageValue.catalog);
}

function payloadRecords(packageValue, familyId) {
  const collection = PAYLOAD_COLLECTIONS[familyId];
  return collection ? array(packagePayload(packageValue)[collection]).filter(isObject) : [];
}

function payloadLinks(packageValue, familyId) {
  if (!["network", "flow", "mechanism"].includes(familyId)) return [];
  const collection = familyId === "network" ? "edges" : "links";
  return array(packagePayload(packageValue)[collection]).filter(isObject);
}

function markId(value) {
  if (typeof value === "string") return value;
  if (isObject(value)) return value.markId ?? value.id ?? null;
  return null;
}

function opaqueEvidenceRefs(value) {
  // Evidence references are intentionally opaque at the browser boundary.
  // An Atlas package must never carry a source, record, locator, or quote here.
  return array(value)
    .filter((entry) => typeof entry === "string" && OPAQUE_EVIDENCE_REF.test(entry));
}

function evidenceForMarks(marks) {
  return marks.flatMap((mark) => opaqueEvidenceRefs(mark.evidenceRefs));
}

function markValues(mark) {
  return isObject(mark.values) ? immutableCopy(mark.values) : {};
}

function markRecord(mark, payloadRecord) {
  const values = markValues(mark);
  const payloadCopy = isObject(payloadRecord) ? immutableCopy(payloadRecord) : {};
  const domainId = values.id ?? payloadCopy.id;
  const semanticLabel = values.label ?? payloadCopy.label;
  return {
    ...payloadCopy,
    ...values,
    ...(domainId !== undefined ? { nodeId: String(domainId) } : {}),
    ...(semanticLabel !== undefined ? { semanticLabel: String(semanticLabel) } : {}),
    // `markId` is the only selection identity. `id` remains the default
    // renderer identity for non-hierarchical records; hierarchy uses nodeId.
    id: String(mark.id),
    markId: String(mark.id),
    label: String(mark.label ?? values.label ?? mark.id),
    ...(mark.media ? {
      media: immutableCopy(mark.media),
      mediaType: mark.media.type,
      preview: immutableCopy(mark.media.preview),
    } : {}),
    evidenceRefs: opaqueEvidenceRefs(mark.evidenceRefs),
  };
}

function normalizeRecords(packageValue, familyId, marks) {
  const sourceRecords = payloadRecords(packageValue, familyId);
  const byMarkId = new Map(sourceRecords.map((record) => [String(markId(record)), record]));
  return marks.map((mark) => applyFamilyDefaults(familyId, markRecord(
    mark,
    byMarkId.get(String(mark.id)) ?? null,
  )));
}

function applyFamilyDefaults(familyId, record) {
  const defaults = {
    distribution: { group: "All observations" },
    composition: { whole: "Whole" },
    trend: { series: "Series 1" },
    timeline: { lane: "Timeline" },
  }[familyId];
  return defaults ? { ...defaults, ...record } : record;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== "").map(String))];
}

function roleAliases(familyId, records, hasSimilarityReceipt = false) {
  const roles = {
    rank: { label: "label", value: "value", group: "group" },
    distribution: { label: "label", value: "value", group: "group" },
    composition: { series: "whole", part: "part", value: "value" },
    profile: { entity: "entity", dimension: "dimension", value: "value" },
    "passage-comparison": { text: "passage", label: "semanticLabel", version: "version", order: "order" },
    trend: { x: "time", y: "value", series: "series" },
    timeline: { start: "time", end: "endTime", group: "lane" },
    sequence: { order: "order", stage: "stage" },
    relationship: { x: "x", y: "y", group: "group" },
    matrix: { row: "row", column: "column", value: "value" },
    hierarchy: { nodeId: "nodeId", parent: "parentId", value: "value" },
    "region-map": { region: "region", regionLabel: "label", value: "value", baseline: "baseline" },
    "point-map": { latitude: "latitude", longitude: "longitude", value: "value", group: "group" },
    field: { x: "x", y: "y", value: "value" },
    "annotated-specimen": { x: "x", y: "y", width: "width", height: "height", layer: "layer" },
    "collection-atlas": {
      x: "x",
      y: "y",
      category: "cluster",
      value: hasSimilarityReceipt ? "similarity" : "value",
      mediaType: "mediaType",
    },
  }[familyId] ?? {};
  if (familyId === "profile") roles.measures = unique(records.map((record) => record.dimension));
  if (["network", "flow", "mechanism"].includes(familyId)) {
    return { id: "id", label: "label", stage: "stage", group: "group", layer: "layer" };
  }
  return roles;
}

function edgeLinks(marks, familyId) {
  return marks.map((mark, index) => {
    const values = markValues(mark);
    const stable = String(mark.id);
    const source = values.source ?? values.from ?? `${familyId}-source-${stable}`;
    const target = values.target ?? values.to ?? `${familyId}-target-${stable}`;
    const strengthValue = Number(values.weight ?? values.strength ?? values.value);
    const itemValue = Number(values.value ?? values.items);
    return {
      id: String(mark.id),
      source: String(source),
      target: String(target),
      type: String(values.relation ?? values.type ?? "connects"),
      strength: Number.isFinite(strengthValue) ? strengthValue : 1,
      items: Number.isFinite(itemValue) ? itemValue : 1,
      stage: values.stage,
      layer: values.stage,
      order: index,
    };
  });
}

function graphRecords(links, familyId) {
  const ids = unique(links.flatMap((link) => [link.source, link.target]));
  if (familyId === "network") {
    return ids.map((nodeId) => ({ id: nodeId, label: nodeId, stage: 0, layer: 0, group: "Network" }));
  }

  const outgoing = new Map(ids.map((nodeId) => [nodeId, []]));
  const indegree = new Map(ids.map((nodeId) => [nodeId, 0]));
  const depth = new Map(ids.map((nodeId) => [nodeId, 0]));
  const inflow = new Map(ids.map((nodeId) => [nodeId, 0]));
  const outflow = new Map(ids.map((nodeId) => [nodeId, 0]));
  for (const link of links) {
    outgoing.get(link.source)?.push(link.target);
    indegree.set(link.target, (indegree.get(link.target) ?? 0) + 1);
    const amount = Number.isFinite(link.items) ? link.items : 0;
    outflow.set(link.source, (outflow.get(link.source) ?? 0) + amount);
    inflow.set(link.target, (inflow.get(link.target) ?? 0) + amount);
  }
  for (const targets of outgoing.values()) targets.sort();
  const queue = ids.filter((nodeId) => indegree.get(nodeId) === 0).sort();
  const visited = new Set();
  while (queue.length) {
    const nodeId = queue.shift();
    visited.add(nodeId);
    for (const target of outgoing.get(nodeId) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(nodeId) ?? 0) + 1));
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }
  const maximumDepth = Math.max(0, ...depth.values());
  for (const nodeId of ids) {
    if (!visited.has(nodeId)) depth.set(nodeId, maximumDepth + 1);
  }
  return ids.map((nodeId) => {
    const stage = depth.get(nodeId) ?? 0;
    const input = inflow.get(nodeId) ?? 0;
    const output = outflow.get(nodeId) ?? 0;
    return {
      // These are renderer-only display nodes. They deliberately have no
      // markId, so the shared selection decorator cannot make them selectable.
      id: nodeId,
      label: nodeId,
      stage,
      layer: stage,
      group: visited.has(nodeId) ? `Stage ${stage + 1}` : "Cycle",
      inflow: input,
      outflow: output,
      balanceGap: input - output,
      cyclic: !visited.has(nodeId),
    };
  });
}

function familySpecificModel(familyId, payload, marks, records) {
  if (["network", "flow", "mechanism"].includes(familyId)) {
    const links = edgeLinks(marks, familyId);
    return {
      records: graphRecords(links, familyId),
      links,
      roles: roleAliases(familyId, [], false),
      similarityReceipt: null,
    };
  }
  if (familyId === "hierarchy") {
    return {
      records: records.map((record) => ({
        ...record,
        id: String(record.nodeId ?? record.id),
      })),
      links: [],
      roles: roleAliases(familyId, records, false),
      similarityReceipt: null,
    };
  }
  if (familyId === "collection-atlas") {
    const similarityReceipt = isObject(payload.similarityReceipt) ? immutableCopy(payload.similarityReceipt) : null;
    return {
      records: records.map((record) => ({
        ...record,
        cluster: record.cluster ?? "Uncategorized",
        mediaType: record.mediaType ?? "text",
      })),
      links: [],
      roles: roleAliases(familyId, records, Boolean(similarityReceipt)),
      similarityReceipt,
    };
  }
  return {
    records,
    links: payloadLinks({ payload }, familyId),
    roles: roleAliases(familyId, records, false),
    similarityReceipt: null,
  };
}

function specimenModel(payload, records) {
  const declared = isObject(payload.specimen) ? immutableCopy(payload.specimen) : {};
  const specimenIds = unique([
    ...array(payload.specimenIds),
    ...records.map((record) => record.specimen),
  ]);
  const previewRecord = records.find((record) => isObject(record.media?.preview));
  const media = isObject(previewRecord?.media) ? immutableCopy(previewRecord.media) : undefined;
  const preview = isObject(declared.preview)
    ? immutableCopy(declared.preview)
    : isObject(media?.preview) ? immutableCopy(media.preview) : undefined;
  const suppliedAspectRatio = Number(declared.aspectRatio ?? preview?.aspectRatio);
  const measuredAspectRatio = Number(media?.width) > 0 && Number(media?.height) > 0
    ? Number(media.width) / Number(media.height)
    : Number.NaN;
  const aspectRatio = Number.isFinite(suppliedAspectRatio) && suppliedAspectRatio > 0
    ? suppliedAspectRatio
    : measuredAspectRatio;
  if (!specimenIds.length && !media && !Object.keys(declared).length) return undefined;
  return {
    ...declared,
    ...(specimenIds.length ? { id: specimenIds[0], specimenIds } : {}),
    ...(media ? {
      media,
      mediaType: media.type,
    } : {}),
    ...(preview ? { preview } : {}),
    ...(Number.isFinite(aspectRatio) && aspectRatio > 0 ? { aspectRatio } : {}),
  };
}

export function isAtlasPackage(value) {
  if (!isObject(value) || value.kind !== "attend-data-package" || value.schemaVersion !== ATLAS_SCHEMA_VERSION) return false;
  if (!nonEmpty(value.id) || !isObject(value.family) || !isObject(value.payload)) return false;
  const familyId = value.family.id;
  return FAMILY_SET.has(familyId)
    && catalogIsAllowlisted(value, familyId)
    && Array.isArray(value.marks)
    && value.marks.length > 0
    && value.marks.every((mark) => (
      isObject(mark)
      && nonEmpty(mark.id)
      && !("recordId" in mark)
      && Array.isArray(mark.evidenceRefs)
      && mark.evidenceRefs.length > 0
      && mark.evidenceRefs.every((reference) => typeof reference === "string" && OPAQUE_EVIDENCE_REF.test(reference))
    ));
}

export function atlasPackageToRenderModel(packageValue) {
  if (!isAtlasPackage(packageValue)) {
    throw new TypeError("atlas package must be the catalog-authorized attend-data-package v2 shape");
  }

  const familyId = packageValue.family.id;
  const payload = packagePayload(packageValue);
  const marks = packageMarks(packageValue);
  const records = normalizeRecords(packageValue, familyId, marks);
  const familyModel = familySpecificModel(familyId, payload, marks, records);
  const renderRecords = familyModel.records.map((record) => immutableCopy(record));
  const markById = Object.fromEntries(marks.map((mark) => [String(mark.id), {
    id: String(mark.id),
    kind: mark.kind,
    label: String(mark.label ?? mark.id),
    summary: String(mark.summary ?? ""),
    evidenceRefs: opaqueEvidenceRefs(mark.evidenceRefs),
    values: markValues(mark),
  }]));
  const question = isObject(packageValue.question) ? packageValue.question : {};

  return {
    familyId,
    title: String(question.target ?? question.text ?? familyId),
    question: String(question.text ?? question.target ?? "Explore the evidence-bearing view."),
    roles: familyModel.roles,
    records: renderRecords,
    links: familyModel.links.map(immutableCopy),
    evidence: evidenceForMarks(marks),
    specimen: familyId === "annotated-specimen" ? specimenModel(payload, records) : undefined,
    selectableMarkIds: marks.map((mark) => String(mark.id)),
    markById,
    packageId: String(packageValue.id),
    packageHash: String(packageValue.hashes?.package ?? ""),
    catalog: {
      version: String(packageValue.catalog.version),
      family: familyId,
      member: String(packageValue.catalog.member),
      rendererId: String(packageValue.catalog.rendererId),
      rendererVariantId: String(packageValue.catalog.rendererVariantId),
      rendererVersion: packageValue.catalog.rendererVersion,
    },
    assets: [],
    similarityReceipt: familyModel.similarityReceipt ?? null,
  };
}

export function markIdsForPackage(packageValue) {
  return atlasPackageToRenderModel(packageValue).selectableMarkIds;
}
