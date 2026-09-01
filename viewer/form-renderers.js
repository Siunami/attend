import renderPartList, { descriptor as partList } from "./forms/composition/part-list.js";
import renderHundredBar, { descriptor as hundredBar } from "./forms/composition/hundred-bar.js";
import renderEcdf, { descriptor as ecdf } from "./forms/distribution/ecdf.js";
import renderHistogram, { descriptor as histogram } from "./forms/distribution/histogram.js";
import renderStrip, { descriptor as strip } from "./forms/distribution/strip.js";
import renderContours, { descriptor as contours } from "./forms/field/contours.js";
import renderSampleRaster, { descriptor as sampleRaster } from "./forms/field/sample-raster.js";
import renderSankey, { descriptor as sankey } from "./forms/flow/sankey.js";
import renderIcicle, { descriptor as icicle } from "./forms/hierarchy/icicle.js";
import renderOutline, { descriptor as outline } from "./forms/hierarchy/outline.js";
import renderTidy, { descriptor as tidy } from "./forms/hierarchy/tidy.js";
import renderTreemap, { descriptor as treemap } from "./forms/hierarchy/treemap.js";
import renderHeatmap, { descriptor as heatmap } from "./forms/matrix/heatmap.js";
import renderFlowchart, { descriptor as flowchart } from "./forms/mechanism/flowchart.js";
import renderLocalNetwork, { descriptor as localNetwork } from "./forms/network/local.js";
import renderParallelText, { descriptor as parallelText } from "./forms/passage-comparison/parallel-text.js";
import renderExactPoints, { descriptor as exactPoints } from "./forms/point-map/exact-points.js";
import renderParallelProfile, { descriptor as parallelProfile } from "./forms/profile/parallel.js";
import renderProfileTable, { descriptor as profileTable } from "./forms/profile/profile-table.js";
import renderMarginals, { descriptor as marginals } from "./forms/relationship/marginals.js";
import renderScatter, { descriptor as scatter } from "./forms/relationship/scatter.js";
import renderChoropleth, { descriptor as choropleth } from "./forms/region-map/choropleth.js";
import renderRegionSymbols, { descriptor as regionSymbols } from "./forms/region-map/region-symbols.js";
import renderBarList, { descriptor as barList } from "./forms/rank/bar-list.js";
import renderDotPlot, { descriptor as dotPlot } from "./forms/rank/dot-plot.js";
import renderSlopegraph, { descriptor as slopegraph } from "./forms/rank/slopegraph.js";
import renderStateRibbon, { descriptor as stateRibbon } from "./forms/sequence/state-ribbon.js";
import renderStepStrip, { descriptor as stepStrip } from "./forms/sequence/step-strip.js";
import renderEventStrip, { descriptor as eventStrip } from "./forms/timeline/event-strip.js";
import renderInterval, { descriptor as interval } from "./forms/timeline/interval.js";
import renderLine, { descriptor as line } from "./forms/trend/line.js";
import renderPeriodBars, { descriptor as periodBars } from "./forms/trend/period-bars.js";
import renderContactAtlas, { descriptor as contactAtlas } from "./forms/collection-atlas/contact-atlas.js";
import renderFacetedAtlas, { descriptor as facetedAtlas } from "./forms/collection-atlas/faceted-atlas.js";
import { allowlistedCatalogReceipt, catalogReceiptKey, EXECUTABLE_FORM_RECEIPTS } from "./form-registry.js";

