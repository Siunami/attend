import {
  CANONICAL_INPUT_MEDIA,
  REPEAT_LAYOUT_PROFILES,
  getMapFamily,
  requireMapFamily,
} from "../map-families/registry.js";
import {
  canonicalObservationsFromPackage,
  evaluateFormEligibility,
  evaluateFormSourcePolicy,
  getExecutableForm,
  projectFormPayload,
} from "../forms/index.js";
import {
  CATALOG_VERSION,
  resolveCatalogReceipt,
} from "../catalog/index.js";
import { historicalPackageContractForMember } from "./historical-package-contracts.js";

export const DATA_PACKAGE_SCHEMA_VERSION = 2;
export const DATA_PACKAGE_KIND = "attend-data-package";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z][a-z0-9_-]{1,127}$/u;
const OPAQUE_EVIDENCE_REF = /^evidence_[a-f0-9]{16}$/u;
const CONTACT_ASSET_ID = /^asset_[a-f0-9]{32}$/u;
const CONTACT_CAPTURE_TIME_DISCLOSURE_FIELDS = new Set([
  "basis",
  "tieBreak",
  "tieStatement",
  "tiedItemCount",
  "tiedTimestampGroupCount",
  "timezoneStatement",
  "timezoneStatus",
  "unknownTimezoneCount",
]);
const DATA_PACKAGE_FIELDS = new Set([
  "catalog",
  "execution",
  "family",
  "hashes",
  "id",
  "kind",
  "marks",
  "payload",
  "presentation",
  "provenance",
  "quality",
  "question",
  "roleMapping",
  "schemaVersion",
  "scope",
  "sources",
]);
const SOURCE_FIELDS = new Set([
  "byteLength",
  "date",
  "displayPath",
  "id",
  "kind",
  "mediaType",
  "mimeType",
  "permissionRef",
  "sha256",
  "textProjection",
  "title",
]);
const FAMILY_FIELDS = new Set(["dataSchemaVersion", "group", "id", "version"]);
const QUESTION_FIELDS = new Set(["analyticJob", "target", "text"]);
const SCOPE_FIELDS = new Set([
  "adapter",
  "inputMedium",
  "knownOmissions",
  "mediaAdapterDecision",
  "recordCount",
  "requestedInputs",
]);
const ADAPTER_FIELDS = new Set(["id", "version"]);
const MARK_FIELDS = new Set(["evidenceRefs", "id", "kind", "label", "media", "summary", "values"]);
const MEDIA_FIELDS = new Set(["durationSeconds", "height", "mimeType", "preview", "type", "width"]);
const PREVIEW_FIELDS = new Set([
  "alt",
  "aspectRatio",
  "dominantColor",
  "durationSeconds",
  "kind",
  "label",
  "lineCount",
  "peaks",
  "poster",
  "posterFrameSeconds",
  "src",
]);
const PRESENTATION_FIELDS = new Set(["geography", "grammarVersion", "multiples", "renderer", "variant"]);
const RENDERER_FIELDS = new Set(["id", "version"]);
const MULTIPLES_FIELDS = new Set([
  "adaptationDecision",
  "availableWidth",
  "columns",
  "count",
  "fallback",
  "layout",
  "minimumReadableUnit",
  "policy",
  "profile",
  "quantityBand",
  "requestedMediaType",
  "rows",
  "selectionBehavior",
]);
const MINIMUM_READABLE_UNIT_FIELDS = new Set(["height", "unit", "width"]);
const POLICY_FIELDS = new Set(["id", "version"]);
const CATALOG_FIELDS = new Set([
  "family",
  "member",
  "rendererId",
  "rendererVariantId",
  "rendererVersion",
  "version",
]);
const PROVENANCE_FIELDS = new Set(["enrichments", "inputs", "pipeline", "transformations", "validations"]);
const PROVENANCE_INPUT_FIELDS = new Set([
  "adapter",
  "mediaAdapterDecision",
  "medium",
  "recordCount",
  "recordsHash",
  "sourceIds",
]);
const TRANSFORMATION_FIELDS = new Set([
  "deterministic",
  "id",
  "optionsHash",
  "outputMarkCount",
  "roleMapping",
  "version",
]);
const ENRICHMENT_FIELDS = new Set([
  "field",
  "id",
  "inputEvidenceRefs",
  "markId",
  "method",
  "outputHash",
  "status",
  "validation",
]);
const METHOD_FIELDS = new Set(["id", "kind", "version"]);
const ENRICHMENT_VALIDATION_FIELDS = new Set(["rule", "status"]);
const VALIDATION_RECEIPT_FIELDS = new Set(["checked", "id", "status"]);
const QUALITY_FIELDS = new Set(["coverage", "knownOmissions", "media", "status", "warnings"]);
const COVERAGE_FIELDS = new Set([
  "evidenceRefCount",
  "markCount",
  "recordsCompiled",
  "recordsTotal",
  "sourceCount",
]);
const QUALITY_MEDIA_FIELDS = new Set([
  "adapterDecision",
  "inputMedium",
  "missingPreviewCount",
  "previewCount",
  "types",
]);
const EXECUTION_FIELDS = new Set(["modelCalls", "networkCalls"]);
const HASH_FIELDS = new Set(["algorithm", "config", "corpus", "data", "package"]);
const PAYLOAD_EXTRA_FIELDS = Object.freeze({
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
  "annotated-specimen": ["layers", "specimenIds"],
  "collection-atlas": ["clusters", "domains"],
});
const PAYLOAD_DERIVED_ITEM_FIELDS = Object.freeze({
  "collection-atlas/faceted-atlas": ["x", "y"],
  "composition/part-list": ["share"],
  "hierarchy/icicle": ["depth", "leaf", "targetId", "total"],
  "hierarchy/outline": ["depth", "leaf", "path", "targetId", "total"],
  "hierarchy/treemap": ["depth", "leaf", "targetId", "total"],
  "sequence/state-ribbon": ["endShare", "share", "startShare"],
});
const VISUAL_TARGET_FIELDS = new Set([
  "count",
  "id",
  "includeUpper",
  "index",
  "item",
  "kind",
  "label",
  "lower",
  "membershipHash",
  "nodeId",
  "operator",
  "states",
  "threshold",
  "upper",
]);
const FORBIDDEN_SOURCE_CONTENT_FIELDS = new Set([
  "body",
  "bytes",
  "content",
  "contents",
  "recordId",
  "raw",
  "text",
]);
const PUBLIC_EVIDENCE_LINK_FIELDS = new Set([
  "sourceId",
  "recordId",
  "locator",
  "excerpt",
  "quote",
]);
const PRIVATE_PREVIEW_FIELDS = new Set([
  ...PUBLIC_EVIDENCE_LINK_FIELDS,
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

function currentPackageContract(form, manifest) {
  return {
    ...form,
    payload: {
      ...form.payload,
      itemFields: PAYLOAD_DERIVED_ITEM_FIELDS[form.key] ?? [],
    },
    family: {
      id: manifest.id,
      version: manifest.version,
      group: manifest.group,
      dataSchemaVersion: manifest.transformation.payload.schemaVersion,
      minimumMarks: manifest.data.minimumRecords,
      maximumMarks: manifest.data.maximumRecords,
      maximumEnrichments: manifest.enrichment.maximumPatches,
    },
    presentation: {
      renderer: form.renderer,
      multiples: {
        policy: manifest.multiples.policy,
        supportedProfiles: manifest.multiples.supportedMedia,
        adaptationDecisions: Object.fromEntries(manifest.multiples.supportedMedia.map((profile) => [
          profile,
          REPEAT_LAYOUT_PROFILES[profile]?.adaptationDecision,
        ])),
      },
      geography: manifest.renderer.geography ?? null,
    },
  };
}

function packageFormContract(familyId, memberId, catalogVersion, manifest) {
  if (catalogVersion === CATALOG_VERSION) {
    const form = getExecutableForm(familyId, memberId);
    if (!form) {
      fail(
        "INVALID_CATALOG",
        `catalog member ${String(familyId)}/${String(memberId)} has no executable form contract`,
        "dataPackage.catalog.member",
      );
    }
    return currentPackageContract(form, manifest);
  }
  try {
    return historicalPackageContractForMember(catalogVersion, familyId, memberId);
  } catch {
    fail(
      "INVALID_CATALOG",
      `catalog version ${String(catalogVersion)} has no frozen package contract for ${String(familyId)}/${String(memberId)}`,
      "dataPackage.catalog",
    );
  }
}

function rejectUnknownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("UNKNOWN_FIELD", `${key} is not part of the canonical data-package schema`, `${path}.${key}`);
  }
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

/** A public Atlas mark may name evidence, but can never describe it. */
export function isOpaqueEvidenceReferenceId(value) {
  return typeof value === "string" && OPAQUE_EVIDENCE_REF.test(value);
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
  rejectUnknownFields(question, QUESTION_FIELDS, path);
  requiredString(question.text, `${path}.text`, 4_000);
  if (question.target !== undefined && typeof question.target !== "string") fail("INVALID_QUESTION", "target must be a string", `${path}.target`);
  requiredString(question.analyticJob, `${path}.analyticJob`, 128);
}

function validateScope(scope, path) {
  if (!isPlainObject(scope)) fail("INVALID_SCOPE", "must be an object", path);
  rejectUnknownFields(scope, SCOPE_FIELDS, path);
  if (!isPlainObject(scope.adapter)) fail("INVALID_SCOPE", "adapter must be an object", `${path}.adapter`);
  rejectUnknownFields(scope.adapter, ADAPTER_FIELDS, `${path}.adapter`);
  safeIdentifier(scope.adapter?.id, `${path}.adapter.id`);
  if (!Number.isSafeInteger(scope.adapter?.version) || scope.adapter.version < 1) fail("INVALID_SCOPE", "adapter version must be a positive integer", `${path}.adapter.version`);
  if (!CANONICAL_INPUT_MEDIA.includes(scope.inputMedium)) fail("INVALID_SCOPE", "inputMedium must be canonical", `${path}.inputMedium`);
  requiredString(scope.mediaAdapterDecision, `${path}.mediaAdapterDecision`, 128);
  if (!Array.isArray(scope.requestedInputs)) fail("INVALID_SCOPE", "requestedInputs must be an array", `${path}.requestedInputs`);
  scope.requestedInputs.forEach((value, index) => safeDisplayPath(value, `${path}.requestedInputs[${index}]`));
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
    for (const key of Object.keys(source)) {
      if (FORBIDDEN_SOURCE_CONTENT_FIELDS.has(key)) fail("PUBLIC_SOURCE_CONTENT", `${key} cannot appear in a public data package`, `${itemPath}.${key}`);
    }
    rejectUnknownFields(source, SOURCE_FIELDS, itemPath);
    safeIdentifier(source.id, `${itemPath}.id`);
    if (ids.has(source.id)) fail("DUPLICATE_SOURCE", `duplicate source id ${source.id}`, `${itemPath}.id`);
    ids.add(source.id);
    safeDisplayPath(source.displayPath, `${itemPath}.displayPath`);
    if (!SHA256.test(source.sha256 ?? "")) fail("INVALID_SOURCE_HASH", "sha256 must be a lowercase SHA-256 digest", `${itemPath}.sha256`);
    requiredString(source.kind, `${itemPath}.kind`, 128);
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0) fail("INVALID_SOURCE", "byteLength must be a non-negative integer", `${itemPath}.byteLength`);
    if (source.textProjection !== undefined && !["utf8", "normalized-text"].includes(source.textProjection)) {
      fail("INVALID_SOURCE", "textProjection must be utf8 or normalized-text", `${itemPath}.textProjection`);
    }
  }
  return ids;
}

