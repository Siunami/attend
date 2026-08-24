import { join, resolve } from "node:path";

import {
  artifactAdapterFor,
  evidenceReferenceIdsForSelection,
  evidenceSourceIdsForSelection,
  validateArtifactPackage,
} from "./artifacts/index.js";
import { isOpaqueEvidenceReferenceId } from "./pipeline/data-package.js";
import { readJson, writeJsonAtomic } from "./project.js";
import { loadSources, sha256 } from "./sources.js";

const EVIDENCE_STORE_SCHEMA_VERSION = 1;
const ATLAS_EVIDENCE_STORE_SCHEMA_VERSION = 2;
const EVIDENCE_PACKET_SCHEMA_VERSION = 1;
const EVIDENCE_DIRECTORY = ".attend/local/evidence";
const SAFE_DATA_ID = /^data_[a-f0-9]{16}$/u;
const DEFAULT_MAX_PACKET_BYTES = 1024 * 1024;
const HARD_MAX_PACKET_BYTES = 1024 * 1024;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function evidenceError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function validateDataPackage(dataPackage) {
  const value = validateArtifactPackage(dataPackage);
  if (!SAFE_DATA_ID.test(value.id ?? "")) {
    throw new TypeError("dataPackage.id must be a safe Attend data id");
  }
  if (
    typeof value.hashes?.data !== "string" ||
    typeof value.hashes?.corpus !== "string" ||
    !Array.isArray(value.sources)
  ) {
    throw new TypeError("dataPackage is missing hashes or sources");
  }
  return value;
}

export function evidenceStorePath({ root, dataPackageId }) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("root must be a non-empty path");
  }
  if (!SAFE_DATA_ID.test(dataPackageId ?? "")) {
    throw new TypeError("dataPackageId must be a safe Attend data id");
  }
  return join(resolve(root), EVIDENCE_DIRECTORY, `${dataPackageId}.json`);
}

function sourceEvidence(source) {
  if (typeof source?.text !== "string") {
    throw new TypeError(`Evidence source ${source?.id ?? "unknown"} is missing text`);
  }
  const metadata = {
    id: source.id,
    displayPath: source.displayPath,
    sourceSha256: source.sha256,
    byteLength: source.byteLength,
    kind: source.kind,
  };
  for (const field of ["title", "date", "recordId", "containerPath", "textProjection"]) {
    if (typeof source[field] === "string" && source[field].length > 0) {
      metadata[field] = source[field];
    }
  }
  return { ...metadata, text: source.text };
}

function storeHashable(store) {
  return {
    schemaVersion: store.schemaVersion,
    kind: store.kind,
    dataPackageId: store.dataPackageId,
    dataHash: store.dataHash,
    corpusHash: store.corpusHash,
    sources: store.sources,
    ...(store.references === undefined ? {} : { references: store.references }),
  };
}

function isAtlasPackage(dataPackage) {
  return artifactAdapterFor(dataPackage).artifactKind === "atlas-v2";
}

function publicEvidenceReferenceIds(dataPackage) {
  return new Set(dataPackage.marks.flatMap((mark) => mark.evidenceRefs));
}

function privateEvidenceReferenceId(reference) {
  return `evidence_${sha256(canonicalJson({
    sourceId: reference.sourceId,
    recordId: reference.recordId,
    locator: reference.locator,
    quote: reference.quote,
  })).slice(0, 16)}`;
}

function invalidPrivateReference(message) {
  return evidenceError(
    "EVIDENCE_REFERENCE_INVALID",
    `The private Atlas evidence linkage is invalid: ${message}. Regenerate the map.`,
  );
}

