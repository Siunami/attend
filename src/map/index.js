import { buildEvidenceStore } from "../evidence.js";
import { canonicalUsStateFips } from "../geography.js";
import {
  CATALOG_VERSION,
  catalogReceiptForMember,
  requireCatalogFamily,
  requireCatalogMember,
  requireExecutableCatalogMember,
} from "../catalog/index.js";
import {
  assertRepresentationIntentSupported,
  normalizeRepresentationIntent,
} from "../representation-intent.js";
import {
  evaluateFormEligibility,
  isLegacyExecutableForm,
  requireExecutableForm,
} from "../forms/index.js";
import { compileMapWithEvidence } from "../pipeline/compile.js";
import {
  buildImageEvidenceStore,
  LocalImageSetError,
  loadLocalImageSet,
} from "../media/index.js";
import {
  loadSources,
  sha256 as sourceSha256,
  stableId as sourceStableId,
} from "../sources.js";
import { posix, win32 } from "node:path";

const REQUEST_SCHEMA_VERSIONS = new Set([1, 2, 3]);
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]*$/u;
const REQUEST_KEYS = new Set([
  "version",
  "question",
  "family",
  "member",
  "representationIntent",
  "input",
  "sources",
  "records",
  "evidence",
  "options",
]);
const EVIDENCED_INPUT_KEYS = new Set(["adapter", "sources", "records", "evidence"]);
const IMAGE_SET_INPUT_KEYS = new Set(["adapter", "directory"]);
const SOURCE_REF_KEYS = new Set(["path", "textProjection"]);
const EVIDENCE_KEYS = new Set(["source", "quote", "occurrence", "recordKey", "field"]);
const OPTIONS_KEYS = new Set(["categoryOrder", "title"]);
const LEGACY_FACETED_ATLAS_RECORD_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["label", "cluster"],
  properties: {
    label: { type: "string" },
    cluster: { type: "string" },
    order: { type: "number" },
  },
});
const LEGACY_FACETED_ATLAS_REQUIREMENTS = Object.freeze([Object.freeze({
  id: "bounded-clusters",
  kind: "group-size",
  field: "cluster",
  minimumGroups: 2,
  maximumGroups: 12,
  minimumItems: 5,
  maximumItems: 200,
})]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(code, message, path = "request") {
  const error = new Error(`${path}: ${message}`);
  error.code = code;
  error.path = path;
  throw error;
}

function ineligibleRequestedForm({ familyId, memberId, message, failedRequirements, cause }) {
  const error = new Error(`request.member: ${message}`, cause === undefined ? undefined : { cause });
  error.code = "INELIGIBLE_REQUESTED_FORM";
  error.path = "request.member";
  error.familyId = familyId;
  error.memberId = memberId;
  error.failedRequirements = failedRequirements;
  return error;
}

function rejectUnknownKeys(value, allowed, path, code = "UNKNOWN_REQUEST_KEY") {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `unknown field ${key}`, `${path}.${key}`);
  }
}

function normalizeString(value, path, { maximum = 16_384, allowEmpty = false } = {}) {
  if (typeof value !== "string") fail("INVALID_STRING", "must be a string", path);
  const trimmed = allowEmpty ? value : value.trim();
  if (!allowEmpty && trimmed.length === 0) fail("INVALID_STRING", "must be a non-empty string", path);
  if (trimmed.length > maximum) fail("STRING_TOO_LONG", `must contain at most ${maximum} characters`, path);
  return trimmed;
}

function normalizeOptionalString(value, path, maximum = 16_384) {
  if (value === undefined) return undefined;
  return normalizeString(value, path, { maximum });
}

function normalizePositiveInteger(value, path) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) fail("INVALID_INTEGER", "must be a positive integer", path);
  return value;
}

function normalizeRequest(request) {
  if (!isPlainObject(request)) fail("INVALID_REQUEST", "must be an object");
  rejectUnknownKeys(request, REQUEST_KEYS, "request");
  if (!REQUEST_SCHEMA_VERSIONS.has(request.version)) {
    fail("INVALID_REQUEST", "version must be 1, 2, or 3", "request.version");
  }
  const question = normalizeString(request.question, "request.question", { maximum: 4_000 });
  const family = normalizeString(request.family, "request.family", { maximum: 128 });
  const member = normalizeString(request.member, "request.member", { maximum: 128 });
  let input;
  if (request.version === 3) {
    if (request.sources !== undefined || request.records !== undefined || request.evidence !== undefined) {
      fail(
        "INVALID_REQUEST",
        "version 3 places sources, records, and evidence inside input",
        "request.input",
      );
    }
    if (!isPlainObject(request.input)) fail("INVALID_INPUT_ADAPTER", "must be an object", "request.input");
    const adapter = normalizeString(request.input.adapter, "request.input.adapter", { maximum: 128 });
    if (adapter === "evidenced-records-v1") {
      rejectUnknownKeys(request.input, EVIDENCED_INPUT_KEYS, "request.input", "UNKNOWN_INPUT_KEY");
      if (!Array.isArray(request.input.sources) || request.input.sources.length === 0) {
        fail("INVALID_REQUEST", "sources must be a non-empty array", "request.input.sources");
      }
      if (!Array.isArray(request.input.records) || request.input.records.length === 0) {
        fail("INVALID_REQUEST", "records must be a non-empty array", "request.input.records");
      }
      if (!Array.isArray(request.input.evidence) || request.input.evidence.length === 0) {
        fail("INVALID_REQUEST", "evidence must be a non-empty array", "request.input.evidence");
      }
      input = {
        adapter,
        sources: request.input.sources,
        records: request.input.records,
        evidence: request.input.evidence,
      };
    } else if (adapter === "local-image-set-v1") {
      rejectUnknownKeys(request.input, IMAGE_SET_INPUT_KEYS, "request.input", "UNKNOWN_INPUT_KEY");
      input = {
        adapter,
        directory: normalizeRelativeSourcePath(request.input.directory, "request.input.directory"),
      };
    } else {
      fail("UNKNOWN_INPUT_ADAPTER", `unknown input adapter ${adapter}`, "request.input.adapter");
    }
  } else {
    if (request.input !== undefined) {
      fail("INVALID_REQUEST", "input is available only in version 3", "request.input");
    }
    if (!Array.isArray(request.sources) || request.sources.length === 0) fail("INVALID_REQUEST", "sources must be a non-empty array", "request.sources");
    if (!Array.isArray(request.records) || request.records.length === 0) fail("INVALID_REQUEST", "records must be a non-empty array", "request.records");
    if (!Array.isArray(request.evidence) || request.evidence.length === 0) fail("INVALID_REQUEST", "evidence must be a non-empty array", "request.evidence");
    input = {
      adapter: "evidenced-records-v1",
      sources: request.sources,
      records: request.records,
      evidence: request.evidence,
    };
  }
  if (request.options !== undefined && !isPlainObject(request.options)) fail("INVALID_OPTIONS", "must be an object", "request.options");
  return {
    version: request.version,
    question,
    family,
    member,
    representationIntent: normalizeRepresentationIntent(request.representationIntent, {
      path: "request.representationIntent",
      required: request.version >= 2,
    }),
    input,
    options: request.options ?? {},
  };
}

