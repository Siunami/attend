import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  CATALOG_COUNTS,
  CATALOG_VERSION,
  CATALOG_FAMILIES,
  listCatalogFamilies,
  requireExecutableCatalogMember,
} from "../src/catalog/index.js";
import { getMapFamily } from "../src/map-families/registry.js";
import { AUTHORED_FAMILY_ATLAS_CONTENT } from "../src/catalog/snapshot.js";
import { FORM_REQUIREMENT_KINDS, assertSupportedFormRequirement } from "../src/forms/index.js";
import { assertRepresentationIntentSupported } from "../src/representation-intent.js";

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
    documented: 71,
    executable: 34,
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
      assert.deepEqual(family.executableMemberIds, []);
      assert.match(unavailable[0].unavailableReason, /visible specimen/u);
      continue;
    }
    assert.ok(executable.length >= 1, `${family.id} must expose executable members`);
    assert.equal(unavailable.length, 0, family.id);
    assert.deepEqual(executable.map((member) => member.id), family.executableMemberIds);
    for (const member of executable) {
      assert.equal(requireExecutableCatalogMember(family.id, member.id), member);
      assert.equal(member.rendererId, getMapFamily(family.id).renderer.id);
    }
  }
});

test("catalog members expose structured authored data requirements and honest renderer bindings", () => {
  const incumbents = {
    sequence: "step-strip",
    rank: "bar-list",
    profile: "parallel",
    network: "local",
    flow: "sankey",
    "collection-atlas": "faceted-atlas",
    "point-map": "exact-points",
    mechanism: "flowchart",
  };
  const executable = (familyId) => requireExecutableCatalogMember(familyId, incumbents[familyId]);
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
  assert.deepEqual(executable("collection-atlas").roleSchema.required, ["label", "cluster"]);
  assert.deepEqual(Object.keys(executable("collection-atlas").roleSchema.properties), ["label", "cluster", "order"]);
  const sampleRaster = requireExecutableCatalogMember("field", "sample-raster");
  assert.equal(sampleRaster.authoredBand, "20–250,000 cells; ≥2 px per visible cell");
  assert.deepEqual(sampleRaster.requirements.find((item) => item.id === "record-count"), {
    id: "record-count",
    kind: "record-count",
    minimum: 20,
    maximum: 2_500,
  });
});

test("catalog generation fails closed on unknown exact-form requirement kinds", () => {
  const supported = new Set(FORM_REQUIREMENT_KINDS);
  for (const family of CATALOG_FAMILIES) {
    for (const member of family.members.filter((item) => item.status === "executable")) {
      for (const requirement of member.requirements) {
        assert.ok(supported.has(requirement.kind), `${family.id}/${member.id}/${requirement.id}`);
        assert.equal(assertSupportedFormRequirement(requirement), requirement);
      }
    }
  }
  assert.throws(
    () => assertSupportedFormRequirement({ id: "typo", kind: "record-cont" }),
    (error) => error.code === "UNKNOWN_FORM_REQUIREMENT",
  );
});

test("executable members publish finite representation capabilities", () => {
  const mechanism = requireExecutableCatalogMember("mechanism", "flowchart");
  assert.deepEqual(mechanism.representationCapabilities, {
    version: 1,
    constraints: {
      dimensionality: ["2d"],
      form: ["flowchart"],
      interaction: ["selection"],
      motion: ["static"],
      projection: ["none"],
    },
  });

  const executable = CATALOG_FAMILIES.flatMap((family) => family.members
    .filter((member) => member.status === "executable")
    .map((member) => ({ family, member })));
  assert.equal(executable.length, 34);
  for (const { family, member } of executable) {
    assert.deepEqual(member.representationCapabilities.constraints.form, [member.id], `${family.id}/${member.id}`);
    assert.deepEqual(member.representationCapabilities.constraints.interaction, ["selection"], `${family.id}/${member.id}`);
    assert.equal(member.representationCapabilities.constraints.interaction.includes("pan-zoom"), false, `${family.id}/${member.id}`);
  }

  const pointMap = requireExecutableCatalogMember("point-map", "exact-points");
  assert.deepEqual(pointMap.representationCapabilities.constraints.projection, ["geographic"]);
  assert.equal(mechanism.representationCapabilities.constraints.dimensionality.includes("3d"), false);
  assert.equal(mechanism.representationCapabilities.constraints.interaction.includes("orbit"), false);
});

test("exact representation intent accepts only member-owned form and implemented interaction capabilities", () => {
  const intent = (kind, value) => ({ version: 1, mode: "exact", constraints: [{ kind, value }] });
  const cases = [
    ["composition", "hundred-bar", "form", "normalized-parts"],
    ["collection-atlas", "faceted-atlas", "form", "contact-atlas"],
    ["point-map", "exact-points", "interaction", "pan-zoom"],
  ];
  for (const [familyId, memberId, kind, value] of cases) {
    const family = CATALOG_FAMILIES.find((item) => item.id === familyId);
    const member = requireExecutableCatalogMember(familyId, memberId);
    assert.throws(
      () => assertRepresentationIntentSupported(intent(kind, value), { family, member }),
      (error) => error.code === "UNSUPPORTED_REQUESTED_REPRESENTATION",
      `${familyId}/${memberId} ${kind}=${value}`,
    );
    assert.deepEqual(
      assertRepresentationIntentSupported(intent("form", memberId), { family, member }),
      intent("form", memberId),
    );
  }
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
