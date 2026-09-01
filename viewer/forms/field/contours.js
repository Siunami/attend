import { array, canvas, number, objects, records, selectable, selectedClass, svgElement, text } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "field", memberId: "contours", fixtureId: "field/contours/fixture-v1", assets: ["vendor/d3.min.js"] });

export default function renderContours(root, dataset, selection) {
  const cells = records(dataset, "cells", ["samples"]);
  const columns = number(dataset.payload?.columns ?? dataset.payload?.width, new Set(cells.map((cell) => cell.x)).size);
  const rows = number(dataset.payload?.rows ?? dataset.payload?.height, new Set(cells.map((cell) => cell.y)).size);
  const levels = objects(dataset.payload?.levels);
  const thresholds = levels.length ? levels.map((level) => number(level.threshold ?? level.value)) : array(dataset.payload?.thresholds).map(number);
  if (!globalThis.d3?.contours || columns < 1 || rows < 1 || cells.length !== columns * rows) throw new Error("The contour payload is not a complete regular grid.");
  const ordered = [...cells].sort((left, right) => number(left.row ?? left.y) - number(right.row ?? right.y) || number(left.column ?? left.x) - number(right.column ?? right.x));
  const contours = globalThis.d3.contours().size([columns, rows]).thresholds(thresholds)(ordered.map((cell) => number(cell.value)));
  const path = globalThis.d3.geoPath(globalThis.d3.geoIdentity().scale(Math.min(820 / columns, 360 / rows)).translate([70, 40]));
  const svg = canvas(root, dataset, `${contours.length} recorded contour thresholds over a complete ${columns} by ${rows} grid.`);
  contours.forEach((contour, index) => {
    const level = levels[index] ?? { targetId: `contour-${index}`, label: `Level ${contour.value}` };
    svg.append(svgElement("path", { d: path(contour), class: selectedClass(level, selection, `contour-level contour-level--${index % 4}`), ...selectable(level), "aria-label": `${text(level.label, "Contour")}: ${contour.value}` }));
  });
}