function assertNoPrivateFields(value, path, fields, code = "PUBLIC_EVIDENCE_LINK") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateFields(item, `${path}[${index}]`, fields, code));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (fields.has(key)) fail(code, `${key} cannot appear in a public Atlas mark`, itemPath);
    assertNoPrivateFields(item, itemPath, fields, code);
  }
}

function validatePreview(preview, path) {
  if (!isPlainObject(preview)) fail("INVALID_PREVIEW", "must be an object", path);
  assertNoPrivateFields(preview, path, PRIVATE_PREVIEW_FIELDS);
  rejectUnknownFields(preview, PREVIEW_FIELDS, path);
  requiredString(preview.kind, `${path}.kind`, 64);
  for (const field of ["src", "poster", "alt", "label", "dominantColor"]) {
    if (preview[field] !== undefined && (typeof preview[field] !== "string" || preview[field].length > 16_384)) fail("INVALID_PREVIEW", `${field} must be a bounded string`, `${path}.${field}`);
  }
  if (preview.aspectRatio !== undefined && (typeof preview.aspectRatio !== "number" || !Number.isFinite(preview.aspectRatio) || preview.aspectRatio <= 0)) fail("INVALID_PREVIEW", "aspectRatio must be a positive finite number", `${path}.aspectRatio`);
  for (const field of ["durationSeconds", "posterFrameSeconds"]) {
    if (preview[field] !== undefined && (typeof preview[field] !== "number" || !Number.isFinite(preview[field]) || preview[field] < 0)) fail("INVALID_PREVIEW", `${field} must be a non-negative finite number`, `${path}.${field}`);
  }
  if (preview.peaks !== undefined && (!Array.isArray(preview.peaks) || preview.peaks.length > 4_096 || preview.peaks.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1))) fail("INVALID_PREVIEW", "peaks must be at most 4,096 finite samples between -1 and 1", `${path}.peaks`);
  if (preview.lineCount !== undefined && (!Number.isSafeInteger(preview.lineCount) || preview.lineCount < 1)) fail("INVALID_PREVIEW", "lineCount must be a positive integer", `${path}.lineCount`);
  if (new TextEncoder().encode(canonicalJson(preview)).byteLength > 32_768) fail("INVALID_PREVIEW", "serialized preview exceeds 32 KiB", path);
}

