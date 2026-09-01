import { canvas, formLabel, number, records, scale, selectable, selectedClass, svgElement, text } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "region-map", memberId: "region-symbols", fixtureId: "region-map/region-symbols/fixture-v1", assets: ["vendor/d3.min.js", "vendor/topojson-client.min.js", "vendor/us-states.json"] });

const TERRITORY_INSETS = Object.freeze({
  "60": Object.freeze({ x: 105, abbreviation: "AS", label: "American Samoa" }),
  "66": Object.freeze({ x: 285, abbreviation: "GU", label: "Guam" }),
  "69": Object.freeze({ x: 465, abbreviation: "MP", label: "Northern Mariana Islands" }),
  "72": Object.freeze({ x: 645, abbreviation: "PR", label: "Puerto Rico" }),
  "78": Object.freeze({ x: 825, abbreviation: "VI", label: "U.S. Virgin Islands" }),
});

export default async function renderRegionSymbols(root, dataset, selection) {
  const regions = records(dataset, "regions");
  if (!globalThis.d3 || !globalThis.topojson) throw new Error("Bundled geography renderer is unavailable.");
  const response = await fetch("vendor/us-states.json", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Bundled US geography could not be loaded.");
  const topology = await response.json();
  const object = topology.objects?.states ?? Object.values(topology.objects ?? {})[0];
  const features = globalThis.topojson.feature(topology, object).features;
  const featureById = new Map(features.map((feature) => [String(feature.id).padStart(2, "0"), feature]));
  const projection = globalThis.d3.geoAlbersUsa().fitExtent([[35, 30], [925, 385]], { type: "FeatureCollection", features });
  const path = globalThis.d3.geoPath(projection);
  const radius = scale([0, Math.sqrt(Math.max(1, ...regions.map((region) => number(region.value))))], [4, 28]);
  const placements = regions.map((region) => {
    const regionId = text(region.fips ?? region.regionId ?? region.region).padStart(2, "0");
    const territory = TERRITORY_INSETS[regionId];
    const feature = featureById.get(regionId);
    const supplied = [Number(region.x ?? region.longitude), Number(region.y ?? region.latitude)];
    const center = territory
      ? [territory.x, 438]
      : supplied.every(Number.isFinite)
        ? (Math.abs(supplied[0]) <= 180 && Math.abs(supplied[1]) <= 90 ? projection(supplied) : supplied)
        : feature ? path.centroid(feature) : null;
    return { region, regionId, center };
  });
  const unresolved = placements.filter(({ center }) => !center || !center.every(Number.isFinite));
  if (unresolved.length) {
    throw new Error(`Bundled US geography has no separable center for ${unresolved.map(({ region }) => formLabel(region)).join(", ")}.`);
  }

  const svg = canvas(
    root,
    dataset,
    `${regions.length} US region totals encoded by symbol area. The five territories use labeled, separated insets whose positions are not geographic.`,
    535,
  );
  features.forEach((feature) => {
    const geometry = path(feature);
    if (geometry) svg.append(svgElement("path", { d: geometry, class: "map-boundary", "aria-hidden": "true" }));
  });
  Object.values(TERRITORY_INSETS).forEach((inset) => {
    svg.append(
      svgElement("rect", { x: inset.x - 76, y: 403, width: 152, height: 72, rx: 3, class: "territory-inset", "aria-hidden": "true" }),
      svgElement("text", { x: inset.x, y: 421, class: "axis-label", "text-anchor": "middle", "aria-hidden": "true" }, inset.abbreviation),
      svgElement("text", { x: inset.x, y: 494, class: "territory-inset-label", "text-anchor": "middle", "aria-hidden": "true" }, inset.label),
    );
  });
  placements.forEach(({ region, regionId, center }) => {
    svg.append(svgElement("circle", {
      cx: center[0],
      cy: center[1],
      r: radius(Math.sqrt(Math.max(0, number(region.value)))),
      class: selectedClass(region, selection, "region-symbol"),
      ...selectable(region),
      "data-region-id": regionId,
      "aria-label": `${formLabel(region)}: ${number(region.value)}`,
    }));
  });
  svg.append(svgElement("text", { x: 925, y: 522, class: "map-note", "text-anchor": "end" }, "Territories use separated insets; inset positions are not geographic."));
}