function normalizeSourceRef(value, path) {
  if (!isPlainObject(value)) fail("INVALID_SOURCE_REF", "must be an object", path);
  rejectUnknownKeys(value, SOURCE_REF_KEYS, path);
  const projection = value.textProjection ?? "utf8";
  if (projection !== "utf8" && projection !== "normalized-text") {
    fail("INVALID_SOURCE_REF", "textProjection must be utf8 or normalized-text", `${path}.textProjection`);
  }
  return {
    path: normalizeRelativeSourcePath(value.path, `${path}.path`),
    textProjection: projection,
  };
}

function normalizeRelativeSourcePath(value, path) {
  const raw = normalizeString(value, path, { maximum: 2_048 });
  const forward = raw.replaceAll("\\", "/");
  if (
    raw.includes("\0")
    || raw.startsWith("~")
    || win32.isAbsolute(raw)
    || forward.startsWith("/")
    || forward.split("/").includes("..")
  ) {
    fail("UNSAFE_SOURCE_PATH", "must be a relative project path without parent traversal", path);
  }
  const normalized = posix.normalize(forward);
  if (normalized === ".." || normalized.startsWith("../")) {
    fail("UNSAFE_SOURCE_PATH", "must remain inside the project root", path);
  }
  return normalized;
}

function normalizeEvidenceClaim(value, index, basePath = "request.evidence") {
  const path = `${basePath}[${index}]`;
  if (!isPlainObject(value)) fail("INVALID_EVIDENCE", "must be an object", path);
  rejectUnknownKeys(value, EVIDENCE_KEYS, path, "UNKNOWN_EVIDENCE_KEY");
  const field = normalizeString(value.field, `${path}.field`, { maximum: 128 });
  if (!SAFE_FIELD.test(field)) fail("INVALID_EVIDENCE", "field must be a safe field name", `${path}.field`);
  return {
    source: normalizeSourceRef(value.source, `${path}.source`),
    quote: normalizeString(value.quote, `${path}.quote`),
    occurrence: normalizePositiveInteger(value.occurrence, `${path}.occurrence`),
    recordKey: normalizeString(value.recordKey, `${path}.recordKey`, { maximum: 256 }),
    field,
  };
}

function uniqueSourceRefs(values) {
  const byPath = new Map();
  for (const value of values) {
    const existing = byPath.get(value.path);
    if (existing && existing.textProjection !== value.textProjection) {
      fail(
        "CONFLICTING_TEXT_PROJECTION",
        `source ${value.path} is declared with more than one text projection`,
        "request.sources",
      );
    }
    if (!existing) byPath.set(value.path, value);
  }
  return [...byPath.values()].sort((left, right) => compareText(left.path, right.path));
}

function sourceInputPath(source) {
  return source.containerPath ?? source.displayPath;
}

function declarationForSource(source, declarations) {
  const inputPath = sourceInputPath(source);
  const candidates = declarations
    .filter((declaration) =>
      declaration.path === "."
      || inputPath === declaration.path
      || inputPath.startsWith(`${declaration.path}/`))
    .sort((left, right) => right.path.length - left.path.length || compareText(left.path, right.path));
  if (!candidates.length) {
    fail(
      "UNDECLARED_LOADED_SOURCE",
      `loaded source ${source.displayPath} does not resolve to a declared source path`,
      "request.sources",
    );
  }
  return candidates[0];
}

function projectSource(source, declaration) {
  const text = declaration.textProjection === "normalized-text"
    ? source.text.replace(/\r\n?/gu, "\n").normalize("NFC")
    : source.text;
  const bytes = Buffer.from(text, "utf8");
  return {
    ...source,
    text,
    sha256: sourceSha256(bytes),
    byteLength: bytes.byteLength,
    textProjection: declaration.textProjection,
  };
}

function normalizeCategoryOrder(value, member) {
  if (!isPlainObject(value)) fail("INVALID_OPTIONS", "must be an object mapping a role to its category order", "request.options.categoryOrder");
  const declaredRoles = new Set(Object.keys(member.roleSchema?.properties ?? {}));
  const normalized = {};
  for (const [role, categories] of Object.entries(value)) {
    const path = `request.options.categoryOrder.${role}`;
    if (!SAFE_FIELD.test(role)) fail("INVALID_OPTIONS", "must be a role name", path);
    if (declaredRoles.size > 0 && !declaredRoles.has(role)) fail("INVALID_OPTIONS", `${member.id} declares no role ${role}`, path);
    if (!Array.isArray(categories) || categories.length === 0) fail("INVALID_OPTIONS", "must be a non-empty array of category strings", path);
    const seen = new Set();
    categories.forEach((category, index) => {
      if (typeof category !== "string" || category.trim().length === 0) fail("INVALID_OPTIONS", "must be a non-empty string", `${path}[${index}]`);
      if (seen.has(category)) fail("INVALID_OPTIONS", `duplicate category ${category}`, `${path}[${index}]`);
      seen.add(category);
    });
    normalized[role] = [...categories];
  }
  return normalized;
}