function validateMedia(media, path) {
  if (!isPlainObject(media)) fail("INVALID_MEDIA", "must be an object", path);
  rejectUnknownFields(media, MEDIA_FIELDS, path);
  if (!Object.hasOwn(REPEAT_LAYOUT_PROFILES, media.type)) fail("INVALID_MEDIA", "type must be a canonical repeat-layout profile", `${path}.type`);
  if (media.mimeType !== undefined) requiredString(media.mimeType, `${path}.mimeType`, 256);
  if (media.preview !== undefined) validatePreview(media.preview, `${path}.preview`);
  for (const field of ["width", "height", "durationSeconds"]) {
    if (media[field] !== undefined && (typeof media[field] !== "number" || !Number.isFinite(media[field]) || media[field] < 0)) fail("INVALID_MEDIA", `${field} must be a non-negative finite number`, `${path}.${field}`);
  }
}

function validateContactAssetFields(value, path) {
  if (!CONTACT_ASSET_ID.test(value?.assetId ?? "")) {
    fail(
      "INVALID_CONTACT_ASSET",
      "assetId must be an opaque 32-hex staged asset id",
      `${path}.assetId`,
    );
  }
  const expectedRoute = `assets/${value.assetId}`;
  if (value.previewRoute !== expectedRoute) {
    fail(
      "INVALID_CONTACT_ASSET",
      "previewRoute must be the relative route derived from assetId",
      `${path}.previewRoute`,
    );
  }
  return expectedRoute;
}

function validateContactCaptureTimeDisclosure(value, itemCount, path) {
  if (!isPlainObject(value)) fail("INVALID_CONTACT_DISCLOSURE", "must be an object", path);
  rejectUnknownFields(value, CONTACT_CAPTURE_TIME_DISCLOSURE_FIELDS, path);
  if (value.basis !== "camera-local DateTimeOriginal") {
    fail("INVALID_CONTACT_DISCLOSURE", "basis must identify camera-local DateTimeOriginal", `${path}.basis`);
  }
  if (value.tieBreak !== "verified source order; normalized relative-path values are not published") {
    fail("INVALID_CONTACT_DISCLOSURE", "tieBreak must state the fixed private tie-break policy", `${path}.tieBreak`);
  }
  if (!["unknown", "partial", "declared"].includes(value.timezoneStatus)) {
    fail("INVALID_CONTACT_DISCLOSURE", "timezoneStatus must be unknown, partial, or declared", `${path}.timezoneStatus`);
  }
  for (const field of ["unknownTimezoneCount", "tiedTimestampGroupCount", "tiedItemCount"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0 || value[field] > itemCount) {
      fail("INVALID_CONTACT_DISCLOSURE", `${field} must be a bounded non-negative count`, `${path}.${field}`);
    }
  }
  if ((value.timezoneStatus === "unknown" && value.unknownTimezoneCount !== itemCount)
    || (value.timezoneStatus === "declared" && value.unknownTimezoneCount !== 0)
    || (value.timezoneStatus === "partial" && (value.unknownTimezoneCount === 0 || value.unknownTimezoneCount === itemCount))) {
    fail("INVALID_CONTACT_DISCLOSURE", "timezoneStatus does not match unknownTimezoneCount", `${path}.timezoneStatus`);
  }
  if ((value.tiedTimestampGroupCount === 0) !== (value.tiedItemCount === 0)
    || value.tiedTimestampGroupCount > Math.floor(value.tiedItemCount / 2)) {
    fail("INVALID_CONTACT_DISCLOSURE", "tie counts are inconsistent", `${path}.tiedTimestampGroupCount`);
  }
  requiredString(value.timezoneStatement, `${path}.timezoneStatement`, 512);
  requiredString(value.tieStatement, `${path}.tieStatement`, 512);
}

