import { canvas, formLabel, markId, number, records, scale, selectable, selectedClass, svgElement, targetId, text, thinLabels, truncateToWidth } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "trend", memberId: "period-bars", fixtureId: "trend/period-bars/fixture-v1" });

export default function renderPeriodBars(root, dataset, selection) {
  const periods = records(dataset, "periods", ["bars"]);
  const domain = [Math.min(0, ...periods.map((period) => number(period.value))), Math.max(0, ...periods.map((period) => number(period.value)))];
  const y = scale(domain, [380, 35]);
  const baseline = y(0);
  const band = 820 / Math.max(periods.length, 1);
  const chosen = (item) => {
    const target = targetId(item);
    const mark = markId(item);
    return target ? target === selection.selectedTargetId : Boolean(mark) && selection.selectedMarkIds.has(mark);
  };
  const kept = thinLabels(periods.map((period, index) => ({
    position: 75 + (index + 0.5) * band,
    text: formLabel(period),
    keep: chosen(period),
  })));
  const svg = canvas(root, dataset, `${periods.length} discrete ${text(dataset.payload?.calendarGrain, "calendar")} period totals.`);
  periods.forEach((period, index) => {
    const value = number(period.value);
    const top = Math.min(y(value), baseline);
    svg.append(svgElement("rect", { x: 75 + index * band + 2, y: top, width: Math.max(2, band - 4), height: Math.max(1, Math.abs(y(value) - baseline)), class: selectedClass(period, selection), ...selectable(period), "aria-label": `${formLabel(period)}: ${value}` }));
    if (kept.has(index)) {
      // Thinning already cleared this label's neighbours, so the only bound left
      // is the canvas: a centred label may grow until one side reaches an edge.
      const center = 75 + (index + 0.5) * band;
      svg.append(svgElement("text", { x: center, y: 410, class: "axis-label", "text-anchor": "middle" }, truncateToWidth(formLabel(period), 2 * Math.min(center, 960 - center))));
    }
  });
  svg.append(svgElement("line", { x1: 75, x2: 895, y1: baseline, y2: baseline, class: "axis-line" }));
}
