import { GENERATED_FORM_RUNTIME } from "./form-runtime-generated.js";

// This table is a URL compatibility boundary only. It is never consulted by
// compilation or open-form selection.
export const LEGACY_FAMILY_BOOKMARKS = Object.freeze({
  rank: "bar-list",
  distribution: "strip",
  composition: "hundred-bar",
  profile: "parallel",
  "passage-comparison": "parallel-text",
  trend: "line",
  timeline: "interval",
  sequence: "step-strip",
  relationship: "scatter",
  matrix: "heatmap",
  hierarchy: "tidy",
  network: "local",
  flow: "sankey",
  mechanism: "flowchart",
  "region-map": "choropleth",
  "point-map": "exact-points",
  field: "sample-raster",
  "collection-atlas": "faceted-atlas",
});

export function catalogReceiptKey(receipt) {
  return [
    receipt?.version,
    receipt?.family,
    receipt?.member,
    receipt?.rendererId,
    receipt?.rendererVariantId,
    receipt?.rendererVersion,
  ].map(String).join(":");
}

const currentReceipts = GENERATED_FORM_RUNTIME.forms.map((form) => Object.freeze({ ...form.receipt }));
const historicalReceipts = GENERATED_FORM_RUNTIME.historicalReceipts.map((receipt) => Object.freeze({ ...receipt }));
const receipts = [...currentReceipts, ...historicalReceipts];
const receiptByKey = new Map(receipts.map((receipt) => [catalogReceiptKey(receipt), receipt]));
const currentByForm = new Map(currentReceipts.map((receipt) => [`${receipt.family}/${receipt.member}`, receipt]));

export const HISTORICAL_CATALOG_VERSIONS = Object.freeze([...new Set(historicalReceipts.map((receipt) => receipt.version))]);
export const EXECUTABLE_FORM_RECEIPTS = Object.freeze([...receiptByKey.values()]);
export const FORM_RENDERER_KEYS = Object.freeze(GENERATED_FORM_RUNTIME.forms.map((form) => form.key));
export const FORM_RENDERER_MODULE_PATHS = GENERATED_FORM_RUNTIME.rendererImports;
export const FORM_FIXTURE_KEYS = Object.freeze(Object.values(GENERATED_FORM_RUNTIME.fixtureIndex));
export const FORM_STATIC_ASSET_PATHS = GENERATED_FORM_RUNTIME.staticAssets;

export function allowlistedCatalogReceipt(receipt) {
  return receiptByKey.get(catalogReceiptKey(receipt)) ?? null;
}

export function expectedPresentationVariantForCatalogReceipt(receipt) {
  const allowlisted = allowlistedCatalogReceipt(receipt);
  if (!allowlisted) return null;
  if (allowlisted.version === GENERATED_FORM_RUNTIME.catalogVersion) {
    return allowlisted.rendererVariantId;
  }
  return GENERATED_FORM_RUNTIME.historicalPresentationVariants[
    `${allowlisted.version}/${allowlisted.family}/${allowlisted.member}`
  ] ?? null;
}

export function currentCatalogReceipt(familyId, memberId) {
  return currentByForm.get(`${familyId}/${memberId}`) ?? null;
}

export function executableMemberIds(familyId) {
  return currentReceipts.filter((receipt) => receipt.family === familyId).map((receipt) => receipt.member);
}

export function legacyIncumbentMemberId(familyId) {
  return LEGACY_FAMILY_BOOKMARKS[familyId] ?? null;
}