function roleValueMatches(value, type) {
  if (type === "string") return typeof value === "string" && value.trim().length > 0 && value.length <= 16_384;
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "time") {
    if (typeof value === "number") return Number.isFinite(value);
    return typeof value === "string" && value.trim().length > 0 && value.length <= 16_384 && Number.isFinite(Date.parse(value));
  }
  if (type === "identifier") {
    return (typeof value === "string" && value.trim().length > 0 && value.length <= 1_024)
      || (typeof value === "number" && Number.isFinite(value));
  }
  if (type === "latitude") return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
  if (type === "longitude") return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
  if (type === "ratio") return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (type === "media") return isPlainObject(value) || (typeof value === "string" && value.trim().length > 0 && value.length <= 16_384);
  return false;
}

function validateMarks(marks, manifest, form, path) {
  if (!Array.isArray(marks)) fail("INVALID_MARKS", "must be an array", path);
  const rolesById = new Map(
    [...form.roles.required, ...form.roles.optional]
      .map((role) => [role.id, role]),
  );
  const marksById = new Map();
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(mark)) fail("INVALID_MARK", "must be an object", itemPath);
    rejectUnknownFields(mark, MARK_FIELDS, itemPath);
    safeIdentifier(mark.id, `${itemPath}.id`);
    if (marksById.has(mark.id)) fail("DUPLICATE_MARK", `duplicate mark id ${mark.id}`, `${itemPath}.id`);
    marksById.set(mark.id, mark);
    requiredString(mark.kind, `${itemPath}.kind`, 128);
    requiredString(mark.label, `${itemPath}.label`, 1_000);
    if (typeof mark.summary !== "string" || mark.summary.length > 4_000) fail("INVALID_MARK", "summary must be a bounded string", `${itemPath}.summary`);
    if (!isPlainObject(mark.values)) fail("INVALID_MARK", "values must be an object", `${itemPath}.values`);
    rejectUnknownFields(mark.values, new Set([
      ...form.roles.required.map((role) => role.id),
      ...form.roles.optional.map((role) => role.id),
    ]), `${itemPath}.values`);
    for (const role of form.roles.required) {
      if (!Object.hasOwn(mark.values, role.id)) {
        fail(
          "MISSING_REQUIRED_ROLE_VALUE",
          `mark is missing required role ${role.id}`,
          `${itemPath}.values.${role.id}`,
        );
      }
    }
    for (const [roleId, value] of Object.entries(mark.values)) {
      const role = rolesById.get(roleId);
      if (!Array.isArray(role?.types)
        || role.types.length === 0
        || !role.types.some((type) => roleValueMatches(value, type))) {
        fail(
          "INVALID_ROLE_VALUE",
          `mark role ${roleId} does not match ${role?.types?.join(" or ") ?? "its frozen type"}`,
          `${itemPath}.values.${roleId}`,
        );
      }
    }
    assertJson(mark.values, `${itemPath}.values`);
    if (!Array.isArray(mark.evidenceRefs) || mark.evidenceRefs.length === 0) fail("INVALID_MARK", "at least one evidence reference is required", `${itemPath}.evidenceRefs`);
    const evidenceRefs = new Set();
    mark.evidenceRefs.forEach((reference, refIndex) => {
      if (!isOpaqueEvidenceReferenceId(reference)) {
        fail("INVALID_EVIDENCE_REF", "must be an opaque derived evidence reference id", `${itemPath}.evidenceRefs[${refIndex}]`);
      }
      if (evidenceRefs.has(reference)) {
        fail("DUPLICATE_EVIDENCE_REF", `duplicate evidence reference ${reference}`, `${itemPath}.evidenceRefs[${refIndex}]`);
      }
      evidenceRefs.add(reference);
    });
    if (mark.media !== undefined) validateMedia(mark.media, `${itemPath}.media`);
    if (form.key === "collection-atlas/contact-atlas") {
      const expectedRoute = validateContactAssetFields(mark.values, `${itemPath}.values`);
      if (mark.media?.preview?.src !== expectedRoute) {
        fail(
          "INVALID_CONTACT_ASSET",
          "media.preview.src must match the mark's staged asset route",
          `${itemPath}.media.preview.src`,
        );
      }
    }
    assertNoPrivateFields(mark, itemPath, PUBLIC_EVIDENCE_LINK_FIELDS);
  }
  return marksById;
}

