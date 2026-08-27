import { createHash } from "node:crypto";

import {
  CATALOG_VERSION,
  requireExecutableCatalogMember,
} from "../catalog/index.js";
import { getMapFamily } from "../map-families/registry.js";
import {
  validateDataPackage,
  verifyDataPackageHashes,
} from "../pipeline/data-package.js";

const MARK_KINDS = new Set([
  "point",
  "area",
  "edge",
  "band",
  "cell",
  "segment",
  "group",
]);
const AUTHORIZED_CATALOG_VERSIONS = new Set([
  CATALOG_VERSION,
  "3bcb588eaf291763",
]);
const FAMILY_MARK_KINDS = Object.freeze({
  rank: "band",
  distribution: "point",
  composition: "area",
  profile: "segment",
  "passage-comparison": "segment",
  trend: "point",
  timeline: "segment",
  sequence: "segment",
  relationship: "point",
  matrix: "cell",
  hierarchy: "group",
  network: "edge",
  flow: "edge",
  mechanism: "edge",
  "region-map": "area",
  "point-map": "point",
  field: "cell",
  "annotated-specimen": "area",
  "collection-atlas": "group",
});

function cloneJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (encoded === undefined) throw new TypeError(`${label} must be JSON-serializable`);
  return JSON.parse(encoded);
}

