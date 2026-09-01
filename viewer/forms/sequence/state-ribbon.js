import { canvas, formLabel, number, records, selectable, selectedClass, svgElement, truncateToWidth } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "sequence", memberId: "state-ribbon", fixtureId: "sequence/state-ribbon/fixture-v1" });

export default function renderStateRibbon(root, dataset, selection) {
  const states = records(dataset, "states");
  const durations = states.map((state) => Math.max(0, number(state.duration)));
  const total = durations.reduce((sum, duration) => sum + duration, 0) || 1;
  const svg = canvas(root, dataset, `${states.length} ordered observed states; width encodes duration.`, 300);
  let cursor = 55;
  states.forEach((state, index) => {
    const width = 850 * (durations[index] / total);
    svg.append(svgElement("rect", { x: cursor, y: 95, width: Math.max(1, width), height: 92, class: selectedClass(state, selection, `state-ribbon state-ribbon--${index % 4}`), ...selectable(state), "aria-label": `${formLabel(state)}: duration ${durations[index]}` }));
    const label = truncateToWidth(formLabel(state), width - 4);
    if (label) svg.append(svgElement("text", { x: cursor + width / 2, y: 145, class: "state-ribbon__label", "text-anchor": "middle" }, label));
    cursor += width;
  });
}