function validatePayload(payload, manifest, form, marksById, path) {
  if (!isPlainObject(payload) || payload.schemaVersion !== form.payload.schemaVersion || payload.kind !== form.payload.kind) fail("INVALID_PAYLOAD", "kind or schemaVersion does not match the exact form receipt", path);
  assertNoPrivateFields(payload, path, PUBLIC_EVIDENCE_LINK_FIELDS);
  const collection = form.payload.collection;
  const payloadFields = form.payload.fields ?? [];
  rejectUnknownFields(payload, new Set(["kind", "schemaVersion", collection, ...payloadFields]), path);
  for (const field of payloadFields) {
    if (!Object.hasOwn(payload, field)) fail("INVALID_PAYLOAD", `exact form payload is missing ${field}`, `${path}.${field}`);
  }
  if (!Array.isArray(payload[collection])) fail("INVALID_PAYLOAD", `must contain array ${collection}`, `${path}.${collection}`);
  const declaredRoles = [...form.roles.required, ...form.roles.optional];
  const referenced = new Set();
  for (let index = 0; index < payload[collection].length; index += 1) {
    const item = payload[collection][index];
    if (!isPlainObject(item) || !marksById.has(item.markId)) fail("DANGLING_PAYLOAD_MARK", "payload item references an unknown mark", `${path}.${collection}[${index}].markId`);
    rejectUnknownFields(item, new Set([
      "markId",
      ...form.roles.required.map((role) => role.id),
      ...form.roles.optional.map((role) => role.id),
      ...(form.payload.itemFields ?? []),
    ]), `${path}.${collection}[${index}]`);
    const mark = marksById.get(item.markId);
    if (referenced.has(item.markId)) fail("DUPLICATE_PAYLOAD_MARK", `mark ${item.markId} appears more than once`, `${path}.${collection}[${index}].markId`);
    referenced.add(item.markId);
    if (form.key === "collection-atlas/contact-atlas") {
      validateContactAssetFields(item, `${path}.${collection}[${index}]`);
      const markValues = mark.values;
      if (item.assetId !== markValues.assetId || item.previewRoute !== markValues.previewRoute) {
        fail(
          "INVALID_CONTACT_ASSET",
          "payload asset identity must match its source-backed mark",
          `${path}.${collection}[${index}]`,
        );
      }
    }
    for (const role of declaredRoles) {
      const markHasRole = Object.hasOwn(mark.values, role.id);
      const payloadHasRole = Object.hasOwn(item, role.id);
      if (markHasRole !== payloadHasRole
        || (markHasRole && canonicalJson(item[role.id]) !== canonicalJson(mark.values[role.id]))) {
        fail(
          "PAYLOAD_ROLE_MISMATCH",
          `payload item does not exactly preserve mark role ${role.id}`,
          `${path}.${collection}[${index}].${role.id}`,
        );
      }
    }
  }
  if (referenced.size !== marksById.size) fail("INCOMPLETE_PAYLOAD_MARKS", "payload must reference every mark exactly once", path);
  if (form.key === "collection-atlas/contact-atlas") {
    validateContactCaptureTimeDisclosure(
      payload.captureTimeDisclosure,
      marksById.size,
      `${path}.captureTimeDisclosure`,
    );
  }
  if (payload.visualTargets !== undefined) {
    if (!Array.isArray(payload.visualTargets)) fail("INVALID_VISUAL_TARGET", "visualTargets must be an array", `${path}.visualTargets`);
    const targetIds = new Set();
    payload.visualTargets.forEach((target, index) => {
      const targetPath = `${path}.visualTargets[${index}]`;
      if (!isPlainObject(target)) fail("INVALID_VISUAL_TARGET", "must be an object", targetPath);
      rejectUnknownFields(target, VISUAL_TARGET_FIELDS, targetPath);
      if (!/^target_[a-f0-9]{16}$/u.test(target.id ?? "") || targetIds.has(target.id)) fail("INVALID_VISUAL_TARGET", "id must be a unique derived target id", `${targetPath}.id`);
      targetIds.add(target.id);
      requiredString(target.kind, `${targetPath}.kind`, 128);
      if (!form.selection.targetKinds.includes(target.kind)) {
        fail("INVALID_VISUAL_TARGET", `${target.kind} is not allowed for ${form.key}`, `${targetPath}.kind`);
      }
      requiredString(target.label, `${targetPath}.label`, 1_000);
      if (!Number.isSafeInteger(target.count) || target.count < 1 || target.count > 1_000_000) fail("INVALID_VISUAL_TARGET", "count must be a bounded positive membership count", `${targetPath}.count`);
      if (!SHA256.test(target.membershipHash ?? "")) fail("INVALID_VISUAL_TARGET", "membershipHash must be SHA-256", `${targetPath}.membershipHash`);
    });
    for (const field of ["bins", "steps", "segments", "levels", collection]) {
      if (!Array.isArray(payload[field])) continue;
      payload[field].forEach((item, index) => {
        if (item?.targetId !== undefined && !targetIds.has(item.targetId)) fail("INVALID_VISUAL_TARGET", `unknown targetId ${String(item.targetId)}`, `${path}.${field}[${index}].targetId`);
      });
    }
  }
  if (manifest.id === "composition" && Array.isArray(payload.totals)) {
    payload.totals.forEach((total, index) => {
      if (!isPlainObject(total)) fail("INVALID_PAYLOAD", "composition totals must be objects", `${path}.totals[${index}]`);
      rejectUnknownFields(total, new Set(["value", "whole"]), `${path}.totals[${index}]`);
    });
  }
  const boundedObjectFields = {
    relationship: { domains: ["size", "x", "y"] },
    "point-map": { extent: ["latitude", "longitude", "value"] },
    field: { domains: ["uncertainty", "value", "x", "y"] },
    "collection-atlas": { domains: ["x", "y"] },
  }[manifest.id];
  for (const [field, keys] of Object.entries(boundedObjectFields ?? {})) {
    if (payload[field] === undefined) continue;
    if (!isPlainObject(payload[field])) fail("INVALID_PAYLOAD", `${field} must be an object`, `${path}.${field}`);
    rejectUnknownFields(payload[field], new Set(keys), `${path}.${field}`);
  }
  assertJson(payload, path);
}

function validateRoleMapping(mapping, form, path) {
  if (!isPlainObject(mapping)) fail("INVALID_ROLE_MAPPING", "must be an object", path);
  const allowed = new Set([
    ...form.roles.required.map((role) => role.id),
    ...form.roles.optional.map((role) => role.id),
  ]);
  for (const role of form.roles.required) requiredString(mapping[role.id], `${path}.${role.id}`, 256);
  for (const [key, value] of Object.entries(mapping)) {
    if (!allowed.has(key)) fail("INVALID_ROLE_MAPPING", `unknown role ${key}`, `${path}.${key}`);
    requiredString(value, `${path}.${key}`, 256);
  }
}

