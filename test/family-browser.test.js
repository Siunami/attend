import assert from "node:assert/strict";
import test from "node:test";

import {
  filterFamilyBrowserMembers,
  mountFamilyBrowser,
  parseFamilyBrowserState,
  serializeFamilyBrowserState,
} from "../viewer/family-browser.js";
import { FAMILY_BROWSER_CATALOG } from "../viewer/family-catalog.js";

const CATALOG = Object.freeze({
  schemaVersion: 1,
  catalogVersion: "test-catalog",
  counts: {
    families: 3,
    approved: 4,
    executable: 2,
    documented: 1,
    unavailable: 1,
    rejected: 2,
  },
  groups: [
    { id: "comparison", label: "Comparison" },
    { id: "systems", label: "Systems" },
  ],
  inputMedia: ["structured", "text", "image"],
  families: [
    {
      id: "rank",
      title: "Rank",
      group: "comparison",
      question: "What is larger or smaller?",
      oneLine: "Ordered magnitudes.",
      summary: "Compare observed quantities.",
      executableMemberIds: ["bar-list"],
      renderer: { id: "attend-rank", version: 1 },
      roles: {
        required: [{ id: "label", description: "Item label.", types: ["string"] }],
        optional: [],
        minimumRecords: 3,
        maximumRecords: 40,
      },
      grammar: { mark: "bar", layout: "ordered list", encodings: ["length"], invariants: ["zero baseline"] },
      validationRules: ["Every item has a label."],
      evidenceRequirements: ["Every mark has evidence."],
      mediaAdapters: [
        { medium: "structured", decision: "direct", reason: "Values are already supplied." },
        { medium: "text", decision: "deterministic", reason: "Extract observed values." },
        { medium: "image", decision: "abstain", reason: "Images do not supply a measure." },
      ],
      abstention: { question: "What deserves attention?", why: "No measure exists.", instead: "Show the evidence list." },
      members: [
        {
          id: "bar-list",
          name: "Bar list",
          authoredBand: "core",
          status: "executable",
          when: "items share one measure",
          rationale: "Direct labels and a zero baseline keep comparison honest.",
          band: "3–40 items",
          lineage: "Playfair",
          rendererVariantId: "bar-list",
        },
        {
          id: "lollipop",
          name: "Lollipop",
          authoredBand: "variant",
          status: "documented",
          when: "the baseline should stay quiet",
          rationale: "A point and stem reduce ink.",
          band: "3–30 items",
          lineage: "dot plot",
        },
        {
          id: "three-d-bars",
          name: "Three-dimensional bars",
          authoredBand: "rejected",
          status: "rejected",
          when: "never",
          rationale: "Perspective distorts length.",
          rejectionReason: "Perspective distorts length.",
          band: "rejected",
          lineage: "presentation default",
        },
      ],
    },
    {
      id: "mechanism",
      title: "Mechanism",
      group: "systems",
      question: "How does this system work?",
      oneLine: "Typed components and connections.",
      summary: "Explain a process without decorative arrows.",
      executableMemberIds: ["flowchart"],
      renderer: { id: "attend-mechanism", version: 1 },
      roles: { required: [], optional: [], minimumRecords: 1, maximumRecords: 80 },
      grammar: { mark: "node and link", layout: "directed", encodings: ["connection"], invariants: ["typed links"] },
      validationRules: ["Every link resolves."],
      evidenceRequirements: ["Every link has evidence."],
      mediaAdapters: [
        { medium: "structured", decision: "direct", reason: "Typed links are supplied." },
        { medium: "text", decision: "enrich", reason: "Claims need bounded review." },
        { medium: "image", decision: "enrich", reason: "Observed components may help." },
      ],
      abstention: { question: "Why did this happen?", why: "No causal evidence exists.", instead: "Show recorded observations." },
      members: [
        {
          id: "flowchart",
          name: "Flowchart",
          authoredBand: "core",
          status: "executable",
          when: "steps and decisions are explicit",
          rationale: "Typed arrows connect named components.",
          band: "3–20 nodes",
          lineage: "process chart",
          rendererVariantId: "system-schematic",
        },
        {
          id: "fishbone",
          name: "Fishbone",
          authoredBand: "rejected",
          status: "rejected",
          when: "never without causal evidence",
          rationale: "Branches turn guesses into causes.",
          rejectionReason: "Branches turn guesses into causes.",
          band: "rejected",
          lineage: "Ishikawa",
        },
      ],
    },
    {
      id: "annotated-specimen",
      title: "Annotated specimen",
      group: "systems",
      question: "What matters on this artifact?",
      oneLine: "Labels anchored to source geometry.",
      summary: "Inspect exact regions of a visible source.",
      executableMemberIds: [],
      renderer: { id: "attend-annotated-specimen", version: 1 },
      roles: { required: [], optional: [], minimumRecords: 1, maximumRecords: 20 },
      grammar: { mark: "callout", layout: "anchored", encodings: ["position"], invariants: ["visible specimen"] },
      validationRules: ["Every callout has a locator."],
      evidenceRequirements: ["The specimen remains visible."],
      mediaAdapters: [
        { medium: "structured", decision: "enrich", reason: "A visible specimen is still required." },
        { medium: "text", decision: "deterministic", reason: "Text ranges can be located." },
        { medium: "image", decision: "direct", reason: "Image geometry is native." },
      ],
      abstention: { question: "Label this automatically", why: "No exact locators exist.", instead: "Show the source unchanged." },
      members: [
        {
          id: "callout-overlay",
          name: "Anchored callout overlay",
          authoredBand: "core",
          status: "unavailable",
          when: "a few observed regions need names",
          rationale: "Labels resolve to exact regions.",
          unavailableReason: "This release cannot bind a visible specimen.",
          band: "2–12 callouts",
          lineage: "scientific plate",
        },
      ],
    },
  ],
});

