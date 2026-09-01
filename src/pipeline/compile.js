import {
  CANONICAL_INPUT_MEDIA,
  GEOGRAPHY_RENDERER_POLICY,
  classifyRepeatMedia,
  multiplesPolicy,
  requireMapFamily,
} from "../map-families/registry.js";
import { canonicalUsStateFips } from "../geography.js";
import { CATALOG_VERSION, catalogReceiptForMember } from "../catalog/index.js";
import {
  compareCategoryValues,
  evaluateFormEligibility,
  evaluateFormSourcePolicy,
  isLegacyExecutableForm,
  projectFormPayload,
  requireExecutableForm,
} from "../forms/index.js";
import {
  DataPackageContractError,
  canonicalJson,
  canonicalize,
  createDataPackage,
  isOpaqueEvidenceReferenceId,
  sha256Hex,
  stableId,
} from "./data-package.js";

export const PIPELINE_ID = "attend-map-compiler";
export const PIPELINE_VERSION = 1;

const SAFE_ID = /^[a-z][a-z0-9_-]{1,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ROLE_PATH = /^(?:record\.|fields\.|media\.)?[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/u;
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/u;
const SOURCE_PUBLIC_FIELDS = [
  "id",
  "displayPath",
  "sha256",
  "kind",
  "byteLength",
  "title",
  "date",
  "mediaType",
  "mimeType",
  "permissionRef",
  "textProjection",
];
const PRIVATE_PREVIEW_FIELDS = new Set([
  "sourceId",
  "recordId",
  "locator",
  "excerpt",
  "quote",
  "text",
]);

export class PipelineContractError extends TypeError {
  constructor(code, message, path = "compile") {
    super(`${path}: ${message}`);
    this.name = "PipelineContractError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path) {
  throw new PipelineContractError(code, message, path);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value, path, maximum = 16_384) {
  if (typeof value !== "string" || value.trim().length === 0) fail("INVALID_STRING", "must be a non-empty string", path);
  if (value.length > maximum) fail("STRING_TOO_LONG", `must contain at most ${maximum} characters`, path);
  return value;
}

function safeDisplayPath(value, path) {
  requiredString(value, path, 2_048);
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized.startsWith("~")
    || /^[a-z]:\//iu.test(normalized)
    || normalized.split("/").includes("..")
  ) {
    fail("UNSAFE_DISPLAY_PATH", "must be relative and cannot traverse a parent directory", path);
  }
  return value;
}

function safeId(value, path) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("INVALID_IDENTIFIER", "must be a safe stable identifier", path);
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparableTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return Number.NaN;
  return Date.parse(value);
}

function roleValueMatches(value, type) {
  if (type === "string") return typeof value === "string" && value.trim().length > 0 && value.length <= 16_384;
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "time") return (typeof value === "number" || (typeof value === "string" && value.length <= 16_384))
    && Number.isFinite(comparableTime(value));
  if (type === "identifier") return (typeof value === "string" && value.trim().length > 0 && value.length <= 1_024) || (typeof value === "number" && Number.isFinite(value));
  if (type === "latitude") return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
  if (type === "longitude") return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
  if (type === "ratio") return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (type === "media") return isPlainObject(value) || (typeof value === "string" && value.trim().length > 0 && value.length <= 16_384);
  return false;
}

function resolvePath(record, mapping) {
  const path = mapping.split(".");
  let value;
  if (path[0] === "record") {
    value = record;
    path.shift();
  } else if (path[0] === "fields") {
    value = record.fields;
    path.shift();
  } else if (path[0] === "media") {
    value = record.media;
    path.shift();
  } else {
    value = record.fields;
  }
  for (const segment of path) {
    if (!value || typeof value !== "object") return undefined;
    value = value[segment];
  }
  return value;
}

function publicSource(source) {
  return Object.fromEntries(
    SOURCE_PUBLIC_FIELDS
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  );
}

function validateSource(source, path) {
  if (!isPlainObject(source)) fail("INVALID_SOURCE", "must be an object", path);
  safeId(source.id, `${path}.id`);
  safeDisplayPath(source.displayPath, `${path}.displayPath`);
  if (!SHA256.test(source.sha256 ?? "")) fail("INVALID_SOURCE", "sha256 must be a lowercase SHA-256 digest", `${path}.sha256`);
  requiredString(source.kind, `${path}.kind`, 128);
  if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) fail("INVALID_SOURCE", "byteLength must be a non-negative integer", `${path}.byteLength`);
  if (source.textProjection !== undefined && !["utf8", "normalized-text"].includes(source.textProjection)) {
    fail("INVALID_SOURCE", "textProjection must be utf8 or normalized-text", `${path}.textProjection`);
  }
}

function validateRecord(record, sourceIds, path) {
  if (!isPlainObject(record)) fail("INVALID_RECORD", "must be an object", path);
  safeId(record.id, `${path}.id`);
  if (!sourceIds.has(record.sourceId)) fail("INVALID_RECORD", `unknown source ${String(record.sourceId)}`, `${path}.sourceId`);
  if (!isPlainObject(record.fields)) fail("INVALID_RECORD", "fields must be a plain object", `${path}.fields`);
  try {
    canonicalJson(record.fields);
  } catch (error) {
    if (error instanceof DataPackageContractError) fail("INVALID_RECORD", error.message, `${path}.fields`);
    throw error;
  }
  if (record.evidenceRefs !== undefined && !Array.isArray(record.evidenceRefs)) fail("INVALID_RECORD", "evidenceRefs must be an array", `${path}.evidenceRefs`);
  if (record.media !== undefined && !isPlainObject(record.media)) fail("INVALID_RECORD", "media must be an object", `${path}.media`);
}