function validateProvenance(provenance, form, {
  marks,
  roleMapping,
  scope,
  sources,
}, path) {
  if (!isPlainObject(provenance)) fail("INVALID_PROVENANCE", "must be an object", path);
  rejectUnknownFields(provenance, PROVENANCE_FIELDS, path);
  if (!isPlainObject(provenance.pipeline)) fail("INVALID_PROVENANCE", "pipeline must be an object", `${path}.pipeline`);
  rejectUnknownFields(provenance.pipeline, ADAPTER_FIELDS, `${path}.pipeline`);
  safeIdentifier(provenance.pipeline?.id, `${path}.pipeline.id`);
  if (!Number.isSafeInteger(provenance.pipeline?.version) || provenance.pipeline.version < 1) fail("INVALID_PROVENANCE", "pipeline version must be positive", `${path}.pipeline.version`);
  if (!isPlainObject(provenance.inputs) || !SHA256.test(provenance.inputs.recordsHash ?? "")) fail("INVALID_PROVENANCE", "inputs.recordsHash is required", `${path}.inputs.recordsHash`);
  rejectUnknownFields(provenance.inputs, PROVENANCE_INPUT_FIELDS, `${path}.inputs`);
  if (!isPlainObject(provenance.inputs.adapter)) fail("INVALID_PROVENANCE", "input adapter must be an object", `${path}.inputs.adapter`);
  rejectUnknownFields(provenance.inputs.adapter, ADAPTER_FIELDS, `${path}.inputs.adapter`);
  safeIdentifier(provenance.inputs.adapter.id, `${path}.inputs.adapter.id`);
  if (!Number.isSafeInteger(provenance.inputs.adapter.version) || provenance.inputs.adapter.version < 1) {
    fail("INVALID_PROVENANCE", "input adapter version must be positive", `${path}.inputs.adapter.version`);
  }
  if (canonicalJson(provenance.inputs.adapter) !== canonicalJson(scope.adapter)) {
    fail("INVALID_PROVENANCE", "input adapter must match the package scope", `${path}.inputs.adapter`);
  }
  if (provenance.inputs.medium !== scope.inputMedium) {
    fail("INVALID_PROVENANCE", "input medium must match the package scope", `${path}.inputs.medium`);
  }
  if (provenance.inputs.mediaAdapterDecision !== scope.mediaAdapterDecision) {
    fail("INVALID_PROVENANCE", "media adapter decision must match the package scope", `${path}.inputs.mediaAdapterDecision`);
  }
  if (provenance.inputs.recordCount !== scope.recordCount) {
    fail("INVALID_PROVENANCE", "input record count must match the package scope", `${path}.inputs.recordCount`);
  }
  const expectedSourceIds = sources.map((source) => source.id);
  if (canonicalJson(provenance.inputs.sourceIds) !== canonicalJson(expectedSourceIds)) {
    fail("INVALID_PROVENANCE", "input sourceIds must match the packaged sources", `${path}.inputs.sourceIds`);
  }
  if (!Array.isArray(provenance.transformations)
    || provenance.transformations.length !== 1
    || provenance.transformations[0]?.id !== form.projector.id
    || provenance.transformations[0]?.version !== form.projector.version) {
    fail("INVALID_PROVENANCE", "exact form transformation receipt is missing", `${path}.transformations`);
  }
  if (!Array.isArray(provenance.enrichments) || provenance.enrichments.length > form.family.maximumEnrichments) fail("INVALID_PROVENANCE", "enrichments exceed the family bound", `${path}.enrichments`);
  if (!Array.isArray(provenance.validations) || provenance.validations.length === 0) fail("INVALID_PROVENANCE", "validation receipts are required", `${path}.validations`);
  provenance.transformations.forEach((receipt, index) => {
    if (!isPlainObject(receipt)) fail("INVALID_PROVENANCE", "transformation receipt must be an object", `${path}.transformations[${index}]`);
    rejectUnknownFields(receipt, TRANSFORMATION_FIELDS, `${path}.transformations[${index}]`);
    validateRoleMapping(receipt.roleMapping, form, `${path}.transformations[${index}].roleMapping`);
    if (canonicalJson(receipt.roleMapping) !== canonicalJson(roleMapping)) {
      fail("INVALID_PROVENANCE", "transformation roleMapping must match the package roleMapping", `${path}.transformations[${index}].roleMapping`);
    }
    if (receipt.deterministic !== true) {
      fail("INVALID_PROVENANCE", "exact form transformation must be deterministic", `${path}.transformations[${index}].deterministic`);
    }
    if (!SHA256.test(receipt.optionsHash ?? "")) {
      fail("INVALID_PROVENANCE", "transformation optionsHash must be SHA-256", `${path}.transformations[${index}].optionsHash`);
    }
    if (receipt.outputMarkCount !== marks.length) {
      fail("INVALID_PROVENANCE", "transformation outputMarkCount must match marks", `${path}.transformations[${index}].outputMarkCount`);
    }
  });
  provenance.enrichments.forEach((receipt, index) => {
    const itemPath = `${path}.enrichments[${index}]`;
    if (!isPlainObject(receipt)) fail("INVALID_PROVENANCE", "enrichment receipt must be an object", itemPath);
    rejectUnknownFields(receipt, ENRICHMENT_FIELDS, itemPath);
    if (!isPlainObject(receipt.method)) fail("INVALID_PROVENANCE", "method must be an object", `${itemPath}.method`);
    rejectUnknownFields(receipt.method, METHOD_FIELDS, `${itemPath}.method`);
    if (!isPlainObject(receipt.validation)) fail("INVALID_PROVENANCE", "validation must be an object", `${itemPath}.validation`);
    rejectUnknownFields(receipt.validation, ENRICHMENT_VALIDATION_FIELDS, `${itemPath}.validation`);
  });
  provenance.validations.forEach((receipt, index) => {
    if (!isPlainObject(receipt)) fail("INVALID_PROVENANCE", "validation receipt must be an object", `${path}.validations[${index}]`);
    rejectUnknownFields(receipt, VALIDATION_RECEIPT_FIELDS, `${path}.validations[${index}]`);
  });
}

