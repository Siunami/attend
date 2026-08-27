import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  CATALOG_COUNTS,
  CATALOG_VERSION,
  CATALOG_FAMILIES,
  executableCatalogMemberForFamily,
  listCatalogFamilies,
} from "../src/catalog/index.js";
import { getMapFamily } from "../src/map-families/registry.js";
import { AUTHORED_FAMILY_ATLAS_CONTENT } from "../src/catalog/snapshot.js";

const AUTHORED_IDS = [
  "annotated-specimen",
  "collection-atlas",
  "composition",
  "distribution",
  "field",
  "flow",
  "hierarchy",
  "matrix",
  "mechanism",
  "network",
  "passage-comparison",
  "point-map",
  "profile",
  "rank",
  "region-map",
  "relationship",
  "sequence",
  "timeline",
  "trend",
];

const AUTHORED_CONTENT_DIRECTORY = new URL("../../family-atlas/content/", import.meta.url);
const HAS_AUTHORED_CONTENT = existsSync(AUTHORED_CONTENT_DIRECTORY);

function canonicalProjection(content) {
  return {
    id: content.id,
    title: content.title,
    question: content.question,
    oneLine: content.oneLine,
    abstain: content.abstain
      ? {
          question: content.abstain.question,
          why: content.abstain.why,
          instead: content.abstain.instead,
          note: content.abstain.note,
        }
      : null,
    members: content.members.map(({ id, name, when, good, band, lineage, status }) => ({
      id,
      name,
      when,
      good,
      band,
      lineage,
      status,
    })),
  };
}

test("generated Family Atlas catalog snapshots the exact inventory and does not advertise a text-only specimen renderer", () => {
  const families = listCatalogFamilies();
  assert.match(CATALOG_VERSION, /^[a-f0-9]{16}$/u);
  assert.deepEqual(CATALOG_COUNTS, {
    families: 19,
    approved: 106,
    documented: 87,
    executable: 18,
    unavailable: 1,
    rejected: 38,
  });
  assert.equal(families.length, 19);
  for (const family of families) {
    const executable = family.members.filter((member) => member.status === "executable");
    const unavailable = family.members.filter((member) => member.status === "unavailable");
    if (family.id === "annotated-specimen") {
      assert.equal(executable.length, 0);
      assert.equal(unavailable.length, 1);
      assert.equal(unavailable[0].id, "callout-overlay");
      assert.equal(family.executableMemberId, null);
      assert.match(unavailable[0].unavailableReason, /visible specimen/u);
      continue;
    }
    assert.equal(executable.length, 1, `${family.id} must expose exactly one executable member`);
    assert.equal(unavailable.length, 0, family.id);
    assert.equal(executable[0].id, family.executableMemberId);
    assert.equal(executableCatalogMemberForFamily(family.id).id, family.executableMemberId);
    assert.equal(
      getMapFamily(family.id).variants.some((variant) => variant.id === executable[0].rendererVariantId),
      true,
      `${family.id}/${executable[0].id} must bind one declared renderer variant`,
    );
  }
});

