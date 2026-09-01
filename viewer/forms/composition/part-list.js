import { canvas, formLabel, format, number, records, scale, selectable, selectedClass, svgElement, text, truncateToWidth } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "composition", memberId: "part-list", fixtureId: "composition/part-list/fixture-v1" });

export default function renderPartList(root, dataset, selection) {
  const parts = records(dataset, "parts");
  const total = number(dataset.payload?.total, parts.reduce((sum, part) => sum + Math.max(0, number(part.value)), 0));
  const x = scale([0, Math.max(1, ...parts.map((part) => number(part.value)))], [250, 780]);
  const rowHeight = Math.min(42, 360 / Math.max(parts.length, 1));
  const svg = canvas(root, dataset, `${parts.length} non-negative parts of ${text(dataset.payload?.whole, "one whole")}.`);
  parts.forEach((part, index) => {
    const y = 30 + index * rowHeight;
    const amount = Math.max(0, number(part.value));
    const share = total > 0 ? number(part.share, amount / total) : 0;
    svg.append(
      svgElement("text", { x: 235, y: y + 4, class: "mark-label", "text-anchor": "end" }, truncateToWidth(formLabel(part), 235)),
      svgElement("line", { x1: 250, x2: x(amount), y1: y, y2: y, class: "connector" }),
      svgElement("circle", { cx: x(amount), cy: y, r: 5, class: selectedClass(part, selection), ...selectable(part), "aria-label": `${formLabel(part)}: ${format(amount)}, ${format(share * 100)} percent` }),
      svgElement("text", { x: 800, y: y + 4, class: "value-label" }, truncateToWidth(`${format(amount)} · ${format(share * 100)}%`, 155)),
    );
  });
}
