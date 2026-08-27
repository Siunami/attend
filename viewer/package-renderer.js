import { atlasPackageToRenderModel, isCatalogReceiptAllowlisted } from "./package-model.js";
import { renderFamily } from "./family-renderers.js";

// These are the only browser assets a package-native renderer may request. The
// server publishes them as same-origin session assets; a package cannot add URLs.
export const ATLAS_ASSET_PATHS = Object.freeze([
  "vendor/d3.min.js",
  "vendor/topojson-client.min.js",
  "vendor/us-states.json",
  "vendor/us-counties.json",
  "vendor/world-countries.json",
]);

function selectedIds(value, model) {
  const requested = Array.isArray(value) ? value : value ? [value] : [];
  const allowed = new Set(model.selectableMarkIds);
  return [...new Set(requested.map(String).filter((id) => allowed.has(id)))];
}

export function packageToFamilyRenderModel(packageValue) {
  return atlasPackageToRenderModel(packageValue);
}

export async function renderAtlasPackage({
  root,
  packageValue,
  selectedMarkIds = [],
  selectedNodeId = null,
  onSelect,
} = {}) {
  const model = atlasPackageToRenderModel(packageValue);
  if (!isCatalogReceiptAllowlisted(model.catalog)) {
    throw new Error(`No bundled renderer receipt is allowlisted for ${model.familyId}`);
  }
  const selected = selectedIds(selectedMarkIds, model);
  const receipt = await renderFamily({
    root,
    dataset: model,
    selectedId: selected[0] ?? null,
    selectedIds: selected,
    selectedNodeId,
    selectableMarkIds: model.selectableMarkIds,
    onSelect,
  });
  return {
    ...receipt,
    packageId: model.packageId,
    familyId: model.familyId,
    selectedMarkIds: selected,
  };
}

export function atlasSelectionSummary(packageValue, selectedMarkIds = []) {
  const model = atlasPackageToRenderModel(packageValue);
  const selected = selectedIds(selectedMarkIds, model);
  return selected.map((id) => model.markById[id]).filter(Boolean);
}
