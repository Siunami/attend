import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

import SAMPLE_SOURCES from "../viewer/family-datasets.js";
import { toCompilerRequest } from "../viewer/family-compiler-adapter.js";
import {
  ATLAS_CATALOG_VERSION,
  atlasPackageToRenderModel,
  catalogReceiptForFamily,
  isAtlasPackage,
} from "../viewer/package-model.js";
import { ATLAS_ASSET_PATHS } from "../viewer/package-renderer.js";
import { RENDERER_IDS, renderFamily } from "../viewer/family-renderers.js";
import { CATALOG_VERSION, getCatalogFamily } from "../src/catalog/index.js";
import { MAP_FAMILIES } from "../src/map-families/registry.js";
import { compileMap } from "../src/pipeline/compile.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_ROOT = join(HERE, "..", "viewer");
const vendorContext = {};
runInNewContext(await readFile(join(VIEWER_ROOT, "vendor", "d3.min.js"), "utf8"), vendorContext);
runInNewContext(
  await readFile(join(VIEWER_ROOT, "vendor", "topojson-client.min.js"), "utf8"),
  vendorContext,
);
const { d3, topojson } = vendorContext;
const [statesTopology, countiesTopology, worldTopology] = await Promise.all([
  readFile(join(VIEWER_ROOT, "vendor", "us-states.json"), "utf8").then(JSON.parse),
  readFile(join(VIEWER_ROOT, "vendor", "us-counties.json"), "utf8").then(JSON.parse),
  readFile(join(VIEWER_ROOT, "vendor", "world-countries.json"), "utf8").then(JSON.parse),
]);
const FAMILY_IDS = [
  "rank", "distribution", "composition", "profile", "passage-comparison", "trend",
  "timeline", "sequence", "relationship", "matrix", "hierarchy", "network", "flow",
  "mechanism", "region-map", "point-map", "field", "annotated-specimen", "collection-atlas",
];

const MINIMAL_COLLECTIONS = Object.freeze({
  rank: "items",
  distribution: "observations",
  composition: "parts",
  profile: "measurements",
  "passage-comparison": "passages",
  trend: "points",
  timeline: "events",
  sequence: "steps",
  relationship: "points",
  matrix: "cells",
  hierarchy: "nodes",
  network: "edges",
  flow: "links",
  mechanism: "links",
  "region-map": "regions",
  "point-map": "points",
  field: "samples",
  "annotated-specimen": "annotations",
  "collection-atlas": "items",
});

// Reuse each real compiler package, then remove every optional role from its
// first canonical mark/record. This leaves an honest required-only package
// without inventing evidence ids or a parallel test schema.
async function minimalRequiredPackage(familyId, manifest) {
  const compiled = await compileMap(await toCompilerRequest(SAMPLE_SOURCES[familyId], manifest));
  const required = new Set(manifest.data.requiredRoles.map((role) => role.id));
  const mark = compiled.marks[0];
  const values = Object.fromEntries(Object.entries(mark.values).filter(([key]) => required.has(key)));
  const minimalMark = {
    ...mark,
    label: String(values.label ?? mark.id),
    values,
  };
  const payload = { ...compiled.payload };
  const collection = MINIMAL_COLLECTIONS[familyId];
  if (collection && Array.isArray(payload[collection])) {
    payload[collection] = payload[collection]
      .filter((record) => record.markId === mark.id)
      .slice(0, 1)
      .map((record) => Object.fromEntries(
        Object.entries(record).filter(([key]) => key === "markId" || required.has(key)),
      ));
  }
  return { ...compiled, payload, marks: [minimalMark] };
}

class MiniElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this._text = "";
    const owner = this;
    this.dataset = new Proxy({}, {
      set(target, key, value) {
        target[key] = String(value);
        owner.setAttribute(`data-${String(key).replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`, value);
        return true;
      },
    });
  }

  set textContent(value) { this._text = String(value); }
  get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join("")}`; }
  set className(value) { this.setAttribute("class", value); }
  get className() { return this.getAttribute("class") ?? ""; }
  append(...nodes) {
    for (const node of nodes.flat()) {
      if (node === undefined || node === null) continue;
      this.children.push(node);
      if (typeof node === "object") node.parentNode = this;
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
  click() { this.dispatchEvent({ type: "click" }); }
  querySelectorAll(selector) {
    const attribute = /^\[([a-z-]+)\]$/u.exec(selector)?.[1] ?? null;
    const matches = [];
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if (attribute && child?.getAttribute?.(attribute) !== null) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
  toString() {
    const attributes = [...this.attributes].map(([key, value]) => `${key}=${value}`).join(" ");
    return `<${this.tagName} ${attributes}>${this._text}${this.children.map(String).join("")}</${this.tagName}>`;
  }
}

class MiniDocument {
  createElement(name) { return new MiniElement(name); }
  createElementNS(_namespace, name) { return new MiniElement(name); }
}

function descendants(root) {
  const values = [];
  const visit = (node) => {
    for (const child of node.children ?? []) {
      values.push(child);
      visit(child);
    }
  };
  visit(root);
  return values;
}

function markPositions(root) {
  return Object.fromEntries(root.querySelectorAll("[data-mark-id]").map((mark) => [
    mark.getAttribute("data-mark-id"),
    {
      x: mark.getAttribute("x"),
      y: mark.getAttribute("y"),
      width: mark.getAttribute("width"),
      height: mark.getAttribute("height"),
    },
  ]));
}

async function withMiniRenderer(callback) {
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    window: globalThis.window,
    d3: globalThis.d3,
    topojson: globalThis.topojson,
    fetch: globalThis.fetch,
  };
  globalThis.document = new MiniDocument();
  globalThis.HTMLElement = MiniElement;
  globalThis.MouseEvent = class {};
  globalThis.window = {};
  globalThis.d3 = d3;
  globalThis.topojson = topojson;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => {
      const path = String(url);
      if (path.includes("us-counties")) return countiesTopology;
      if (path.includes("us-states")) return statesTopology;
      return worldTopology;
    },
  });
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test("atlas package model rejects non-canonical or unallowlisted package shapes", () => {
  assert.equal(isAtlasPackage({ schemaVersion: 1, rows: [] }), false);
  assert.equal(isAtlasPackage({
    kind: "attend-data-package",
    schemaVersion: 2,
    id: "data_test",
    family: { id: "rank" },
    catalog: { version: "test", family: "rank", member: "not-a-member", rendererId: "attend-rank", rendererVariantId: "bar-list", rendererVersion: 1 },
    payload: { items: [] },
    marks: [],
  }), false);
});

test("browser catalog authority is pinned to the bundled catalog version", async () => {
  assert.equal(ATLAS_CATALOG_VERSION, CATALOG_VERSION);
  const manifest = MAP_FAMILIES.find((candidate) => candidate.id === "rank");
  const packageValue = await compileMap(await toCompilerRequest(SAMPLE_SOURCES.rank, manifest));
  assert.equal(isAtlasPackage(packageValue), true);
  assert.equal(isAtlasPackage({
    ...packageValue,
    catalog: { ...packageValue.catalog, version: "0000000000000000" },
  }), false);
});

test("the package renderer has explicit self-hosted asset paths", () => {
  assert.deepEqual(ATLAS_ASSET_PATHS, [
    "vendor/d3.min.js",
    "vendor/topojson-client.min.js",
    "vendor/us-states.json",
    "vendor/us-counties.json",
    "vendor/world-countries.json",
  ]);
});

test("all nineteen catalog families retain one fixed renderer grammar", () => {
  assert.deepEqual([...RENDERER_IDS].sort(), [...FAMILY_IDS].sort());
});

test("numeric renderers use supplied domains and neutral labels", async () => {
  await withMiniRenderer(async () => {
    const distribution = new MiniElement("div");
    await renderFamily({
      root: distribution,
      dataset: {
        familyId: "distribution",
        title: "Observed scores",
        roles: { label: "label", value: "value", group: "group" },
        records: [
          { markId: "dist-a", label: "Low", value: -3.5, group: "East" },
          { markId: "dist-b", label: "High", value: 7.25, group: "East" },
        ],
      },
    });
    assert.match(distribution.textContent, /supplied value extent is -3\.5 to 7\.25/u);
    assert.match(distribution.textContent, /Observed value/u);
    assert.doesNotMatch(distribution.textContent, /minutes|work types/iu);

    const composition = new MiniElement("div");
    await renderFamily({
      root: composition,
      dataset: {
        familyId: "composition",
        title: "Observed whole",
        roles: { series: "whole", part: "part", value: "value" },
        records: [
          { markId: "part-a", whole: "Case", part: "Base", value: 2 },
          { markId: "part-b", whole: "Case", part: "Remainder", value: 3 },
        ],
      },
    });
    assert.match(composition.textContent, /Total 5/u);
    assert.doesNotMatch(composition.textContent, /hours|activity categories/iu);

    const profile = new MiniElement("div");
    await renderFamily({
      root: profile,
      dataset: {
        familyId: "profile",
        title: "Observed profiles",
        roles: { entity: "entity", dimension: "dimension", value: "value", measures: ["Latency", "Coverage"] },
        records: [
          { markId: "profile-a-latency", entity: "A", dimension: "Latency", value: 1_000 },
          { markId: "profile-a-coverage", entity: "A", dimension: "Coverage", value: 0.25 },
          { markId: "profile-b-latency", entity: "B", dimension: "Latency", value: 2_000 },
          { markId: "profile-b-coverage", entity: "B", dimension: "Coverage", value: 0.75 },
        ],
      },
    });
    const profileLabels = descendants(profile).filter((node) => node.tagName === "text").map((node) => node.textContent);
    for (const expected of ["1,000", "2,000", "0.25", "0.75"]) assert.ok(profileLabels.includes(expected));
    assert.match(profile.textContent, /independently scaled measures/u);

    const pointMap = new MiniElement("div");
    await renderFamily({
      root: pointMap,
      dataset: {
        familyId: "point-map",
        title: "Supplied locations",
        roles: { label: "label", latitude: "latitude", longitude: "longitude", value: "value" },
        records: [
          { markId: "place-a", label: "A", latitude: -6.8, longitude: 39.2 },
          { markId: "place-b", label: "B", latitude: 51.5, longitude: -0.1 },
        ],
      },
    });
    const pointSvg = descendants(pointMap).find((node) => node.tagName === "svg");
    assert.equal(pointSvg?.getAttribute("data-size-encoding"), "constant");
    assert.doesNotMatch(pointMap.textContent, /sessions/iu);
    assert.deepEqual(
      pointMap.querySelectorAll("[data-mark-id]").map((node) => node.getAttribute("r")),
      ["7", "7"],
    );

    const pointsWithOptionalValues = new MiniElement("div");
    await renderFamily({
      root: pointsWithOptionalValues,
      dataset: {
        familyId: "point-map",
        title: "Supplied point magnitudes",
        roles: { label: "label", latitude: "latitude", longitude: "longitude", value: "value" },
        records: [
          { markId: "magnitude-one", label: "One", latitude: 1, longitude: 1, value: 1 },
          { markId: "magnitude-four", label: "Four", latitude: 2, longitude: 2, value: 4 },
        ],
      },
    });
    const valuedPointSvg = descendants(pointsWithOptionalValues).find((node) => node.tagName === "svg");
    assert.equal(valuedPointSvg?.getAttribute("data-size-encoding"), "constant");
    assert.equal(valuedPointSvg?.getAttribute("data-projection"), "natural-earth-1-world");
    assert.deepEqual(
      pointsWithOptionalValues.querySelectorAll("[data-mark-id]").map((node) => node.getAttribute("r")),
      ["7", "7"],
      "the governed exact-point member cannot silently become a proportional-symbol map",
    );

    const field = new MiniElement("div");
    await renderFamily({
      root: field,
      dataset: {
        familyId: "field",
        title: "Observed field",
        roles: { label: "label", x: "x", y: "y", value: "value" },
        records: [
          { markId: "field-a", label: "A", x: -1.5, y: 10, value: -4 },
          { markId: "field-b", label: "B", x: 2.25, y: 20, value: 8 },
        ],
      },
    });
    assert.match(field.textContent, /observed value range is -4 to 8/iu);
    assert.match(field.textContent, /-1\.5/u);
    assert.match(field.textContent, /2\.25/u);
    assert.doesNotMatch(field.textContent, /attention|:00/u);
    assert.match(field.querySelectorAll("[data-mark-id]")[0].getAttribute("class"), /\blevel-1\b/u);
    assert.match(field.querySelectorAll("[data-mark-id]")[1].getAttribute("class"), /\blevel-5\b/u);
  });
});

test("rank, trend, and relationship keep negative and mixed observed domains", async () => {
  await withMiniRenderer(async () => {
    const rank = new MiniElement("div");
    await renderFamily({
      root: rank,
      dataset: {
        familyId: "rank",
        title: "Mixed rank",
        roles: { label: "label", value: "value" },
        records: [
          { markId: "rank-positive", label: "Positive", value: 5 },
          { markId: "rank-negative", label: "Negative", value: -10 },
        ],
      },
    });
    const rankSvg = descendants(rank).find((node) => node.tagName === "svg");
    assert.equal(rankSvg?.getAttribute("data-value-domain"), "-10,5");
    assert.match(rank.textContent, /supplied value extent is -10 to 5/iu);
    assert.ok(rank.querySelectorAll("[data-mark-id]").every((mark) => Number(mark.getAttribute("width")) > 0));

    const trend = new MiniElement("div");
    await renderFamily({
      root: trend,
      dataset: {
        familyId: "trend",
        title: "Mixed trend",
        roles: { x: "time", y: "value", series: "series" },
        records: [
          { markId: "trend-negative", time: "2026-01-01", value: -4, series: "Observed" },
          { markId: "trend-positive", time: "2026-02-01", value: 6, series: "Observed" },
        ],
      },
    });
    const trendSvg = descendants(trend).find((node) => node.tagName === "svg");
    assert.equal(trendSvg?.getAttribute("data-value-domain"), "-4,6");
    assert.match(trend.textContent, /-4/u);
    assert.match(trend.textContent, /6/u);
    assert.ok(descendants(trend).filter((node) => node.tagName === "text").some((node) => node.textContent === "0"));
    assert.doesNotMatch(trend.textContent, /weekly/iu);
    assert.ok(trend.querySelectorAll("[data-mark-id]").every((mark) => {
      const cy = Number(mark.getAttribute("cy"));
      return cy >= 40 && cy <= 370;
    }));

    const relationship = new MiniElement("div");
    await renderFamily({
      root: relationship,
      dataset: {
        familyId: "relationship",
        title: "Mixed relationship",
        roles: { label: "label", x: "input", y: "output" },
        records: [
          { markId: "pair-a", label: "A", input: -3, output: -8 },
          { markId: "pair-b", label: "B", input: 9, output: 2 },
        ],
      },
    });
    const relationshipSvg = descendants(relationship).find((node) => node.tagName === "svg");
    assert.equal(relationshipSvg?.getAttribute("data-x-domain"), "-3,9");
    assert.equal(relationshipSvg?.getAttribute("data-y-domain"), "-8,2");
    assert.ok(relationship.querySelectorAll("[data-mark-id]").every((mark) => {
      const cx = Number(mark.getAttribute("cx"));
      const cy = Number(mark.getAttribute("cy"));
      return cx >= 100 && cx <= 890 && cy >= 40 && cy <= 370;
    }));
  });
});

test("profile leaves missing dimensions as visible gaps", async () => {
  await withMiniRenderer(async () => {
    const root = new MiniElement("div");
    await renderFamily({
      root,
      dataset: {
        familyId: "profile",
        title: "Profile gaps",
        roles: { entity: "entity", dimension: "dimension", value: "value", measures: ["First", "Middle", "Last"] },
        records: [
          { markId: "a-first", entity: "A", dimension: "First", value: 1 },
          { markId: "a-last", entity: "A", dimension: "Last", value: 3 },
          { markId: "b-first", entity: "B", dimension: "First", value: 2 },
          { markId: "b-middle", entity: "B", dimension: "Middle", value: 4 },
          { markId: "b-last", entity: "B", dimension: "Last", value: 6 },
        ],
      },
    });
    const lines = descendants(root).filter((node) => node.tagName === "polyline");
    assert.equal(lines.length, 1, "only the complete profile may connect all three dimensions");
    assert.equal(lines[0].getAttribute("aria-label"), "B profile");
    assert.equal(root.querySelectorAll("[data-mark-id]").length, 5, "missing values cannot remove observed marks");
  });
});

test("parallel text uses two witness columns aligned by order or label", async () => {
  await withMiniRenderer(async () => {
    const root = new MiniElement("div");
    await renderFamily({
      root,
      dataset: {
        familyId: "passage-comparison",
        title: "Two witnesses",
        roles: { text: "passage", version: "version", label: "section", order: "order" },
        records: [
          { markId: "a-one", version: "Witness A", section: "Opening A", order: 1, passage: "Earlier opening." },
          { markId: "a-two", version: "Witness A", section: "Closing", order: 2, passage: "Earlier closing." },
          { markId: "b-one", version: "Witness B", section: "Opening B", order: 1, passage: "Later opening." },
          { markId: "b-two", version: "Witness B", section: "Closing", order: 2, passage: "Later closing." },
        ],
      },
    });
    const table = descendants(root).find((node) => node.tagName === "table");
    assert.equal(table?.getAttribute("data-layout"), "parallel-witnesses");
    assert.equal(table?.getAttribute("data-witness-columns"), "2");
    const headings = descendants(table).filter((node) => /\bpassage-witness-heading\b/u.test(node.getAttribute?.("class") ?? ""));
    assert.deepEqual(headings.map((heading) => heading.textContent), ["Witness A", "Witness B"]);
    const alignedRows = descendants(table).filter((node) => /\bpassage-alignment-row\b/u.test(node.getAttribute?.("class") ?? ""));
    assert.equal(alignedRows.length, 2);
    assert.ok(alignedRows.every((row) => row.children.length === 2));
    assert.deepEqual(
      [...new Set(root.querySelectorAll("[data-mark-id]").map((node) => node.getAttribute("data-mark-id")))].sort(),
      ["a-one", "a-two", "b-one", "b-two"],
    );

    const packagedModel = atlasPackageToRenderModel({
      kind: "attend-data-package",
      schemaVersion: 2,
      id: "data_parallel_text",
      family: { id: "passage-comparison" },
      catalog: catalogReceiptForFamily("passage-comparison"),
      question: { text: "How did this passage change?", target: "Two supplied witnesses" },
      payload: {
        schemaVersion: 1,
        kind: "attend-passage-comparison-payload",
        passages: [
          { markId: "mark-a", passage: "Earlier wording.", version: "A", label: "Opening" },
          { markId: "mark-b", passage: "Later wording.", version: "B", label: "Opening" },
        ],
      },
      marks: [
        {
          id: "mark-a",
          kind: "passage-comparison",
          label: "Opening · A",
          summary: "",
          values: { passage: "Earlier wording.", version: "A", label: "Opening" },
          evidenceRefs: ["evidence_0123456789abcdef"],
        },
        {
          id: "mark-b",
          kind: "passage-comparison",
          label: "Opening · B",
          summary: "",
          values: { passage: "Later wording.", version: "B", label: "Opening" },
          evidenceRefs: ["evidence_fedcba9876543210"],
        },
      ],
    });
    assert.deepEqual(packagedModel.records.map((record) => record.semanticLabel), ["Opening", "Opening"]);
    const packaged = new MiniElement("div");
    await renderFamily({ root: packaged, dataset: packagedModel });
    const packagedRows = descendants(packaged).filter((node) => /\bpassage-alignment-row\b/u.test(node.getAttribute?.("class") ?? ""));
    assert.equal(packagedRows.length, 1, "the canonical adapter must retain the semantic label used for alignment");
    assert.ok(packagedRows[0].children.every((cell) => cell.querySelectorAll("[data-mark-id]").length === 1));

    const tooMany = new MiniElement("div");
    await renderFamily({
      root: tooMany,
      dataset: {
        familyId: "passage-comparison",
        title: "Three witnesses",
        roles: { text: "passage", version: "version", order: "order" },
        records: [
          { markId: "a", version: "A", order: 1, passage: "A" },
          { markId: "b", version: "B", order: 1, passage: "B" },
          { markId: "c", version: "C", order: 1, passage: "C" },
        ],
      },
    });
    const abstention = descendants(tooMany).find((node) => node.getAttribute?.("data-render-state") === "abstained");
    assert.ok(abstention);
    assert.match(tooMany.textContent, /requires exactly two witnesses/u);
  });
});

test("annotated specimen uses supplied preview media and otherwise declares a neutral frame", async () => {
  const packageValue = {
    kind: "attend-data-package",
    schemaVersion: 2,
    id: "data_specimen_preview",
    family: { id: "annotated-specimen" },
    catalog: catalogReceiptForFamily("annotated-specimen"),
    question: { text: "What is marked?", target: "Supplied specimen" },
    payload: {
      schemaVersion: 1,
      kind: "attend-annotated-specimen-payload",
      specimenIds: ["specimen-one"],
      annotations: [{ markId: "mark-specimen", specimen: "specimen-one", label: "Observed region", x: 0.2, y: 0.3 }],
    },
    marks: [{
      id: "mark-specimen",
      kind: "annotated-specimen",
      label: "Observed region",
      summary: "",
      values: { specimen: "specimen-one", label: "Observed region", x: 0.2, y: 0.3 },
      evidenceRefs: ["evidence_0123456789abcdef"],
      media: {
        type: "image",
        width: 1_600,
        height: 900,
        preview: { kind: "image", src: "previews/specimen.png", alt: "The actual supplied specimen" },
      },
    }],
  };
  const model = atlasPackageToRenderModel(packageValue);
  assert.equal(model.specimen.preview.src, "previews/specimen.png");
  assert.equal(model.specimen.aspectRatio, 16 / 9);

  await withMiniRenderer(async () => {
    const supplied = new MiniElement("div");
    await renderFamily({ root: supplied, dataset: model, selectableMarkIds: model.selectableMarkIds });
    const suppliedSvg = descendants(supplied).find((node) => node.tagName === "svg");
    const image = descendants(supplied).find((node) => node.tagName === "image");
    assert.equal(suppliedSvg?.getAttribute("data-preview-state"), "supplied");
    assert.equal(image?.getAttribute("href"), "previews/specimen.png");
    assert.equal(descendants(supplied).some((node) => /\bspecimen-note\b/u.test(node.getAttribute?.("class") ?? "")), false);

    const unavailable = new MiniElement("div");
    await renderFamily({
      root: unavailable,
      dataset: {
        familyId: "annotated-specimen",
        title: "No preview",
        roles: { label: "label", x: "x", y: "y", width: "width", height: "height" },
        records: [{ markId: "mark-neutral", label: "Observed point", x: 0.4, y: 0.6 }],
      },
    });
    const unavailableSvg = descendants(unavailable).find((node) => node.tagName === "svg");
    assert.equal(unavailableSvg?.getAttribute("data-preview-state"), "unavailable");
    assert.match(unavailable.textContent, /Specimen preview unavailable/u);
    assert.equal(descendants(unavailable).some((node) => /\bspecimen-note\b/u.test(node.getAttribute?.("class") ?? "")), false);
  });
});

test("mechanism render models isolate real feedback loops without swallowing downstream layers", () => {
  const links = [
    ["edge-ab", "A", "B", "invokes"],
    ["edge-ba", "B", "A", "returns to"],
    ["edge-bc", "B", "C", "produces"],
    ["edge-cd", "C", "D", "persists"],
  ];
  const marks = links.map(([id, source, target, relation], index) => ({
    id,
    kind: "mechanism",
    label: `${source} ${relation} ${target}`,
    summary: "",
    values: { source, target, relation },
    evidenceRefs: [`evidence_${String(index + 1).padStart(16, "0")}`],
  }));
  const model = atlasPackageToRenderModel({
    kind: "attend-data-package",
    schemaVersion: 2,
    id: "data_feedback_layers",
    family: { id: "mechanism" },
    catalog: catalogReceiptForFamily("mechanism"),
    question: { text: "How does this loop feed its outputs?", target: "Feedback system" },
    payload: {
      schemaVersion: 1,
      kind: "attend-mechanism-payload",
      links: marks.map((mark) => ({ markId: mark.id, ...mark.values })),
    },
    marks,
  });
  const records = Object.fromEntries(model.records.map((record) => [record.id, record]));

  assert.equal(records.A.cyclic, true);
  assert.equal(records.B.cyclic, true);
  assert.equal(records.C.cyclic, false);
  assert.equal(records.D.cyclic, false);
  assert.equal(records.A.group, records.B.group);
  assert.notEqual(records.B.group, records.C.group);
  assert.notEqual(records.C.group, records.D.group);
  assert.deepEqual([records.A.stage, records.B.stage, records.C.stage, records.D.stage], [0, 0, 1, 2]);
});

test("collection atlas renders equal-size labeled facet strips independent of x and y", async () => {
  await withMiniRenderer(async () => {
    const dataset = {
      familyId: "collection-atlas",
      title: "Observed collection",
      roles: { label: "label", category: "cluster", mediaType: "mediaType", x: "x", y: "y" },
      records: [
        { markId: "atlas-a", label: "First", cluster: "Alpha", mediaType: "image", x: -900, y: 600 },
        { markId: "atlas-b", label: "Second", cluster: "Alpha", mediaType: "text", x: 0.01, y: -0.01 },
        { markId: "atlas-c", label: "Third", cluster: "Beta", mediaType: "audio", x: 900, y: -600 },
      ],
    };
    const first = new MiniElement("div");
    await renderFamily({ root: first, dataset });
    const svg = descendants(first).find((node) => node.tagName === "svg");
    assert.equal(svg?.getAttribute("data-layout"), "faceted-strips");
    assert.match(first.textContent, /Alpha/u);
    assert.match(first.textContent, /2 items/u);
    assert.match(first.textContent, /Beta/u);
    assert.match(first.textContent, /1 item/u);
    const positions = markPositions(first);
    assert.ok(Object.values(positions).every((position) => position.width === "104" && position.height === "42"));
    assert.equal(positions["atlas-a"].y, positions["atlas-b"].y);
    assert.notEqual(positions["atlas-a"].y, positions["atlas-c"].y);

    const moved = new MiniElement("div");
    await renderFamily({
      root: moved,
      dataset: {
        ...dataset,
        records: dataset.records.map((record, index) => ({ ...record, x: index * 100_000, y: index * -100_000 })),
      },
    });
    assert.deepEqual(markPositions(moved), positions, "faceted layout cannot drift with similarity coordinates");
  });
});

test("sequence, flow, mechanism, and region views preserve their governed semantics", async () => {
  await withMiniRenderer(async () => {
    const sequence = new MiniElement("div");
    await renderFamily({
      root: sequence,
      dataset: {
        familyId: "sequence",
        title: "Observed steps",
        roles: { label: "label", order: "order" },
        records: [
          { markId: "step-a", label: "Collect", order: 1 },
          { markId: "step-b", label: "Check", order: 2 },
          { markId: "step-c", label: "Publish", order: 3 },
        ],
      },
    });
    const sequenceSvg = descendants(sequence).find((node) => node.tagName === "svg");
    assert.equal(sequenceSvg?.getAttribute("data-layout"), "step-strip");
    assert.match(sequence.textContent, /Equal spacing shows succession only/u);
    assert.match(sequence.textContent, /does not imply duration or causality/u);
    assert.doesNotMatch(sequence.textContent, /storyboard|source frame/iu);

    const flow = new MiniElement("div");
    await renderFamily({
      root: flow,
      dataset: {
        familyId: "flow",
        title: "Observed flow",
        roles: { id: "id", label: "label", stage: "stage" },
        records: [
          { id: "A", label: "A", stage: 0, inflow: 0, outflow: 10, balanceGap: -10 },
          { id: "B", label: "B", stage: 1, inflow: 10, outflow: 7, balanceGap: 3 },
          { id: "C", label: "C", stage: 2, inflow: 7, outflow: 0, balanceGap: 7 },
        ],
        links: [
          { id: "flow-a", source: "A", target: "B", items: 10 },
          { id: "flow-b", source: "B", target: "C", items: 7 },
        ],
      },
      selectableMarkIds: ["flow-a", "flow-b"],
    });
    const flowSvg = descendants(flow).find((node) => node.tagName === "svg");
    assert.equal(flowSvg?.getAttribute("data-stage-derivation"), "topological-depth");
    assert.equal(flowSvg?.getAttribute("data-conservation-gaps"), "1");
    assert.match(flow.textContent, /in 10 · out 7 · gap \+3/u);
    assert.deepEqual(
      [...new Set(flow.querySelectorAll("[data-mark-id]").map((node) => node.getAttribute("data-mark-id")))],
      ["flow-a", "flow-b"],
      "derived stage nodes cannot masquerade as selectable evidence marks",
    );
    assert.ok(flow.querySelectorAll("[data-mark-id]").every((node) => /value/u.test(node.getAttribute("aria-label") ?? "")));

    const selectedTargets = [];
    const mechanism = new MiniElement("div");
    await renderFamily({
      root: mechanism,
      dataset: {
        familyId: "mechanism",
        title: "Observed system",
        roles: { id: "id", label: "label", group: "group" },
        records: [
          { id: "check", label: "Check", group: "Stage 2" },
          { id: "normalize", label: "Normalize", group: "Stage 2" },
          { id: "compile", label: "Compile", group: "Stage 2" },
          { id: "resolve", label: "Resolve", group: "Stage 2" },
          { id: "view", label: "View", group: "Stage 3" },
          { id: "source", label: "Source", group: "Stage 1" },
        ],
        links: [
          { id: "mechanism-a", source: "source", target: "check", type: "validates" },
          { id: "mechanism-b", source: "source", target: "normalize", type: "normalizes" },
          { id: "mechanism-c", source: "source", target: "compile", type: "compiles" },
          { id: "mechanism-d", source: "source", target: "resolve", type: "resolves" },
          { id: "mechanism-e", source: "check", target: "view", type: "renders" },
        ],
      },
      selectableMarkIds: ["mechanism-a", "mechanism-b", "mechanism-c", "mechanism-d", "mechanism-e"],
      onSelect: (target) => selectedTargets.push(target),
    });
    const mechanismSvg = descendants(mechanism).find((node) => node.tagName === "svg");
    assert.equal(mechanismSvg?.getAttribute("data-layout"), "evidence-flowchart");
    assert.match(mechanism.textContent, /validates/u);
    assert.match(mechanism.textContent, /renders/u);
    assert.match(mechanism.textContent, /not causal strength/u);
    assert.ok(
      Number(mechanismSvg?.getAttribute("viewBox")?.split(" ").at(-1)) > 450,
      "the canvas must grow when a stage contains more nodes than the default height fits",
    );
    const stageLabels = descendants(mechanism)
      .filter((node) => /^Stage [123]$/u.test(node.textContent))
      .sort((left, right) => Number(left.getAttribute("x")) - Number(right.getAttribute("x")))
      .map((node) => node.textContent);
    assert.deepEqual(stageLabels, ["Stage 1", "Stage 2", "Stage 3"]);
    const sourceNode = mechanism.querySelectorAll("[data-node-id]")
      .find((node) => node.getAttribute("data-node-id") === "source");
    assert.deepEqual(
      [...new Set(mechanism.querySelectorAll("[data-node-id]").map((node) => node.children[0]?.getAttribute("class")))],
      ["mechanism-node-card"],
      "peer components cannot imply unsupported categories through decorative color",
    );
    assert.equal(sourceNode?.getAttribute("role"), "button");
    sourceNode?.click();
    assert.deepEqual(selectedTargets, [{ kind: "node", nodeId: "source" }]);

    const denseMechanism = new MiniElement("div");
    const denseRecords = Array.from({ length: 12 }, (_, index) => ({
      id: `component-${index + 1}`,
      label: `Component ${index + 1} with readable words`,
      group: "Feedback layer",
      cyclic: true,
    }));
    const denseLinks = denseRecords.map((record, index) => ({
      id: `dense-link-${index + 1}`,
      source: record.id,
      target: denseRecords[(index + 1) % denseRecords.length].id,
      type: `hands control to component ${((index + 1) % denseRecords.length) + 1}`,
    }));
    await renderFamily({
      root: denseMechanism,
      dataset: {
        familyId: "mechanism",
        title: "Dense feedback system",
        roles: { id: "id", label: "label", group: "group" },
        records: denseRecords,
        links: denseLinks,
      },
      selectableMarkIds: denseLinks.map((link) => link.id),
      selectedNodeId: "component-1",
    });
    const denseSvg = descendants(denseMechanism).find((node) => node.tagName === "svg");
    const denseNodes = denseMechanism.querySelectorAll("[data-node-id]");
    assert.equal(denseSvg?.getAttribute("data-density-treatment"), "focus-and-context");
    assert.equal(denseSvg?.getAttribute("data-cycle-layout"), "wrapped-grid");
    assert.ok(
      new Set(denseNodes.map((node) => node.children.find((child) => child.tagName === "rect")?.getAttribute("x"))).size > 1,
      "a large feedback layer must wrap across columns",
    );
    assert.ok(Number(denseSvg?.getAttribute("viewBox")?.split(" ").at(-1)) <= 900);
    assert.ok(descendants(denseMechanism).some((node) => node.tagName === "tspan"), "long card labels must wrap");
    for (const node of denseNodes) {
      const rect = node.children.find((child) => child.tagName === "rect");
      const text = node.children.find((child) => child.tagName === "text");
      assert.equal(text?.getAttribute("class"), "mechanism-node-label");
      const labelRows = text?.children.filter((child) => child.tagName === "tspan") ?? [];
      assert.ok(labelRows.length >= 1 && labelRows.length <= 2);
      assert.ok(labelRows.every((row) => (
        Number(row.getAttribute("y")) > Number(rect.getAttribute("y"))
        && Number(row.getAttribute("y")) < Number(rect.getAttribute("y")) + Number(rect.getAttribute("height"))
      )));
    }
    const rail = denseMechanism.querySelectorAll("[data-mark-id]")
      .find((node) => node.getAttribute("data-route") === "same-layer-rail");
    assert.ok(rail, "same-layer feedback must route outside the cards");
    assert.ok(
      denseMechanism.querySelectorAll("[data-mark-id]").every((node) => /hands control/u.test(node.getAttribute("aria-label") ?? "")),
      "every subdued connector must retain its full typed relation",
    );

    const region = new MiniElement("div");
    await renderFamily({
      root: region,
      dataset: {
        familyId: "region-map",
        title: "Observed rates",
        roles: { label: "label", region: "region", regionLabel: "label", value: "value", baseline: "baseline" },
        records: [
          { markId: "region-ca", label: "California", region: "06", value: 0.05, baseline: 200 },
          { markId: "region-or", label: "Oregon", region: "41", value: 0.2, baseline: 100 },
          { markId: "region-wa", label: "Washington", region: "53", value: 0.4, baseline: 80 },
          { markId: "region-ny", label: "New York", region: "36", value: 0.6, baseline: 50 },
          { markId: "region-tx", label: "Texas", region: "48", value: 1, baseline: 25 },
        ],
      },
    });
    const regionSvg = descendants(region).find((node) => node.tagName === "svg");
    assert.equal(regionSvg?.getAttribute("data-classification"), "five-equal-intervals-0-1");
    assert.equal(regionSvg?.getAttribute("data-boundary-version"), "us-atlas-3.0.1-states-10m");
    assert.match(region.textContent, /Observed 5%–100%/u);
    assert.match(region.textContent, /No data/u);
    assert.match(region.textContent, /US state boundaries · us-atlas 3\.0\.1/u);
    const california = region.querySelectorAll("[data-mark-id]").find((node) => node.getAttribute("data-mark-id") === "region-ca");
    assert.match(california?.getAttribute("aria-label") ?? "", /denominator 200/u);
  });
});

test("real compiler output for every executable family closes over package mark IDs", async () => {
  for (const manifest of MAP_FAMILIES) {
    if (!getCatalogFamily(manifest.id)?.executableMemberId) continue;
    const request = await toCompilerRequest(SAMPLE_SOURCES[manifest.id], manifest, { availableWidth: 1_024 });
    const compiled = await compileMap(request);
    const packageValue = compiled;
    const model = atlasPackageToRenderModel(packageValue);
    assert.equal(isAtlasPackage(packageValue), true, `${manifest.id} must be atlas-v2 compatible`);
    assert.ok(model.records.length > 0, `${manifest.id} must produce render records`);
    assert.deepEqual(
      [...model.selectableMarkIds].sort(),
      compiled.marks.map((mark) => mark.id).sort(),
      `${manifest.id} selectable IDs must be exactly the compiled package marks`,
    );
    const renderedIds = new Set([
      ...model.records.map((record) => record.markId).filter(Boolean),
      ...model.links.map((link) => link.id).filter(Boolean),
    ].map(String));
    assert.deepEqual(
      [...renderedIds].sort(),
      compiled.marks.map((mark) => mark.id).sort(),
      `${manifest.id} render records/edges must expose every exact package mark ID`,
    );
    const firstEvidence = compiled.marks[0].evidenceRefs?.[0];
    if (firstEvidence) {
      assert.deepEqual(model.markById[compiled.marks[0].id].evidenceRefs[0], firstEvidence);
      assert.equal(Object.prototype.hasOwnProperty.call(model.markById[compiled.marks[0].id].evidenceRefs[0], "id"), false);
    }
    assert.equal(model.familyId, manifest.id);
  }
});

test("required-only canonical packages render all eighteen executable families with exact mark ids", async () => {
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    window: globalThis.window,
    d3: globalThis.d3,
    topojson: globalThis.topojson,
    fetch: globalThis.fetch,
  };
  globalThis.document = new MiniDocument();
  globalThis.HTMLElement = MiniElement;
  globalThis.MouseEvent = class {};
  globalThis.window = {};
  globalThis.d3 = d3;
  globalThis.topojson = topojson;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => {
      const path = String(url);
      if (path.includes("us-counties")) return countiesTopology;
      if (path.includes("us-states")) return statesTopology;
      return worldTopology;
    },
  });

  try {
    for (const familyId of FAMILY_IDS.filter((candidate) => getCatalogFamily(candidate)?.executableMemberId)) {
      const manifest = MAP_FAMILIES.find((candidate) => candidate.id === familyId);
      const packageValue = await minimalRequiredPackage(familyId, manifest);
      const model = atlasPackageToRenderModel(packageValue);
      const root = new MiniElement("div");
      await renderFamily({
        root,
        dataset: model,
        selectableMarkIds: model.selectableMarkIds,
      });
      const renderedIds = root.querySelectorAll("[data-mark-id]").map((node) => node.getAttribute("data-mark-id"));
      assert.deepEqual([...new Set(renderedIds)], [packageValue.marks[0].id], `${familyId} must render its exact package mark id`);
      assert.doesNotMatch(String(root), /\b(?:undefined|NaN|Infinity)\b/u, `${familyId} must not render undefined or non-finite semantics`);
      if (familyId === "point-map") {
        const svg = root.children.find((child) => child.tagName === "svg");
        assert.equal(svg?.getAttribute("data-projection"), "natural-earth-1-world");
        const point = root.querySelectorAll("[data-mark-id]")[0];
        assert.ok(Number.isFinite(Number(point?.getAttribute("cx"))) && Number.isFinite(Number(point?.getAttribute("cy"))), "singleton point must remain usable on the fixed world projection");
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("production app branches by artifact schema and does not import fixtures", async () => {
  const [app, packageModel, compilerAdapter] = await Promise.all([
    readFile(join(VIEWER_ROOT, "app.js"), "utf8"),
    readFile(join(VIEWER_ROOT, "package-model.js"), "utf8"),
    readFile(join(VIEWER_ROOT, "family-compiler-adapter.js"), "utf8"),
  ]);
  assert.match(app, /isAtlasPackage/u);
  assert.match(app, /renderAtlasPackage/u);
  assert.match(app, /schemaVersion/u);
  assert.doesNotMatch(app, /family-datasets/u);
  assert.doesNotMatch(packageModel, /compilerPackageToAtlasPackage/u);
  assert.doesNotMatch(compilerAdapter, /\.\.\/src\/catalog/u);
  assert.match(compilerAdapter, /rendererVariantId/u);
  assert.doesNotMatch(compilerAdapter, /manifest\.variants\[0\]/u);
});

test("Atlas draft attachment keys change when the selected mark changes", async () => {
  const app = await readFile(join(VIEWER_ROOT, "app.js"), "utf8");
  const start = app.indexOf("function semanticAttachmentKey");
  const end = app.indexOf("function pinDraftToCurrentSelection", start);
  assert.ok(start >= 0 && end > start);
  const semanticAttachmentKey = runInNewContext(`(${app.slice(start, end)})`, {
    atlasMode: () => true,
    atlasSelectedMarkIds: (value) => value.selection.selectedMarkIds,
  });
  const selection = {
    dataPackageId: "data_test",
    dataHash: "hash_test",
    map: { id: "rank", version: 1 },
    selectedMarkIds: ["mark-a"],
    predicate: { field: "markId", operator: "in", values: ["mark-a"] },
    filters: {},
    aggregation: { family: "rank" },
    sort: {},
  };
  const keyA = semanticAttachmentKey({ selection });
  const keyB = semanticAttachmentKey({
    selection: {
      ...selection,
      selectedMarkIds: ["mark-b"],
      predicate: { ...selection.predicate, values: ["mark-b"] },
    },
  });
  assert.notEqual(keyA, keyB);
});

test("family lab renders the compiled package through the package adapter", async () => {
  const lab = await readFile(join(VIEWER_ROOT, "family-lab.js"), "utf8");
  assert.match(lab, /compileMap\(request\)/u);
  assert.match(lab, /atlasPackageToRenderModel|renderAtlasPackage/u);
  assert.doesNotMatch(lab, /renderFamily\(\{ root: elements\.visual, dataset/u);
});
