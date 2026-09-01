import { finite, formLabel, format, hierarchyDepthById, htmlElement, records, selectable, text } from "../shared.js";

export const descriptor = Object.freeze({ familyId: "hierarchy", memberId: "outline", fixtureId: "hierarchy/outline/fixture-v1" });

export default function renderOutline(root, dataset) {
  const nodes = records(dataset, "nodes");
  const depths = hierarchyDepthById(nodes);
  root.replaceChildren();
  const list = htmlElement("ol", "hierarchy-outline");
  list.setAttribute("aria-label", dataset.title);
  list.setAttribute("data-form-id", `${dataset.familyId}/${dataset.memberId}`);
  nodes.forEach((node) => {
    const row = htmlElement("li", "hierarchy-outline__row");
    row.setAttribute("data-depth", String(depths.get(text(node.nodeId ?? node.id)) ?? 0));
    for (const [key, value] of Object.entries(selectable(node))) row.setAttribute(key, value);
    const path = text(node.path, formLabel(node));
    row.setAttribute("aria-label", `${path}${finite(node.value) === null ? "" : `, ${format(node.value)}`}`);
    row.append(htmlElement("span", "hierarchy-outline__path", path), htmlElement("span", "hierarchy-outline__value", finite(node.value) === null ? "" : format(node.value)));
    list.append(row);
  });
  root.append(list);
}