function normalizeOptions(value, member) {
  rejectUnknownKeys(value, OPTIONS_KEYS, "request.options", "UNKNOWN_OPTIONS_KEY");
  return {
    ...(value.title === undefined ? {} : {
      title: normalizeString(value.title, "request.options.title", { maximum: 512 }),
    }),
    ...(value.categoryOrder === undefined ? {} : {
      categoryOrder: normalizeCategoryOrder(value.categoryOrder, member),
    }),
  };
}

function validateAgainstSchema(record, schema, path) {
  if (!isPlainObject(record)) fail("INVALID_RECORD", "must be an object", path);
  const required = new Set(schema.required ?? []);
  for (const key of required) {
    if (record[key] === undefined) fail("MISSING_REQUIRED_FIELD", `missing ${key}`, `${path}.${key}`);
  }
  for (const [key, value] of Object.entries(record)) {
    const property = schema.properties?.[key];
    if (!property) fail("UNKNOWN_RECORD_FIELD", `unknown field ${key}`, `${path}.${key}`);
    if (property.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      fail("INVALID_RECORD_FIELD", "must be a finite number", `${path}.${key}`);
    }
    if (property.type === "string" && typeof value !== "string") {
      fail("INVALID_RECORD_FIELD", "must be a string", `${path}.${key}`);
    }
    if (property.anyOf) {
      const valid = property.anyOf.some((candidate) =>
        (candidate.type === "string" && typeof value === "string")
        || (candidate.type === "number" && typeof value === "number" && Number.isFinite(value)));
      if (!valid) fail("INVALID_RECORD_FIELD", "must match one of the allowed scalar types", `${path}.${key}`);
    }
  }
}

function lineRangeFor(text, start, endExclusive) {
  let line = 1;
  let startLine = 1;
  let endLine = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (index === start) startLine = line;
    if (index === endExclusive) {
      endLine = line;
      break;
    }
    if (text[index] === "\n") line += 1;
  }
  if (endExclusive >= text.length) endLine = line;
  return { startLine, endLine };
}

function quoteMatches(text, quote) {
  const matches = [];
  let index = text.indexOf(quote);
  while (index >= 0) {
    matches.push(index);
    index = text.indexOf(quote, index + quote.length);
  }
  return matches;
}

function locatorForQuote(source, quote, offset) {
  const { startLine, endLine } = lineRangeFor(source.text, offset, offset + quote.length);
  return {
    kind: "text-range",
    path: source.displayPath,
    startLine,
    endLine,
    startOffset: offset,
    endOffset: offset + quote.length,
  };
}

function deriveCollectionAtlasFields(records) {
  const grouped = new Map();
  const orderValue = (record, index) => {
    if (typeof record.order === "number" && Number.isFinite(record.order)) return record.order;
    return index + 1;
  };
  records.forEach((record, index) => {
    const cluster = String(record.cluster);
    const list = grouped.get(cluster) ?? [];
    list.push({ record, index, order: orderValue(record, index) });
    grouped.set(cluster, list);
  });
  const clusters = [...grouped.keys()].sort(compareText);
  const totalClusters = Math.max(clusters.length, 1);
  return records.map((record, index) => {
    const cluster = String(record.cluster);
    const groupIndex = clusters.indexOf(cluster);
    const ordered = [...(grouped.get(cluster) ?? [])].sort((left, right) => left.order - right.order || left.index - right.index);
    const recordIndex = ordered.findIndex((entry) => entry.record === record);
    const x = 10 + (groupIndex * 80) / Math.max(totalClusters - 1, 1);
    const y = 12 + recordIndex * 14;
    return {
      x,
      y,
      label: String(record.label),
      cluster,
      ...(typeof record.order === "number" ? { order: record.order } : {}),
    };
  });
}

function deriveCompiledFields(records, { legacyFacetedAtlasAdapter = false } = {}) {
  if (legacyFacetedAtlasAdapter) return deriveCollectionAtlasFields(records);
  return records.map((record) => ({ ...record }));
}

function usesLegacyFacetedAtlasAdapter(normalized, family, member) {
  return normalized.version < 3
    && family.id === "collection-atlas"
    && member.id === "faceted-atlas";
}