test("parseFamilyBrowserState returns stable defaults and drops unknown values", () => {
  assert.deepEqual(parseFamilyBrowserState("?lens=bogus&family=missing&status=bogus&group=missing&medium=audio", CATALOG), {
    version: 1,
    lens: "families",
    familyId: null,
    memberId: null,
    query: "",
    statuses: ["executable", "documented", "unavailable", "rejected"],
    groupIds: [],
    medium: null,
  });
});

test("parseFamilyBrowserState validates member ownership and restores an implied family", () => {
  const implied = parseFamilyBrowserState(
    "?v=1&lens=forms&member=flowchart&q=%20typed%20arrows%20&status=rejected,executable&group=systems&medium=text",
    CATALOG,
  );
  assert.deepEqual(implied, {
    version: 1,
    lens: "forms",
    familyId: "mechanism",
    memberId: "flowchart",
    query: "typed arrows",
    statuses: ["executable", "rejected"],
    groupIds: ["systems"],
    medium: "text",
  });

  assert.equal(
    parseFamilyBrowserState("?family=rank&member=flowchart", CATALOG).memberId,
    null,
    "a member from another family must not survive a conflicting family route",
  );
});

test("serializeFamilyBrowserState emits one canonical query and round-trips empty status", () => {
  const state = {
    version: 1,
    lens: "constraints",
    familyId: "mechanism",
    memberId: "flowchart",
    query: "typed arrows",
    statuses: ["rejected", "executable", "rejected"],
    groupIds: ["systems", "comparison", "systems"],
    medium: "text",
  };
  assert.equal(
    serializeFamilyBrowserState(state),
    "?v=1&lens=constraints&family=mechanism&member=flowchart&q=typed+arrows&status=executable%2Crejected&group=comparison%2Csystems&medium=text",
  );
  assert.deepEqual(
    parseFamilyBrowserState(serializeFamilyBrowserState(state), CATALOG),
    { ...state, statuses: ["executable", "rejected"], groupIds: ["comparison", "systems"] },
  );

  const noStatuses = { ...state, statuses: [] };
  assert.match(serializeFamilyBrowserState(noStatuses), /(?:^|&)status=none(?:&|$)/u);
  assert.deepEqual(parseFamilyBrowserState(serializeFamilyBrowserState(noStatuses), CATALOG).statuses, []);
});

test("filterFamilyBrowserMembers intersects status, group, medium, and tokenized search", () => {
  const state = {
    ...parseFamilyBrowserState("", CATALOG),
    lens: "forms",
    statuses: ["executable", "rejected"],
    groupIds: ["systems"],
    medium: "text",
    query: "typed arrows",
  };
  assert.deepEqual(
    filterFamilyBrowserMembers(CATALOG, state).map(({ family, member }) => `${family.id}/${member.id}`),
    ["mechanism/flowchart"],
  );
  assert.deepEqual(
    filterFamilyBrowserMembers(CATALOG, { ...state, query: "mechanism flowchart" })
      .map(({ family, member }) => `${family.id}/${member.id}`),
    ["mechanism/flowchart"],
    "search falls back to matching tokens across family and form fields",
  );
});

