import { createHash } from "node:crypto";

import { VIEW_ID, VIEW_VERSION } from "../constants.js";

const DEFAULT_SOURCE_REF_LIMIT = 50;
const SORT_FIELDS = new Set([
  "occurrenceCount",
  "distinctSourceCount",
  "wordCount",
  "phrase",
]);
const SORT_DIRECTIONS = new Set(["asc", "desc"]);
const MUTABLE_STATE_FIELDS = new Set([
  "selectedIds",
  "query",
  "minCount",
  "sort",
  "sourceScope",
]);

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

function normalizeSelectedIds(selectedIds) {
  if (!Array.isArray(selectedIds)) throw new TypeError("selectedIds must be an array");
  const seen = new Set();
  const normalized = [];
  for (const id of selectedIds) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("Every selected id must be a non-empty string");
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return normalized;
}

function normalizeSort(sort) {
  if (!sort || typeof sort !== "object" || Array.isArray(sort)) {
    throw new TypeError("sort must be an object with by and direction");
  }
  const by = sort.by ?? sort.field;
  if (!SORT_FIELDS.has(by)) throw new TypeError(`Unsupported sort field: ${by}`);
  if (!SORT_DIRECTIONS.has(sort.direction)) {
    throw new TypeError(`Unsupported sort direction: ${sort.direction}`);
  }
  return { by, direction: sort.direction };
}

function normalizeSourceScope(sourceScope, availableSourceIds) {
  if (!sourceScope || typeof sourceScope !== "object" || Array.isArray(sourceScope)) {
    throw new TypeError("sourceScope must be an object");
  }
  if (sourceScope.mode !== "all" && sourceScope.mode !== "include") {
    throw new TypeError("sourceScope.mode must be 'all' or 'include'");
  }
  const sourceIds = normalizeSelectedIds(sourceScope.sourceIds ?? []);
  const available = new Set(availableSourceIds);
  for (const sourceId of sourceIds) {
    if (!available.has(sourceId)) throw new TypeError(`Unknown source id in sourceScope: ${sourceId}`);
  }
  return sourceScope.mode === "all"
    ? { mode: "all", sourceIds: [] }
    : { mode: "include", sourceIds };
}

function canonicalSourceScope(sourceScope, sources) {
  const scope = Array.isArray(sourceScope)
    ? { mode: "include", sourceIds: sourceScope }
    : (sourceScope ?? { mode: "all", sourceIds: [] });
  return normalizeSourceScope(scope, sources.map((source) => source.id));
}

function validateMinCount(minCount) {
  if (!Number.isSafeInteger(minCount) || minCount < 1) {
    throw new TypeError("minCount must be a positive integer");
  }
  return minCount;
}

function uniqueSourceRefs(rows, sources, limit) {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const seen = new Set();
  const refs = [];
  for (const row of rows) {
    for (const occurrence of row.occurrences) {
      const key = `${occurrence.sourceId}:${occurrence.line}:${occurrence.excerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (refs.length >= limit) continue;
      const source = sourcesById.get(occurrence.sourceId);
      refs.push({
        sourceId: occurrence.sourceId,
        displayPath: source?.displayPath ?? occurrence.sourceId,
        sourceSha256: source?.sha256 ?? null,
        line: occurrence.line,
        excerpt: occurrence.excerpt,
      });
    }
  }
  return { refs, total: seen.size };
}

function selectionId(value) {
  return `selection_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

function validatePackage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("dataPackage must be an object");
  }
  if (value.schemaVersion !== 1 || value.kind !== "attend-data-package") {
    throw new TypeError("dataPackage is not a phrase-v1 package");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new TypeError("dataPackage.id must be a non-empty string");
  }
  if (!Array.isArray(value.sources) || !Array.isArray(value.rows)) {
    throw new TypeError("dataPackage must include sources and rows arrays");
  }
  if (value.map?.id !== VIEW_ID || value.map?.version !== VIEW_VERSION) {
    throw new TypeError(
      `dataPackage.map must identify ${VIEW_ID} version ${VIEW_VERSION}`,
    );
  }
  const sourceIds = value.sources.map((source) => source?.id);
  if (sourceIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("Every dataPackage source must have a non-empty id");
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError("dataPackage source ids must be unique");
  }
  return value;
}

function initialState(dataPackage, overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("state must be an object");
  }
  if (Object.hasOwn(overrides, "revision") && overrides.revision !== 0) {
    throw new TypeError("A new session always starts at revision 0");
  }
  const unknown = Object.keys(overrides).filter(
    (key) => key !== "revision" && !MUTABLE_STATE_FIELDS.has(key),
  );
  if (unknown.length) throw new TypeError(`Unknown session state field: ${unknown.join(", ")}`);
  return {
    revision: 0,
    selectedIds: normalizeSelectedIds(overrides.selectedIds ?? []),
    query: overrides.query === undefined
      ? ""
      : typeof overrides.query === "string"
        ? overrides.query
        : (() => { throw new TypeError("query must be a string"); })(),
    minCount: validateMinCount(overrides.minCount ?? dataPackage.config?.minCount ?? 2),
    sort: normalizeSort(
      overrides.sort ?? dataPackage.config?.ranking?.[0] ?? { by: "occurrenceCount", direction: "desc" },
    ),
    sourceScope: normalizeSourceScope(
      overrides.sourceScope ?? { mode: "all", sourceIds: [] },
      dataPackage.sources.map((source) => source.id),
    ),
  };
}

