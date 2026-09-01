import { binBounds, canvas, extent, formLabel, format, number, objects, records, scale, selectable, selectedClass, svgElement } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "relationship", memberId: "marginals", fixtureId: "relationship/marginals/fixture-v1" });

export default function renderMarginals(root, dataset, selection) {
  const points = records(dataset, "points");
  const xBins = objects(dataset.payload?.xBins);
  const yBins = objects(dataset.payload?.yBins);
  const x = scale(extent(points.map((point) => number(point.x))), [130, 785]);
  const y = scale(extent(points.map((point) => number(point.y))), [385, 85]);
  const svg = canvas(root, dataset, `${points.length} joint observations with both marginal distributions.`);
  if (xBins.some((bin) => bin.lower !== undefined || bin.x0 !== undefined)) {
    const maxXCount = Math.max(1, ...xBins.map((bin) => binBounds(bin, 0).count));
    xBins.forEach((bin, index) => {
      const bound = binBounds(bin, index);
      const height = 54 * bound.count / maxXCount;
      svg.append(svgElement("rect", { x: x(bound.lower), y: 70 - height, width: Math.max(1, x(bound.upper) - x(bound.lower) - 1), height, class: selectedClass(bin, selection, "marginal-bin"), ...selectable(bin), "aria-label": `x ${format(bound.lower)} to ${format(bound.upper)}: ${format(bound.count)}` }));
    });
  } else {
    xBins.forEach((item) => svg.append(svgElement("line", { x1: x(number(item.value)), x2: x(number(item.value)), y1: 28, y2: 70, class: selectedClass(item, selection, "mark-primary marginal-rug"), ...selectable(item), "aria-label": `x ${format(item.value)}` })));
  }
  if (yBins.some((bin) => bin.lower !== undefined || bin.x0 !== undefined)) {
    const maxYCount = Math.max(1, ...yBins.map((bin) => binBounds(bin, 0).count));
    yBins.forEach((bin, index) => {
      const bound = binBounds(bin, index);
      const width = 75 * bound.count / maxYCount;
      svg.append(svgElement("rect", { x: 800, y: y(bound.upper), width, height: Math.max(1, y(bound.lower) - y(bound.upper) - 1), class: selectedClass(bin, selection, "marginal-bin"), ...selectable(bin), "aria-label": `y ${format(bound.lower)} to ${format(bound.upper)}: ${format(bound.count)}` }));
    });
  } else {
    yBins.forEach((item) => svg.append(svgElement("line", { x1: 800, x2: 875, y1: y(number(item.value)), y2: y(number(item.value)), class: selectedClass(item, selection, "mark-primary marginal-rug"), ...selectable(item), "aria-label": `y ${format(item.value)}` })));
  }
  points.forEach((point) => svg.append(svgElement("circle", { cx: x(number(point.x)), cy: y(number(point.y)), r: 4, class: selectedClass(point, selection), ...selectable(point), "aria-label": `${formLabel(point)}: x ${format(point.x)}, y ${format(point.y)}` })));
}
