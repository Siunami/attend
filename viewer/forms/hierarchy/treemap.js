import { renderPartition } from "./partition.js";

export const descriptor = Object.freeze({ familyId: "hierarchy", memberId: "treemap", fixtureId: "hierarchy/treemap/fixture-v1" });

export default function renderTreemap(root, dataset, selection) {
  return renderPartition(root, dataset, selection, "treemap");
}