function applyStatePatch(dataPackage, current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("patch must be an object");
  }
  const unknown = Object.keys(patch).filter((key) => !MUTABLE_STATE_FIELDS.has(key));
  if (unknown.length) throw new TypeError(`Unknown session state field: ${unknown.join(", ")}`);
  const next = cloneJson(current, "session state");
  const sourceIds = dataPackage.sources.map((source) => source.id);
  next.sourceScope = normalizeSourceScope(next.sourceScope ?? { mode: "all", sourceIds: [] }, sourceIds);
  if (Object.hasOwn(patch, "selectedIds")) next.selectedIds = normalizeSelectedIds(patch.selectedIds);
  if (Object.hasOwn(patch, "query")) {
    if (typeof patch.query !== "string") throw new TypeError("query must be a string");
    next.query = patch.query;
  }
  if (Object.hasOwn(patch, "minCount")) next.minCount = validateMinCount(patch.minCount);
  if (Object.hasOwn(patch, "sort")) next.sort = normalizeSort(patch.sort);
  if (Object.hasOwn(patch, "sourceScope")) {
    next.sourceScope = normalizeSourceScope(patch.sourceScope, sourceIds);
  }
  return next;
}

function normalizeStoredState(dataPackage, state) {
  if (state?.sourceScope) {
    state.sourceScope = normalizeSourceScope(
      state.sourceScope,
      dataPackage.sources.map((source) => source.id),
    );
  }
  return state;
}

function buildSelection(dataPackage, state, { sourceRefLimit = DEFAULT_SOURCE_REF_LIMIT } = {}) {
  if (!Number.isSafeInteger(sourceRefLimit) || sourceRefLimit < 0) {
    throw new TypeError("sourceRefLimit must be a non-negative integer");
  }
  const selectedIds = state.selectedIds || [];
  const selected = selectedIds
    .map((id) => dataPackage.rows.find((row) => row.id === id))
    .filter(Boolean);
  const predicate = selected.length === 0
    ? null
    : selected.length === 1
      ? { field: "phrase", operator: "equals", value: selected[0].phrase }
      : { field: "phrase", operator: "in", value: selected.map((row) => row.phrase) };
  const evidence = uniqueSourceRefs(selected, dataPackage.sources, sourceRefLimit);
  const value = {
    kind: "attend-selection",
    dataPackageId: dataPackage.id,
    dataHash: dataPackage.hashes.data,
    map: { id: dataPackage.map.id, version: dataPackage.map.version },
    stateRevision: state.revision,
    selectedMarkIds: selected.map((row) => row.id),
    marks: selected.map((row) => ({
      id: row.id,
      phrase: row.phrase,
      occurrenceCount: row.occurrenceCount,
      distinctSourceCount: row.distinctSourceCount,
    })),
    predicate,
    filters: {
      query: state.query || "",
      minCount: state.minCount ?? dataPackage.config.minCount,
      minSources: dataPackage.config.minSources ?? 1,
      sourceScope: canonicalSourceScope(state.sourceScope, dataPackage.sources),
    },
    aggregation: {
      groupBy: "normalized phrase",
      measure: "exact occurrences",
      breadth: "distinct sources",
    },
    sort: state.sort || { by: "occurrenceCount", direction: "desc" },
    sourceRefCount: evidence.total,
    sourceRefsTruncated: evidence.total > evidence.refs.length,
    sourceRefs: evidence.refs,
  };
  return { id: selectionId(value), ...value };
}