function normalizePrivateReference(reference, sourceById, expectedIds, index) {
  const path = `references[${index}]`;
  if (!isPlainObject(reference)) throw invalidPrivateReference(`${path} must be an object`);
  const allowed = new Set(["id", "sourceId", "recordId", "locator", "quote"]);
  for (const key of Object.keys(reference)) {
    if (!allowed.has(key)) throw invalidPrivateReference(`${path}.${key} is not supported`);
  }
  if (!isOpaqueEvidenceReferenceId(reference.id) || !expectedIds.has(reference.id)) {
    throw invalidPrivateReference(`${path}.id does not resolve to a public mark evidence id`);
  }
  if (typeof reference.sourceId !== "string" || !sourceById.has(reference.sourceId)) {
    throw invalidPrivateReference(`${path}.sourceId does not resolve to a verified source`);
  }
  if (typeof reference.recordId !== "string" || !/^[a-z][a-z0-9_-]{1,127}$/u.test(reference.recordId)) {
    throw invalidPrivateReference(`${path}.recordId is invalid`);
  }
  if (!isPlainObject(reference.locator) || Object.keys(reference.locator).length === 0) {
    throw invalidPrivateReference(`${path}.locator is invalid`);
  }
  try {
    canonicalJson(reference.locator);
  } catch (error) {
    throw invalidPrivateReference(`${path}.locator is not JSON-safe`);
  }
  if (typeof reference.quote !== "string" || reference.quote.length === 0 || reference.quote.length > 16_384) {
    throw invalidPrivateReference(`${path}.quote is invalid`);
  }
  const source = sourceById.get(reference.sourceId);
  const locator = reference.locator;
  if (locator.kind === "text-range") {
    if (
      !Number.isSafeInteger(locator.startOffset) ||
      !Number.isSafeInteger(locator.endOffset) ||
      locator.startOffset < 0 ||
      locator.endOffset < locator.startOffset ||
      locator.endOffset > source.text.length ||
      (locator.path !== undefined && locator.path !== source.displayPath) ||
      source.text.slice(locator.startOffset, locator.endOffset) !== reference.quote
    ) {
      throw invalidPrivateReference(`${path} does not match its source text-range`);
    }
  } else if (!source.text.includes(reference.quote)) {
    throw invalidPrivateReference(`${path}.quote does not occur in its verified source`);
  }
  const normalized = canonicalValue({
    id: reference.id,
    sourceId: reference.sourceId,
    recordId: reference.recordId,
    locator: reference.locator,
    quote: reference.quote,
  });
  if (privateEvidenceReferenceId(normalized) !== normalized.id) {
    throw invalidPrivateReference(`${path}.id does not bind its source, record, locator, and quote`);
  }
  return normalized;
}

function normalizeAtlasEvidenceReferences({ dataPackage, evidenceSources, evidenceReferences }) {
  if (!Array.isArray(evidenceReferences)) {
    throw invalidPrivateReference("references are required for an Atlas package");
  }
  const expectedIds = publicEvidenceReferenceIds(dataPackage);
  const sourceById = new Map(evidenceSources.map((source) => [source.id, source]));
  const seen = new Set();
  const references = evidenceReferences.map((reference, index) => {
    const normalized = normalizePrivateReference(reference, sourceById, expectedIds, index);
    if (seen.has(normalized.id)) {
      throw invalidPrivateReference(`references contains duplicate id ${normalized.id}`);
    }
    seen.add(normalized.id);
    return normalized;
  });
  if (seen.size !== expectedIds.size || [...expectedIds].some((id) => !seen.has(id))) {
    throw invalidPrivateReference("references do not close over every public mark evidence id");
  }
  return references.sort((left, right) => compareText(left.id, right.id));
}