test("catalog members expose structured authored data requirements and honest renderer bindings", () => {
  const executable = (familyId) => executableCatalogMemberForFamily(familyId);
  const requirement = (familyId, id) => executable(familyId).requirements.find((item) => item.id === id);

  assert.deepEqual(
    Object.fromEntries(["sequence", "point-map", "mechanism"].map((familyId) => {
      const member = executable(familyId);
      return [familyId, { member: member.id, variant: member.rendererVariantId }];
    })),
    {
      sequence: { member: "step-strip", variant: "storyboard" },
      "point-map": { member: "exact-points", variant: "dot-map" },
      mechanism: { member: "flowchart", variant: "system-schematic" },
    },
  );
  assert.deepEqual(requirement("rank", "record-count"), {
    id: "record-count", kind: "record-count", minimum: 3, maximum: 40,
  });
  assert.deepEqual(requirement("profile", "complete-entity-dimension-grid"), {
    id: "complete-entity-dimension-grid", kind: "complete-cartesian", fields: ["entity", "dimension"],
  });
  assert.deepEqual(requirement("network", "bounded-sparse-network"), {
    id: "bounded-sparse-network",
    kind: "directed-graph",
    sourceField: "source",
    targetField: "target",
    minimumNodes: 5,
    maximumNodes: 100,
    connected: "weak",
    allowSelfEdges: false,
    allowDuplicateEdges: false,
    maximumEdgesPerNode: 3,
  });
  assert.deepEqual(requirement("flow", "bounded-directed-flow"), {
    id: "bounded-directed-flow",
    kind: "directed-flow",
    sourceField: "source",
    targetField: "target",
    valueField: "value",
    minimumValue: 0,
    minimumStages: 2,
    maximumStages: 5,
    maximumNodes: 30,
    stageDerivation: "topological-depth",
    stageFieldPolicy: "evidenced-link-label-only",
    conservationGaps: "derive-and-render",
    allowSelfEdges: false,
    allowDuplicateEdges: false,
    acyclic: true,
  });
  assert.deepEqual(requirement("collection-atlas", "bounded-clusters"), {
    id: "bounded-clusters",
    kind: "group-size",
    field: "cluster",
    minimumGroups: 2,
    maximumGroups: 12,
    minimumItems: 5,
    maximumItems: 200,
  });
});

test("executable members publish finite representation capabilities", () => {
  const mechanism = executableCatalogMemberForFamily("mechanism");
  assert.deepEqual(mechanism.representationCapabilities, {
    version: 1,
    constraints: {
      dimensionality: ["2d"],
      form: ["flowchart", "system-schematic"],
      interaction: ["selection"],
      motion: ["static"],
      projection: ["none"],
    },
  });

  const pointMap = executableCatalogMemberForFamily("point-map");
  assert.deepEqual(pointMap.representationCapabilities.constraints.interaction, [
    "pan-zoom",
    "selection",
  ]);
  assert.deepEqual(pointMap.representationCapabilities.constraints.projection, ["geographic"]);
  assert.equal(mechanism.representationCapabilities.constraints.dimensionality.includes("3d"), false);
  assert.equal(mechanism.representationCapabilities.constraints.interaction.includes("orbit"), false);
});

test("bundled catalog snapshot preserves the complete authored inventory", () => {
  const snapshotStatuses = AUTHORED_FAMILY_ATLAS_CONTENT.flatMap((family) =>
    family.members.map((member) => ({
      family: family.id,
      member: member.id,
      status: member.status,
      rejectionText: member.status === "rejected" ? member.good : null,
    })),
  );
  assert.equal(snapshotStatuses.length, 144);
  assert.equal(
    snapshotStatuses.filter((member) => member.status !== "rejected").length,
    CATALOG_COUNTS.approved,
  );
  assert.equal(
    snapshotStatuses.filter((member) => member.status === "rejected").length,
    CATALOG_COUNTS.rejected,
  );
  assert.deepEqual(
    CATALOG_FAMILIES.flatMap((family) =>
      family.members
        .filter((member) => member.status === "rejected")
        .map((member) => ({
          family: family.id,
          member: member.id,
          rejectionText: member.rejectionReason,
        })),
    ),
    snapshotStatuses
      .filter((member) => member.status === "rejected")
      .map(({ family, member, rejectionText }) => ({ family, member, rejectionText })),
  );
});

test("bundled catalog snapshot stays in sync with authored Family Atlas content", {
  skip: HAS_AUTHORED_CONTENT ? false : "Family Atlas authored source is not present in this checkout",
}, async () => {
  const authored = await Promise.all(AUTHORED_IDS.map(async (id) => {
    const module = await import(new URL(`${id}.js`, AUTHORED_CONTENT_DIRECTORY));
    return canonicalProjection(module.default);
  }));

  assert.deepEqual(AUTHORED_FAMILY_ATLAS_CONTENT, authored);
});
