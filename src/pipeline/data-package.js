import {
  REPEAT_LAYOUT_PROFILES,
  getMapFamily,
  requireMapFamily,
} from "../map-families/registry.js";

export const DATA_PACKAGE_SCHEMA_VERSION = 2;
export const DATA_PACKAGE_KIND = "attend-data-package";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z][a-z0-9_-]{1,127}$/u;
const FORBIDDEN_SOURCE_CONTENT_FIELDS = new Set([
  "body",
  "bytes",
  "content",
  "contents",
  "raw",
  "text",
]);

export class DataPackageContractError extends TypeError {
  constructor(code, message, path = "dataPackage") {
    super(`${path}: ${message}`);
    this.name = "DataPackageContractError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path) {
  throw new DataPackageContractError(code, message, path);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJson(value, path = "value", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NON_JSON_VALUE", "numbers must be finite", path);
    return;
  }
  if (typeof value !== "object") fail("NON_JSON_VALUE", `unsupported ${typeof value} value`, path);
  if (ancestors.has(value)) fail("NON_JSON_VALUE", "cyclic values are not supported", path);
  if (!Array.isArray(value) && !isPlainObject(value)) fail("NON_JSON_VALUE", "objects must have a plain prototype", path);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`, ancestors));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) fail("NON_JSON_VALUE", "undefined values are not supported", `${path}.${key}`);
      assertJson(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalize(value) {
  assertJson(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail("CRYPTO_UNAVAILABLE", "Web Crypto SHA-256 is unavailable", "crypto.subtle");
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? value
      : new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stableId(prefix, value, length = 16) {
  if (!/^[a-z][a-z0-9_]{0,31}$/u.test(prefix ?? "")) fail("INVALID_ID_PREFIX", "prefix must be a safe identifier", "prefix");
  if (!Number.isSafeInteger(length) || length < 8 || length > 64) fail("INVALID_ID_LENGTH", "length must be between 8 and 64", "length");
  return `${prefix}_${(await sha256Hex(typeof value === "string" ? value : canonicalJson(value))).slice(0, length)}`;
}

function requiredString(value, path, maximum = 16_384) {
  if (typeof value !== "string" || value.trim().length === 0) fail("INVALID_STRING", "must be a non-empty string", path);
  if (value.length > maximum) fail("STRING_TOO_LONG", `must contain at most ${maximum} characters`, path);
  return value;
}

function safeIdentifier(value, path) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("INVALID_IDENTIFIER", "must be a safe stable identifier", path);
  return value;
}

function safeDisplayPath(value, path) {
  requiredString(value, path, 2_048);
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    fail("UNSAFE_DISPLAY_PATH", "must be relative and cannot traverse a parent directory", path);
  }
  return value;
}

function validateQuestion(question, path) {
  if (!isPlainObject(question)) fail("INVALID_QUESTION", "must be an object", path);
  requiredString(question.text, `${path}.text`, 4_000);
  if (question.target !== undefined && typeof question.target !== "string") fail("INVALID_QUESTION", "target must be a string", `${path}.target`);
  requiredString(question.analyticJob, `${path}.analyticJob`, 128);
}

function validateScope(scope, path) {
  if (!isPlainObject(scope)) fail("INVALID_SCOPE", "must be an object", path);
  safeIdentifier(scope.adapter?.id, `${path}.adapter.id`);
  if (!Number.isSafeInteger(scope.adapter?.version) || scope.adapter.version < 1) fail("INVALID_SCOPE", "adapter version must be a positive integer", `${path}.adapter.version`);
  if (!Array.isArray(scope.requestedInputs) || scope.requestedInputs.some((value) => typeof value !== "string" || value.length > 2_048)) fail("INVALID_SCOPE", "requestedInputs must be bounded strings", `${path}.requestedInputs`);
  if (!Number.isSafeInteger(scope.recordCount) || scope.recordCount < 0) fail("INVALID_SCOPE", "recordCount must be a non-negative integer", `${path}.recordCount`);
  if (!Array.isArray(scope.knownOmissions)) fail("INVALID_SCOPE", "knownOmissions must be an array", `${path}.knownOmissions`);
}

function validateSources(sources, path) {
  if (!Array.isArray(sources) || sources.length === 0) fail("INVALID_SOURCES", "must be a non-empty array", path);
  const ids = new Set();
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(source)) fail("INVALID_SOURCE", "must be an object", itemPath);
    safeIdentifier(source.id, `${itemPath}.id`);
    if (ids.has(source.id)) fail("DUPLICATE_SOURCE", `duplicate source id ${source.id}`, `${itemPath}.id`);
    ids.add(source.id);
    safeDisplayPath(source.displayPath, `${itemPath}.displayPath`);
    if (!SHA256.test(source.sha256 ?? "")) fail("INVALID_SOURCE_HASH", "sha256 must be a lowercase SHA-256 digest", `${itemPath}.sha256`);
    requiredString(source.kind, `${itemPath}.kind`, 128);
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) fail("INVALID_SOURCE", "byteLength must be a non-negative integer", `${itemPath}.byteLength`);
    for (const key of Object.keys(source)) {
      if (FORBIDDEN_SOURCE_CONTENT_FIELDS.has(key)) fail("PUBLIC_SOURCE_CONTENT", `${key} cannot appear in a public data package`, `${itemPath}.${key}`);
    }
  }
  return ids;
}

function validatePreview(preview, path) {
  if (!isPlainObject(preview)) fail("INVALID_PREVIEW", "must be an object", path);
  requiredString(preview.kind, `${path}.kind`, 64);
  for (const field of ["src", "poster", "text", "alt", "label"]) {
    if (preview[field] !== undefined && (typeof preview[field] !== "string" || preview[field].length > 16_384)) fail("INVALID_PREVIEW", `${field} must be a bounded string`, `${path}.${field}`);
  }
  if (new TextEncoder().encode(canonicalJson(preview)).byteLength > 32_768) fail("INVALID_PREVIEW", "serialized preview exceeds 32 KiB", path);
}

function validateMedia(media, path) {
  if (!isPlainObject(media)) fail("INVALID_MEDIA", "must be an object", path);
  if (!Object.hasOwn(REPEAT_LAYOUT_PROFILES, media.type)) fail("INVALID_MEDIA", "type must be a canonical repeat-layout profile", `${path}.type`);
  if (media.mimeType !== undefined) requiredString(media.mimeType, `${path}.mimeType`, 256);
  if (media.preview !== undefined) validatePreview(media.preview, `${path}.preview`);
  for (const field of ["width", "height", "durationSeconds"]) {
    if (media[field] !== undefined && (typeof media[field] !== "number" || !Number.isFinite(media[field]) || media[field] < 0)) fail("INVALID_MEDIA", `${field} must be a non-negative finite number`, `${path}.${field}`);
  }
}

function validateEvidenceRef(reference, sourceIds, path) {
  if (!isPlainObject(reference)) fail("INVALID_EVIDENCE_REF", "must be an object", path);
  if (!sourceIds.has(reference.sourceId)) fail("DANGLING_EVIDENCE_REF", `unknown source ${String(reference.sourceId)}`, `${path}.sourceId`);
  if (reference.recordId !== undefined) safeIdentifier(reference.recordId, `${path}.recordId`);
  if (!isPlainObject(reference.locator) || Object.keys(reference.locator).length === 0) fail("INVALID_EVIDENCE_REF", "locator must be a non-empty object", `${path}.locator`);
  assertJson(reference.locator, `${path}.locator`);
  if (reference.excerpt !== undefined && (typeof reference.excerpt !== "string" || reference.excerpt.length > 1_000)) fail("INVALID_EVIDENCE_REF", "excerpt must be a string of at most 1000 characters", `${path}.excerpt`);
}

function validateMarks(marks, sourceIds, path) {
  if (!Array.isArray(marks)) fail("INVALID_MARKS", "must be an array", path);
  const ids = new Set();
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(mark)) fail("INVALID_MARK", "must be an object", itemPath);
    safeIdentifier(mark.id, `${itemPath}.id`);
    if (ids.has(mark.id)) fail("DUPLICATE_MARK", `duplicate mark id ${mark.id}`, `${itemPath}.id`);
    ids.add(mark.id);
    requiredString(mark.kind, `${itemPath}.kind`, 128);
    requiredString(mark.label, `${itemPath}.label`, 1_000);
    if (typeof mark.summary !== "string" || mark.summary.length > 4_000) fail("INVALID_MARK", "summary must be a bounded string", `${itemPath}.summary`);
    safeIdentifier(mark.recordId, `${itemPath}.recordId`);
    if (!isPlainObject(mark.values)) fail("INVALID_MARK", "values must be an object", `${itemPath}.values`);
    assertJson(mark.values, `${itemPath}.values`);
    if (!Array.isArray(mark.evidenceRefs) || mark.evidenceRefs.length === 0) fail("INVALID_MARK", "at least one evidence reference is required", `${itemPath}.evidenceRefs`);
    mark.evidenceRefs.forEach((reference, refIndex) => validateEvidenceRef(reference, sourceIds, `${itemPath}.evidenceRefs[${refIndex}]`));
    if (mark.media !== undefined) validateMedia(mark.media, `${itemPath}.media`);
  }
  return ids;
}

function validatePayload(payload, manifest, markIds, path) {
  if (!isPlainObject(payload) || payload.schemaVersion !== manifest.transformation.payload.schemaVersion || payload.kind !== manifest.transformation.payload.kind) fail("INVALID_PAYLOAD", "kind or schemaVersion does not match the family manifest", path);
  const collection = manifest.transformation.payload.collection;
  if (!Array.isArray(payload[collection])) fail("INVALID_PAYLOAD", `must contain array ${collection}`, `${path}.${collection}`);
  const referenced = new Set();
  for (let index = 0; index < payload[collection].length; index += 1) {
    const item = payload[collection][index];
    if (!isPlainObject(item) || !markIds.has(item.markId)) fail("DANGLING_PAYLOAD_MARK", "payload item references an unknown mark", `${path}.${collection}[${index}].markId`);
    if (referenced.has(item.markId)) fail("DUPLICATE_PAYLOAD_MARK", `mark ${item.markId} appears more than once`, `${path}.${collection}[${index}].markId`);
    referenced.add(item.markId);
  }
  if (referenced.size !== markIds.size) fail("INCOMPLETE_PAYLOAD_MARKS", "payload must reference every mark exactly once", path);
  assertJson(payload, path);
}

function validateRoleMapping(mapping, manifest, path) {
  if (!isPlainObject(mapping)) fail("INVALID_ROLE_MAPPING", "must be an object", path);
  const allowed = new Set([
    ...manifest.data.requiredRoles.map((role) => role.id),
    ...manifest.data.optionalRoles.map((role) => role.id),
  ]);
  for (const role of manifest.data.requiredRoles) requiredString(mapping[role.id], `${path}.${role.id}`, 256);
  for (const [key, value] of Object.entries(mapping)) {
    if (!allowed.has(key)) fail("INVALID_ROLE_MAPPING", `unknown role ${key}`, `${path}.${key}`);
    requiredString(value, `${path}.${key}`, 256);
  }
}

function validateProvenance(provenance, manifest, path) {
  if (!isPlainObject(provenance)) fail("INVALID_PROVENANCE", "must be an object", path);
  safeIdentifier(provenance.pipeline?.id, `${path}.pipeline.id`);
  if (!Number.isSafeInteger(provenance.pipeline?.version) || provenance.pipeline.version < 1) fail("INVALID_PROVENANCE", "pipeline version must be positive", `${path}.pipeline.version`);
  if (!isPlainObject(provenance.inputs) || !SHA256.test(provenance.inputs.recordsHash ?? "")) fail("INVALID_PROVENANCE", "inputs.recordsHash is required", `${path}.inputs.recordsHash`);
  if (!Array.isArray(provenance.transformations) || provenance.transformations.length === 0 || provenance.transformations[0]?.id !== manifest.transformation.id) fail("INVALID_PROVENANCE", "family transformation receipt is missing", `${path}.transformations`);
  if (!Array.isArray(provenance.enrichments) || provenance.enrichments.length > manifest.enrichment.maximumPatches) fail("INVALID_PROVENANCE", "enrichments exceed the family bound", `${path}.enrichments`);
  if (!Array.isArray(provenance.validations) || provenance.validations.length === 0) fail("INVALID_PROVENANCE", "validation receipts are required", `${path}.validations`);
}

function validateQuality(quality, sources, marks, path) {
  if (!isPlainObject(quality) || quality.status !== "valid") fail("INVALID_QUALITY", "status must be valid", path);
  const coverage = quality.coverage;
  if (!isPlainObject(coverage)) fail("INVALID_QUALITY", "coverage is required", `${path}.coverage`);
  if (coverage.sourceCount !== sources.length || coverage.markCount !== marks.length || coverage.recordsCompiled !== marks.length || !Number.isSafeInteger(coverage.recordsTotal) || coverage.recordsTotal < coverage.recordsCompiled) fail("INVALID_QUALITY", "coverage counts do not match package contents", `${path}.coverage`);
  const evidenceCount = marks.reduce((total, mark) => total + mark.evidenceRefs.length, 0);
  if (coverage.evidenceRefCount !== evidenceCount) fail("INVALID_QUALITY", "evidenceRefCount does not match marks", `${path}.coverage.evidenceRefCount`);
  if (!Array.isArray(quality.knownOmissions) || !Array.isArray(quality.warnings) || !isPlainObject(quality.media)) fail("INVALID_QUALITY", "omissions, warnings, and media summary are required", path);
  const expectedMedia = {};
  for (const mark of marks) expectedMedia[mark.media?.type] = (expectedMedia[mark.media?.type] ?? 0) + 1;
  const previewCount = marks.filter((mark) => mark.media?.preview).length;
  if (canonicalJson(quality.media.types) !== canonicalJson(expectedMedia) || quality.media.previewCount !== previewCount || quality.media.missingPreviewCount !== marks.length - previewCount) fail("INVALID_QUALITY", "media summary does not match marks", `${path}.media`);
}

function validateHashes(hashes, path) {
  if (!isPlainObject(hashes) || hashes.algorithm !== "sha256") fail("INVALID_HASHES", "algorithm must be sha256", path);
  for (const field of ["corpus", "config", "data", "package"]) {
    if (!SHA256.test(hashes[field] ?? "")) fail("INVALID_HASHES", `${field} must be a SHA-256 digest`, `${path}.${field}`);
  }
}

export function validateDataPackage(dataPackage) {
  if (!isPlainObject(dataPackage)) fail("INVALID_DATA_PACKAGE", "must be an object", "dataPackage");
  assertJson(dataPackage, "dataPackage");
  if (dataPackage.schemaVersion !== DATA_PACKAGE_SCHEMA_VERSION || dataPackage.kind !== DATA_PACKAGE_KIND) fail("INVALID_DATA_PACKAGE", "kind or schemaVersion is unsupported", "dataPackage");
  if (!/^data_[a-f0-9]{16}$/u.test(dataPackage.id ?? "")) fail("INVALID_DATA_PACKAGE_ID", "id must be derived from the package hash", "dataPackage.id");
  const manifest = getMapFamily(dataPackage.family?.id);
  if (!manifest || dataPackage.family.version !== manifest.version || dataPackage.family.group !== manifest.group || dataPackage.family.dataSchemaVersion !== manifest.transformation.payload.schemaVersion) fail("INVALID_FAMILY", "family identity does not match the registry", "dataPackage.family");
  validateQuestion(dataPackage.question, "dataPackage.question");
  validateScope(dataPackage.scope, "dataPackage.scope");
  const sourceIds = validateSources(dataPackage.sources, "dataPackage.sources");
  validateRoleMapping(dataPackage.roleMapping, manifest, "dataPackage.roleMapping");
  const markIds = validateMarks(dataPackage.marks, sourceIds, "dataPackage.marks");
  if (dataPackage.marks.length < manifest.data.minimumRecords || dataPackage.marks.length > manifest.data.maximumRecords) fail("INVALID_MARK_COUNT", "mark count violates family bounds", "dataPackage.marks");
  validatePayload(dataPackage.payload, manifest, markIds, "dataPackage.payload");
  if (!isPlainObject(dataPackage.presentation) || dataPackage.presentation.renderer?.id !== manifest.renderer.id || dataPackage.presentation.renderer?.version !== manifest.renderer.version || dataPackage.presentation.variant === undefined || !manifest.variants.some((variant) => variant.id === dataPackage.presentation.variant) || dataPackage.presentation.multiples?.policy?.id !== manifest.multiples.policy.id || !manifest.multiples.supportedMedia.includes(dataPackage.presentation.multiples?.profile) || dataPackage.presentation.multiples?.adaptationDecision !== REPEAT_LAYOUT_PROFILES[dataPackage.presentation.multiples?.profile]?.adaptationDecision) fail("INVALID_PRESENTATION", "presentation does not match the fixed family contract", "dataPackage.presentation");
  validateProvenance(dataPackage.provenance, manifest, "dataPackage.provenance");
  validateQuality(dataPackage.quality, dataPackage.sources, dataPackage.marks, "dataPackage.quality");
  if (!isPlainObject(dataPackage.execution) || !Number.isSafeInteger(dataPackage.execution.modelCalls) || dataPackage.execution.modelCalls < 0 || !Number.isSafeInteger(dataPackage.execution.networkCalls) || dataPackage.execution.networkCalls < 0) fail("INVALID_EXECUTION", "modelCalls and networkCalls must be non-negative integers", "dataPackage.execution");
  validateHashes(dataPackage.hashes, "dataPackage.hashes");
  if (dataPackage.id !== `data_${dataPackage.hashes.package.slice(0, 16)}`) fail("INVALID_DATA_PACKAGE_ID", "id does not match package hash", "dataPackage.id");
  return dataPackage;
}

function hashSections(base) {
  return {
    corpus: { scope: base.scope, sources: base.sources, inputs: base.provenance.inputs },
    config: {
      family: base.family,
      question: base.question,
      roleMapping: base.roleMapping,
      presentation: base.presentation,
      pipeline: base.provenance.pipeline,
      transformations: base.provenance.transformations,
    },
    data: { marks: base.marks, payload: base.payload },
  };
}

async function calculateHashes(base) {
  const sections = hashSections(base);
  const hashes = {
    algorithm: "sha256",
    corpus: await sha256Hex(canonicalJson(sections.corpus)),
    config: await sha256Hex(canonicalJson(sections.config)),
    data: await sha256Hex(canonicalJson(sections.data)),
  };
  hashes.package = await sha256Hex(canonicalJson({ ...base, hashes }));
  return hashes;
}

export async function createDataPackage({
  family,
  question,
  scope,
  sources,
  roleMapping,
  marks,
  payload,
  presentation,
  provenance,
  quality,
  execution = { modelCalls: 0, networkCalls: 0 },
} = {}) {
  const manifest = typeof family === "string" ? requireMapFamily(family) : requireMapFamily(family?.id);
  const base = canonicalize({
    schemaVersion: DATA_PACKAGE_SCHEMA_VERSION,
    kind: DATA_PACKAGE_KIND,
    family: {
      id: manifest.id,
      version: manifest.version,
      group: manifest.group,
      dataSchemaVersion: manifest.transformation.payload.schemaVersion,
    },
    question,
    scope,
    sources,
    roleMapping,
    marks,
    payload,
    presentation,
    provenance,
    quality,
    execution,
  });
  const hashes = await calculateHashes(base);
  const dataPackage = canonicalize({
    ...base,
    id: `data_${hashes.package.slice(0, 16)}`,
    hashes,
  });
  return validateDataPackage(dataPackage);
}

export async function verifyDataPackageHashes(dataPackage) {
  validateDataPackage(dataPackage);
  const { id: _id, hashes: _hashes, ...base } = dataPackage;
  const calculated = await calculateHashes(base);
  for (const field of ["corpus", "config", "data", "package"]) {
    if (calculated[field] !== dataPackage.hashes[field]) fail("HASH_MISMATCH", `${field} hash does not match package contents`, `dataPackage.hashes.${field}`);
  }
  if (dataPackage.id !== `data_${calculated.package.slice(0, 16)}`) fail("HASH_MISMATCH", "id does not match the verified package hash", "dataPackage.id");
  return true;
}