/** Build the private content companion for a public, text-free DataPackage. */
export function buildEvidenceStore({ dataPackage, sources, evidenceReferences } = {}) {
  const packageValue = validateDataPackage(dataPackage);
  const atlas = isAtlasPackage(packageValue);
  if (!Array.isArray(sources)) throw new TypeError("sources must be an array");
  if (sources.length !== packageValue.sources.length) {
    throw evidenceError(
      "EVIDENCE_SOURCE_MISMATCH",
      "Evidence sources do not match the analyzed source count; regenerate the analysis.",
    );
  }

  const suppliedById = new Map();
  for (const source of sources) {
    if (typeof source?.id !== "string" || suppliedById.has(source.id)) {
      throw evidenceError("EVIDENCE_SOURCE_MISMATCH", "Evidence source ids must be unique.");
    }
    suppliedById.set(source.id, source);
  }

  const evidenceSources = packageValue.sources.map((expected) => {
    const source = suppliedById.get(expected.id);
    const metadataMatches = [
      "kind",
      "title",
      "date",
      ...(atlas ? [] : ["recordId", "containerPath"]),
      "textProjection",
    ]
      .every((field) => (source?.[field] ?? null) === (expected[field] ?? null));
    if (
      !source ||
      source.displayPath !== expected.displayPath ||
      source.sha256 !== expected.sha256 ||
      !metadataMatches ||
      Buffer.byteLength(source.text ?? "", "utf8") !== expected.byteLength ||
      sha256(Buffer.from(source.text ?? "", "utf8")) !== expected.sha256
    ) {
      throw evidenceError(
        "EVIDENCE_SOURCE_MISMATCH",
        `Evidence source no longer matches the analysis: ${expected.displayPath}. Regenerate the analysis.`,
      );
    }
    return sourceEvidence(source);
  });

  const references = atlas
    ? normalizeAtlasEvidenceReferences({
        dataPackage: packageValue,
        evidenceSources,
        evidenceReferences,
      })
    : undefined;
  const hashable = {
    schemaVersion: atlas ? ATLAS_EVIDENCE_STORE_SCHEMA_VERSION : EVIDENCE_STORE_SCHEMA_VERSION,
    kind: "attend-evidence-store",
    dataPackageId: packageValue.id,
    dataHash: packageValue.hashes.data,
    corpusHash: packageValue.hashes.corpus,
    sources: evidenceSources,
    ...(references === undefined ? {} : { references }),
  };
  const contentHash = sha256(canonicalJson(hashable));
  return {
    ...hashable,
    id: `evidence_${contentHash.slice(0, 16)}`,
    hashes: { content: contentHash },
  };
}

/** Validate linkage and every source body before any content enters a prompt. */
export function validateEvidenceStore({ dataPackage, evidenceStore } = {}) {
  const packageValue = validateDataPackage(dataPackage);
  const atlas = isAtlasPackage(packageValue);
  if (
    !evidenceStore ||
    typeof evidenceStore !== "object" ||
    Array.isArray(evidenceStore) ||
    evidenceStore.schemaVersion !== (atlas ? ATLAS_EVIDENCE_STORE_SCHEMA_VERSION : EVIDENCE_STORE_SCHEMA_VERSION) ||
    evidenceStore.kind !== "attend-evidence-store" ||
    evidenceStore.dataPackageId !== packageValue.id ||
    evidenceStore.dataHash !== packageValue.hashes.data ||
    evidenceStore.corpusHash !== packageValue.hashes.corpus ||
    !Array.isArray(evidenceStore.sources) ||
    (atlas && !Array.isArray(evidenceStore.references)) ||
    (!atlas && evidenceStore.references !== undefined)
  ) {
    throw evidenceError(
      "EVIDENCE_STORE_INVALID",
      "The private evidence store is not linked to this analysis; regenerate the analysis.",
    );
  }
  const expectedHash = sha256(canonicalJson(storeHashable(evidenceStore)));
  if (
    evidenceStore.hashes?.content !== expectedHash ||
    evidenceStore.id !== `evidence_${expectedHash.slice(0, 16)}`
  ) {
    throw evidenceError(
      "EVIDENCE_STORE_INVALID",
      "The private evidence store failed its content hash; regenerate the analysis.",
    );
  }
  // Reuse the exact source/package checks used at creation, including each
  // original source SHA. This intentionally hashes bodies on each load.
  const rebuilt = buildEvidenceStore({
    dataPackage: packageValue,
    sources: evidenceStore.sources.map((source) => ({
      ...source,
      sha256: source.sourceSha256,
    })),
    ...(atlas ? { evidenceReferences: evidenceStore.references } : {}),
  });
  if (rebuilt.hashes.content !== expectedHash) {
    throw evidenceError(
      "EVIDENCE_STORE_INVALID",
      "The private evidence store does not reproduce its recorded hash.",
    );
  }
  return evidenceStore;
}