test("filterFamilyBrowserMembers treats abstaining media as unsupported and never mutates the catalog", () => {
  const before = JSON.stringify(CATALOG);
  const imageState = {
    ...parseFamilyBrowserState("", CATALOG),
    statuses: ["executable", "documented", "unavailable"],
    medium: "image",
  };
  assert.deepEqual(
    filterFamilyBrowserMembers(CATALOG, imageState).map(({ family, member }) => `${family.id}/${member.id}`),
    [
      "mechanism/flowchart",
      "annotated-specimen/callout-overlay",
    ],
  );
  assert.deepEqual(filterFamilyBrowserMembers(CATALOG, { ...imageState, statuses: [] }), []);
  assert.equal(JSON.stringify(CATALOG), before);
});

test("the real catalog starts with every governed member and accepts its declared media vocabulary", () => {
  const state = parseFamilyBrowserState("", FAMILY_BROWSER_CATALOG);
  const members = filterFamilyBrowserMembers(FAMILY_BROWSER_CATALOG, state);
  assert.equal(members.length, 144);
  assert.deepEqual(
    Object.fromEntries(["executable", "documented", "unavailable", "rejected"].map((status) => [
      status,
      members.filter(({ member }) => member.status === status).length,
    ])),
    {
      executable: 34,
      documented: 71,
      unavailable: 1,
      rejected: 38,
    },
  );
  assert.equal(parseFamilyBrowserState("?medium=mixed", FAMILY_BROWSER_CATALOG).medium, "mixed");

  const crossFieldMatches = filterFamilyBrowserMembers(FAMILY_BROWSER_CATALOG, {
    ...state,
    query: "distribution histogram",
  });
  assert.ok(
    crossFieldMatches.some(({ family, member }) => family.id === "distribution" && member.id === "histogram"),
    "a same-field result cannot hide a form whose query spans family and member fields",
  );
});

class MiniClassList {
  constructor(element) { this.element = element; }
  values() { return new Set(this.element.className.split(/\s+/u).filter(Boolean)); }
  add(value) {
    const names = this.values();
    names.add(value);
    this.element.className = [...names].join(" ");
  }
  toggle(value, force) {
    const names = this.values();
    const enabled = force ?? !names.has(value);
    if (enabled) names.add(value);
    else names.delete(value);
    this.element.className = [...names].join(" ");
    return enabled;
  }
}

class MiniElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.classList = new MiniClassList(this);
    this.dataset = new Proxy({}, {
      set: (target, key, value) => {
        target[key] = String(value);
        this.setAttribute(`data-${String(key).replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`, value);
        return true;
      },
    });
    this._text = "";
    this.value = "";
    this.checked = false;
  }
  set textContent(value) { this._text = String(value ?? ""); this.children = []; }
  get textContent() { return `${this._text}${this.children.map((child) => child.textContent ?? "").join("")}`; }
  set className(value) { this.setAttribute("class", value); }
  get className() { return this.getAttribute("class") ?? ""; }
  set id(value) { this.setAttribute("id", value); }
  get id() { return this.getAttribute("id") ?? ""; }
  append(...nodes) {
    nodes.flat().filter((node) => node !== null && node !== undefined).forEach((node) => this.children.push(node));
  }
  replaceChildren(...nodes) { this.children = []; this._text = ""; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
  getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
  click() { this.dispatchEvent({ type: "click" }); }
  focus() { globalThis.document.activeElement = this; }
}

class MiniDocument {
  constructor() { this.activeElement = null; }
  createElement(tagName) { return new MiniElement(tagName); }
  createTextNode(value) { return { textContent: String(value) }; }
  createDocumentFragment() { return new MiniElement("fragment"); }
}

