import { atlasV2Adapter } from "./atlas-v2.js";
import { phraseV1Adapter } from "./phrase-v1.js";

const ADAPTERS = Object.freeze([phraseV1Adapter, atlasV2Adapter]);

function artifactError(message) {
  const error = new TypeError(message);
  error.code = "UNSUPPORTED_ARTIFACT";
  return error;
}

/**
 * The only version switch in the runtime. All callers ask the resolved adapter
 * for behavior instead of branching on phrase or Atlas fields themselves.
 */
export function artifactAdapterFor(value) {
  const adapter = ADAPTERS.find((candidate) => candidate.matches(value));
  if (!adapter) {
    throw artifactError("Unsupported Attend artifact package version or kind");
  }
  return adapter;
}

export function validateArtifactPackage(value) {
  return artifactAdapterFor(value).validatePublicPackage(value);
}

export async function verifyArtifactPackage(value) {
  const adapter = artifactAdapterFor(value);
  return adapter.verifyPublicPackage(value);
}

export function viewDescriptorForArtifact(value) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).viewDescriptor(dataPackage);
}

export function libraryMetadataForArtifact(value) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).libraryMetadata(dataPackage);
}

export function createArtifactState(value, overrides = {}) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).initialState(dataPackage, overrides);
}

export function patchArtifactState(value, current, patch) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).applyStatePatch(dataPackage, current, patch);
}

export function normalizeArtifactState(value, state) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).normalizeStoredState(dataPackage, state);
}

export function clearArtifactSelection(value, state) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).clearSelectionState(state);
}

export function selectableIdsForArtifact(value) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).selectableIds(dataPackage);
}

export function listArtifactMarks(value) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).listMarks(dataPackage);
}

export function buildArtifactSelection(value, state, options) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).buildSelection(dataPackage, state, options);
}

export function evidenceSourceIdsForSelection(value, selection) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).evidenceSourceIds(dataPackage, selection);
}

/**
 * Atlas reference ids are public capability-free handles only. Their source,
 * record, locator, and quote linkage lives in the private evidence store.
 */
export function evidenceReferenceIdsForSelection(value, selection) {
  const dataPackage = validateArtifactPackage(value);
  const adapter = artifactAdapterFor(dataPackage);
  if (typeof adapter.evidenceReferenceIds !== "function") {
    const error = new TypeError(`${adapter.artifactKind} does not use opaque evidence reference ids`);
    error.code = "EVIDENCE_REFERENCE_IDS_UNSUPPORTED";
    throw error;
  }
  return adapter.evidenceReferenceIds(dataPackage, selection);
}

export function renderModelForArtifact(value) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).packageToRenderModel(dataPackage);
}

/** Public browser projection: never leak exact evidence excerpts from v2. */
export function publicArtifactForBrowser(value) {
  const dataPackage = validateArtifactPackage(value);
  const adapter = artifactAdapterFor(dataPackage);
  return adapter.publicPackageForBrowser?.(dataPackage) ?? dataPackage;
}

export function deriveArtifactSelection(value, markId, state) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).deriveSelection(dataPackage, markId, state);
}

export function deriveArtifactEvidence(value, selection) {
  const dataPackage = validateArtifactPackage(value);
  return artifactAdapterFor(dataPackage).deriveEvidence(dataPackage, selection);
}

export async function resolveArtifactVisualTarget(value, targetId, options) {
  const dataPackage = validateArtifactPackage(value);
  const adapter = artifactAdapterFor(dataPackage);
  if (typeof adapter.resolveVisualTarget !== "function") {
    const error = new TypeError(`${adapter.artifactKind} does not expose aggregate visual targets`);
    error.code = "VISUAL_TARGET_UNSUPPORTED";
    throw error;
  }
  return adapter.resolveVisualTarget(dataPackage, targetId, options);
}

export const ARTIFACT_ADAPTERS = ADAPTERS;
