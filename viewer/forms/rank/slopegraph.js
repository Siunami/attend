import { array, canvas, extent, finite, formLabel, format, number, records, scale, selectable, selectedClass, svgElement, text } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "rank", memberId: "slopegraph", fixtureId: "rank/slopegraph/fixture-v1" });

function endpoints(segment, states) {
  const start = segment.start ?? segment.values?.[0] ?? {};
  const end = segment.end ?? segment.values?.[1] ?? {};
  return {
    start: { state: text(start.state ?? start.label, states[0] ?? "Start"), value: number(start.value), rank: finite(start.rank) },
    end: { state: text(end.state ?? end.label, states[1] ?? "End"), value: number(end.value), rank: finite(end.rank) },
  };
}

export default function renderSlopegraph(root, dataset, selection) {
  const segments = records(dataset, "segments", ["items"]);
  const states = array(dataset.payload?.states).map((state) => text(state.label ?? state));
  const pairs = segments.map((segment) => endpoints(segment, states));
  const domain = extent(pairs.flatMap((pair) => [pair.start.rank ?? pair.start.value, pair.end.rank ?? pair.end.value]));
  const height = Math.max(450, 96 + segments.length * 24);
  const y = scale(domain, [48, height - 48]);
  const svg = canvas(
    root,
    dataset,
    `${segments.length} items compared across exactly two ordered states. Canvas height preserves endpoint-label spacing.`,
    height,
  );
  const startX = 245;
  const endX = 715;
  svg.append(
    svgElement("text", { x: startX, y: 25, class: "axis-label", "text-anchor": "middle" }, pairs[0]?.start.state ?? "Start"),
    svgElement("text", { x: endX, y: 25, class: "axis-label", "text-anchor": "middle" }, pairs[0]?.end.state ?? "End"),
  );
  segments.forEach((segment, index) => {
    const pair = pairs[index];
    const startY = y(pair.start.rank ?? pair.start.value);
    const endY = y(pair.end.rank ?? pair.end.value);
    const label = formLabel(segment);
    svg.append(
      svgElement("line", { x1: startX, y1: startY, x2: endX, y2: endY, class: selectedClass(segment, selection, "slope-segment"), ...selectable(segment), "aria-label": `${label}: ${format(pair.start.value)} to ${format(pair.end.value)}` }),
      svgElement("text", { x: startX - 12, y: startY + 4, class: "mark-label", "text-anchor": "end" }, `${label} ${format(pair.start.value)}`),
      svgElement("text", { x: endX + 12, y: endY + 4, class: "mark-label" }, `${format(pair.end.value)} ${label}`),
    );
  });
}