function validateQuality(quality, sources, marks, scope, path) {
  if (!isPlainObject(quality) || quality.status !== "valid") fail("INVALID_QUALITY", "status must be valid", path);
  rejectUnknownFields(quality, QUALITY_FIELDS, path);
  const coverage = quality.coverage;
  if (!isPlainObject(coverage)) fail("INVALID_QUALITY", "coverage is required", `${path}.coverage`);
  rejectUnknownFields(coverage, COVERAGE_FIELDS, `${path}.coverage`);
  if (coverage.sourceCount !== sources.length || coverage.markCount !== marks.length || coverage.recordsCompiled !== marks.length || coverage.recordsTotal !== scope.recordCount || coverage.recordsTotal < coverage.recordsCompiled) fail("INVALID_QUALITY", "coverage counts do not match package contents", `${path}.coverage`);
  const evidenceCount = marks.reduce((total, mark) => total + mark.evidenceRefs.length, 0);
  if (coverage.evidenceRefCount !== evidenceCount) fail("INVALID_QUALITY", "evidenceRefCount does not match marks", `${path}.coverage.evidenceRefCount`);
  if (!Array.isArray(quality.knownOmissions) || !Array.isArray(quality.warnings) || !isPlainObject(quality.media)) fail("INVALID_QUALITY", "omissions, warnings, and media summary are required", path);
  rejectUnknownFields(quality.media, QUALITY_MEDIA_FIELDS, `${path}.media`);
  const expectedMedia = {};
  for (const mark of marks) expectedMedia[mark.media?.type] = (expectedMedia[mark.media?.type] ?? 0) + 1;
  const previewCount = marks.filter((mark) => mark.media?.preview).length;
  if (canonicalJson(quality.media.types) !== canonicalJson(expectedMedia)
    || quality.media.previewCount !== previewCount
    || quality.media.missingPreviewCount !== marks.length - previewCount
    || quality.media.inputMedium !== scope.inputMedium
    || quality.media.adapterDecision !== scope.mediaAdapterDecision) {
    fail("INVALID_QUALITY", "media summary does not match marks or scope", `${path}.media`);
  }
  if (canonicalJson(quality.knownOmissions) !== canonicalJson(scope.knownOmissions)) {
    fail("INVALID_QUALITY", "known omissions must match the package scope", `${path}.knownOmissions`);
  }
}

function validateHashes(hashes, path) {
  if (!isPlainObject(hashes) || hashes.algorithm !== "sha256") fail("INVALID_HASHES", "algorithm must be sha256", path);
  rejectUnknownFields(hashes, HASH_FIELDS, path);
  for (const field of ["corpus", "config", "data", "package"]) {
    if (!SHA256.test(hashes[field] ?? "")) fail("INVALID_HASHES", `${field} must be a SHA-256 digest`, `${path}.${field}`);
  }
}

function validateCatalogReceipt(catalog, form, path) {
  if (!isPlainObject(catalog)) fail("INVALID_CATALOG", "catalog receipt is required", path);
  rejectUnknownFields(catalog, CATALOG_FIELDS, path);
  if (!requiredString(catalog.version, `${path}.version`, 64)) fail("INVALID_CATALOG", "catalog version is required", `${path}.version`);
  if (catalog.family !== form.family.id) fail("INVALID_CATALOG", "catalog family must match the package family", `${path}.family`);
  safeIdentifier(catalog.member, `${path}.member`);
  if (catalog.rendererId !== form.renderer.id) fail("INVALID_CATALOG", "catalog rendererId must match the exact form contract", `${path}.rendererId`);
  if (catalog.rendererVersion !== undefined && catalog.rendererVersion !== form.renderer.version) fail("INVALID_CATALOG", "catalog rendererVersion must match the exact form contract", `${path}.rendererVersion`);
  let expected;
  try {
    expected = resolveCatalogReceipt(catalog);
  } catch (cause) {
    fail("INVALID_CATALOG", cause.message, path);
  }
  if (canonicalJson(catalog) !== canonicalJson(expected)) fail("INVALID_CATALOG", "catalog receipt fields are cross-wired", path);
}