function selectableIds(dataPackage) {
  return listMarks(dataPackage).map((row) => row.id);
}

function listMarks(dataPackage) {
  return dataPackage.rows;
}

function evidenceSourceIds(dataPackage, selection) {
  if (selection === null || selection === undefined) return [];
  if (typeof selection !== "object" || Array.isArray(selection)) {
    throw new TypeError("selection must be an object or null");
  }
  const markIds = Array.isArray(selection.selectedMarkIds)
    ? selection.selectedMarkIds
    : Array.isArray(selection.marks)
      ? selection.marks.map((mark) => mark?.id).filter(Boolean)
      : [];
  if (markIds.length === 0) return [];
  const rowsById = new Map(dataPackage.rows.map((row) => [row.id, row]));
  const selectedRows = markIds.map((id) => {
    const row = rowsById.get(id);
    if (!row) {
      const error = new Error(`Selection references an unknown mark: ${String(id)}`);
      error.code = "EVIDENCE_SELECTION_INVALID";
      throw error;
    }
    return row;
  });
  const includedScope = selection.filters?.sourceScope?.mode === "include"
    ? new Set(selection.filters.sourceScope.sourceIds ?? [])
    : null;
  const implicated = new Set();
  for (const row of selectedRows) {
    for (const occurrence of row.occurrences ?? []) {
      if (!includedScope || includedScope.has(occurrence.sourceId)) {
        implicated.add(occurrence.sourceId);
      }
    }
  }
  const ordered = dataPackage.sources
    .map((source) => source.id)
    .filter((sourceId) => implicated.has(sourceId));
  if (ordered.length !== implicated.size) {
    const error = new Error("Selection occurrences reference a source outside the analyzed corpus.");
    error.code = "EVIDENCE_SELECTION_INVALID";
    throw error;
  }
  return ordered;
}

export const phraseV1Adapter = Object.freeze({
  artifactKind: "phrase-v1",
  matches: (value) => value?.schemaVersion === 1 && value?.kind === "attend-data-package",
  validatePublicPackage: validatePackage,
  verifyPublicPackage: async (value) => validatePackage(value),
  viewDescriptor: (dataPackage) => ({ id: dataPackage.map.id, version: dataPackage.map.version }),
  libraryMetadata: (dataPackage) => ({
    question: typeof dataPackage.question?.text === "string" ? dataPackage.question.text : "Untitled question",
    target: typeof dataPackage.question?.target === "string" ? dataPackage.question.target : "",
    counts: { phrases: dataPackage.rows.length, sources: dataPackage.sources.length },
  }),
  initialState,
  applyStatePatch,
  normalizeStoredState,
  clearSelectionState: (state) => ({ ...state, selectedIds: [] }),
  listMarks,
  selectableIds,
  buildSelection,
  evidenceSourceIds,
  packageToRenderModel: (dataPackage) => ({
    schemaVersion: 1,
    kind: "attend-render-model",
    artifactKind: "phrase-v1",
    view: { id: dataPackage.map.id, version: dataPackage.map.version },
    data: {
      rows: dataPackage.rows,
      sources: dataPackage.sources,
      config: dataPackage.config,
      question: dataPackage.question,
    },
  }),
  publicPackageForBrowser: (dataPackage) => dataPackage,
  deriveSelection: (dataPackage, markId, state = {}) => buildSelection(
    dataPackage,
    { ...state, selectedIds: markId === null ? [] : [markId] },
  ),
  deriveEvidence: (dataPackage, selection) => ({
    sourceIds: evidenceSourceIds(dataPackage, selection),
  }),
});