function migrationInputs(dataPackage) {
  const inputs = new Set();
  for (const source of dataPackage.sources) {
    let input;
    if (source.kind === "jsonl-record") {
      input = source.containerPath;
      if (typeof input !== "string" || input.length === 0) {
        throw evidenceError(
          "EVIDENCE_REGENERATION_REQUIRED",
          `Legacy JSONL source ${source.displayPath} has no container path. Rerun \`attend phrases\` with the original inputs.`,
        );
      }
    } else {
      input = source.displayPath;
    }
    if (typeof input !== "string" || input.length === 0) {
      throw evidenceError(
        "EVIDENCE_REGENERATION_REQUIRED",
        "Legacy source metadata is incomplete. Rerun `attend phrases` with the original inputs.",
      );
    }
    inputs.add(input);
  }
  return [...inputs];
}

/**
 * Load the private store, or safely migrate a legacy analysis by re-reading
 * only its explicit recorded files/JSONL containers through loadSources.
 */
export async function ensureEvidenceStore({ root, dataPackage } = {}) {
  const packageValue = validateDataPackage(dataPackage);
  const path = evidenceStorePath({ root, dataPackageId: packageValue.id });
  try {
    return validateEvidenceStore({
      dataPackage: packageValue,
      evidenceStore: await readJson(path),
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (artifactAdapterFor(packageValue).artifactKind === "atlas-v2") {
    throw evidenceError(
      "EVIDENCE_REGENERATION_REQUIRED",
      "The private Atlas evidence store is missing. Re-run `attend map` so Attend can verify and stage its source evidence again.",
    );
  }

  let loaded;
  try {
    loaded = await loadSources({
      root,
      inputPaths: migrationInputs(packageValue),
      maxFileBytes: packageValue.config?.maxFileBytes ?? 2_000_000,
    });
  } catch (error) {
    if (error?.code === "EVIDENCE_REGENERATION_REQUIRED") throw error;
    throw evidenceError(
      "EVIDENCE_REGENERATION_REQUIRED",
      "The original sources could not be safely verified for this legacy analysis. Rerun `attend phrases` with the original inputs.",
      error,
    );
  }

  let store;
  try {
    store = buildEvidenceStore({ dataPackage: packageValue, sources: loaded.sources });
  } catch (error) {
    if (error?.code === "EVIDENCE_SOURCE_MISMATCH") {
      throw evidenceError(
        "EVIDENCE_REGENERATION_REQUIRED",
        `${error.message} Rerun \`attend phrases\` with the original inputs.`,
        error,
      );
    }
    throw error;
  }
  await writeJsonAtomic(path, store, { root: resolve(root) });
  return store;
}

function utf8Prefix(value, maxBytes) {
  if (maxBytes <= 0 || value.length === 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Never end on the first half of a surrogate pair.
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1])) low -= 1;
  return value.slice(0, low);
}

function utf8Suffix(value, maxBytes) {
  if (maxBytes <= 0 || value.length === 0) return { start: value.length, text: "" };
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { start: 0, text: value };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(middle), "utf8") <= maxBytes) high = middle;
    else low = middle + 1;
  }
  if (low < value.length && /[\uDC00-\uDFFF]/u.test(value[low])) low += 1;
  return { start: low, text: value.slice(low) };
}

