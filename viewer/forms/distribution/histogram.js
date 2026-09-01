import { binBounds, canvas, extent, horizontalAxis, records, scale, selectable, selectedClass, svgElement } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "distribution", memberId: "histogram", fixtureId: "distribution/histogram/fixture-v1" });

export default function renderHistogram(root, dataset, selection) {
  const bins = records(dataset, "bins");
  const bounds = bins.map(binBounds);
  const xDomain = extent(bounds.flatMap((bin) => [bin.lower, bin.upper]));
  const yDomain = [0, Math.max(1, ...bounds.map((bin) => bin.count))];
  const x = scale(xDomain, [75, 915]);
  const y = scale(yDomain, [380, 35]);
  const svg = canvas(root, dataset, `${bins.length} recorded bins. Selecting a bin resolves its complete evidence membership.`);
  bins.forEach((bin, index) => {
    const bound = bounds[index];
    svg.append(svgElement("rect", { x: x(bound.lower), y: y(bound.count), width: Math.max(1, x(bound.upper) - x(bound.lower) - 1), height: 380 - y(bound.count), class: selectedClass(bin, selection), ...selectable(bin), "aria-label": `${bound.lower} to ${bound.upper}: ${bound.count} observations` }));
  });
  horizontalAxis(svg, xDomain, x, 380, { label: dataset.payload?.axisLabel });
}