const modules = [
  [barList, renderBarList, "./forms/rank/bar-list.js"],
  [dotPlot, renderDotPlot, "./forms/rank/dot-plot.js"],
  [slopegraph, renderSlopegraph, "./forms/rank/slopegraph.js"],
  [strip, renderStrip, "./forms/distribution/strip.js"],
  [histogram, renderHistogram, "./forms/distribution/histogram.js"],
  [ecdf, renderEcdf, "./forms/distribution/ecdf.js"],
  [hundredBar, renderHundredBar, "./forms/composition/hundred-bar.js"],
  [partList, renderPartList, "./forms/composition/part-list.js"],
  [parallelProfile, renderParallelProfile, "./forms/profile/parallel.js"],
  [profileTable, renderProfileTable, "./forms/profile/profile-table.js"],
  [parallelText, renderParallelText, "./forms/passage-comparison/parallel-text.js"],
  [line, renderLine, "./forms/trend/line.js"],
  [periodBars, renderPeriodBars, "./forms/trend/period-bars.js"],
  [interval, renderInterval, "./forms/timeline/interval.js"],
  [eventStrip, renderEventStrip, "./forms/timeline/event-strip.js"],
  [stepStrip, renderStepStrip, "./forms/sequence/step-strip.js"],
  [stateRibbon, renderStateRibbon, "./forms/sequence/state-ribbon.js"],
  [scatter, renderScatter, "./forms/relationship/scatter.js"],
  [marginals, renderMarginals, "./forms/relationship/marginals.js"],
  [heatmap, renderHeatmap, "./forms/matrix/heatmap.js"],
  [tidy, renderTidy, "./forms/hierarchy/tidy.js"],
  [outline, renderOutline, "./forms/hierarchy/outline.js"],
  [icicle, renderIcicle, "./forms/hierarchy/icicle.js"],
  [treemap, renderTreemap, "./forms/hierarchy/treemap.js"],
  [localNetwork, renderLocalNetwork, "./forms/network/local.js"],
  [sankey, renderSankey, "./forms/flow/sankey.js"],
  [flowchart, renderFlowchart, "./forms/mechanism/flowchart.js"],
  [choropleth, renderChoropleth, "./forms/region-map/choropleth.js"],
  [regionSymbols, renderRegionSymbols, "./forms/region-map/region-symbols.js"],
  [exactPoints, renderExactPoints, "./forms/point-map/exact-points.js"],
  [sampleRaster, renderSampleRaster, "./forms/field/sample-raster.js"],
  [contours, renderContours, "./forms/field/contours.js"],
  [facetedAtlas, renderFacetedAtlas, "./forms/collection-atlas/faceted-atlas.js"],
  [contactAtlas, renderContactAtlas, "./forms/collection-atlas/contact-atlas.js"],
];

const rendererByForm = new Map(modules.map(([descriptor, renderer]) => [
  `${descriptor.familyId}/${descriptor.memberId}`,
  renderer,
]));

const rendererByReceipt = new Map(EXECUTABLE_FORM_RECEIPTS.flatMap((receipt) => {
  const renderer = rendererByForm.get(`${receipt.family}/${receipt.member}`);
  return renderer ? [[catalogReceiptKey(receipt), renderer]] : [];
}));

export const FORM_RENDERER_KEYS = Object.freeze(modules.map(([descriptor]) => `${descriptor.familyId}/${descriptor.memberId}`));
export const FORM_FIXTURE_KEYS = Object.freeze(modules.map(([descriptor]) => descriptor.fixtureId));
export const FORM_RENDERER_MODULES = Object.freeze(Object.fromEntries(modules.map(([descriptor, , modulePath]) => [
  `${descriptor.familyId}/${descriptor.memberId}`,
  modulePath,
])));
export const FORM_STATIC_ASSETS = Object.freeze([...new Set(modules.flatMap(([descriptor]) => descriptor.assets ?? []))]);

export function rendererForCatalogReceipt(receipt) {
  if (!allowlistedCatalogReceipt(receipt)) return null;
  return rendererByReceipt.get(catalogReceiptKey(receipt)) ?? null;
}

export async function renderCatalogForm({ root, dataset, selectedIds = [], selectedTargetId = null, selectedNodeId = null, renderLegacy = null }) {
  const renderer = rendererForCatalogReceipt(dataset?.catalog);
  if (!renderer) throw new Error(`No exact renderer registered for ${String(dataset?.familyId)}/${String(dataset?.memberId)}`);
  const normalizedIds = (Array.isArray(selectedIds) ? selectedIds : [selectedIds]).filter((value) => value !== null && value !== undefined).map(String);
  await renderer(root, dataset, {
    selectedIds: normalizedIds,
    selectedMarkIds: new Set(normalizedIds),
    selectedTargetId: selectedTargetId === null ? null : String(selectedTargetId),
  }, { renderLegacy, selectedNodeId });
}

export const renderNewForm = renderCatalogForm;