function selectionId(value) {
  return `selection_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

function resolveRenderer(dataPackage) {
  const manifest = getMapFamily(dataPackage.family?.id);
  if (!manifest) {
    const error = new TypeError(`Unknown Atlas family: ${String(dataPackage.family?.id)}`);
    error.code = "ATLAS_FAMILY_UNKNOWN";
    throw error;
  }
  const renderer = dataPackage.presentation?.renderer;
  if (
    renderer?.id !== manifest.renderer.id ||
    renderer?.version !== manifest.renderer.version
  ) {
    const error = new TypeError("Atlas package renderer is not a bundled family renderer");
    error.code = "ATLAS_RENDERER_UNAUTHORIZED";
    throw error;
  }

  const catalog = dataPackage.catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    const error = new TypeError("Atlas package is missing its bundled catalog receipt");
    error.code = "ATLAS_CATALOG_UNAUTHORIZED";
    throw error;
  }
  if (!AUTHORIZED_CATALOG_VERSIONS.has(catalog.version) || catalog.family !== manifest.id) {
    const error = new TypeError("Atlas catalog receipt does not match the bundled catalog version or family");
    error.code = "ATLAS_CATALOG_UNAUTHORIZED";
    throw error;
  }
  let member;
  try {
    member = requireExecutableCatalogMember(catalog.family, catalog.member);
  } catch (cause) {
    const error = new TypeError("Atlas catalog receipt does not identify an executable bundled member", { cause });
    error.code = "ATLAS_CATALOG_UNAUTHORIZED";
    throw error;
  }
  if (
    catalog.rendererId !== member.rendererId ||
    catalog.rendererVersion !== member.rendererVersion ||
    catalog.rendererVariantId !== member.rendererVariantId ||
    member.rendererId !== manifest.renderer.id ||
    member.rendererVersion !== manifest.renderer.version ||
    dataPackage.presentation?.variant !== member.rendererVariantId
  ) {
    const error = new TypeError("Atlas catalog member does not resolve to the package's bundled renderer");
    error.code = "ATLAS_CATALOG_UNAUTHORIZED";
    throw error;
  }
  return Object.freeze({
    familyId: manifest.id,
    rendererId: manifest.renderer.id,
    rendererVersion: manifest.renderer.version,
    catalogVersion: catalog.version,
    memberId: member.id,
    rendererVariantId: member.rendererVariantId,
  });
}

function validatePackage(value) {
  const dataPackage = validateDataPackage(value);
  resolveRenderer(dataPackage);
  return dataPackage;
}

function normalizeMarkIds(markIds) {
  if (!Array.isArray(markIds)) throw new TypeError("markIds must be an array");
  const seen = new Set();
  const normalized = [];
  for (const id of markIds) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("Every mark id must be a non-empty string");
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return normalized;
}

function assertKnownMarkIds(dataPackage, markIds) {
  const known = new Set(selectableIds(dataPackage));
  for (const markId of markIds) {
    if (!known.has(markId)) throw new TypeError(`Unknown Atlas mark id: ${markId}`);
  }
  return markIds;
}

function incidentMarkIds(dataPackage, nodeId) {
  return dataPackage.marks
    .filter((mark) => String(mark.values?.source) === nodeId || String(mark.values?.target) === nodeId)
    .map((mark) => mark.id);
}

function normalizeFocus(dataPackage, focus, markIds) {
  if (focus === null || focus === undefined) return null;
  if (!focus || typeof focus !== "object" || Array.isArray(focus)) {
    throw new TypeError("Atlas selection focus must be a node focus or null");
  }
  const unknown = Object.keys(focus).filter((key) => key !== "kind" && key !== "id");
  if (unknown.length || focus.kind !== "node" || typeof focus.id !== "string" || !focus.id) {
    throw new TypeError("Atlas selection focus must identify one known node");
  }
  const knownNodes = new Set(Array.isArray(dataPackage.payload?.nodes) ? dataPackage.payload.nodes.map(String) : []);
  if (!knownNodes.has(focus.id)) throw new TypeError(`Unknown Atlas node id: ${focus.id}`);
  const connected = incidentMarkIds(dataPackage, focus.id);
  if (
    connected.length !== markIds.length ||
    connected.some((markId, index) => markId !== markIds[index])
  ) {
    throw new TypeError("Atlas node focus must select every connected evidence mark");
  }
  return { kind: "node", id: focus.id };
}

function initialState(dataPackage, overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("state must be an object");
  }
  if (Object.hasOwn(overrides, "revision") && overrides.revision !== 0) {
    throw new TypeError("A new session always starts at revision 0");
  }
  const unknown = Object.keys(overrides).filter(
    (key) => key !== "revision" && key !== "markIds" && key !== "focus",
  );
  if (unknown.length) throw new TypeError(`Unknown Atlas session state field: ${unknown.join(", ")}`);
  const markIds = assertKnownMarkIds(dataPackage, normalizeMarkIds(overrides.markIds ?? []));
  const focus = normalizeFocus(dataPackage, overrides.focus, markIds);
  return {
    revision: 0,
    markIds,
    ...(focus ? { focus } : {}),
  };
}

function applyStatePatch(dataPackage, current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("patch must be an object");
  }
  const unknown = Object.keys(patch).filter((key) => key !== "markIds" && key !== "focus");
  if (unknown.length) throw new TypeError(`Unknown Atlas session state field: ${unknown.join(", ")}`);
  const next = cloneJson(current, "session state");
  if (Object.hasOwn(patch, "markIds")) {
    const markIds = normalizeMarkIds(patch.markIds);
    next.markIds = assertKnownMarkIds(dataPackage, markIds);
    if (!Object.hasOwn(patch, "focus")) delete next.focus;
  }
  if (Object.hasOwn(patch, "focus")) {
    const focus = normalizeFocus(dataPackage, patch.focus, next.markIds ?? []);
    if (focus) next.focus = focus;
    else delete next.focus;
  }
  return next;
}

function normalizeStoredState(dataPackage, state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("Atlas session state must be an object");
  }
  const markIds = normalizeMarkIds(state.markIds ?? []);
  state.markIds = assertKnownMarkIds(dataPackage, markIds);
  const focus = normalizeFocus(dataPackage, state.focus, state.markIds);
  if (focus) state.focus = focus;
  else delete state.focus;
  delete state.selectedIds;
  return state;
}

function selectableIds(dataPackage) {
  return listMarks(dataPackage).map((mark) => mark.id);
}

function listMarks(dataPackage) {
  return dataPackage.marks;
}

function selectedMarks(dataPackage, state) {
  const marksById = new Map(dataPackage.marks.map((mark) => [mark.id, mark]));
  return (state.markIds ?? []).map((id) => marksById.get(id)).filter(Boolean);
}

function universalMarkKind(dataPackage, mark) {
  if (MARK_KINDS.has(mark.kind)) return mark.kind;
  return FAMILY_MARK_KINDS[dataPackage.family.id] ?? "group";
}

function evidenceReferenceIds(marks) {
  const refs = [];
  const seen = new Set();
  for (const mark of marks) {
    for (const reference of mark.evidenceRefs ?? []) {
      if (!seen.has(reference)) {
        seen.add(reference);
        refs.push(reference);
      }
    }
  }
  return refs;
}

function buildSelection(dataPackage, state) {
  const renderer = resolveRenderer(dataPackage);
  const marks = selectedMarks(dataPackage, state);
  const evidenceRefIds = evidenceReferenceIds(marks);
  const focus = normalizeFocus(dataPackage, state.focus, marks.map((mark) => mark.id));
  const value = {
    kind: "attend-selection",
    artifactKind: "atlas-v2",
    dataPackageId: dataPackage.id,
    dataHash: dataPackage.hashes.data,
    map: {
      id: dataPackage.family.id,
      version: dataPackage.family.version,
      rendererId: renderer.rendererId,
      rendererVersion: renderer.rendererVersion,
    },
    stateRevision: state.revision,
    selectedMarkIds: marks.map((mark) => mark.id),
    marks: marks.map((mark) => ({
      id: mark.id,
      kind: universalMarkKind(dataPackage, mark),
      label: mark.label,
      summary: mark.summary,
      values: cloneJson(mark.values, "Atlas mark values"),
    })),
    predicate: marks.length === 0
      ? null
      : { field: "markId", operator: "in", values: marks.map((mark) => mark.id) },
    aggregation: {
      family: dataPackage.family.id,
      rendererId: renderer.rendererId,
      markKinds: [...new Set(marks.map((mark) => universalMarkKind(dataPackage, mark)))],
    },
    evidenceRefCount: evidenceRefIds.length,
    evidenceRefIds,
    ...(focus ? { focus: { ...focus, label: focus.id } } : {}),
  };
  return { id: selectionId(value), ...value };
}

function marksForSelection(dataPackage, selection) {
  if (selection === null || selection === undefined) return [];
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new TypeError("selection must be an object or null");
  }
  const markIds = Array.isArray(selection.selectedMarkIds)
    ? selection.selectedMarkIds
    : Array.isArray(selection.marks)
      ? selection.marks.map((mark) => mark?.id).filter(Boolean)
      : [];
  const marksById = new Map(dataPackage.marks.map((mark) => [mark.id, mark]));
  const selected = markIds.map((id) => {
    const mark = marksById.get(id);
    if (!mark) {
      const error = new Error(`Selection references an unknown mark: ${String(id)}`);
      error.code = "EVIDENCE_SELECTION_INVALID";
      throw error;
    }
    return mark;
  });
  return selected;
}

function evidenceReferenceIdsForSelection(dataPackage, selection) {
  return evidenceReferenceIds(marksForSelection(dataPackage, selection));
}

function evidenceSourceIds(dataPackage, selection) {
  if (evidenceReferenceIdsForSelection(dataPackage, selection).length === 0) return [];
  const error = new Error("Atlas source ids are private evidence-store linkage, not public package data.");
  error.code = "EVIDENCE_PRIVATE_LINK_REQUIRED";
  throw error;
}

function packageToRenderModel(dataPackage) {
  const renderer = resolveRenderer(dataPackage);
  return {
    schemaVersion: 1,
    kind: "attend-render-model",
    artifactKind: "atlas-v2",
    packageId: dataPackage.id,
    dataHash: dataPackage.hashes.data,
    family: cloneJson(dataPackage.family, "Atlas family"),
    renderer,
    question: cloneJson(dataPackage.question, "Atlas question"),
    presentation: cloneJson(dataPackage.presentation, "Atlas presentation"),
    marks: dataPackage.marks.map((mark) => ({
      id: mark.id,
      kind: universalMarkKind(dataPackage, mark),
      label: mark.label,
      summary: mark.summary,
      values: cloneJson(mark.values, "Atlas mark values"),
      media: mark.media === undefined ? undefined : cloneJson(mark.media, "Atlas mark media"),
    })),
    payload: cloneJson(dataPackage.payload, "Atlas payload"),
  };
}

function publicPackageForBrowser(dataPackage) {
  // Construct the browser projection field by field. The canonical package
  // remains on disk with its source-integrity receipts; the browser receives
  // only what its fixed renderer needs plus capability-free evidence handles.
  return cloneJson({
    schemaVersion: dataPackage.schemaVersion,
    kind: dataPackage.kind,
    id: dataPackage.id,
    family: dataPackage.family,
    question: dataPackage.question,
    catalog: dataPackage.catalog,
    hashes: { package: dataPackage.hashes.package },
    marks: dataPackage.marks,
    payload: dataPackage.payload,
  }, "Atlas browser projection");
}

export const atlasV2Adapter = Object.freeze({
  artifactKind: "atlas-v2",
  matches: (value) => value?.schemaVersion === 2 && value?.kind === "attend-data-package",
  validatePublicPackage: validatePackage,
  verifyPublicPackage: async (value) => {
    validatePackage(value);
    await verifyDataPackageHashes(value);
    return value;
  },
  viewDescriptor: (dataPackage) => {
    const renderer = resolveRenderer(dataPackage);
    return {
      id: dataPackage.family.id,
      version: dataPackage.family.version,
      rendererId: renderer.rendererId,
      rendererVersion: renderer.rendererVersion,
    };
  },
  libraryMetadata: (dataPackage) => ({
    question: typeof dataPackage.question?.text === "string" ? dataPackage.question.text : "Untitled question",
    target: typeof dataPackage.question?.target === "string" ? dataPackage.question.target : "",
    counts: {
      marks: dataPackage.marks.length,
      sources: dataPackage.sources.length,
      noun: "mark",
    },
  }),
  initialState,
  applyStatePatch,
  normalizeStoredState,
  clearSelectionState: (state) => {
    const next = { ...state, markIds: [] };
    delete next.focus;
    return next;
  },
  listMarks,
  selectableIds,
  buildSelection,
  evidenceSourceIds,
  evidenceReferenceIds: evidenceReferenceIdsForSelection,
  packageToRenderModel,
  publicPackageForBrowser,
  deriveSelection: (dataPackage, markId, state = {}) => buildSelection(
    dataPackage,
    { ...state, markIds: markId === null ? [] : [markId], focus: null },
  ),
  deriveEvidence: (dataPackage, selection) => ({
    evidenceRefIds: evidenceReferenceIdsForSelection(dataPackage, selection),
  }),
});

export function atlasRendererForPackage(dataPackage) {
  return resolveRenderer(validatePackage(dataPackage));
}
