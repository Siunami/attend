import { canvas, extent, formLabel, format, horizontalAxis, markId, number, records, scale, selectable, selectedClass, svgElement, targetId, thinLabels, truncateToWidth } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "rank", memberId: "dot-plot", fixtureId: "rank/dot-plot/fixture-v1" });

export default function renderDotPlot(root, dataset, selection) {
  const items = records(dataset, "items");
  const domain = extent(items.map((item) => number(item.value)));
  const x = scale(domain, [245, 900]);
  const rowHeight = Math.max(12, Math.min(30, 640 / Math.max(items.length, 1)));
  const height = Math.max(300, 64 + items.length * rowHeight);
  const chosen = (item) => {
    const target = targetId(item);
    const mark = markId(item);
    return target ? target === selection.selectedTargetId : Boolean(mark) && selection.selectedMarkIds.has(mark);
  };
  const kept = rowHeight < 14
    ? thinLabels(items.map((item, index) => ({ position: 24 + index * rowHeight, size: 12, keep: chosen(item) })))
    : null;
  const svg = canvas(root, dataset, `${items.length} named values shown as position on a common scale.`, height);
  items.forEach((item, index) => {
    const y = 24 + index * rowHeight;
    if (!kept || kept.has(index)) {
      svg.append(svgElement("text", { x: 230, y: y + 4, class: "mark-label", "text-anchor": "end" }, truncateToWidth(formLabel(item), 230)));
    }
    svg.append(svgElement("circle", { cx: x(number(item.value)), cy: y, r: Math.max(3, Math.min(6, rowHeight / 4)), class: selectedClass(item, selection), ...selectable(item), "aria-label": `${formLabel(item)}: ${format(item.value)}` }));
  });
  horizontalAxis(svg, domain, x, height - 45, { label: dataset.payload?.axisLabel });
}
