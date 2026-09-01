import { canvas, extent, formLabel, markId, records, scale, selectable, selectedClass, svgElement, text, thinLabels, truncateToWidth } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "timeline", memberId: "event-strip", fixtureId: "timeline/event-strip/fixture-v1" });

function comparableTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

export default function renderEventStrip(root, dataset, selection) {
  const events = records(dataset, "events");
  const times = events.map((event) => comparableTime(event.time ?? event.timestamp));
  const x = scale(extent(times), [70, 900]);
  const dense = events.length > 80;
  const selected = (event) => {
    const id = markId(event);
    return id !== null && selection.selectedMarkIds.has(id);
  };
  // One em of clear space at the label's 12px size is what reads as separation
  // between neighbouring centred labels strung along a continuous rug.
  const kept = thinLabels(
    events.map((event, index) => ({ position: x(times[index]), text: formLabel(event), keep: selected(event) })),
    { minGap: 12 },
  );
  const svg = canvas(
    root,
    dataset,
    `${events.length} instantaneous events in one context.${kept.size < events.length ? " Labels are sampled for density; every event remains evidence-selectable." : ""}`,
  );
  svg.append(svgElement("line", { x1: 70, x2: 900, y1: 225, y2: 225, class: "axis-line" }));
  events.forEach((event, index) => {
    const position = x(times[index]);
    const above = index % 2 === 0;
    const showLabel = kept.has(index);
    const endpoint = dense ? (above ? 205 : 245) : (above ? 105 : 345);
    const label = `${formLabel(event)} at ${text(event.time ?? event.timestamp)}`;
    if (dense) {
      svg.append(svgElement("line", {
        x1: position,
        x2: position,
        y1: 225,
        y2: endpoint,
        class: selectedClass(event, selection, "mark-primary event-rug"),
        ...selectable(event),
        "aria-label": label,
      }));
    } else {
      svg.append(
        svgElement("line", { x1: position, x2: position, y1: 225, y2: endpoint, class: "event-stem" }),
        svgElement("circle", { cx: position, cy: 225, r: 5, class: selectedClass(event, selection), ...selectable(event), "aria-label": label }),
      );
    }
    // The first and last labels are kept unconditionally, so only the canvas
    // edge bounds them; every other kept label already cleared its neighbours.
    if (showLabel) svg.append(svgElement("text", {
      x: position,
      y: dense ? (above ? 190 : 263) : (above ? 92 : 363),
      class: "mark-label event-sampled-label",
      "text-anchor": "middle",
    }, truncateToWidth(formLabel(event), 2 * Math.min(position, 960 - position))));
  });
  if (kept.size < events.length) svg.append(svgElement(
    "text",
    { x: 70, y: 420, class: "axis-label" },
    `Showing ${kept.size} sampled labels; all ${events.length} events remain selectable.`,
  ));
}