function constraintValueKey(value, requirement = {}) {
  if (value === undefined) {
    return requirement.missingValue === undefined
      ? null
      : `missing:${String(requirement.missingValue)}`;
  }
  if (requirement.canonical === "us-state-fips") {
    const canonical = canonicalUsStateFips(value);
    return canonical === null ? null : `us-state-fips:${canonical}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

function assertRecordCount(requirement, records) {
  const count = records.length;
  if (
    (requirement.minimum !== undefined && count < requirement.minimum)
    || (requirement.maximum !== undefined && count > requirement.maximum)
  ) {
    const bounds = [
      requirement.minimum === undefined ? null : `at least ${requirement.minimum}`,
      requirement.maximum === undefined ? null : `at most ${requirement.maximum}`,
    ].filter(Boolean).join(" and ");
    fail("RECORD_COUNT_OUT_OF_RANGE", `requires ${bounds} records; received ${count}`, "request.records");
  }
}

function assertRequiredFields(requirement, records) {
  records.forEach((record, index) => {
    for (const field of requirement.fields) {
      if (record.value[field] === undefined) {
        fail(
          "MISSING_CONSTRAINT_FIELD",
          `${field} is required by ${requirement.id}`,
          `request.records[${index}].${field}`,
        );
      }
    }
  });
}

function assertUniqueTuple(requirement, records) {
  const seen = new Set();
  records.forEach((record, index) => {
    const values = requirement.fields.map((field) => {
      const key = constraintValueKey(record.value[field], requirement);
      if (key === null) {
        fail(
          "MISSING_CONSTRAINT_FIELD",
          `${field} is required by ${requirement.id}`,
          `request.records[${index}].${field}`,
        );
      }
      return key;
    });
    const tuple = JSON.stringify(values);
    if (seen.has(tuple)) {
      fail(
        "DUPLICATE_CONSTRAINT_TUPLE",
        `duplicate ${requirement.fields.join("/")} tuple`,
        `request.records[${index}]`,
      );
    }
    seen.add(tuple);
  });
}

function distinctConstraintValues(requirement, records) {
  const values = new Set();
  records.forEach((record, index) => {
    const key = constraintValueKey(record.value[requirement.field], requirement);
    if (key === null) {
      fail(
        "MISSING_CONSTRAINT_FIELD",
        `${requirement.field} is required by ${requirement.id}`,
        `request.records[${index}].${requirement.field}`,
      );
    }
    values.add(key);
  });
  return values;
}

function assertDistinctCount(requirement, records) {
  const count = distinctConstraintValues(requirement, records).size;
  if (count < requirement.minimum || count > requirement.maximum) {
    fail(
      "DISTINCT_COUNT_OUT_OF_RANGE",
      `${requirement.field} requires ${requirement.minimum} to ${requirement.maximum} distinct values; received ${count}`,
      "request.records",
    );
  }
}

function assertCompleteCartesian(requirement, records) {
  if (requirement.fields.length !== 2) {
    fail("INVALID_CATALOG_CONSTRAINT", `${requirement.id} must name two fields`, "catalog.requirements");
  }
  const [leftField, rightField] = requirement.fields;
  const leftValues = new Set();
  const rightValues = new Set();
  const pairs = new Set();
  records.forEach((record, index) => {
    const left = constraintValueKey(record.value[leftField]);
    const right = constraintValueKey(record.value[rightField]);
    if (left === null || right === null) {
      const missing = left === null ? leftField : rightField;
      fail("MISSING_CONSTRAINT_FIELD", `${missing} is required by ${requirement.id}`, `request.records[${index}].${missing}`);
    }
    leftValues.add(left);
    rightValues.add(right);
    pairs.add(JSON.stringify([left, right]));
  });
  const expected = leftValues.size * rightValues.size;
  if (pairs.size !== expected) {
    fail(
      "INCOMPLETE_CARTESIAN",
      `${leftField}/${rightField} must contain every pair; expected ${expected}, received ${pairs.size}`,
      "request.records",
    );
  }
}

function assertNumericRange(requirement, records) {
  records.forEach((record, index) => {
    const value = record.value[requirement.field];
    if (value === undefined) return;
    const belowMinimum = requirement.minimum !== undefined && value < requirement.minimum;
    const belowExclusiveMinimum = requirement.exclusiveMinimum !== undefined && value <= requirement.exclusiveMinimum;
    const aboveMaximum = requirement.maximum !== undefined && value > requirement.maximum;
    if (belowMinimum || belowExclusiveMinimum || aboveMaximum) {
      fail(
        "NUMERIC_CONSTRAINT_VIOLATION",
        `${requirement.field} violates ${requirement.id}`,
        `request.records[${index}].${requirement.field}`,
      );
    }
  });
}

function assertNumericAggregate(requirement, records) {
  if (requirement.operation !== "sum") {
    fail("INVALID_CATALOG_CONSTRAINT", `${requirement.id} uses an unknown aggregate`, "catalog.requirements");
  }
  const total = records.reduce((sum, record) => sum + record.value[requirement.field], 0);
  if (requirement.exclusiveMinimum !== undefined && total <= requirement.exclusiveMinimum) {
    fail(
      "NUMERIC_AGGREGATE_VIOLATION",
      `${requirement.field} ${requirement.operation} must exceed ${requirement.exclusiveMinimum}; received ${total}`,
      "request.records",
    );
  }
}

function comparableTime(value) {
  if (typeof value !== "string" || value.trim().length === 0) return Number.NaN;
  return Date.parse(value);
}

function assertTimeOrder(requirement, records) {
  records.forEach((record, index) => {
    const start = comparableTime(record.value[requirement.startField]);
    const end = comparableTime(record.value[requirement.endField]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      fail("INVALID_CONSTRAINT_TIME", "interval boundaries must be valid comparable times", `request.records[${index}]`);
    }
    if (end < start) {
      fail(
        "INVALID_CONSTRAINT_TIME_ORDER",
        `${requirement.endField} cannot precede ${requirement.startField}`,
        `request.records[${index}].${requirement.endField}`,
      );
    }
  });
}

function assertHierarchyTree(requirement, records) {
  const nodes = new Map();
  records.forEach((record, index) => {
    const id = constraintValueKey(record.value[requirement.idField]);
    if (nodes.has(id)) {
      fail("INVALID_HIERARCHY", `duplicate node id ${String(record.value[requirement.idField])}`, `request.records[${index}].${requirement.idField}`);
    }
    nodes.set(id, { record, index });
  });
  const roots = [...nodes.values()].filter(({ record }) => record.value[requirement.parentField] === undefined);
  if (roots.length !== requirement.rootCount) {
    fail("INVALID_HIERARCHY", `requires exactly ${requirement.rootCount} root; received ${roots.length}`, "request.records");
  }
  for (const { record, index } of nodes.values()) {
    const parent = record.value[requirement.parentField];
    if (parent !== undefined && !nodes.has(constraintValueKey(parent))) {
      fail("INVALID_HIERARCHY", `parent ${String(parent)} does not resolve`, `request.records[${index}].${requirement.parentField}`);
    }
    const visited = new Set();
    let cursor = constraintValueKey(record.value[requirement.idField]);
    while (cursor !== null) {
      if (visited.has(cursor)) {
        fail("INVALID_HIERARCHY", "hierarchy contains a cycle", `request.records[${index}]`);
      }
      visited.add(cursor);
      const node = nodes.get(cursor);
      if (!node) break;
      const next = node.record.value[requirement.parentField];
      cursor = next === undefined ? null : constraintValueKey(next);
    }
  }
}

function graphNodes(requirement, records) {
  const nodes = new Map();
  for (const record of records) {
    for (const field of [requirement.sourceField, requirement.targetField]) {
      const value = record.value[field];
      nodes.set(constraintValueKey(value), value);
    }
  }
  return nodes;
}

function assertGraphNodeCount(requirement, records) {
  const count = graphNodes(requirement, records).size;
  if (
    (requirement.minimum !== undefined && count < requirement.minimum)
    || (requirement.maximum !== undefined && count > requirement.maximum)
  ) {
    fail("GRAPH_NODE_COUNT_OUT_OF_RANGE", `${requirement.id} received ${count} distinct nodes`, "request.records");
  }
}

function assertDirectedGraph(requirement, records) {
  const nodes = graphNodes(requirement, records);
  if (nodes.size < requirement.minimumNodes || nodes.size > requirement.maximumNodes) {
    fail(
      "GRAPH_NODE_COUNT_OUT_OF_RANGE",
      `requires ${requirement.minimumNodes} to ${requirement.maximumNodes} distinct nodes; received ${nodes.size}`,
      "request.records",
    );
  }
  const edges = new Set();
  const adjacent = new Map([...nodes.keys()].map((node) => [node, new Set()]));
  records.forEach((record, index) => {
    const source = constraintValueKey(record.value[requirement.sourceField]);
    const target = constraintValueKey(record.value[requirement.targetField]);
    if (!requirement.allowSelfEdges && source === target) {
      fail("INVALID_DIRECTED_GRAPH", "self edges are not allowed", `request.records[${index}]`);
    }
    const edge = JSON.stringify([source, target]);
    if (!requirement.allowDuplicateEdges && edges.has(edge)) {
      fail("INVALID_DIRECTED_GRAPH", "duplicate directed edges are not allowed", `request.records[${index}]`);
    }
    edges.add(edge);
    adjacent.get(source).add(target);
    adjacent.get(target).add(source);
  });
  if (records.length > requirement.maximumEdgesPerNode * nodes.size) {
    fail(
      "INVALID_DIRECTED_GRAPH",
      `sparse network accepts at most ${requirement.maximumEdgesPerNode} edges per node`,
      "request.records",
    );
  }
  if (requirement.connected === "weak") {
    const [first] = nodes.keys();
    const reached = new Set(first === undefined ? [] : [first]);
    const pending = first === undefined ? [] : [first];
    while (pending.length) {
      const node = pending.pop();
      for (const neighbor of adjacent.get(node)) {
        if (reached.has(neighbor)) continue;
        reached.add(neighbor);
        pending.push(neighbor);
      }
    }
    if (reached.size !== nodes.size) {
      fail("INVALID_DIRECTED_GRAPH", "network must be connected when edge direction is ignored", "request.records");
    }
  }
}

function assertDirectedFlow(requirement, records) {
  const nodes = graphNodes(requirement, records);
  if (nodes.size > requirement.maximumNodes) {
    fail(
      "GRAPH_NODE_COUNT_OUT_OF_RANGE",
      `flow accepts at most ${requirement.maximumNodes} distinct nodes; received ${nodes.size}`,
      "request.records",
    );
  }
  const outgoing = new Map([...nodes.keys()].map((node) => [node, []]));
  const indegree = new Map([...nodes.keys()].map((node) => [node, 0]));
  const edges = new Set();
  records.forEach((record, index) => {
    const source = constraintValueKey(record.value[requirement.sourceField]);
    const target = constraintValueKey(record.value[requirement.targetField]);
    const value = record.value[requirement.valueField];
    if (value < requirement.minimumValue) {
      fail("INVALID_DIRECTED_FLOW", `${requirement.valueField} must be at least ${requirement.minimumValue}`, `request.records[${index}].${requirement.valueField}`);
    }
    if (!requirement.allowSelfEdges && source === target) {
      fail("INVALID_DIRECTED_FLOW", "self edges are not allowed", `request.records[${index}]`);
    }
    const edge = JSON.stringify([source, target]);
    if (!requirement.allowDuplicateEdges && edges.has(edge)) {
      fail("INVALID_DIRECTED_FLOW", "duplicate directed edges are not allowed", `request.records[${index}]`);
    }
    edges.add(edge);
    outgoing.get(source).push(target);
    indegree.set(target, indegree.get(target) + 1);
  });

  const depth = new Map([...nodes.keys()].map((node) => [node, 0]));
  const pending = [...nodes.keys()].filter((node) => indegree.get(node) === 0).sort(compareText);
  let visited = 0;
  while (pending.length) {
    const node = pending.shift();
    visited += 1;
    for (const target of outgoing.get(node)) {
      depth.set(target, Math.max(depth.get(target), depth.get(node) + 1));
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        pending.push(target);
        pending.sort(compareText);
      }
    }
  }
  if (requirement.acyclic && visited !== nodes.size) {
    fail("INVALID_DIRECTED_FLOW", "flow edges must form a directed acyclic graph", "request.records");
  }
  const stageCount = Math.max(...depth.values()) + 1;
  if (stageCount < requirement.minimumStages || stageCount > requirement.maximumStages) {
    fail(
      "FLOW_STAGE_COUNT_OUT_OF_RANGE",
      `topological depth yields ${stageCount} stages; requires ${requirement.minimumStages} to ${requirement.maximumStages}`,
      "request.records",
    );
  }
}

function assertGroupSize(requirement, records) {
  const groups = new Map();
  records.forEach((record, index) => {
    const value = record.value[requirement.field];
    const key = constraintValueKey(value);
    if (key === null) {
      fail("MISSING_CONSTRAINT_FIELD", `${requirement.field} is required by ${requirement.id}`, `request.records[${index}].${requirement.field}`);
    }
    groups.set(key, (groups.get(key) ?? 0) + 1);
  });
  if (groups.size < requirement.minimumGroups || groups.size > requirement.maximumGroups) {
    fail(
      "GROUP_COUNT_OUT_OF_RANGE",
      `${requirement.field} requires ${requirement.minimumGroups} to ${requirement.maximumGroups} groups; received ${groups.size}`,
      "request.records",
    );
  }
  for (const count of groups.values()) {
    if (count < requirement.minimumItems || count > requirement.maximumItems) {
      fail(
        "GROUP_SIZE_OUT_OF_RANGE",
        `each ${requirement.field} requires ${requirement.minimumItems} to ${requirement.maximumItems} items; received ${count}`,
        "request.records",
      );
    }
  }
}

function assertMemberRequirements(member, records) {
  for (const requirement of member.requirements) {
    if (requirement.kind === "record-count") assertRecordCount(requirement, records);
    else if (requirement.kind === "required-fields") assertRequiredFields(requirement, records);
    else if (requirement.kind === "unique-tuple") assertUniqueTuple(requirement, records);
    else if (requirement.kind === "distinct-count") assertDistinctCount(requirement, records);
    else if (requirement.kind === "complete-cartesian") assertCompleteCartesian(requirement, records);
    else if (requirement.kind === "numeric-range") assertNumericRange(requirement, records);
    else if (requirement.kind === "numeric-aggregate") assertNumericAggregate(requirement, records);
    else if (requirement.kind === "time-order") assertTimeOrder(requirement, records);
    else if (requirement.kind === "hierarchy-tree") assertHierarchyTree(requirement, records);
    else if (requirement.kind === "directed-graph") assertDirectedGraph(requirement, records);
    else if (requirement.kind === "directed-flow") assertDirectedFlow(requirement, records);
    else if (requirement.kind === "graph-node-count") assertGraphNodeCount(requirement, records);
    else if (requirement.kind === "group-size") assertGroupSize(requirement, records);
    else if (requirement.kind === "capability-blocker") {
      fail("UNAVAILABLE_MEMBER_CAPABILITY", requirement.reason, "request.member");
    } else if (![
      "field-evidence",
      "derived-layout",
      "native-locator",
      "geography-binding",
      "renderer-binding",
    ].includes(requirement.kind)) {
      fail("INVALID_CATALOG_CONSTRAINT", `unknown requirement kind ${requirement.kind}`, "catalog.requirements");
    }
  }
}

const LEGACY_REQUIREMENT_KIND_BY_ERROR = Object.freeze({
  DISTINCT_COUNT_OUT_OF_RANGE: "distinct-count",
  DUPLICATE_CONSTRAINT_TUPLE: "unique-tuple",
  FLOW_STAGE_COUNT_OUT_OF_RANGE: "directed-flow",
  GRAPH_NODE_COUNT_OUT_OF_RANGE: "graph-node-count",
  GROUP_COUNT_OUT_OF_RANGE: "group-size",
  GROUP_SIZE_OUT_OF_RANGE: "group-size",
  INCOMPLETE_CARTESIAN: "complete-cartesian",
  INVALID_CONSTRAINT_TIME_ORDER: "time-order",
  INVALID_DIRECTED_FLOW: "directed-flow",
  INVALID_DIRECTED_GRAPH: "directed-graph",
  INVALID_HIERARCHY: "hierarchy-tree",
  MISSING_CONSTRAINT_FIELD: "required-fields",
  NUMERIC_AGGREGATE_VIOLATION: "numeric-aggregate",
  NUMERIC_CONSTRAINT_VIOLATION: "numeric-range",
  RECORD_COUNT_OUT_OF_RANGE: "record-count",
  UNAVAILABLE_MEMBER_CAPABILITY: "capability-blocker",
});

function exactLegacyIneligibility(familyId, member, rawRecords, cause) {
  const form = requireExecutableForm(familyId, member.id);
  const evaluated = evaluateFormEligibility(
    form,
    rawRecords.map((record) => ({ roles: record.value })),
    { adapter: { id: "evidenced-records-v1", version: 1 }, medium: "text" },
  );
  const expectedKind = LEGACY_REQUIREMENT_KIND_BY_ERROR[cause.code];
  const failedRequirements = evaluated.failedRequirements.length > 0
    ? evaluated.failedRequirements
    : member.requirements.filter((requirement) => requirement.kind === expectedKind);
  const error = new Error(
    `request.member: ${familyId}/${member.id} is incompatible with the verified records`,
    { cause },
  );
  error.code = "INELIGIBLE_REQUESTED_FORM";
  error.path = "request.member";
  error.familyId = familyId;
  error.memberId = member.id;
  error.failedRequirements = failedRequirements.length > 0
    ? failedRequirements
    : [{ id: cause.code, kind: "frozen-form-requirement" }];
  return error;
}

function scalarLiteral(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function assertLiteralFieldBinding(claim, recordValue) {
  const literal = scalarLiteral(recordValue);
  if (!literal) return;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const numeric = typeof recordValue === "number";
  const before = numeric ? "(?<![\\p{L}\\p{N}_.+\\-])" : "(?<![\\p{L}\\p{N}_])";
  const after = numeric ? "(?![\\p{L}\\p{N}_]|\\.\\p{N})" : "(?![\\p{L}\\p{N}_])";
  const bound = new RegExp(`${before}${escaped}${after}`, "u").test(claim.quote);
  if (!bound) {
    fail(
      "UNBOUND_FIELD_EVIDENCE",
      `quote does not literally bind ${claim.recordKey}.${claim.field}=${literal}`,
      "request.evidence.quote",
    );
  }
}

function assertRegionIdentifiers(familyId, records) {
  if (familyId !== "region-map") return;
  records.forEach((record, index) => {
    if (!canonicalUsStateFips(record.value.region)) {
      fail(
        "UNKNOWN_GEOGRAPHIC_REGION",
        "region must be a US Census two-digit state or territory FIPS id supported by us-atlas/states-10m",
        `request.records[${index}].region`,
      );
    }
  });
}

function compileOptionsForMember(familyId, member, options) {
  return {
    availableWidth: 1_200,
    ...(member.mediaPolicy === "normalized-text" ? { mediaType: "text" } : {}),
    ...(options.categoryOrder === undefined ? {} : { categoryOrder: options.categoryOrder }),
  };
}

function roleMappingForPackage(member, compiledRecords) {
  const required = new Set(member.roleSchema?.required ?? []);
  return Object.fromEntries(
    Object.keys(member.roleSchema?.properties ?? {})
      .filter((role) => required.has(role) || compiledRecords.some((record) => record[role] !== undefined))
      .map((role) => [role, role]),
  );
}

function evidenceRequiredFields(record) {
  return Object.keys(record.value).filter((field) => record.value[field] !== undefined);
}

export async function compileCatalogMapRequest({ root, request }) {
  const normalized = normalizeRequest(request);
  const family = requireCatalogFamily(normalized.family);
  const requestedMember = requireCatalogMember(normalized.family, normalized.member);
  if (normalized.representationIntent.mode === "exact" && requestedMember.status !== "executable") {
    if (normalized.version === 3) {
      throw ineligibleRequestedForm({
        familyId: normalized.family,
        memberId: normalized.member,
        message: `${normalized.family}/${normalized.member} is ${requestedMember.status}, not executable in this release`,
        failedRequirements: [{
          id: "executable-status",
          kind: "catalog-status",
          expected: "executable",
          actual: requestedMember.status,
          ...(requestedMember.unavailableReason
            ? { reason: requestedMember.unavailableReason }
            : requestedMember.rejectionReason
              ? { reason: requestedMember.rejectionReason }
              : {}),
        }],
      });
    }
    fail(
      "UNSUPPORTED_REQUESTED_REPRESENTATION",
      `${normalized.family}/${normalized.member} is not executable in this release`,
      "request.member",
    );
  }
  const member = requireExecutableCatalogMember(normalized.family, normalized.member);
  try {
    assertRepresentationIntentSupported(normalized.representationIntent, {
      family: normalized.family,
      member,
      path: "request.representationIntent",
    });
  } catch (error) {
    if (normalized.version !== 3 || error?.code !== "UNSUPPORTED_REQUESTED_REPRESENTATION") throw error;
    const constraintIndex = Number(error.path?.match(/constraints\[([0-9]+)\]/u)?.[1]);
    const constraint = normalized.representationIntent.constraints[constraintIndex];
    throw ineligibleRequestedForm({
      familyId: normalized.family,
      memberId: normalized.member,
      message: error.message,
      cause: error,
      failedRequirements: [{
        id: constraint ? `representation-${constraint.kind}` : "representation-capability",
        kind: "representation-capability",
        ...(constraint ? {
          constraintKind: constraint.kind,
          expected: member.representationCapabilities?.constraints?.[constraint.kind] ?? [],
          actual: constraint.value,
        } : {}),
      }],
    });
  }
  const options = normalizeOptions(normalized.options, member);
  if (normalized.input.adapter === "local-image-set-v1") {
    if (family.id !== "collection-atlas" || member.id !== "contact-atlas") {
      const error = new Error(
        `request.member: ${family.id}/${member.id} does not accept local-image-set-v1 input`,
      );
      error.code = "INELIGIBLE_REQUESTED_FORM";
      error.path = "request.member";
      error.familyId = family.id;
      error.memberId = member.id;
      error.failedRequirements = [{
        id: "input-adapter",
        kind: "adapter-policy",
        expected: "evidenced-records-v1",
        actual: "local-image-set-v1",
      }];
      throw error;
    }
    let imageSet;
    try {
      imageSet = await loadLocalImageSet({
        root,
        directory: normalized.input.directory,
      });
    } catch (error) {
      if (normalized.representationIntent.mode !== "exact" || !(error instanceof LocalImageSetError)) throw error;
      throw ineligibleRequestedForm({
        familyId: family.id,
        memberId: member.id,
        message: error.message,
        cause: error,
        failedRequirements: error.failedRequirements.map(({ requirement, message, ...details }) => ({
          id: requirement,
          kind: "media-eligibility",
          message,
          ...details,
        })),
      });
    }
    const compiledFields = imageSet.canonicalSourceBundle.records.map((record) => record.fields);
    const { dataPackage, evidenceReferences } = await compileMapWithEvidence({
      familyId: family.id,
      catalog: catalogReceiptForMember(family.id, member.id),
      question: {
        text: normalized.question,
        target: options.title ?? family.title,
        analyticJob: `${family.id}:${member.id}`,
      },
      sourceBundle: imageSet.canonicalSourceBundle,
      roleMapping: roleMappingForPackage(member, compiledFields),
      options: compileOptionsForMember(family.id, member, options),
    });
    const evidenceStore = buildImageEvidenceStore({
      dataPackage,
      sources: imageSet.canonicalSourceBundle.sources,
      evidenceReferences,
      sourceBundleSha256: imageSet.stagingManifest.sourceBundleSha256,
    });
    return {
      catalogVersion: CATALOG_VERSION,
      representationIntent: normalized.representationIntent,
      dataPackage,
      evidenceStore,
      family,
      member,
      imageSet,
      loadedSources: imageSet.canonicalSourceBundle.sources,
      knownOmissions: imageSet.canonicalSourceBundle.knownOmissions,
      disclosures: imageSet.disclosures,
    };
  }
  const evidencedInput = normalized.input;
  const legacyFacetedAtlasAdapter = usesLegacyFacetedAtlasAdapter(normalized, family, member);
  const recordSchema = legacyFacetedAtlasAdapter
    ? LEGACY_FACETED_ATLAS_RECORD_SCHEMA
    : member.recordSchema;
  const sourceRefs = uniqueSourceRefs(evidencedInput.sources.map((source, index) =>
    normalizeSourceRef(source, `request${normalized.version === 3 ? ".input" : ""}.sources[${index}]`)));
  const requestedInputs = [...new Set(sourceRefs.map((source) => source.path))].sort(compareText);
  const rawLoaded = await loadSources({ root, inputPaths: requestedInputs });
  const loaded = {
    ...rawLoaded,
    sources: rawLoaded.sources.map((source) => projectSource(
      source,
      declarationForSource(source, sourceRefs),
    )),
  };
  const sourceByPath = new Map(loaded.sources.map((source) => [source.displayPath, source]));
  const evidenceBasePath = normalized.version === 3 ? "request.input.evidence" : "request.evidence";
  const evidenceClaims = evidencedInput.evidence.map((claim, index) =>
    normalizeEvidenceClaim(claim, index, evidenceBasePath));

  const rawRecords = evidencedInput.records.map((record, index) => {
    const recordKey = normalizeString(record.key ?? record.id ?? `record-${index + 1}`, `request.records[${index}].key`, { maximum: 256 });
    const { key: _key, ...fields } = record;
    validateAgainstSchema(fields, recordSchema, `request.records[${index}]`);
    return {
      key: recordKey,
      value: fields,
    };
  });
  assertRegionIdentifiers(family.id, rawRecords);
  // Preserve the frozen map-request errors for the original 18 forms. New
  // exact forms are governed by their FormDefinition so callers receive one
  // structured eligibility failure instead of a family-era constraint error.
  if (legacyFacetedAtlasAdapter) {
    assertMemberRequirements({ requirements: LEGACY_FACETED_ATLAS_REQUIREMENTS }, rawRecords);
  } else if (isLegacyExecutableForm({ familyId: family.id, memberId: member.id })) {
    try {
      assertMemberRequirements(member, rawRecords);
    } catch (error) {
      if (normalized.version !== 3 || normalized.representationIntent.mode !== "exact") throw error;
      throw exactLegacyIneligibility(family.id, member, rawRecords, error);
    }
  }
  const recordByKey = new Map();
  rawRecords.forEach((record, index) => {
    if (recordByKey.has(record.key)) fail("DUPLICATE_RECORD_KEY", `duplicate record key ${record.key}`, `request.records[${index}].key`);
    recordByKey.set(record.key, record);
  });

  const evidenceRefsByRecord = new Map(rawRecords.map((record) => [record.key, []]));
  const coveredFieldsByRecord = new Map(rawRecords.map((record) => [record.key, new Set()]));
  for (const claim of evidenceClaims) {
    const record = recordByKey.get(claim.recordKey);
    if (!record) fail("UNKNOWN_RECORD_KEY", `unknown recordKey ${claim.recordKey}`, "request.evidence.recordKey");
    if (record.value[claim.field] === undefined) fail("UNKNOWN_RECORD_FIELD", `${claim.recordKey} has no field ${claim.field}`, "request.evidence.field");
    assertLiteralFieldBinding(claim, record.value[claim.field]);
    const source = sourceByPath.get(claim.source.path);
    if (!source) fail("UNKNOWN_SOURCE_PATH", `evidence references unloaded source ${claim.source.path}`, "request.evidence.source.path");
    if (claim.source.textProjection !== source.textProjection) {
      fail(
        "TEXT_PROJECTION_MISMATCH",
        `evidence projection ${claim.source.textProjection} does not match declared source projection ${source.textProjection}`,
        "request.evidence.source.textProjection",
      );
    }
    const matches = quoteMatches(source.text, claim.quote);
    if (!matches.length) fail("QUOTE_NOT_FOUND", `quote was not found in ${source.displayPath}`, "request.evidence.quote");
    if (matches.length > 1 && claim.occurrence === undefined) {
      fail("AMBIGUOUS_QUOTE", `quote matched ${matches.length} times in ${source.displayPath}; supply occurrence`, "request.evidence.occurrence");
    }
    const occurrence = claim.occurrence ?? 1;
    const offset = matches[occurrence - 1];
    if (offset === undefined) fail("AMBIGUOUS_QUOTE", `occurrence ${occurrence} is out of range for ${source.displayPath}`, "request.evidence.occurrence");
    const locator = locatorForQuote(source, claim.quote, offset);
    evidenceRefsByRecord.get(record.key).push({
      sourceId: source.id,
      locator,
      quote: claim.quote,
    });
    coveredFieldsByRecord.get(record.key).add(claim.field);
  }

  rawRecords.forEach((record, index) => {
    const covered = coveredFieldsByRecord.get(record.key);
    for (const field of evidenceRequiredFields(record)) {
      if (!covered.has(field)) {
        fail("MISSING_FIELD_EVIDENCE", `${record.key}.${field} has no exact quote evidence`, `request.records[${index}].${field}`);
      }
    }
  });

  const compiledFields = deriveCompiledFields(
    rawRecords.map((record) => record.value),
    { legacyFacetedAtlasAdapter },
  );
  const compiledRecords = rawRecords.map((record, index) => {
    const evidenceRefs = [...(evidenceRefsByRecord.get(record.key) ?? [])].sort((left, right) =>
      compareText(left.sourceId, right.sourceId) || compareText(JSON.stringify(left.locator), JSON.stringify(right.locator)));
    if (!evidenceRefs.length) fail("MISSING_RECORD_EVIDENCE", `${record.key} has no evidence`, `request.records[${index}]`);
    const sourceId = evidenceRefs[0].sourceId;
    return {
      id: sourceStableId("record", `${family.id}\u0000${member.id}\u0000${record.key}`),
      sourceId,
      fields: compiledFields[index],
      evidenceRefs,
      ...(typeof record.value.mediaType === "string" ? { media: { type: record.value.mediaType } } : {}),
    };
  });

  const { dataPackage, evidenceReferences } = await compileMapWithEvidence({
    familyId: family.id,
    catalog: catalogReceiptForMember(family.id, member.id),
    question: {
      text: normalized.question,
      target: options.title ?? family.title,
      analyticJob: `${family.id}:${member.id}`,
    },
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: {
        id: "evidenced-records-v1",
        version: 1,
      },
      medium: "text",
      requestedInputs,
      knownOmissions: loaded.omissions.map((omission) => omission.reason ?? omission.id),
      sources: loaded.sources.map((source) => ({
        id: source.id,
        displayPath: source.displayPath,
        sha256: source.sha256,
        kind: source.kind,
        byteLength: source.byteLength,
        textProjection: source.textProjection,
        ...(source.title ? { title: source.title } : {}),
        ...(source.date ? { date: source.date } : {}),
        ...(source.recordId ? { recordId: source.recordId } : {}),
      })),
      records: compiledRecords,
    },
    roleMapping: roleMappingForPackage(member, compiledFields),
    options: compileOptionsForMember(family.id, member, options),
  });

  const evidenceStore = buildEvidenceStore({
    dataPackage,
    sources: loaded.sources,
    evidenceReferences,
  });

  return {
    catalogVersion: CATALOG_VERSION,
    representationIntent: normalized.representationIntent,
    dataPackage,
    evidenceStore,
    family,
    member,
    loadedSources: loaded.sources,
    knownOmissions: loaded.omissions,
  };
}