export function validateDataPackage(dataPackage) {
  if (!isPlainObject(dataPackage)) fail("INVALID_DATA_PACKAGE", "must be an object", "dataPackage");
  assertJson(dataPackage, "dataPackage");
  rejectUnknownFields(dataPackage, DATA_PACKAGE_FIELDS, "dataPackage");
  if (dataPackage.schemaVersion !== DATA_PACKAGE_SCHEMA_VERSION || dataPackage.kind !== DATA_PACKAGE_KIND) fail("INVALID_DATA_PACKAGE", "kind or schemaVersion is unsupported", "dataPackage");
  if (!/^data_[a-f0-9]{16}$/u.test(dataPackage.id ?? "")) fail("INVALID_DATA_PACKAGE_ID", "id must be derived from the package hash", "dataPackage.id");
  const manifest = getMapFamily(dataPackage.family?.id);
  if (!manifest) fail("INVALID_FAMILY", "family identity does not match the registry", "dataPackage.family");
  const form = packageFormContract(
    manifest.id,
    dataPackage.catalog?.member,
    dataPackage.catalog?.version,
    manifest,
  );
  if (dataPackage.family.id !== form.family.id
    || dataPackage.family.version !== form.family.version
    || dataPackage.family.group !== form.family.group
    || dataPackage.family.dataSchemaVersion !== form.family.dataSchemaVersion) {
    fail("INVALID_FAMILY", "family identity does not match the exact package contract", "dataPackage.family");
  }
  rejectUnknownFields(dataPackage.family, FAMILY_FIELDS, "dataPackage.family");
  validateQuestion(dataPackage.question, "dataPackage.question");
  validateScope(dataPackage.scope, "dataPackage.scope");
  validateSources(dataPackage.sources, "dataPackage.sources");
  validateRoleMapping(dataPackage.roleMapping, form, "dataPackage.roleMapping");
  const marksById = validateMarks(dataPackage.marks, manifest, form, "dataPackage.marks");
  if (dataPackage.catalog.version === CATALOG_VERSION) {
    const sourceEligibility = evaluateFormSourcePolicy(form, {
      adapter: dataPackage.scope.adapter,
      medium: dataPackage.scope.inputMedium,
    });
    if (!sourceEligibility.eligible) {
      fail(
        "INELIGIBLE_REQUESTED_FORM",
        `package fails ${sourceEligibility.failedRequirements.map((item) => item.id).join(", ")}`,
        "dataPackage.scope",
      );
    }
    const packageObservations = dataPackage.marks.map((mark) => ({ markId: mark.id, roles: mark.values, evidenceRefs: mark.evidenceRefs, media: mark.media }));
    const eligibility = evaluateFormEligibility(form, packageObservations, { adapter: dataPackage.scope.adapter, medium: dataPackage.scope.inputMedium });
    if (!eligibility.eligible) fail("INELIGIBLE_REQUESTED_FORM", `package fails ${eligibility.failedRequirements.map((item) => item.id).join(", ")}`, "dataPackage.marks");
  } else if (dataPackage.marks.length < form.family.minimumMarks || dataPackage.marks.length > form.family.maximumMarks) {
    fail("INVALID_MARK_COUNT", "historical mark count violates its frozen family bounds", "dataPackage.marks");
  }
  validatePayload(dataPackage.payload, manifest, form, marksById, "dataPackage.payload");
  if (dataPackage.catalog.version === CATALOG_VERSION) {
    const expectedPayload = projectFormPayload(form, canonicalObservationsFromPackage(dataPackage));
    if (canonicalJson(expectedPayload) !== canonicalJson(dataPackage.payload)) {
      fail(
        "INVALID_PAYLOAD",
        "payload does not match the exact form's deterministic projector",
        "dataPackage.payload",
      );
    }
  }
  const presentationContract = form.presentation;
  const presentationProfile = dataPackage.presentation?.multiples?.profile;
  if (!isPlainObject(dataPackage.presentation)
    || dataPackage.presentation.renderer?.id !== presentationContract.renderer.id
    || dataPackage.presentation.renderer?.version !== presentationContract.renderer.version
    || dataPackage.presentation.variant !== presentationContract.renderer.variant
    || dataPackage.presentation.multiples?.policy?.id !== presentationContract.multiples.policy.id
    || dataPackage.presentation.multiples?.policy?.version !== presentationContract.multiples.policy.version
    || !presentationContract.multiples.supportedProfiles.includes(presentationProfile)
    || dataPackage.presentation.multiples?.adaptationDecision !== presentationContract.multiples.adaptationDecisions[presentationProfile]) {
    fail("INVALID_PRESENTATION", "presentation does not match the exact form contract", "dataPackage.presentation");
  }
  rejectUnknownFields(dataPackage.presentation, PRESENTATION_FIELDS, "dataPackage.presentation");
  rejectUnknownFields(dataPackage.presentation.renderer, RENDERER_FIELDS, "dataPackage.presentation.renderer");
  rejectUnknownFields(dataPackage.presentation.multiples, MULTIPLES_FIELDS, "dataPackage.presentation.multiples");
  if (!isPlainObject(dataPackage.presentation.multiples.minimumReadableUnit)) fail("INVALID_PRESENTATION", "minimumReadableUnit must be an object", "dataPackage.presentation.multiples.minimumReadableUnit");
  rejectUnknownFields(dataPackage.presentation.multiples.minimumReadableUnit, MINIMUM_READABLE_UNIT_FIELDS, "dataPackage.presentation.multiples.minimumReadableUnit");
  if (!isPlainObject(dataPackage.presentation.multiples.policy)) fail("INVALID_PRESENTATION", "policy must be an object", "dataPackage.presentation.multiples.policy");
  rejectUnknownFields(dataPackage.presentation.multiples.policy, POLICY_FIELDS, "dataPackage.presentation.multiples.policy");
  if (presentationContract.geography) {
    if (canonicalJson(dataPackage.presentation.geography) !== canonicalJson(presentationContract.geography)) fail("INVALID_PRESENTATION", "geography policy must match the bundled renderer", "dataPackage.presentation.geography");
  } else if (dataPackage.presentation.geography !== undefined) {
    fail("INVALID_PRESENTATION", "geography is not declared for this family", "dataPackage.presentation.geography");
  }
  validateCatalogReceipt(dataPackage.catalog, form, "dataPackage.catalog");
  validateProvenance(dataPackage.provenance, form, {
    marks: dataPackage.marks,
    roleMapping: dataPackage.roleMapping,
    scope: dataPackage.scope,
    sources: dataPackage.sources,
  }, "dataPackage.provenance");
  validateQuality(dataPackage.quality, dataPackage.sources, dataPackage.marks, dataPackage.scope, "dataPackage.quality");
  if (!isPlainObject(dataPackage.execution) || !Number.isSafeInteger(dataPackage.execution.modelCalls) || dataPackage.execution.modelCalls < 0 || !Number.isSafeInteger(dataPackage.execution.networkCalls) || dataPackage.execution.networkCalls < 0) fail("INVALID_EXECUTION", "modelCalls and networkCalls must be non-negative integers", "dataPackage.execution");
  rejectUnknownFields(dataPackage.execution, EXECUTION_FIELDS, "dataPackage.execution");
  validateHashes(dataPackage.hashes, "dataPackage.hashes");
  if (dataPackage.id !== `data_${dataPackage.hashes.package.slice(0, 16)}`) fail("INVALID_DATA_PACKAGE_ID", "id does not match package hash", "dataPackage.id");
  // Exact source, record, locator, and quote bindings belong only in the
  // separately authenticated evidence store. Run this after structural checks
  // so malformed evidenceRefs retain their specific contract error.
  assertNoPrivateFields(dataPackage, "dataPackage", PUBLIC_EVIDENCE_LINK_FIELDS);
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
  catalog,
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
    catalog,
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
