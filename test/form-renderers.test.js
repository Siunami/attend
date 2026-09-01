import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { renderFamily } from "../viewer/family-renderers.js";
import { FORM_RENDERER_KEYS, FORM_RENDERER_MODULES, rendererForCatalogReceipt } from "../viewer/form-renderers.js";
import { currentCatalogReceipt, EXECUTABLE_FORM_RECEIPTS } from "../viewer/form-registry.js";
import renderPartList from "../viewer/forms/composition/part-list.js";
import renderEcdf from "../viewer/forms/distribution/ecdf.js";
import renderHistogram from "../viewer/forms/distribution/histogram.js";
import renderContours from "../viewer/forms/field/contours.js";
import renderIcicle from "../viewer/forms/hierarchy/icicle.js";
import renderOutline from "../viewer/forms/hierarchy/outline.js";
import renderTreemap from "../viewer/forms/hierarchy/treemap.js";
import renderProfileTable from "../viewer/forms/profile/profile-table.js";
import renderMarginals from "../viewer/forms/relationship/marginals.js";
import renderRegionSymbols from "../viewer/forms/region-map/region-symbols.js";
import renderDotPlot from "../viewer/forms/rank/dot-plot.js";
import renderSlopegraph from "../viewer/forms/rank/slopegraph.js";
import renderStateRibbon from "../viewer/forms/sequence/state-ribbon.js";
import renderEventStrip from "../viewer/forms/timeline/event-strip.js";
import renderPeriodBars from "../viewer/forms/trend/period-bars.js";
import renderContactAtlas from "../viewer/forms/collection-atlas/contact-atlas.js";
import { labelInterval } from "../viewer/forms/shared.js";

const VIEWER = new URL("../viewer/", import.meta.url);

class MiniElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this._text = "";
  }
  set textContent(value) { this._text = String(value); }
  get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join("")}`; }
  set className(value) { this.setAttribute("class", value); }
  get className() { return this.getAttribute("class") ?? ""; }
  append(...children) {
    const added = children.flat().filter((child) => child !== null && child !== undefined);
    for (const child of added) child.parentNode = this;
    this.children.push(...added);
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  after(...nodes) {
    const siblings = this.parentNode?.children;
    if (!siblings) return;
    const added = nodes.flat().filter((node) => node !== null && node !== undefined);
    for (const node of added) node.parentNode = this.parentNode;
    siblings.splice(siblings.indexOf(this) + 1, 0, ...added);
  }
  remove() {
    const siblings = this.parentNode?.children;
    if (!siblings) return;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  removeAttribute(name) { this.attributes.delete(String(name)); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
  click() { this.dispatchEvent({ type: "click" }); }
  focus() {
    globalThis.document.activeElement = this;
    this.dispatchEvent({ type: "focus" });
  }
  querySelectorAll(selector) {
    const attribute = /^\[([a-z-]+)\]$/u.exec(selector)?.[1];
    const tag = /^[a-z]+$/u.test(selector) ? selector : null;
    const result = [];
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if ((attribute && child.getAttribute?.(attribute) !== null) || (tag && child.tagName === tag)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

class MiniDocument {
  constructor() { this.activeElement = null; }
  createElement(name) { return new MiniElement(name); }
  createElementNS(_namespace, name) { return new MiniElement(name); }
}

function model(familyId, memberId, payload, records = []) {
  return { familyId, memberId, title: `${familyId}/${memberId}`, payload, records };
}

const selection = { selectedMarkIds: new Set(), selectedTargetId: null };

async function withDocument(callback) {
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    window: globalThis.window,
  };
  globalThis.document = new MiniDocument();
  globalThis.HTMLElement = MiniElement;
  globalThis.MouseEvent = class {};
  globalThis.window = {};
  try { return await callback(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

function nodeCount(root) {
  return root.children.reduce((total, child) => total + 1 + nodeCount(child), 0);
}

// Every class below inherits `.atlas-visual text` at 12px in viewer/styles.css
// except these, which set their own size.
const LABEL_FONT_SIZES = Object.freeze({
  "atlas-cluster-label": 15,
  "atlas-item-label": 11,
  "mechanism-layer-label": 11,
  "mechanism-node-label": 11.5,
  "mechanism-link-label": 10,
  "map-note": 10,
});

function labelFontSize(className) {
  for (const token of String(className ?? "").split(/\s+/u)) {
    if (Object.hasOwn(LABEL_FONT_SIZES, token)) return LABEL_FONT_SIZES[token];
  }
  return 12;
}

function labelBoxes(root) {
  const boxes = [];
  for (const node of root.querySelectorAll("text")) {
    const fontSize = labelFontSize(node.getAttribute("class"));
    const anchor = node.getAttribute("text-anchor") ?? "start";
    const spans = node.children.filter((child) => child.tagName === "tspan");
    const lines = spans.length
      ? spans.map((span) => ({ x: span.getAttribute("x") ?? node.getAttribute("x"), y: span.getAttribute("y"), text: span.textContent }))
      : [{ x: node.getAttribute("x"), y: node.getAttribute("y"), text: node.textContent }];
    for (const line of lines) {
      const x = Number(line.x);
      const y = Number(line.y);
      if (!line.text || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      const [left, right] = labelInterval(x, line.text, { anchor, fontSize });
      boxes.push({ owner: node, y, left, right, text: line.text });
    }
  }
  return boxes;
}

function assertLegibleLabels(root, subject) {
  const boxes = labelBoxes(root);
  assert.ok(boxes.length > 0, `${subject} drew no labels at all`);
  for (const box of boxes) {
    assert.ok(
      box.left >= 0 && box.right <= 960,
      `${subject}: "${box.text}" spans ${box.left.toFixed(1)}..${box.right.toFixed(1)}, outside the 960-unit canvas`,
    );
  }
  const byRow = [...boxes].sort((left, right) => left.y - right.y);
  for (let index = 0; index < byRow.length; index += 1) {
    for (let peer = index + 1; peer < byRow.length && byRow[peer].y - byRow[index].y <= 4; peer += 1) {
      if (byRow[index].owner === byRow[peer].owner) continue;
      const [first, second] = byRow[index].left <= byRow[peer].left
        ? [byRow[index], byRow[peer]]
        : [byRow[peer], byRow[index]];
      assert.ok(
        second.left - first.right >= 2,
        `${subject}: "${first.text}" and "${second.text}" overlap on the row near y=${byRow[index].y}`,
      );
    }
  }
  return boxes;
}

function stressDataset(familyId, roles, records, extra = {}) {
  return {
    familyId,
    title: `${familyId} stress`,
    roles,
    records,
    links: [],
    evidence: [],
    selectableMarkIds: records.map((record) => String(record.markId)),
    selectableTargetIds: [],
    targetById: {},
    markById: Object.fromEntries(records.map((record) => [String(record.markId), {
      id: String(record.markId),
      label: String(record.label ?? record.markId),
      values: {},
      evidenceRefs: [],
    }])),
    ...extra,
  };
}

const WEEKDAYS = Object.freeze(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);

test("every executable form has one exact browser module and receipt handler", async () => {
  assert.equal(FORM_RENDERER_KEYS.length, 34);
  assert.equal(new Set(FORM_RENDERER_KEYS).size, 34);
  for (const [key, modulePath] of Object.entries(FORM_RENDERER_MODULES)) {
    assert.ok(FORM_RENDERER_KEYS.includes(key));
    await access(new URL(modulePath, VIEWER));
  }
  for (const receipt of EXECUTABLE_FORM_RECEIPTS) {
    assert.equal(typeof rendererForCatalogReceipt(receipt), "function", `${receipt.family}/${receipt.member}`);
  }
  assert.equal(rendererForCatalogReceipt({ family: "rank", member: "dot-plot", version: "forged" }), null);
});

test("the fifteen structured form modules place their governed semantic payloads", async () => withDocument(async () => {
  const hierarchy = [
    { id: "root", markId: "mark-root", label: "Root", value: 4, parentId: null, x0: 0, x1: 1, y0: 0, y1: 0.5 },
    { id: "leaf", markId: "mark-leaf", label: "Leaf", value: 4, parentId: "root", x0: 0, x1: 1, y0: 0.5, y1: 1 },
  ];
  const cases = [
    [renderDotPlot, model("rank", "dot-plot", { items: [{ markId: "mark-a", label: "A", value: 4 }] })],
    [renderSlopegraph, model("rank", "slopegraph", { segments: [{ targetId: "target-slope", label: "A", start: { state: "Before", value: 4 }, end: { state: "After", value: 2 } }] })],
    [renderHistogram, model("distribution", "histogram", { bins: [{ targetId: "target-bin", lower: 0, upper: 2, count: 4 }] })],
    [renderEcdf, model("distribution", "ecdf", { steps: [{ targetId: "target-step", value: 2, share: 1 }] })],
    [renderPartList, model("composition", "part-list", { total: 4, parts: [{ markId: "mark-part", label: "Part", value: 4, share: 1 }] })],
    [renderProfileTable, model("profile", "profile-table", { dimensions: ["Size"], rows: [{ label: "A", values: { Size: { markId: "mark-cell", value: 4 } } }] })],
    [renderPeriodBars, model("trend", "period-bars", { calendarGrain: "month", periods: [{ markId: "mark-period", label: "Jan", value: 4 }] })],
    [renderEventStrip, model("timeline", "event-strip", { events: [{ markId: "mark-event", label: "Saved", time: "2026-01-01T00:00:00Z" }] })],
    [renderStateRibbon, model("sequence", "state-ribbon", { states: [{ markId: "mark-state", label: "Draft", duration: 4 }] })],
    [renderMarginals, model("relationship", "marginals", { points: [{ markId: "mark-point", label: "A", x: 1, y: 2 }], xBins: [{ targetId: "target-x", lower: 0, upper: 2, count: 1 }], yBins: [{ targetId: "target-y", lower: 1, upper: 3, count: 1 }] })],
    [renderOutline, model("hierarchy", "outline", { nodes: hierarchy })],
    [renderIcicle, model("hierarchy", "icicle", { nodes: hierarchy })],
    [renderTreemap, model("hierarchy", "treemap", { nodes: hierarchy })],
  ];
  for (const [render, dataset] of cases) {
    const root = new MiniElement("div");
    await render(root, dataset, selection);
    assert.equal(root.querySelectorAll("[data-form-id]").length, 1, `${dataset.familyId}/${dataset.memberId}`);
    assert.ok(root.querySelectorAll("[data-mark-id]").length + root.querySelectorAll("[data-target-id]").length > 0, `${dataset.familyId}/${dataset.memberId} must expose evidence interaction`);
  }
}));

test("outline, tidy partition forms remain visually distinct", async () => withDocument(async () => {
  const nodes = [{ id: "root", markId: "mark-root", label: "Root", value: 1, x0: 0, x1: 1, y0: 0, y1: 1 }];
  const outline = new MiniElement("div");
  const icicle = new MiniElement("div");
  const treemap = new MiniElement("div");
  await renderOutline(outline, model("hierarchy", "outline", { nodes }), selection);
  await renderIcicle(icicle, model("hierarchy", "icicle", { nodes }), selection);
  await renderTreemap(treemap, model("hierarchy", "treemap", { nodes }), selection);
  assert.equal(outline.querySelectorAll("ol").length, 1);
  assert.match(icicle.querySelectorAll("[data-mark-id]")[0].className, /icicle-node/u);
  assert.match(treemap.querySelectorAll("[data-mark-id]")[0].className, /treemap-node/u);
}));

test("profile table preserves projector-declared missing cells as nonselectable missing values", async () => withDocument(async () => {
  const root = new MiniElement("div");
  renderProfileTable(root, model("profile", "profile-table", {
    dimensions: ["Present", "Absent"],
    rows: [{
      entity: "Case A",
      cells: [
        { dimension: "Present", markId: "profile-present", value: 7 },
        { dimension: "Absent", missing: true },
      ],
    }],
  }));
  const cells = root.querySelectorAll("td");
  assert.equal(cells[0].textContent, "7");
  assert.equal(cells[0].getAttribute("data-mark-id"), "profile-present");
  assert.equal(cells[1].textContent, "Missing");
  assert.equal(cells[1].className, "is-missing");
  assert.equal(cells[1].getAttribute("data-mark-id"), null);
}));

test("part list gives zero-valued parts a visible evidence endpoint", async () => withDocument(async () => {
  const root = new MiniElement("div");
  renderPartList(root, model("composition", "part-list", {
    whole: "Whole",
    total: 2,
    parts: [
      { markId: "zero-part", label: "Zero", value: 0, share: 0 },
      { markId: "positive-part", label: "Positive", value: 2, share: 1 },
    ],
  }), selection);
  const marks = root.querySelectorAll("[data-mark-id]");
  assert.equal(marks.length, 2);
  assert.equal(marks[0].tagName, "circle");
  assert.equal(marks[0].getAttribute("cx"), "250");
  assert.equal(marks[0].getAttribute("r"), "5");
  assert.match(marks[0].getAttribute("aria-label"), /Zero: 0, 0 percent/u);
}));

test("contact atlas pages at most eight staged images and removes the prior page", async () => withDocument(async () => {
  const items = Array.from({ length: 12 }, (_, index) => {
    const assetId = `asset_${index.toString(16).padStart(32, "0")}`;
    return { assetId, markId: `mark-${index}`, label: `IMG_${index}.jpg`, captureTime: `2026-01-${String(index + 1).padStart(2, "0")}T10:00:00`, previewRoute: `assets/${assetId}`, width: 120, height: 100 };
  });
  const tiedDisclosure = {
    basis: "camera-local DateTimeOriginal",
    timezoneStatus: "unknown",
    unknownTimezoneCount: 12,
    timezoneStatement: "Camera-local timezone is unknown for all 12 images.",
    tiedTimestampGroupCount: 1,
    tiedItemCount: 2,
    tieStatement: "One capture-time tie contains 2 images.",
    tieBreak: "verified source order; normalized relative-path values are not published",
  };
  const root = new MiniElement("div");
  await renderContactAtlas(root, model("collection-atlas", "contact-atlas", {
    items,
    pageSize: 8,
    captureTimeDisclosure: tiedDisclosure,
  }), selection);
  const firstPageImages = root.querySelectorAll("img");
  assert.equal(firstPageImages.length, 8);
  assert.equal(root.querySelectorAll("[data-mark-id]").length, 8);
  root.querySelectorAll("button").at(-1).click();
  assert.equal(root.querySelectorAll("img").length, 4);
  assert.equal(root.querySelectorAll("[data-mark-id]").length, 4);
  assert.ok(firstPageImages.every((image) => !root.querySelectorAll("img").includes(image)));
  assert.match(root.textContent, /Order: camera-local DateTimeOriginal/u);
  assert.match(root.textContent, /Camera-local timezone is unknown for all 12 images/u);
  assert.match(root.textContent, /One capture-time tie contains 2 images/u);
  assert.match(root.textContent, /normalized relative-path values are not published/u);
  assert.doesNotMatch(root.textContent, /\/Users\//u);

  const untiedRoot = new MiniElement("div");
  renderContactAtlas(untiedRoot, model("collection-atlas", "contact-atlas", {
    items,
    pageSize: 8,
    captureTimeDisclosure: {
      ...tiedDisclosure,
      timezoneStatus: "declared",
      unknownTimezoneCount: 0,
      timezoneStatement: "Capture timezone is declared for all 12 images.",
      tiedTimestampGroupCount: 0,
      tiedItemCount: 0,
      tieStatement: "No capture-time ties were observed.",
    },
  }), selection);
  assert.match(untiedRoot.textContent, /Capture timezone is declared for all 12 images/u);
  assert.match(untiedRoot.textContent, /No capture-time ties were observed/u);

  for (const previewRoute of [
    "/s/another-session/assets/asset_00000000000000000000000000000000",
    "https://example.com/asset_00000000000000000000000000000000",
    "../assets/asset_00000000000000000000000000000000",
    "assets/asset_11111111111111111111111111111111",
  ]) {
    assert.throws(() => renderContactAtlas(
      new MiniElement("div"),
      model("collection-atlas", "contact-atlas", { items: [{ ...items[0], previewRoute }] }),
      selection,
    ), /owning session's opaque relative asset route/u);
  }
}));

test("contours render only a complete regular grid with recorded thresholds", async () => {
  const context = {};
  runInNewContext(await readFile(new URL("vendor/d3.min.js", VIEWER), "utf8"), context);
  const previous = { document: globalThis.document, d3: globalThis.d3 };
  globalThis.document = new MiniDocument();
  globalThis.d3 = context.d3;
  try {
    const cells = Array.from({ length: 100 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), value: (index % 10) + Math.floor(index / 10) }));
    const root = new MiniElement("div");
    renderContours(root, model("field", "contours", { columns: 10, rows: 10, cells, levels: [{ targetId: "target-contour", threshold: 8, label: "Eight" }] }), selection);
    assert.equal(root.querySelectorAll("[data-target-id]").length, 1);
    assert.throws(() => renderContours(root, model("field", "contours", { columns: 10, rows: 10, cells: cells.slice(1), thresholds: [8] }), selection), /complete regular grid/u);
  } finally {
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    if (previous.d3 === undefined) delete globalThis.d3; else globalThis.d3 = previous.d3;
  }
});

test("ECDF keeps the 50,000-observation runtime band to a bounded SVG DOM", async () => withDocument(async () => {
  const steps = Array.from({ length: 50_000 }, (_, index) => ({
    targetId: `target-${index}`,
    value: index,
    share: (index + 1) / 50_000,
  }));
  const root = new MiniElement("div");
  renderEcdf(root, model("distribution", "ecdf", { steps }), selection);
  assert.equal(root.querySelectorAll("path").length, 1, "the staircase must be one combined path");
  assert.ok(root.querySelectorAll("[data-target-id]").length <= 65, "target anchors must stay bounded");
}));

test("declared high-count forms preserve every evidence target without unreadable label DOM", async () => withDocument(async () => {
  const dotItems = Array.from({ length: 300 }, (_, index) => ({
    markId: `dot-${index}`,
    label: `Item ${index + 1}`,
    value: index,
  }));
  const dotRoot = new MiniElement("div");
  renderDotPlot(dotRoot, model("rank", "dot-plot", { items: dotItems }), selection);
  assert.equal(dotRoot.querySelectorAll("[data-mark-id]").length, 300);
  assert.ok(nodeCount(dotRoot) < 700, "300 dots must remain a linear, bounded DOM");
  assert.ok(Number(dotRoot.querySelectorAll("svg")[0].getAttribute("viewBox").split(" ").at(-1)) >= 3_600);

  const slopeSegments = Array.from({ length: 40 }, (_, index) => ({
    targetId: `slope-${index}`,
    label: `Item ${index + 1}`,
    start: { state: "Before", value: index, rank: index + 1 },
    end: { state: "After", value: 40 - index, rank: 40 - index },
  }));
  const slopeRoot = new MiniElement("div");
  renderSlopegraph(slopeRoot, model("rank", "slopegraph", {
    states: [{ label: "Before", order: 1 }, { label: "After", order: 2 }],
    segments: slopeSegments,
  }), selection);
  assert.equal(slopeRoot.querySelectorAll("[data-target-id]").length, 40);
  assert.ok(nodeCount(slopeRoot) < 140, "40 slopes must stay linear without duplicate hit targets");
  assert.ok(Number(slopeRoot.querySelectorAll("svg")[0].getAttribute("viewBox").split(" ").at(-1)) >= 1_050, "40 endpoint pairs need vertical label spacing");

  const eventItems = Array.from({ length: 500 }, (_, index) => ({
    markId: `event-${index}`,
    label: `Event ${index + 1}`,
    time: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  const eventRoot = new MiniElement("div");
  renderEventStrip(eventRoot, model("timeline", "event-strip", { events: eventItems }), selection);
  assert.equal(eventRoot.querySelectorAll("[data-mark-id]").length, 500, "dense mode must retain every evidence event");
  assert.ok(eventRoot.querySelectorAll("text").length <= 14, "dense mode must bound visible labels");
  assert.ok(nodeCount(eventRoot) < 550, "500 events must render as one bounded rug, not full label/stem triplets");
  assert.match(eventRoot.textContent, /all 500 events remain selectable/u);
}));

test("event strip preserves finite numeric time coordinates including epoch zero", async () => withDocument(async () => {
  const root = new MiniElement("div");
  renderEventStrip(root, model("timeline", "event-strip", {
    events: [
      { markId: "at-zero", label: "Zero", time: 0 },
      { markId: "at-thousand", label: "Thousand", time: 1_000 },
    ],
  }), selection);
  assert.deepEqual(
    root.querySelectorAll("circle").map((circle) => Number(circle.getAttribute("cx"))),
    [70, 900],
  );
}));

test("sample raster keeps a beyond-runtime 100 by 100 grid to bounded linear renderer work", async () => withDocument(async () => {
  const records = Array.from({ length: 10_000 }, (_, index) => {
    const x = index % 100;
    const y = Math.floor(index / 100);
    return {
      markId: `sample-${index}`,
      label: `Sample ${x}, ${y}`,
      x,
      y,
      value: x + y,
    };
  });
  const markById = Object.fromEntries(records.map((record) => [record.markId, {
    id: record.markId,
    label: record.label,
    values: { x: record.x, y: record.y, value: record.value },
    evidenceRefs: [],
  }]));
  const root = new MiniElement("div");
  const startedAt = performance.now();
  const receipt = await renderFamily({
    root,
    dataset: {
      familyId: "field",
      memberId: "sample-raster",
      catalog: currentCatalogReceipt("field", "sample-raster"),
      title: "10,000 samples",
      roles: { x: "x", y: "y", value: "value", label: "label" },
      payload: { samples: records },
      records,
      links: [],
      evidence: [],
      selectableMarkIds: records.map((record) => record.markId),
      selectableTargetIds: [],
      targetById: {},
      markById,
    },
  });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(receipt.markCount, 10_000);
  assert.equal(root.querySelectorAll("[data-mark-id]").length, 10_000);
  assert.ok(root.querySelectorAll("text").length <= 35, "dense raster axes must sample legible endpoint-preserving labels");
  assert.ok(nodeCount(root) < 10_700, `the raster must use one evidence-bearing rectangle per sample plus bounded axes and a bounded data list (at most 100 rows regardless of sample count), not ${nodeCount(root)} nodes`);
  assert.ok(elapsedMs < 5_000, `10,000 samples took ${Math.round(elapsedMs)} ms in the deterministic DOM harness`);
}));

test("exact-form marks and aggregate targets share roving keyboard selection and mobile scroll semantics", async () => withDocument(async () => {
  const markEvents = [];
  const items = [
    { markId: "dot-a", label: "A", value: 1 },
    { markId: "dot-b", label: "B", value: 2 },
    { markId: "dot-c", label: "C", value: 3 },
  ];
  const markRoot = new MiniElement("div");
  await renderFamily({
    root: markRoot,
    dataset: {
      familyId: "rank",
      memberId: "dot-plot",
      catalog: currentCatalogReceipt("rank", "dot-plot"),
      title: "Dots",
      payload: { items },
      records: items,
      links: [],
      evidence: [],
      selectableMarkIds: items.map((item) => item.markId),
      selectableTargetIds: [],
      targetById: {},
      markById: Object.fromEntries(items.map((item) => [item.markId, { ...item, id: item.markId, values: { value: item.value }, evidenceRefs: [] }])),
    },
    onSelect: (event) => markEvents.push(event),
  });
  const marks = markRoot.querySelectorAll("[data-mark-id]");
  assert.deepEqual(marks.map((mark) => mark.getAttribute("tabindex")), ["0", "-1", "-1"]);
  marks[0].dispatchEvent({ type: "keydown", key: "ArrowRight", preventDefault() {} });
  assert.equal(globalThis.document.activeElement, marks[1]);
  marks[1].dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  assert.deepEqual(markEvents, [{ kind: "mark", markId: "dot-b" }]);
  const scrollRegion = markRoot.querySelectorAll("[data-visualization-scroll-region]")[0];
  assert.equal(scrollRegion.getAttribute("role"), "region");
  assert.equal(scrollRegion.getAttribute("tabindex"), "0");

  const targetEvents = [];
  const bins = [
    { targetId: "bin-a", lower: 0, upper: 1, count: 2 },
    { targetId: "bin-b", lower: 1, upper: 2, count: 3 },
  ];
  const targetRoot = new MiniElement("div");
  await renderFamily({
    root: targetRoot,
    dataset: {
      familyId: "distribution",
      memberId: "histogram",
      catalog: currentCatalogReceipt("distribution", "histogram"),
      title: "Histogram",
      payload: { bins },
      records: [],
      links: [],
      evidence: [],
      selectableMarkIds: [],
      selectableTargetIds: ["bin-a", "bin-b"],
      targetById: {
        "bin-a": { id: "bin-a", label: "0–1", count: 2 },
        "bin-b": { id: "bin-b", label: "1–2", count: 3 },
      },
      markById: {},
    },
    onSelect: (event) => targetEvents.push(event),
  });
  const targets = targetRoot.querySelectorAll("[data-target-id]");
  targets[0].dispatchEvent({ type: "keydown", key: "End", preventDefault() {} });
  assert.equal(globalThis.document.activeElement, targets[1]);
  targets[1].dispatchEvent({ type: "keydown", key: " ", preventDefault() {} });
  assert.deepEqual(targetEvents, [{ kind: "target", targetId: "bin-b" }]);

  const outlineRoot = new MiniElement("div");
  const outlineNodes = [
    { nodeId: "root", markId: "outline-root", targetId: "branch-root", label: "Root", parentId: null, value: 2 },
    { nodeId: "leaf", markId: "outline-leaf", targetId: "branch-leaf", label: "Leaf", parentId: "root", value: 1 },
  ];
  await renderFamily({
    root: outlineRoot,
    dataset: {
      familyId: "hierarchy",
      memberId: "outline",
      catalog: currentCatalogReceipt("hierarchy", "outline"),
      title: "Outline",
      payload: { nodes: outlineNodes },
      records: outlineNodes,
      links: [],
      evidence: [],
      selectableMarkIds: outlineNodes.map((node) => node.markId),
      selectableTargetIds: outlineNodes.map((node) => node.targetId),
      targetById: Object.fromEntries(outlineNodes.map((node) => [node.targetId, {
        id: node.targetId,
        label: node.label,
        count: 1,
      }])),
      markById: {},
    },
  });
  assert.deepEqual(
    outlineRoot.querySelectorAll("[data-target-id]").map((target) => target.getAttribute("tabindex")),
    ["0", "-1"],
    "aggregate-only forms must expose one initial keyboard stop",
  );
}));

test("outline computes a valid 5,000-node chain without recursive depth overflow", async () => withDocument(async () => {
  const nodes = Array.from({ length: 5_000 }, (_, index) => ({
    id: `node-${index}`,
    markId: `mark-${index}`,
    label: `Node ${index}`,
    parentId: index === 0 ? null : `node-${index - 1}`,
  }));
  const root = new MiniElement("div");
  renderOutline(root, model("hierarchy", "outline", { nodes }), selection);
  const rows = root.querySelectorAll("[data-mark-id]");
  assert.equal(rows.length, 5_000);
  assert.equal(rows.at(-1).getAttribute("data-depth"), "4999");
}));

test("dense trend, rank, timeline and flow views keep every drawn label inside the canvas and off its neighbours", async () => withDocument(async () => {
  const dates = Array.from({ length: 31 }, (_, index) => `2026-01-${String(index + 1).padStart(2, "0")}`);
  const trendRecords = ["Observed", "Projected"].flatMap((series) => dates.map((time, index) => ({
    markId: `${series}-${time}`,
    label: `${series} ${time}`,
    time,
    series,
    value: index % 7,
  })));
  const trend = new MiniElement("div");
  await renderFamily({
    root: trend,
    dataset: stressDataset("trend", { x: "time", y: "value", series: "series", label: "label" }, trendRecords),
  });
  const trendLabels = assertLegibleLabels(trend, "trend/line with 31 dates and 2 series");
  assert.ok(trendLabels.some((box) => box.text === dates[0]), "the first date must stay labeled");
  assert.ok(trendLabels.some((box) => box.text === dates.at(-1)), "the last date must stay labeled");
  assert.equal(trend.querySelectorAll("[data-mark-id]").length, 62, "thinning removes labels, never marks");

  const rankRecords = Array.from({ length: 40 }, (_, index) => ({
    markId: `rank-${index}`,
    label: `Ranked subject number ${index + 1}`,
    value: 1_000 - index * 25,
  }));
  const rank = new MiniElement("div");
  await renderFamily({ root: rank, dataset: stressDataset("rank", { label: "label", value: "value" }, rankRecords) });
  const rankLabels = assertLegibleLabels(rank, "rank/bar-list with 40 items");
  assert.equal(rank.querySelectorAll("[data-mark-id]").length, 40);
  assert.equal(
    rankLabels.filter((box) => box.text.startsWith("Ranked subject")).length,
    40,
    "a ranked bar without its name is unreadable, so the canvas grows instead of thinning row labels",
  );
  assert.ok(Number(rank.querySelectorAll("svg")[0].getAttribute("viewBox").split(" ").at(-1)) >= 600);

  const intervalRecords = Array.from({ length: 40 }, (_, index) => ({
    markId: `interval-${index}`,
    label: `Workstream item number ${index + 1}`,
    start: `2026-0${1 + (index % 6)}-01`,
    end: `2026-0${2 + (index % 6)}-15`,
    group: index % 2 === 0 ? "Alpha" : "Beta",
  }));
  const interval = new MiniElement("div");
  await renderFamily({
    root: interval,
    dataset: stressDataset("timeline", { start: "start", end: "end", group: "group", label: "label" }, intervalRecords),
  });
  assertLegibleLabels(interval, "timeline/interval with 40 intervals");
  assert.equal(interval.querySelectorAll("[data-mark-id]").length, 40);
  assert.ok(
    Number(interval.querySelectorAll("svg")[0].getAttribute("viewBox").split(" ").at(-1)) >= 1000,
    "interval rows keep a legible pitch by growing the canvas instead of compressing",
  );

  const eventRecords = Array.from({ length: 60 }, (_, index) => ({
    markId: `event-${index}`,
    label: `Recorded event ${index + 1}`,
    time: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
  }));
  const events = new MiniElement("div");
  renderEventStrip(events, model("timeline", "event-strip", { events: eventRecords }), selection);
  assertLegibleLabels(events, "timeline/event-strip with 60 events");
  assert.equal(events.querySelectorAll("[data-mark-id]").length, 60);

  const flowRecords = Array.from({ length: 15 }, (_, index) => ({
    markId: `flow-node-${index}`,
    id: `flow-node-${index}`,
    label: `Processing node ${index + 1}`,
    stage: 0,
    inflow: index,
    outflow: index + 1,
  }));
  const flow = new MiniElement("div");
  await renderFamily({
    root: flow,
    dataset: stressDataset("flow", { label: "label", stage: "stage" }, flowRecords, {
      links: [{ id: "flow-link-0", source: "flow-node-0", target: "flow-node-1", value: 3 }],
      selectableMarkIds: ["flow-link-0"],
    }),
  });
  assertLegibleLabels(flow, "flow/sankey with 15 nodes in one stage");
}));

test("a 24 by 7 heatmap renders calendar row order with thinned headers and gated cell values", async () => withDocument(async () => {
  const columns = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
  const scrambled = ["Friday", "Monday", "Saturday", "Sunday", "Thursday", "Tuesday", "Wednesday"];
  const records = scrambled.flatMap((row) => columns.map((column) => ({
    markId: `${row}-${column}`,
    row,
    column,
    value: (WEEKDAYS.indexOf(row) + 1) * 100_000 + Number(column.slice(0, 2)),
  })));
  const root = new MiniElement("div");
  await renderFamily({
    root,
    dataset: stressDataset("matrix", { row: "row", column: "column", value: "value" }, records, {
      payload: { rows: WEEKDAYS, columns },
    }),
  });
  const boxes = assertLegibleLabels(root, "matrix/heatmap with 24 hourly columns and 7 weekday rows");
  assert.equal(root.querySelectorAll("[data-mark-id]").length, 168, "thinning removes labels, never cells");

  const rowLabels = boxes.filter((box) => WEEKDAYS.includes(box.text)).sort((left, right) => left.y - right.y);
  assert.deepEqual(rowLabels.map((box) => box.text), WEEKDAYS, "declared payload row order wins over record order");

  const drawnHeaders = boxes.filter((box) => columns.includes(box.text));
  assert.ok(drawnHeaders.length < columns.length, "24 hourly headers do not fit at a 29-unit pitch");
  assert.ok(drawnHeaders.some((box) => box.text === columns[0]) && drawnHeaders.some((box) => box.text === columns.at(-1)));
  assert.equal(boxes.filter((box) => /^\d{6}$/u.test(box.text)).length, 0, "six-digit values do not fit a 29-unit cell and stay undrawn");

  const roomy = new MiniElement("div");
  await renderFamily({
    root: roomy,
    dataset: stressDataset("matrix", { row: "row", column: "column", value: "value" }, WEEKDAYS.slice(0, 3).flatMap((row) => (
      ["Morning", "Afternoon", "Evening"].map((column) => ({ markId: `${row}-${column}`, row, column, value: 7 }))
    ))),
  });
  const roomyBoxes = assertLegibleLabels(roomy, "matrix/heatmap with 3 wide columns");
  assert.equal(roomyBoxes.filter((box) => box.text === "7").length, 9, "values that fit their cell are still drawn");
}));

test("a 120-leaf tidy tree grows its canvas instead of stacking node labels", async () => {
  const context = {};
  runInNewContext(await readFile(new URL("vendor/d3.min.js", VIEWER), "utf8"), context);
  const previous = { document: globalThis.document, HTMLElement: globalThis.HTMLElement, d3: globalThis.d3 };
  globalThis.document = new MiniDocument();
  globalThis.HTMLElement = MiniElement;
  globalThis.d3 = context.d3;
  try {
    const records = [{ markId: "root", id: "root", label: "Corpus root", parentId: null, value: 4 }];
    for (let index = 0; index < 120; index += 1) {
      records.push({ markId: `leaf-${index}`, id: `leaf-${index}`, label: `Section ${index + 1}`, parentId: "root", value: 1 });
    }
    const root = new MiniElement("div");
    await renderFamily({
      root,
      dataset: stressDataset("hierarchy", { nodeId: "id", parent: "parentId", label: "label", value: "value" }, records),
    });
    assertLegibleLabels(root, "hierarchy/tidy with 120 leaves");
    const viewBox = root.querySelectorAll("svg")[0].getAttribute("viewBox").split(" ");
    assert.ok(Number(viewBox.at(-1)) >= 2_600, "120 leaves need vertical room, not a fixed 450-unit frame");
    assert.equal(root.querySelectorAll("[data-mark-id]").length, 121);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("region symbols give all five bundled territories labeled selectable insets", async () => {
  const prior = {
    document: globalThis.document,
    d3: globalThis.d3,
    topojson: globalThis.topojson,
    fetch: globalThis.fetch,
  };
  globalThis.document = new MiniDocument();
  const projection = (coordinates) => coordinates;
  projection.fitExtent = () => projection;
  const path = () => "M0 0";
  path.centroid = () => [Number.NaN, Number.NaN];
  globalThis.d3 = { geoAlbersUsa: () => projection, geoPath: () => path };
  const territoryIds = ["60", "66", "69", "72", "78"];
  globalThis.topojson = {
    feature: () => ({ features: territoryIds.map((id) => ({ id })) }),
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ objects: { states: {} } }) });
  try {
    const regions = territoryIds.map((region, index) => ({
      fips: region,
      label: `Territory ${region}`,
      markId: `mark-${region}`,
      value: index + 1,
    }));
    const root = new MiniElement("div");
    await renderRegionSymbols(root, model("region-map", "region-symbols", { regions }), selection);
    assert.deepEqual(
      root.querySelectorAll("[data-region-id]").map((node) => node.getAttribute("data-region-id")),
      territoryIds,
    );
    assert.equal(root.querySelectorAll("[data-mark-id]").length, 5);
    assert.match(root.textContent, /Territories use separated insets/u);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
