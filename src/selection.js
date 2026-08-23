import { createHash } from "node:crypto";

const DEFAULT_SOURCE_REF_LIMIT = 50;

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

function canonicalSourceScope(sourceScope, sources) {
  const scope = Array.isArray(sourceScope)
    ? { mode: "include", sourceIds: sourceScope }
    : (sourceScope ?? { mode: "all", sourceIds: [] });
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError("sourceScope must be an object");
  }
  if (scope.mode !== "all" && scope.mode !== "include") {
    throw new TypeError("sourceScope.mode must be 'all' or 'include'");
  }
  if (!Array.isArray(scope.sourceIds ?? [])) {
    throw new TypeError("sourceScope.sourceIds must be an array");
  }

  const available = new Set(sources.map((source) => source.id));
  const seen = new Set();
  const sourceIds = [];
  for (const sourceId of scope.sourceIds ?? []) {
    if (typeof sourceId !== "string" || sourceId.length === 0) {
      throw new TypeError("Every sourceScope source id must be a non-empty string");
    }
    if (!available.has(sourceId)) {
      throw new TypeError(`Unknown source id in sourceScope: ${sourceId}`);
    }
    if (!seen.has(sourceId)) {
      seen.add(sourceId);
      sourceIds.push(sourceId);
    }
  }

  return scope.mode === "all"
    ? { mode: "all", sourceIds: [] }
    : { mode: "include", sourceIds };
}

export function buildSelection(
  dataPackage,
  state,
  { sourceRefLimit = DEFAULT_SOURCE_REF_LIMIT } = {},
) {
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
      : {
        field: "phrase",
        operator: "in",
        value: selected.map((row) => row.phrase),
      };
  const evidence = uniqueSourceRefs(selected, dataPackage.sources, sourceRefLimit);
  const value = {
    kind: "attend-selection",
    dataPackageId: dataPackage.id,
    dataHash: dataPackage.hashes.data,
    map: {
      id: dataPackage.map.id,
      version: dataPackage.map.version,
    },
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