export function validateNormalizedSourceBundle(bundle) {
  if (!isPlainObject(bundle)) fail("INVALID_SOURCE_BUNDLE", "must be an object", "sourceBundle");
  if (bundle.kind !== undefined && bundle.kind !== "attend-normalized-source-bundle") fail("INVALID_SOURCE_BUNDLE", "kind must be attend-normalized-source-bundle", "sourceBundle.kind");
  if (bundle.schemaVersion !== undefined && bundle.schemaVersion !== 1) fail("INVALID_SOURCE_BUNDLE", "schemaVersion must be 1", "sourceBundle.schemaVersion");
  safeId(bundle.adapter?.id, "sourceBundle.adapter.id");
  if (!Number.isSafeInteger(bundle.adapter?.version) || bundle.adapter.version < 1) fail("INVALID_SOURCE_BUNDLE", "adapter version must be a positive integer", "sourceBundle.adapter.version");
  if (!CANONICAL_INPUT_MEDIA.includes(bundle.medium)) fail("INVALID_SOURCE_BUNDLE", "medium must be canonical", "sourceBundle.medium");
  if (!Array.isArray(bundle.sources) || bundle.sources.length === 0) fail("INVALID_SOURCE_BUNDLE", "sources must be a non-empty array", "sourceBundle.sources");
  if (!Array.isArray(bundle.records) || bundle.records.length === 0) fail("INVALID_SOURCE_BUNDLE", "records must be a non-empty array", "sourceBundle.records");
  const sourceIds = new Set();
  bundle.sources.forEach((source, index) => {
    validateSource(source, `sourceBundle.sources[${index}]`);
    if (sourceIds.has(source.id)) fail("DUPLICATE_SOURCE", `duplicate source id ${source.id}`, `sourceBundle.sources[${index}].id`);
    sourceIds.add(source.id);
  });
  const recordIds = new Set();
  bundle.records.forEach((record, index) => {
    validateRecord(record, sourceIds, `sourceBundle.records[${index}]`);
    if (recordIds.has(record.id)) fail("DUPLICATE_RECORD", `duplicate record id ${record.id}`, `sourceBundle.records[${index}].id`);
    recordIds.add(record.id);
  });
  if (bundle.requestedInputs !== undefined) {
    if (!Array.isArray(bundle.requestedInputs)) fail("INVALID_SOURCE_BUNDLE", "requestedInputs must be an array", "sourceBundle.requestedInputs");
    bundle.requestedInputs.forEach((value, index) => safeDisplayPath(value, `sourceBundle.requestedInputs[${index}]`));
  }
  if (bundle.knownOmissions !== undefined && !Array.isArray(bundle.knownOmissions)) fail("INVALID_SOURCE_BUNDLE", "knownOmissions must be an array", "sourceBundle.knownOmissions");
  return bundle;
}

function validateRoleMapping(roleMapping, manifest, form) {
  if (!isPlainObject(roleMapping)) fail("INVALID_ROLE_MAPPING", "must be an object", "roleMapping");
  const allowed = new Set([
    ...form.roles.required.map((item) => item.id),
    ...form.roles.optional.map((item) => item.id),
  ]);
  for (const item of form.roles.required) {
    if (typeof roleMapping[item.id] !== "string") fail("MISSING_REQUIRED_ROLE", `required role ${item.id} is not mapped`, `roleMapping.${item.id}`);
  }
  for (const [role, path] of Object.entries(roleMapping)) {
    if (!allowed.has(role)) fail("UNKNOWN_ROLE", `role ${role} is not declared by ${manifest.id}`, `roleMapping.${role}`);
    if (typeof path !== "string" || !ROLE_PATH.test(path)) fail("INVALID_ROLE_PATH", "must be a bounded dot path into fields, record, or media", `roleMapping.${role}`);
  }
  return canonicalize(roleMapping);
}

function projectRecord(record, roleMapping, form, index) {
  const projected = {};
  const roles = [
    ...form.roles.required,
    ...form.roles.optional,
  ];
  for (const role of roles) {
    const mapping = roleMapping[role.id];
    if (mapping === undefined) continue;
    const value = resolvePath(record, mapping);
    if (value === undefined || value === null || value === "") {
      if (form.roles.required.some((required) => required.id === role.id)) fail("MISSING_ROLE_VALUE", `record ${record.id} has no value for required role ${role.id}`, `sourceBundle.records[${index}].${mapping}`);
      continue;
    }
    if (!role.types.some((type) => roleValueMatches(value, type))) fail("INVALID_ROLE_VALUE", `record ${record.id} value for ${role.id} does not match ${role.types.join(" or ")}`, `sourceBundle.records[${index}].${mapping}`);
    projected[role.id] = canonicalize(value);
  }
  return projected;
}

