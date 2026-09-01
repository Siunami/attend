import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildVisualizationInspectionIndex,
} from "../viewer/visualization-inspector.js";
import { renderFamily } from "../viewer/family-renderers.js";

class MiniElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.parentNode = null;
    this._text = "";
    this.disabled = false;
  }

  set textContent(value) { this._text = String(value); }
  get textContent() { return `${this._text}${this.children.map((child) => child.textContent).join("")}`; }
  set className(value) { this.setAttribute("class", value); }
  get className() { return this.getAttribute("class") ?? ""; }
  append(...nodes) {
    for (const node of nodes.flat()) {
      if (node === null || node === undefined) continue;
      this.children.push(node);
      if (typeof node === "object") node.parentNode = this;
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
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
  focus() {
    globalThis.document.activeElement = this;
    this.dispatchEvent({ type: "focus" });
  }
  querySelectorAll(selector) {
    const attribute = /^\[([a-z-]+)\]$/u.exec(selector)?.[1] ?? null;
    const matches = [];
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if (attribute && child.getAttribute?.(attribute) !== null) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

class MiniDocument {
  constructor() { this.activeElement = null; }
  createElement(name) { return new MiniElement(name); }
  createElementNS(_namespace, name) { return new MiniElement(name); }
}

function field(root, name) {
  return root.querySelectorAll("[data-list-field]")
    .find((node) => node.getAttribute("data-list-field") === name);
}

function action(root, name) {
  return root.querySelectorAll("[data-list-action]")
    .find((node) => node.getAttribute("data-list-action") === name);
}

function listRows(root) {
  return root.querySelectorAll("[data-list-mark-id]");
}

function rowButton(root, markId) {
  return listRows(root)
    .find((row) => row.getAttribute("data-list-mark-id") === markId)
    ?.children.find((child) => child.tagName === "button");
}

function target(root, attribute, id) {
  return root.querySelectorAll(`[${attribute}]`)
    .find((node) => node.getAttribute(attribute) === id);
}

function interaction(type, key) {
  return {
    type,
    key,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}

async function withMiniDocument(callback) {
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    window: globalThis.window,
  };
  globalThis.document = new MiniDocument();
  globalThis.HTMLElement = MiniElement;
  globalThis.MouseEvent = class {
    constructor(type) { this.type = type; }
  };
  globalThis.window = {};
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

const firstReference = "evidence_1111111111111111";
const secondReference = "evidence_2222222222222222";

function networkModel() {
  return {
    familyId: "network",
    title: "Request path",
    roles: { label: "label" },
    selectableMarkIds: ["edge-input-check", "edge-check-output"],
    markById: {
      "edge-input-check": {
        id: "edge-input-check",
        label: "Input feeds Check",
        summary: "A request enters validation.",
        values: {
          source: "Input",
          target: "Check",
          relation: "feeds",
          weight: 7,
          sourceId: "private-source",
          sourceIdentity: "private-source-identity",
          sourcePath: "private/source.md",
          filePath: "private/file.md",
          locator: { line: 12 },
          citation: firstReference,
          location: "private/location.md",
          detail: { status: "observed", displayPath: "private/file.md" },
        },
        evidenceRefs: [firstReference, firstReference, secondReference],
        excerpt: "private excerpt",
      },
      "edge-check-output": {
        id: "edge-check-output",
        label: "Check emits Output",
        summary: "A valid request continues.",
        values: { source: "Check", target: "Output", relation: "emits" },
        evidenceRefs: [secondReference],
      },
    },
    records: [
      { id: "Input", label: "Input" },
      { id: "Check", label: "Check", group: "Validation", stage: 2, sourceId: "private-node-source" },
      { id: "Output", label: "Output" },
    ],
    links: [
      { id: "edge-input-check", source: "Input", target: "Check", type: "feeds" },
      { id: "edge-check-output", source: "Check", target: "Output", type: "emits" },
    ],
  };
}

test("inspection index exposes display context without private evidence linkage", () => {
  const index = buildVisualizationInspectionIndex(networkModel());
  const firstMark = index.entries.find((entry) => entry.target.markId === "edge-input-check");
  const checkNode = index.entries.find((entry) => entry.target.nodeId === "Check");

  assert.deepEqual(firstMark, {
    target: { kind: "mark", markId: "edge-input-check" },
    label: "Input feeds Check",
    summary: "A request enters validation.",
    values: {
      source: "Input",
      target: "Check",
      relation: "feeds",
      weight: 7,
    },
    relations: [{ label: "Input feeds Check", evidenceCount: 2 }],
    evidenceCount: 2,
  });
  assert.deepEqual(checkNode, {
    target: { kind: "node", nodeId: "Check" },
    label: "Check",
    summary: "2 connected relationships",
    values: { group: "Validation", stage: 2 },
    relations: [
      { label: "Input feeds Check", evidenceCount: 2 },
      { label: "Check emits Output", evidenceCount: 1 },
    ],
    evidenceCount: 2,
  });

  const serialized = JSON.stringify(index);
  assert.doesNotMatch(serialized, /evidence_[a-f0-9]+|private-source|private excerpt|private\/(?:file|location)|sourceId|sourceIdentity|sourcePath|filePath|locator|displayPath|citation|location/u);
});

test("the data list shows every row, filters on selection, and clears", async () => {
  await withMiniDocument(async () => {
    const root = new MiniElement("div");
    const selected = [];
    const cleared = [];
    const receipt = await renderFamily({
      root,
      dataset: networkModel(),
      onSelect: (value) => selected.push(value),
      onClear: () => cleared.push(true),
    });
    const panel = root.querySelectorAll("[data-visualization-data-list]")[0];
    const scrollRegion = root.querySelectorAll("[data-visualization-scroll-region]")[0];
    const scrollHint = root.querySelectorAll("[data-visualization-scroll-hint]")[0];

    assert.equal(root.children.at(-1), panel, "the data list follows the rendered visualization in flow");
    assert.equal(root.children[0], scrollRegion, "the visualization is the first item in its scroll region");
    assert.equal(scrollRegion.getAttribute("role"), "region");
    assert.equal(scrollRegion.getAttribute("tabindex"), "0");
    assert.match(scrollRegion.getAttribute("aria-label"), /scrollable visualization/iu);
    assert.match(scrollHint.textContent, /swipe horizontally/iu);
    assert.equal(panel.getAttribute("aria-live"), "off");
    assert.equal(panel.getAttribute("data-list-state"), "all");
    assert.equal(listRows(root).length, 2, "every mark appears as a data row");
    assert.match(field(panel, "status").textContent, /2 items/u);
    assert.equal(action(panel, "clear"), undefined, "nothing to clear before a selection");
    assert.equal(receipt.markCount, 2);

    rowButton(root, "edge-check-output").click();
    assert.deepEqual(selected, [{ kind: "mark", markId: "edge-check-output" }], "a row click selects its mark");

    const filteredRoot = new MiniElement("div");
    await renderFamily({
      root: filteredRoot,
      dataset: networkModel(),
      selectedIds: ["edge-input-check"],
      onSelect: (value) => selected.push(value),
      onClear: () => cleared.push(true),
    });
    const filteredPanel = filteredRoot.querySelectorAll("[data-visualization-data-list]")[0];
    assert.equal(filteredPanel.getAttribute("data-list-state"), "filtered");
    assert.match(field(filteredPanel, "status").textContent, /1 of 2/u);
    assert.equal(listRows(filteredRoot).length, 1, "the list narrows to the selected rows");
    const selectedRow = rowButton(filteredRoot, "edge-input-check");
    assert.equal(selectedRow.getAttribute("aria-pressed"), "true");
    const detail = field(filteredPanel, "detail");
    assert.ok(detail, "the selected row expands to its full fields");
    assert.match(detail.textContent, /A request enters validation\./u);
    assert.match(detail.textContent, /Input feeds Check/u);

    selectedRow.click();
    assert.equal(cleared.length, 1, "clicking the selected row widens back out");
    action(filteredPanel, "clear").click();
    assert.equal(cleared.length, 2, "the clear control widens back out");
  });
});

test("a selected node filters the list to its connected relationship rows", async () => {
  await withMiniDocument(async () => {
    const root = new MiniElement("div");
    await renderFamily({
      root,
      dataset: networkModel(),
      selectedIds: ["edge-input-check", "edge-check-output"],
      selectedNodeId: "Check",
    });
    const panel = root.querySelectorAll("[data-visualization-data-list]")[0];
    assert.equal(panel.getAttribute("data-list-state"), "node");
    assert.match(field(panel, "status").textContent, /Check · 2 of 2/u);
    assert.equal(listRows(root).length, 2, "the node lists every connected relationship row");

    const matrix = new MiniElement("div");
    await renderFamily({
      root: matrix,
      dataset: {
        familyId: "matrix",
        title: "Coverage",
        roles: { row: "row", column: "column", value: "value" },
        records: [{ id: "opaque-mark-id", markId: "opaque-mark-id", row: "Need", column: "Feature", value: 1 }],
        links: [],
        selectableMarkIds: ["opaque-mark-id"],
        markById: {
          "opaque-mark-id": {
            id: "opaque-mark-id",
            label: "Need by feature",
            summary: "One observed intersection.",
            values: { row: "Need", column: "Feature", value: 1 },
            evidenceRefs: [firstReference],
          },
        },
      },
      selectableMarkIds: ["opaque-mark-id"],
    });
    assert.equal(target(matrix, "data-mark-id", "opaque-mark-id").getAttribute("aria-label"), "Need by feature");
  });
});

test("over-connected nodes stay inert instead of advertising a rejected selection", async () => {
  await withMiniDocument(async () => {
    const links = Array.from({ length: 51 }, (_, index) => ({
      id: `edge-${index + 1}`,
      source: "Hub",
      target: `Leaf ${index + 1}`,
      type: "connects",
    }));
    const markById = Object.fromEntries(links.map((link, index) => [link.id, {
      id: link.id,
      label: `Hub connects Leaf ${index + 1}`,
      summary: "Observed connection.",
      values: link,
      evidenceRefs: [`evidence_${String(index + 1).padStart(16, "0")}`],
    }]));
    const root = new MiniElement("div");
    const selected = [];
    const receipt = await renderFamily({
      root,
      dataset: {
        familyId: "network",
        title: "Dense hub",
        roles: { label: "label" },
        records: [
          { id: "Hub", label: "Hub", group: "Center" },
          ...links.map((link) => ({ id: link.target, label: link.target, group: "Leaf" })),
        ],
        links,
        markById,
        selectableMarkIds: links.map((link) => link.id),
      },
      onSelect: (targetValue) => selected.push(targetValue),
    });
    const hub = target(root, "data-inspection-node-id", "Hub");

    assert.ok(hub);
    assert.equal(target(root, "data-node-id", "Hub"), undefined);
    assert.ok(!receipt.selectableNodeIds.includes("Hub"));
    assert.equal(hub.getAttribute("role"), null, "an unselectable node is not presented as a button");
    assert.equal(hub.getAttribute("tabindex"), null);
    assert.match(hub.getAttribute("aria-label"), /too many connections/u);
    hub.click();
    assert.deepEqual(selected, []);
    assert.equal(listRows(root).length, 51, "the data list still shows every relationship row");
  });
});

test("trend halos widen dot targets and select their mark", async () => {
  await withMiniDocument(async () => {
    const root = new MiniElement("div");
    const selected = [];
    await renderFamily({
      root,
      dataset: {
        familyId: "trend",
        title: "Daily messages",
        roles: { x: "time", y: "value", series: "series" },
        records: [
          { markId: "day-1", time: "2026-08-01", value: 4, series: "sent" },
          { markId: "day-2", time: "2026-08-02", value: 6, series: "sent" },
        ],
      },
      onSelect: (value) => selected.push(value),
    });
    const dot = target(root, "data-mark-id", "day-2");
    const halo = target(root, "data-mark-hit", "day-2");
    assert.ok(halo, "every trend dot renders an invisible pointer halo");
    assert.equal(halo.getAttribute("class"), "mark-hit");
    assert.ok(Number(halo.getAttribute("r")) > Number(dot.getAttribute("r")));
    assert.equal(halo.getAttribute("tabindex"), null, "halos never join the focus order");

    halo.click();
    assert.deepEqual(selected, [{ kind: "mark", markId: "day-2" }]);
    assert.equal(listRows(root).length, 2, "the unfiltered list shows both observations");
    assert.match(field(root.querySelectorAll("[data-visualization-data-list]")[0], "status").textContent, /2 items/u);
  });
});

test("both viewer shells style the shared data list", async () => {
  const [viewerStyles, labStyles, viewerHtml] = await Promise.all([
    readFile(new URL("../viewer/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../viewer/family-lab.css", import.meta.url), "utf8"),
    readFile(new URL("../viewer/index.html", import.meta.url), "utf8"),
  ]);

  for (const styles of [viewerStyles, labStyles]) {
    assert.match(styles, /\.visualization-data-list\s*\{/u);
    assert.match(styles, /\.visualization-data-list-rows\s*\{[^}]*overflow-y:\s*auto/su);
    assert.match(styles, /\.visualization-data-list-row-button\[aria-pressed="true"\]/u);
    assert.doesNotMatch(styles, /visualization-inspector/u);
  }
  assert.doesNotMatch(viewerHtml, /id="atlas-visual"[^>]*aria-live/u);
});

test("both viewer shells declare a legible mobile canvas", async () => {
  const [viewerStyles, labStyles] = await Promise.all([
    readFile(new URL("../viewer/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../viewer/family-lab.css", import.meta.url), "utf8"),
  ]);

  for (const styles of [viewerStyles, labStyles]) {
    assert.match(styles, /--mobile-visualization-min-width:\s*900px/u);
    assert.match(styles, /\.visualization-scroll-region\s*\{[^}]*overflow-x:\s*auto/su);
    assert.match(styles, /\.visualization-scroll-region\s*>\s*svg\s*\{[^}]*min-width:\s*var\(--mobile-visualization-min-width\)/su);
    assert.match(styles, /@media\s*\(max-width:\s*820px\),\s*\(pointer:\s*coarse\)/u);
    assert.match(styles, /button,[\s\S]*?min-height:\s*44px/su);
  }
});
