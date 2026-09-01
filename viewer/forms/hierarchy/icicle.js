import { renderPartition } from "./partition.js";

export const descriptor = Object.freeze({ familyId: "hierarchy", memberId: "icicle", fixtureId: "hierarchy/icicle/fixture-v1" });

export default function renderIcicle(root, dataset, selection) {
  return renderPartition(root, dataset, selection, "icicle");
}