function descendants(root) {
  const result = [];
  const visit = (node) => {
    for (const child of node.children ?? []) {
      result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}

function byClass(root, className) {
  return descendants(root).filter((element) => element.className?.split(/\s+/u).includes(className));
}

function byId(root, id) {
  return descendants(root).find((element) => element.id === id) ?? null;
}

test("mountFamilyBrowser renders the governed executable slice and keeps runtime opening explicit", () => {
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
  };
  const historyCalls = [];
  globalThis.document = new MiniDocument();
  globalThis.location = {
    href: "https://attend.test/families/?lens=forms&status=executable",
    search: "?lens=forms&status=executable",
  };
  globalThis.history = {
    pushState(_state, _title, url) {
      historyCalls.push(["push", String(url)]);
      globalThis.location.href = String(url);
      globalThis.location.search = new URL(String(url)).search;
    },
    replaceState(_state, _title, url) {
      historyCalls.push(["replace", String(url)]);
      globalThis.location.href = String(url);
      globalThis.location.search = new URL(String(url)).search;
    },
  };

  try {
    const root = new MiniElement("div");
    const opened = [];
    const browser = mountFamilyBrowser({
      root,
      editorialBaseUrl: "https://atlas.test/",
      onOpenRuntime: (target) => opened.push(target),
    });

    assert.equal(byId(root, "family-browser-heading").textContent, "Explore visualization families");
    assert.equal(byClass(root, "family-browser__ledger-item").length, 4);
    assert.equal(byClass(root, "family-browser__lens").length, 3);
    assert.equal(byClass(root, "family-browser__member-card").length, FAMILY_BROWSER_CATALOG.counts.executable);
    assert.match(byId(root, "family-browser-result-summary").textContent, /^34 of 144 authored forms match$/u);
    assert.equal(byId(root, "family-browser-dossier").dataset.dossierState, "empty");
    assert.ok(historyCalls.some(([kind, url]) => kind === "replace" && url.includes("v=1")));

    const firstRuntime = byClass(root, "family-browser__runtime-link")[0];
    firstRuntime.click();
    assert.equal(opened.length, 1);
    assert.deepEqual(Object.keys(opened[0]).sort(), ["familyId", "memberId"]);
    const runtimeUrl = new URL(globalThis.location.href);
    assert.equal(runtimeUrl.searchParams.get("family"), opened[0].familyId);
    assert.equal(runtimeUrl.searchParams.get("member"), opened[0].memberId);
    assert.equal(byId(root, "family-browser-dossier").dataset.dossierState, "populated");
    assert.equal(globalThis.document.activeElement, byId(root, "family-browser-dossier"));

    const firstMember = byClass(root, "family-browser__member-name")[0];
    firstMember.click();
    assert.ok(historyCalls.some(([kind, url]) => kind === "push" && url.includes("member=")));
    assert.match(byId(root, "family-browser-dossier").textContent, /Data contract/u);
    assert.match(byId(root, "family-browser-dossier").textContent, /Generatable bounds/u);
    assert.match(byId(root, "family-browser-dossier").textContent, /Dimensionality/u);
    assert.equal(byId(root, "family-browser-dossier").dataset.dossierState, "populated");
    assert.equal(globalThis.document.activeElement, byId(root, "family-browser-dossier"));
    assert.match(byId(root, "family-browser-live").textContent, /details opened/u);

    const openMember = (memberId) => {
      const card = byClass(root, "family-browser__member-card").find((candidate) => candidate.dataset.memberId === memberId);
      assert.ok(card, `missing ${memberId} card`);
      byClass(card, "family-browser__member-name")[0].click();
      return byId(root, "family-browser-dossier").textContent;
    };
    const dotPlot = openMember("dot-plot");
    assert.match(dotPlot, /20–300 rows/u, "the authored quantity band must remain visible");
    assert.match(dotPlot, /20–300 records/u, "the executable quantity band must format its runtime requirement");
    assert.doesNotMatch(dotPlot, /No runtime band/u);
    assert.match(dotPlot, /Exact data roles[\s\S]*Label[\s\S]*Value/u);
    assert.match(openMember("slopegraph"), /State Order/u);
    assert.match(openMember("state-ribbon"), /Duration/u);
    assert.match(openMember("contact-atlas"), /Asset Id[\s\S]*Preview Route[\s\S]*Capture Time/u);

    const ledgerItems = byClass(root, "family-browser__ledger-item");
    ledgerItems.find((button) => button.dataset.status === "rejected").click();
    ledgerItems.find((button) => button.dataset.status === "executable").click();
    const rejectedCards = byClass(root, "family-browser__member-card");
    assert.equal(rejectedCards.length, FAMILY_BROWSER_CATALOG.counts.rejected);
    assert.equal(byClass(root, "family-browser__runtime-link").length, 0);
    rejectedCards.forEach((card) => {
      assert.ok(byClass(card, "family-browser__status-copy")[0]?.textContent.trim(), "every rejected form needs its reason");
      assert.equal(byClass(card, "family-browser__status--rejected")[0]?.textContent, "Rejected from the family");
    });

    ledgerItems.find((button) => button.dataset.status === "rejected").click();
    ledgerItems.find((button) => button.dataset.status === "unavailable").click();
    byClass(root, "family-browser__member-name")[0].click();
    const unavailableDossier = byId(root, "family-browser-dossier").textContent;
    assert.match(unavailableDossier, /Governed representation bounds/u);
    assert.match(unavailableDossier, /still blocks it in this release/u);
    assert.doesNotMatch(unavailableDossier, /exact representation constraints this release can satisfy/u);

    browser.destroy();
    assert.equal(root.children.length, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