function sampledSegments(text, maxTextBytes) {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= maxTextBytes) {
    return [{ startCharacter: 0, endCharacter: text.length, text }];
  }
  if (maxTextBytes < 3) {
    const head = utf8Prefix(text, maxTextBytes);
    return [{ startCharacter: 0, endCharacter: head.length, text: head }];
  }

  const headBudget = Math.floor(maxTextBytes / 3);
  const middleBudget = Math.floor(maxTextBytes / 3);
  const tailBudget = maxTextBytes - headBudget - middleBudget;
  const head = utf8Prefix(text, headBudget);
  const tail = utf8Suffix(text, tailBudget);

  const approximateMiddleStart = Math.max(
    head.length,
    Math.floor(text.length / 2) - Math.floor(middleBudget / 2),
  );
  const middleAvailable = text.slice(approximateMiddleStart, tail.start);
  const middle = utf8Prefix(middleAvailable, middleBudget);
  const segments = [
    { startCharacter: 0, endCharacter: head.length, text: head },
    {
      startCharacter: approximateMiddleStart,
      endCharacter: approximateMiddleStart + middle.length,
      text: middle,
    },
    { startCharacter: tail.start, endCharacter: text.length, text: tail.text },
  ];
  return segments.filter(
    (segment, index) =>
      segment.text.length > 0 &&
      (index === 0 || segment.startCharacter >= segments[index - 1].endCharacter),
  );
}

function selectedSourceIds(dataPackage, evidenceStore, selection) {
  try {
    if (isAtlasPackage(dataPackage)) {
      const evidenceRefIds = evidenceReferenceIdsForSelection(dataPackage, selection);
      const referencesById = new Map(evidenceStore.references.map((reference) => [reference.id, reference]));
      const selected = evidenceRefIds.map((id) => {
        const reference = referencesById.get(id);
        if (!reference) {
          throw evidenceError(
            "EVIDENCE_STORE_INVALID",
            `The private evidence store is missing selected reference ${id}.`,
          );
        }
        return reference;
      });
      const implicated = new Set(selected.map((reference) => reference.sourceId));
      return dataPackage.sources
        .map((source) => source.id)
        .filter((sourceId) => implicated.has(sourceId));
    }
    return evidenceSourceIdsForSelection(dataPackage, selection);
  } catch (error) {
    if (["EVIDENCE_SELECTION_INVALID", "EVIDENCE_STORE_INVALID"].includes(error?.code)) throw error;
    throw evidenceError(
      "EVIDENCE_SELECTION_INVALID",
      "Selection does not resolve to canonical package evidence.",
      error,
    );
  }
}

function packetSource(source, maxTextBytes) {
  const segments = sampledSegments(source.text, maxTextBytes);
  const includedByteLength = segments.reduce(
    (total, segment) => total + Buffer.byteLength(segment.text, "utf8"),
    0,
  );
  return {
    sourceId: source.id,
    displayPath: source.displayPath,
    sourceSha256: source.sourceSha256,
    sourceByteLength: source.byteLength,
    ...(source.title ? { title: source.title } : {}),
    ...(source.date ? { date: source.date } : {}),
    contentComplete: includedByteLength === source.byteLength,
    includedByteLength,
    segments,
  };
}

function packetHashable(packet) {
  const { id: _id, hashes: _hashes, ...hashable } = packet;
  return hashable;
}

function finalizePacket(packet) {
  const packetHash = sha256(canonicalJson(packetHashable(packet)));
  return {
    ...packet,
    id: `packet_${packetHash.slice(0, 16)}`,
    hashes: { ...packet.hashes, packet: packetHash },
  };
}