function valueForSort(value, roleTypes) {
  if (value === undefined || value === null) return { missing: true, value: null };
  if (roleTypes?.includes("time")) return { missing: false, value: comparableTime(value) };
  return { missing: false, value };
}

function compareValues(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return compareCategoryValues(String(left), String(right));
}

function compareDeclared(indexes, left, right) {
  const leftIndex = indexes.get(String(left)) ?? indexes.size;
  const rightIndex = indexes.get(String(right)) ?? indexes.size;
  return leftIndex - rightIndex || compareValues(left, right);
}

function entryComparator(manifest, form, categoryOrder = {}) {
  if (form.key === "collection-atlas/contact-atlas") {
    return (left, right) =>
      compareText(String(left.roles.captureTime), String(right.roles.captureTime))
      || compareValues(left.roles.order ?? 0, right.roles.order ?? 0)
      || compareText(String(left.roles.label), String(right.roles.label))
      || compareText(left.record.id, right.record.id);
  }
  const typesByRole = new Map(
    [...form.roles.required, ...form.roles.optional]
      .map((item) => [item.id, item.types]),
  );
  const orderBy = {
    "rank/slopegraph": [{ role: "stateOrder", direction: "asc" }, { role: "value", direction: "desc" }, { role: "label", direction: "asc" }],
    "hierarchy/outline": [{ role: "parentId", direction: "asc" }, { role: "order", direction: "asc" }, { role: "label", direction: "asc" }],
  }[form.key] ?? manifest.transformation.orderBy;
  const declaredByRole = new Map(Object.entries(categoryOrder)
    .map(([role, categories]) => [role, new Map(categories.map((category, index) => [category, index]))]));
  return (left, right) => {
    for (const rule of orderBy) {
      const leftValue = valueForSort(left.roles[rule.role], typesByRole.get(rule.role));
      const rightValue = valueForSort(right.roles[rule.role], typesByRole.get(rule.role));
      if (leftValue.missing !== rightValue.missing) return leftValue.missing ? 1 : -1;
      if (leftValue.missing) continue;
      const declared = declaredByRole.get(rule.role);
      const compared = declared
        ? compareDeclared(declared, leftValue.value, rightValue.value)
        : compareValues(leftValue.value, rightValue.value);
      if (compared !== 0) return rule.direction === "desc" ? -compared : compared;
    }
    return compareText(left.record.id, right.record.id);
  };
}

async function normalizePrivateEvidenceRefs(record, sourceIds) {
  const supplied = record.evidenceRefs?.length
    ? record.evidenceRefs
    : [{
        sourceId: record.sourceId,
        recordId: record.id,
        locator: { kind: "record", recordId: record.id },
        ...(typeof record.excerpt === "string" ? { quote: record.excerpt } : {}),
      }];
  const refs = [];
  const seen = new Set();
  for (let index = 0; index < supplied.length; index += 1) {
    const reference = supplied[index];
    if (!isPlainObject(reference) || !sourceIds.has(reference.sourceId)) fail("INVALID_EVIDENCE_REF", `record ${record.id} evidence references an unknown source`, `record.${record.id}.evidenceRefs[${index}]`);
    const locator = reference.locator ?? { kind: "record", recordId: record.id };
    if (!isPlainObject(locator) || Object.keys(locator).length === 0) fail("INVALID_EVIDENCE_REF", "locator must be a non-empty object", `record.${record.id}.evidenceRefs[${index}].locator`);
    const quote = reference.quote ?? reference.excerpt;
    if (quote !== undefined) requiredString(quote, `record.${record.id}.evidenceRefs[${index}].quote`, 16_384);
    const privateReference = canonicalize({
      sourceId: reference.sourceId,
      recordId: reference.recordId ?? record.id,
      locator,
      ...(quote === undefined ? {} : { quote }),
    });
    const key = canonicalJson(privateReference);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(canonicalize({
        id: await stableId("evidence", privateReference),
        ...privateReference,
      }));
    }
  }
  refs.sort((left, right) => compareText(left.id, right.id));
  return refs;
}

function publicPreviewMetadata(value) {
  if (Array.isArray(value)) return value.map(publicPreviewMetadata);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_PREVIEW_FIELDS.has(key))
      .map(([key, entry]) => [key, publicPreviewMetadata(entry)]),
  );
}

function normalizePreview(preview) {
  if (preview === undefined || preview === null) return undefined;
  if (typeof preview === "string") {
    return {
      kind: "text",
      lineCount: Math.max(1, preview.split(/\r?\n/u).length),
    };
  }
  if (!isPlainObject(preview)) fail("INVALID_MEDIA", "preview must be a string or object", "record.media.preview");
  return canonicalize(publicPreviewMetadata(preview));
}

function normalizeMedia(record, source, manifest) {
  const supplied = record.media ?? {};
  const requestedType = supplied.type ?? supplied.mimeType ?? source.mediaType ?? source.mimeType;
  const type = requestedType === undefined
    ? manifest.multiples.defaultMedia
    : classifyRepeatMedia(requestedType);
  const media = {
    type,
    ...(supplied.mimeType ?? source.mimeType ? { mimeType: supplied.mimeType ?? source.mimeType } : {}),
  };
  const preview = normalizePreview(supplied.preview ?? record.preview);
  if (preview !== undefined) media.preview = preview;
  for (const field of ["width", "height", "durationSeconds"]) {
    const value = supplied[field];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("INVALID_MEDIA", `${field} must be a non-negative finite number`, `record.${record.id}.media.${field}`);
      media[field] = value;
    }
  }
  return canonicalize(media);
}

