import { phraseV1Adapter } from "./artifacts/phrase-v1.js";

/**
 * Compatibility entry point for callers and saved phrase-v1 workflows.
 * New runtime code resolves the package adapter through `src/artifacts`.
 */
export function buildSelection(dataPackage, state, options) {
  return phraseV1Adapter.buildSelection(dataPackage, state, options);
}