function candidatePacket({ dataPackage, evidenceStore, selection, selectedSources, maxTextBytes }) {
  const sources = selectedSources.map((source) => packetSource(source, maxTextBytes));
  const selectedByteCount = selectedSources.reduce(
    (total, source) => total + source.byteLength,
    0,
  );
  const includedByteCount = sources.reduce(
    (total, source) => total + source.includedByteLength,
    0,
  );
  const truncatedSourceCount = sources.filter((source) => !source.contentComplete).length;
  return finalizePacket({
    schemaVersion: EVIDENCE_PACKET_SCHEMA_VERSION,
    kind: "attend-evidence-packet",
    dataPackageId: dataPackage.id,
    dataHash: dataPackage.hashes.data,
    selectionId: typeof selection?.id === "string" ? selection.id : null,
    hashes: { evidenceStore: evidenceStore.hashes.content },
    coverage: {
      selectedSourceCount: selectedSources.length,
      includedSourceCount: sources.length,
      selectedByteCount,
      includedByteCount,
      complete: truncatedSourceCount === 0,
      truncatedSourceCount,
      sampling: truncatedSourceCount === 0 ? "full-source/v1" : "head-middle-tail/v1",
    },
    sources,
  });
}

/**
 * Produce one strict, inline, tool-less packet. Full bodies win whenever the
 * complete packet fits; otherwise every implicated source receives the same
 * deterministic byte allowance sampled across its beginning, middle, and end.
 */
export function buildEvidencePacket({
  dataPackage,
  evidenceStore,
  selection,
  maxBytes = DEFAULT_MAX_PACKET_BYTES,
} = {}) {
  const packageValue = validateDataPackage(dataPackage);
  const store = validateEvidenceStore({ dataPackage: packageValue, evidenceStore });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_MAX_PACKET_BYTES) {
    throw new TypeError(`maxBytes must be an integer between 1 and ${HARD_MAX_PACKET_BYTES}`);
  }
  const selectedIds = selectedSourceIds(packageValue, store, selection);
  const sourceById = new Map(store.sources.map((source) => [source.id, source]));
  const selectedSources = selectedIds.map((sourceId) => {
    const source = sourceById.get(sourceId);
    if (!source) {
      throw evidenceError(
        "EVIDENCE_STORE_INVALID",
        `Evidence store is missing selected source ${sourceId}.`,
      );
    }
    return source;
  });

  const full = candidatePacket({
    dataPackage: packageValue,
    evidenceStore: store,
    selection,
    selectedSources,
    maxTextBytes: Number.MAX_SAFE_INTEGER,
  });
  if (Buffer.byteLength(JSON.stringify(full), "utf8") <= maxBytes) return full;

  let low = 1;
  let high = maxBytes;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = candidatePacket({
      dataPackage: packageValue,
      evidenceStore: store,
      selection,
      selectedSources,
      maxTextBytes: middle,
    });
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!best) {
    throw evidenceError(
      "EVIDENCE_PACKET_TOO_BROAD",
      "The selected source provenance cannot fit in the bounded response context. Narrow the visualization selection.",
    );
  }
  return best;
}

export async function evidencePacketForSelection({
  root,
  dataPackage,
  selection,
  maxBytes = DEFAULT_MAX_PACKET_BYTES,
} = {}) {
  const evidenceStore = await ensureEvidenceStore({ root, dataPackage });
  return buildEvidencePacket({ dataPackage, evidenceStore, selection, maxBytes });
}

/** Persist a store created from the analyzer's already-loaded source snapshot. */
export async function writeEvidenceStore({ root, dataPackage, evidenceStore } = {}) {
  const store = validateEvidenceStore({ dataPackage, evidenceStore });
  const path = evidenceStorePath({ root, dataPackageId: dataPackage.id });
  await writeJsonAtomic(path, store, { root: resolve(root) });
  return path;
}

export const EVIDENCE_LIMITS = Object.freeze({
  defaultPacketBytes: DEFAULT_MAX_PACKET_BYTES,
  hardPacketBytes: HARD_MAX_PACKET_BYTES,
});