function markLabel(roles, manifest, recordId) {
  const values = manifest.transformation.markLabelRoles
    .map((role) => roles[role])
    .filter((value) => value !== undefined && value !== null && String(value).length > 0)
    .map(String);
  const label = values.join(manifest.transformation.markLabelSeparator) || recordId;
  return label.length <= 1_000 ? label : `${label.slice(0, 997)}…`;
}

function markSummary(roles) {
  const summary = Object.entries(roles)
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
  return summary.length <= 4_000 ? summary : `${summary.slice(0, 3_997)}…`;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null).map(String))].sort(compareCategoryValues);
}

function numericExtent(entries, role) {
  const values = entries.map((entry) => entry.roles[role]).filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

function timeExtent(entries, startRole = "time", endRole = "endTime") {
  const values = [];
  for (const entry of entries) {
    const start = comparableTime(entry.roles[startRole]);
    const end = comparableTime(entry.roles[endRole]);
    if (Number.isFinite(start)) values.push(start);
    if (Number.isFinite(end)) values.push(end);
  }
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

function duplicateKey(entries, roles, familyId) {
  const seen = new Set();
  for (const entry of entries) {
    const key = roles.map((role) => String(entry.roles[role] ?? "")).join("\u0000");
    if (seen.has(key)) fail("DUPLICATE_ROLE_KEY", `${familyId} contains duplicate ${roles.join("/")} key ${key.replaceAll("\u0000", " / ")}`, `records.${entry.record.id}`);
    seen.add(key);
  }
}

function validateHierarchy(entries) {
  const nodes = new Map(entries.map((entry) => [String(entry.roles.id), entry]));
  for (const entry of entries) {
    const parent = entry.roles.parentId;
    if (parent !== undefined && !nodes.has(String(parent))) fail("DANGLING_PARENT", `parent ${String(parent)} does not resolve`, `records.${entry.record.id}.parentId`);
  }
  for (const entry of entries) {
    const visited = new Set();
    let cursor = String(entry.roles.id);
    while (cursor) {
      if (visited.has(cursor)) fail("HIERARCHY_CYCLE", `cycle includes node ${cursor}`, `records.${entry.record.id}`);
      visited.add(cursor);
      const parent = nodes.get(cursor)?.roles.parentId;
      cursor = parent === undefined ? "" : String(parent);
    }
  }
}

function validateFamilyEntries(manifest, entries) {
  if (entries.length < manifest.data.minimumRecords) fail("INSUFFICIENT_RECORDS", `${manifest.id} requires at least ${manifest.data.minimumRecords} records`, "sourceBundle.records");
  if (entries.length > manifest.data.maximumRecords) fail("TOO_MANY_RECORDS", `${manifest.id} accepts at most ${manifest.data.maximumRecords} records`, "sourceBundle.records");
  if (manifest.id === "composition" && entries.some((entry) => entry.roles.value < 0)) fail("INVALID_COMPOSITION", "part values must be non-negative", "sourceBundle.records");
  if (manifest.id === "distribution" && entries.some((entry) => entry.roles.weight !== undefined && entry.roles.weight < 0)) fail("INVALID_DISTRIBUTION", "weights must be non-negative", "sourceBundle.records");
  if (["flow"].includes(manifest.id) && entries.some((entry) => entry.roles.value < 0)) fail("INVALID_FLOW", "flow values must be non-negative", "sourceBundle.records");
  if (manifest.id === "region-map") {
    for (const entry of entries) {
      if (!canonicalUsStateFips(entry.roles.region)) {
        fail(
          "UNKNOWN_GEOGRAPHIC_REGION",
          "region must resolve to us-atlas/states-10m using a US Census two-digit state or territory FIPS id",
          `records.${entry.record.id}.region`,
        );
      }
    }
  }
  if (manifest.id === "timeline") {
    for (const entry of entries) {
      if (entry.roles.endTime !== undefined && comparableTime(entry.roles.endTime) < comparableTime(entry.roles.time)) fail("INVALID_INTERVAL", "endTime cannot precede time", `records.${entry.record.id}`);
    }
  }
  if (manifest.id === "profile") duplicateKey(entries, ["entity", "dimension"], manifest.id);
  if (manifest.id === "matrix") duplicateKey(entries, ["row", "column"], manifest.id);
  if (manifest.id === "hierarchy") {
    duplicateKey(entries, ["id"], manifest.id);
    validateHierarchy(entries);
  }
}

function baseItems(entries) {
  return entries.map((entry) => ({ markId: entry.mark.id, ...entry.roles }));
}

function buildPayload(manifest, entries) {
  const collection = manifest.transformation.payload.collection;
  const payload = {
    schemaVersion: manifest.transformation.payload.schemaVersion,
    kind: manifest.transformation.payload.kind,
    [collection]: baseItems(entries),
  };
  switch (manifest.id) {
    case "rank":
      payload.order = entries.map((entry) => entry.mark.id);
      payload.valueExtent = numericExtent(entries, "value");
      payload.groups = unique(entries.map((entry) => entry.roles.group));
      break;
    case "distribution":
      payload.valueExtent = numericExtent(entries, "value");
      payload.groups = unique(entries.map((entry) => entry.roles.group));
      break;
    case "composition": {
      const totals = new Map();
      for (const entry of entries) {
        const whole = String(entry.roles.whole ?? "all");
        totals.set(whole, (totals.get(whole) ?? 0) + entry.roles.value);
      }
      payload.totals = [...totals].sort(([left], [right]) => compareText(left, right)).map(([whole, value]) => ({ whole, value }));
      break;
    }
    case "profile":
      payload.entities = unique(entries.map((entry) => entry.roles.entity));
      payload.dimensions = unique(entries.map((entry) => entry.roles.dimension));
      payload.missingCellCount = payload.entities.length * payload.dimensions.length - entries.length;
      break;
    case "passage-comparison":
      payload.versions = unique(entries.map((entry) => entry.roles.version));
      payload.labels = unique(entries.map((entry) => entry.roles.label));
      break;
    case "trend":
      payload.timeExtent = timeExtent(entries);
      payload.valueExtent = numericExtent(entries, "value");
      payload.series = unique(entries.map((entry) => entry.roles.series ?? "all"));
      break;
    case "timeline":
      payload.timeExtent = timeExtent(entries);
      payload.lanes = unique(entries.map((entry) => entry.roles.lane));
      break;
    case "sequence":
      payload.stages = unique(entries.map((entry) => entry.roles.stage));
      break;
    case "relationship":
      payload.domains = { x: numericExtent(entries, "x"), y: numericExtent(entries, "y"), size: numericExtent(entries, "size") };
      payload.groups = unique(entries.map((entry) => entry.roles.group));
      break;
    case "matrix":
      payload.rows = unique(entries.map((entry) => entry.roles.row));
      payload.columns = unique(entries.map((entry) => entry.roles.column));
      payload.missingCellCount = payload.rows.length * payload.columns.length - entries.length;
      payload.valueExtent = numericExtent(entries, "value");
      break;
    case "hierarchy":
      payload.rootIds = entries.filter((entry) => entry.roles.parentId === undefined).map((entry) => String(entry.roles.id)).sort(compareText);
      payload.maximumDepth = (() => {
        const parent = new Map(entries.map((entry) => [String(entry.roles.id), entry.roles.parentId === undefined ? null : String(entry.roles.parentId)]));
        let maximum = 0;
        for (const id of parent.keys()) {
          let depth = 0;
          let cursor = parent.get(id);
          while (cursor !== null) { depth += 1; cursor = parent.get(cursor) ?? null; }
          maximum = Math.max(maximum, depth);
        }
        return maximum;
      })();
      break;
    case "network":
    case "mechanism":
      payload.nodes = unique(entries.flatMap((entry) => [entry.roles.source, entry.roles.target]));
      payload.relations = unique(entries.map((entry) => entry.roles.relation));
      break;
    case "flow":
      payload.nodes = unique(entries.flatMap((entry) => [entry.roles.source, entry.roles.target]));
      payload.totalFlow = entries.reduce((total, entry) => total + entry.roles.value, 0);
      payload.stages = unique(entries.map((entry) => entry.roles.stage));
      break;
    case "region-map":
      payload.regionIds = unique(entries.map((entry) => entry.roles.region));
      payload.valueExtent = numericExtent(entries, "value");
      break;
    case "point-map":
      payload.extent = {
        latitude: numericExtent(entries, "latitude"),
        longitude: numericExtent(entries, "longitude"),
        value: numericExtent(entries, "value"),
      };
      payload.groups = unique(entries.map((entry) => entry.roles.group));
      break;
    case "field":
      payload.domains = { x: numericExtent(entries, "x"), y: numericExtent(entries, "y"), value: numericExtent(entries, "value"), uncertainty: numericExtent(entries, "uncertainty") };
      break;
    case "collection-atlas":
      payload.domains = { x: numericExtent(entries, "x"), y: numericExtent(entries, "y") };
      payload.clusters = unique(entries.map((entry) => entry.roles.cluster));
      break;
    case "annotated-specimen":
      payload.specimenIds = unique(entries.map((entry) => entry.roles.specimen));
      payload.layers = unique(entries.map((entry) => entry.roles.layer));
      break;
    default:
      fail("UNSUPPORTED_TRANSFORM", `no deterministic transform is registered for ${manifest.id}`, "familyId");
  }
  return canonicalize(payload);
}

function validateQuestionInput(question, manifest) {
  const normalized = typeof question === "string" ? { text: question } : question;
  if (!isPlainObject(normalized)) fail("INVALID_QUESTION", "must be a string or object", "question");
  requiredString(normalized.text, "question.text", 4_000);
  if (normalized.target !== undefined && typeof normalized.target !== "string") fail("INVALID_QUESTION", "target must be a string", "question.target");
  return canonicalize({
    text: normalized.text.trim(),
    target: String(normalized.target ?? "").trim(),
    analyticJob: normalized.analyticJob ?? manifest.id,
  });
}

function validateCategoryOrder(value) {
  if (!isPlainObject(value)) fail("INVALID_OPTIONS", "must be an object mapping a role to its category order", "options.categoryOrder");
  for (const [role, categories] of Object.entries(value)) {
    const path = `options.categoryOrder.${role}`;
    if (!ROLE_NAME.test(role)) fail("INVALID_OPTIONS", "must be a role name", path);
    if (!Array.isArray(categories) || categories.length === 0) fail("INVALID_OPTIONS", "must be a non-empty array of category strings", path);
    const seen = new Set();
    categories.forEach((category, index) => {
      if (typeof category !== "string" || category.trim().length === 0) fail("INVALID_OPTIONS", "must be a non-empty string", `${path}[${index}]`);
      if (seen.has(category)) fail("INVALID_OPTIONS", `duplicate category ${category}`, `${path}[${index}]`);
      seen.add(category);
    });
  }
  return canonicalize(value);
}

function validateOptions(options, derivedVariant) {
  if (!isPlainObject(options)) fail("INVALID_OPTIONS", "must be an object", "options");
  const allowed = new Set(["availableWidth", "categoryOrder", "mediaType"]);
  for (const key of Object.keys(options)) {
    if (key === "variant") fail("CALLER_VARIANT_FORBIDDEN", "presentation.variant is derived from the exact catalog receipt", "options.variant");
    if (!allowed.has(key)) fail("INVALID_OPTIONS", `unknown option ${key}`, `options.${key}`);
  }
  const availableWidth = options.availableWidth ?? 1_200;
  if (typeof availableWidth !== "number" || !Number.isFinite(availableWidth) || availableWidth <= 0) fail("INVALID_OPTIONS", "availableWidth must be positive", "options.availableWidth");
  return {
    availableWidth,
    variant: derivedVariant,
    ...(options.categoryOrder === undefined ? {} : { categoryOrder: validateCategoryOrder(options.categoryOrder) }),
    ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
  };
}

function normalizedPatchEvidence(refs, evidenceRefIds, path) {
  if (!Array.isArray(refs) || refs.length === 0) fail("INVALID_ENRICHMENT", "inputEvidenceRefs must be non-empty", path);
  const uniqueRefs = [];
  const seen = new Set();
  refs.forEach((reference, index) => {
    if (!isOpaqueEvidenceReferenceId(reference) || !evidenceRefIds.has(reference)) {
      fail("INVALID_ENRICHMENT", "inputEvidenceRefs must name canonical opaque evidence ids", `${path}[${index}]`);
    }
    if (!seen.has(reference)) {
      seen.add(reference);
      uniqueRefs.push(reference);
    }
  });
  return uniqueRefs;
}

async function applyEnrichments(marks, enrichments, manifest, evidenceRefIds) {
  if (!Array.isArray(enrichments)) fail("INVALID_ENRICHMENT", "enrichments must be an array", "enrichments");
  if (enrichments.length > manifest.enrichment.maximumPatches) fail("ENRICHMENT_LIMIT", `at most ${manifest.enrichment.maximumPatches} patches are permitted`, "enrichments");
  const markById = new Map(marks.map((mark) => [mark.id, mark]));
  const receipts = [];
  const targets = new Set();
  for (let index = 0; index < enrichments.length; index += 1) {
    const patch = enrichments[index];
    const path = `enrichments[${index}]`;
    if (!isPlainObject(patch)) fail("INVALID_ENRICHMENT", "patch must be an object", path);
    safeId(patch.id, `${path}.id`);
    const mark = markById.get(patch.markId);
    if (!mark) fail("INVALID_ENRICHMENT", `unknown mark ${String(patch.markId)}`, `${path}.markId`);
    if (!manifest.enrichment.allowedFields.includes(patch.field)) fail("INVALID_ENRICHMENT", `field ${String(patch.field)} is not permitted`, `${path}.field`);
    if (patch.status !== manifest.enrichment.acceptedStatus || patch.validation?.status !== "accepted") fail("UNVALIDATED_ENRICHMENT", "only explicitly accepted patches may compile", path);
    requiredString(patch.value, `${path}.value`, patch.field === "summary" ? 4_000 : 1_000);
    safeId(patch.method?.id, `${path}.method.id`);
    if (!Number.isSafeInteger(patch.method?.version) || patch.method.version < 1) fail("INVALID_ENRICHMENT", "method version must be positive", `${path}.method.version`);
    requiredString(patch.validation?.rule, `${path}.validation.rule`, 1_000);
    const inputEvidenceRefs = normalizedPatchEvidence(patch.inputEvidenceRefs, evidenceRefIds, `${path}.inputEvidenceRefs`);
    const target = `${patch.markId}\u0000${patch.field}`;
    if (targets.has(target)) fail("DUPLICATE_ENRICHMENT", "only one patch may target a mark field", path);
    targets.add(target);
    if (patch.field === "label") mark.label = patch.value;
    else if (patch.field === "summary") mark.summary = patch.value;
    else {
      if (!mark.media?.preview) fail("INVALID_ENRICHMENT", "media.preview.alt requires an existing preview", path);
      mark.media.preview.alt = patch.value;
    }
    receipts.push(canonicalize({
      id: patch.id,
      markId: patch.markId,
      field: patch.field,
      status: patch.status,
      method: patch.method,
      inputEvidenceRefs,
      outputHash: await sha256Hex(patch.value),
      validation: patch.validation,
    }));
  }
  receipts.sort((left, right) => compareText(left.id, right.id));
  return receipts;
}

function presentationMediaType(marks, manifest, requested) {
  if (requested !== undefined) {
    const classified = classifyRepeatMedia(requested);
    if (!manifest.multiples.supportedMedia.includes(classified)) fail("UNSUPPORTED_REPEAT_MEDIA", `${manifest.id} does not support ${classified} repeat layout`, "options.mediaType");
    return classified;
  }
  const types = unique(marks.map((mark) => mark.media.type));
  if (types.length === 1 && manifest.multiples.supportedMedia.includes(types[0])) return types[0];
  if (types.length > 1 && manifest.multiples.supportedMedia.includes("3d-mixed")) return "3d-mixed";
  return manifest.multiples.defaultMedia;
}

/**
 * Compile a public v2 package alongside the private evidence linkage required
 * to stage its evidence store. The linkage is deliberately not part of the
 * returned package and must never be serialized with it.
 */
export async function compileMapWithEvidence({
  familyId,
  catalog,
  question,
  sourceBundle,
  roleMapping,
  options = {},
  enrichments = [],
} = {}) {
  const manifest = requireMapFamily(familyId);
  if (!catalog || catalog.family !== manifest.id || catalog.rendererId !== manifest.renderer.id || typeof catalog.member !== "string" || !catalog.member) {
    fail("INVALID_CATALOG", "catalog family/member/renderer receipt is required", "catalog");
  }
  let form;
  let expectedCatalog;
  try {
    form = requireExecutableForm(manifest.id, catalog.member);
    expectedCatalog = catalogReceiptForMember(manifest.id, catalog.member);
  } catch (cause) {
    fail("INVALID_CATALOG", cause.message, "catalog");
  }
  if (catalog.version !== CATALOG_VERSION || canonicalJson(catalog) !== canonicalJson(expectedCatalog)) {
    fail("INVALID_CATALOG", "catalog receipt is stale, forged, or cross-wired", "catalog");
  }
  validateNormalizedSourceBundle(sourceBundle);
  const sourceEligibility = evaluateFormSourcePolicy(form, {
    adapter: sourceBundle.adapter,
    medium: sourceBundle.medium,
  });
  if (!sourceEligibility.eligible) {
    const failed = sourceEligibility.failedRequirements.map((requirement) => requirement.id).join(", ");
    const error = new PipelineContractError(
      "INELIGIBLE_REQUESTED_FORM",
      `${manifest.id}/${form.memberId} failed: ${failed}`,
      "sourceBundle",
    );
    error.familyId = manifest.id;
    error.memberId = form.memberId;
    error.failedRequirements = sourceEligibility.failedRequirements;
    throw error;
  }
  const mediaAdapter = manifest.mediaAdapters.find((adapter) => adapter.medium === sourceBundle.medium);
  if (mediaAdapter.decision === "abstain") fail("FAMILY_ABSTAINS", `${manifest.id} abstains from ${sourceBundle.medium} input: ${mediaAdapter.reason}`, "sourceBundle.medium");
  const mapping = validateRoleMapping(roleMapping, manifest, form);
  const normalizedQuestion = validateQuestionInput(question, manifest);
  const normalizedOptions = validateOptions(options, form.renderer.variant);
  const sourceIds = new Set(sourceBundle.sources.map((source) => source.id));
  const sourcesById = new Map(sourceBundle.sources.map((source) => [source.id, source]));
  const orderedRecords = [...sourceBundle.records].sort((left, right) => compareText(left.id, right.id));
  const entries = orderedRecords.map((record, index) => ({
    record,
    roles: projectRecord(record, mapping, form, index),
  })).sort(entryComparator(manifest, form, normalizedOptions.categoryOrder));
  const legacyForm = isLegacyExecutableForm(form);
  if (legacyForm) validateFamilyEntries(manifest, entries);

  const privateEvidenceRefsById = new Map();
  await Promise.all(entries.map(async (entry) => {
    const source = sourcesById.get(entry.record.sourceId);
    const privateEvidenceRefs = await normalizePrivateEvidenceRefs(entry.record, sourceIds);
    for (const reference of privateEvidenceRefs) {
      const existing = privateEvidenceRefsById.get(reference.id);
      if (existing && canonicalJson(existing) !== canonicalJson(reference)) {
        fail("EVIDENCE_ID_COLLISION", `opaque evidence id collision for ${reference.id}`, `record.${entry.record.id}.evidenceRefs`);
      }
      privateEvidenceRefsById.set(reference.id, reference);
    }
    entry.privateEvidenceRefs = privateEvidenceRefs;
    entry.mark = canonicalize({
      id: await stableId("mark", `${manifest.id}\u0000${entry.record.id}`),
      kind: manifest.id,
      label: markLabel(entry.roles, manifest, entry.record.id),
      summary: markSummary(entry.roles),
      values: entry.roles,
      evidenceRefs: privateEvidenceRefs.map((reference) => reference.id),
      media: normalizeMedia(entry.record, source, manifest),
    });
  }));

  const marks = entries.map((entry) => entry.mark);
  const observations = entries.map((entry) => canonicalize({
    id: entry.record.id,
    markId: entry.mark.id,
    sourceId: entry.record.sourceId,
    roles: entry.roles,
    evidenceRefs: entry.mark.evidenceRefs,
    media: entry.mark.media,
  }));
  const eligibility = evaluateFormEligibility(form, observations, {
    adapter: sourceBundle.adapter,
    medium: sourceBundle.medium,
  });
  if (!eligibility.eligible) {
    const failed = eligibility.failedRequirements.map((requirement) => requirement.id).join(", ");
    const error = new PipelineContractError(
      "INELIGIBLE_REQUESTED_FORM",
      `${manifest.id}/${form.memberId} failed: ${failed}`,
      "sourceBundle.records",
    );
    error.familyId = manifest.id;
    error.memberId = form.memberId;
    error.failedRequirements = eligibility.failedRequirements;
    throw error;
  }
  const privateEvidenceRefs = [...privateEvidenceRefsById.values()]
    .sort((left, right) => compareText(left.id, right.id));
  const enrichmentReceipts = await applyEnrichments(
    marks,
    enrichments,
    manifest,
    new Set(privateEvidenceRefs.map((reference) => reference.id)),
  );
  const payload = await projectFormPayload(form, observations);
  const repeatMedia = presentationMediaType(marks, manifest, normalizedOptions.mediaType);
  const multiples = multiplesPolicy({
    mediaType: repeatMedia,
    count: marks.length,
    availableWidth: normalizedOptions.availableWidth,
  });
  const publicSources = sourceBundle.sources
    .map(publicSource)
    .sort((left, right) => compareText(left.displayPath, right.displayPath) || compareText(left.id, right.id));
  const omissions = canonicalize(sourceBundle.knownOmissions ?? []);
  const recordsHash = await sha256Hex(canonicalJson(orderedRecords));
  const optionsHash = await sha256Hex(canonicalJson(normalizedOptions));
  const evidenceRefCount = marks.reduce((total, mark) => total + mark.evidenceRefs.length, 0);
  const previewCount = marks.filter((mark) => mark.media.preview).length;
  const mediaCounts = {};
  for (const mark of marks) mediaCounts[mark.media.type] = (mediaCounts[mark.media.type] ?? 0) + 1;
  const validationReceipts = [
    { id: "source-bundle", status: "pass", checked: sourceBundle.sources.length + sourceBundle.records.length },
    { id: "form-roles", status: "pass", checked: entries.length },
    { id: "mark-evidence", status: "pass", checked: evidenceRefCount },
    { id: "form-payload", status: "pass", checked: marks.length },
  ];
  const provenance = canonicalize({
    pipeline: { id: PIPELINE_ID, version: PIPELINE_VERSION },
    inputs: {
      adapter: sourceBundle.adapter,
      medium: sourceBundle.medium,
      mediaAdapterDecision: mediaAdapter.decision,
      recordsHash,
      recordCount: sourceBundle.records.length,
      sourceIds: publicSources.map((source) => source.id),
    },
    transformations: [{
      id: form.projector.id,
      version: form.projector.version,
      deterministic: true,
      roleMapping: mapping,
      optionsHash,
      outputMarkCount: marks.length,
    }],
    enrichments: enrichmentReceipts,
    validations: validationReceipts,
  });
  const quality = canonicalize({
    status: "valid",
    coverage: {
      sourceCount: publicSources.length,
      recordsTotal: sourceBundle.records.length,
      recordsCompiled: marks.length,
      markCount: marks.length,
      evidenceRefCount,
    },
    knownOmissions: omissions,
    warnings: [],
    media: {
      types: mediaCounts,
      previewCount,
      missingPreviewCount: marks.length - previewCount,
      inputMedium: sourceBundle.medium,
      adapterDecision: mediaAdapter.decision,
    },
  });
  const presentation = canonicalize({
    renderer: { id: manifest.renderer.id, version: manifest.renderer.version },
    variant: form.renderer.variant,
    grammarVersion: manifest.grammar.version,
    multiples,
    ...(manifest.renderer.geography ? { geography: GEOGRAPHY_RENDERER_POLICY } : {}),
  });
  const dataPackage = await createDataPackage({
    family: manifest,
    catalog,
    question: normalizedQuestion,
    scope: canonicalize({
      adapter: sourceBundle.adapter,
      inputMedium: sourceBundle.medium,
      mediaAdapterDecision: mediaAdapter.decision,
      requestedInputs: sourceBundle.requestedInputs ?? [],
      recordCount: sourceBundle.records.length,
      knownOmissions: omissions,
    }),
    sources: publicSources,
    roleMapping: mapping,
    marks,
    payload,
    presentation,
    provenance,
    quality,
    execution: {
      modelCalls: enrichmentReceipts.filter((receipt) => receipt.method?.kind === "model").length,
      networkCalls: 0,
    },
  });
  return { dataPackage, evidenceReferences: privateEvidenceRefs };
}

/** Public package-only compatibility entry point used by render-only callers. */
export async function compileMap(input = {}) {
  return (await compileMapWithEvidence(input)).dataPackage;
}

export const compileMapPackage = compileMap;
