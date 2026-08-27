// This is intentionally an allowlist. The canonical package validator limits
// mark values to governed data roles, but the inspector is also a public UI
// boundary and must fail closed when handed a future or synthetic model.
const MARK_VALUE_KEYS = new Set([
  "baseline",
  "cluster",
  "column",
  "dimension",
  "duration",
  "endTime",
  "entity",
  "group",
  "height",
  "label",
  "lane",
  "latitude",
  "layer",
  "longitude",
  "order",
  "part",
  "passage",
  "region",
  "relation",
  "row",
  "series",
  "similarity",
  "size",
  "source",
  "specimen",
  "stage",
  "status",
  "target",
  "time",
  "uncertainty",
  "value",
  "version",
  "weight",
  "whole",
  "width",
  "x",
  "y",
]);

const NODE_VALUE_KEYS = new Set([
  "balanceGap",
  "cyclic",
  "group",
  "inflow",
  "layer",
  "outflow",
  "stage",
]);

export const VISUALIZATION_INSPECTOR_CLASSES = Object.freeze({
  root: "visualization-inspector",
  header: "visualization-inspector-header",
  heading: "visualization-inspector-heading",
  position: "visualization-inspector-position",
  navigation: "visualization-inspector-navigation",
  previous: "visualization-inspector-previous",
  next: "visualization-inspector-next",
  close: "visualization-inspector-close",
  body: "visualization-inspector-body",
  rest: "visualization-inspector-rest",
  kind: "visualization-inspector-kind",
  label: "visualization-inspector-label",
  summary: "visualization-inspector-summary",
  values: "visualization-inspector-values",
  value: "visualization-inspector-value",
  evidence: "visualization-inspector-evidence",
  relations: "visualization-inspector-relations",
  relationsHeading: "visualization-inspector-relations-heading",
  relationsList: "visualization-inspector-relations-list",
  relation: "visualization-inspector-relation",
  scrollRegion: "visualization-scroll-region",
  scrollHint: "visualization-scroll-hint",
});

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== "").map(String))];
}

function displayValue(value) {
  return [null, "string", "number", "boolean"].includes(value === null ? null : typeof value)
    ? value
    : undefined;
}

function displayValues(record, allowedKeys) {
  if (!object(record)) return {};
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => allowedKeys.has(key))
    .map(([key, value]) => [key, displayValue(value)])
    .filter(([, value]) => value !== undefined));
}

function evidenceReferences(mark) {
  return unique(list(mark?.evidenceRefs).filter((reference) => typeof reference === "string"));
}

function nodeValues(record) {
  return displayValues(record, NODE_VALUE_KEYS);
}

function markIdentifier(value) {
  if (!object(value)) return "";
  return String(value.markId ?? value.id ?? "");
}

function nodeIdentifier(value) {
  if (!object(value)) return "";
  return String(value.nodeId ?? value.id ?? "");
}

function nodeLabels(dataset) {
  return new Map(list(dataset?.records).map((record) => [
    nodeIdentifier(record),
    String(record.semanticLabel ?? record.label ?? record.nodeId ?? record.id ?? "Untitled"),
  ]));
}

function relationFor(dataset, link, mark, labels) {
  const source = String(link?.source ?? mark?.values?.source ?? "");
  const target = String(link?.target ?? mark?.values?.target ?? "");
  const relation = String(
    link?.type
      ?? link?.relation
      ?? mark?.values?.relation
      ?? mark?.values?.label
      ?? "connects",
  );
  const sourceLabel = labels.get(source) ?? source;
  const targetLabel = labels.get(target) ?? target;
  const label = source && target
    ? `${sourceLabel} ${relation} ${targetLabel}`
    : String(mark?.label ?? relation);
  return {
    label,
    evidenceCount: evidenceReferences(mark ?? link).length,
  };
}

function availableMarkIds(dataset, requestedIds) {
  if (Array.isArray(requestedIds)) return unique(requestedIds);
  if (Array.isArray(dataset?.selectableMarkIds)) return unique(dataset.selectableMarkIds);
  return unique([
    ...Object.keys(object(dataset?.markById) ? dataset.markById : {}),
    ...list(dataset?.records).map((record) => record?.markId).filter(Boolean),
    ...list(dataset?.links).map(markIdentifier).filter(Boolean),
  ]);
}

function markEntry(dataset, markId, labels) {
  const mark = object(dataset?.markById?.[markId]) ? dataset.markById[markId] : {};
  const record = list(dataset?.records).find((candidate) => markIdentifier(candidate) === markId);
  const link = list(dataset?.links).find((candidate) => markIdentifier(candidate) === markId);
  const relation = link ? relationFor(dataset, link, mark, labels) : null;
  const label = String(
    mark.label
      ?? record?.semanticLabel
      ?? record?.label
      ?? relation?.label
      ?? markId,
  );
  return {
    target: { kind: "mark", markId },
    label,
    summary: String(mark.summary ?? record?.summary ?? ""),
    values: displayValues(mark.values, MARK_VALUE_KEYS),
    relations: relation ? [relation] : [],
    evidenceCount: evidenceReferences(mark).length,
  };
}

function nodeEntry(dataset, nodeId, labels) {
  const record = list(dataset?.records).find((candidate) => nodeIdentifier(candidate) === nodeId);
  const links = list(dataset?.links).filter((link) => (
    String(link.source ?? "") === nodeId || String(link.target ?? "") === nodeId
  ));
  const marksById = object(dataset?.markById) ? dataset.markById : {};
  const references = unique(links.flatMap((link) => (
    evidenceReferences(marksById[markIdentifier(link)] ?? link)
  )));
  const relations = links.map((link) => (
    relationFor(dataset, link, marksById[markIdentifier(link)] ?? {}, labels)
  ));
  return {
    target: { kind: "node", nodeId },
    label: labels.get(nodeId) ?? nodeId,
    summary: String(record?.summary ?? `${relations.length} connected relationship${relations.length === 1 ? "" : "s"}`),
    values: nodeValues(record),
    relations,
    evidenceCount: references.length,
  };
}

export function inspectionTargetKey(target) {
  if (target?.kind === "mark" && typeof target.markId === "string" && target.markId) {
    return `mark:${target.markId}`;
  }
  if (target?.kind === "node" && typeof target.nodeId === "string" && target.nodeId) {
    return `node:${target.nodeId}`;
  }
  return null;
}

export function buildVisualizationInspectionIndex(dataset, { selectableMarkIds } = {}) {
  const labels = nodeLabels(dataset);
  const markIds = availableMarkIds(dataset, selectableMarkIds);
  const markIdSet = new Set(markIds);
  const linkedNodeIds = new Set(list(dataset?.links)
    .filter((link) => markIdSet.has(markIdentifier(link)))
    .flatMap((link) => [String(link.source ?? ""), String(link.target ?? "")])
    .filter(Boolean));
  const orderedNodes = unique([
    ...list(dataset?.records).map(nodeIdentifier).filter((nodeId) => linkedNodeIds.has(nodeId)),
    ...linkedNodeIds,
  ]);
  const entries = [
    ...markIds.map((markId) => markEntry(dataset, markId, labels)),
    ...orderedNodes.map((nodeId) => nodeEntry(dataset, nodeId, labels)),
  ];
  return { entries };
}

function html(name, className, text) {
  const element = document.createElement(name);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function targetLabel(target) {
  return target.kind === "node" ? "Component" : "Mark";
}

function formattedValue(value) {
  if (typeof value === "string") return value;
  if (value === null) return "None";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

let inspectorCounter = 0;

function wrapVisualizationCanvas(root, classes) {
  if (root.querySelectorAll("[data-visualization-scroll-region]").length > 0) return;
  const children = Array.from(root.children ?? []);
  const svg = children.find((child) => String(child?.tagName ?? "").toLocaleLowerCase() === "svg");
  if (!svg) return;

  const region = html("div", classes.scrollRegion);
  region.setAttribute("data-visualization-scroll-region", "");
  region.setAttribute("role", "region");
  region.setAttribute("tabindex", "0");
  region.setAttribute("aria-label", "Scrollable visualization canvas");
  const hint = html("p", classes.scrollHint, "Swipe horizontally to see the full visualization.");
  hint.setAttribute("data-visualization-scroll-hint", "");
  region.append(hint, svg);
  root.replaceChildren(region, ...children.filter((child) => child !== svg));
}

export function appendVisualizationInspector({
  root,
  dataset,
  index = buildVisualizationInspectionIndex(dataset),
  selectedMarkIds = [],
  selectedNodeId = null,
} = {}) {
  inspectorCounter += 1;
  const classes = VISUALIZATION_INSPECTOR_CLASSES;
  wrapVisualizationCanvas(root, classes);
  const byKey = new Map(index.entries.map((entry) => [inspectionTargetKey(entry.target), entry]));
  const keys = [...byKey.keys()];
  const headingId = `visualization-inspector-heading-${inspectorCounter}`;
  const ledger = html("section", classes.root);
  ledger.setAttribute("data-visualization-inspector", "");
  ledger.setAttribute("aria-labelledby", headingId);
  ledger.setAttribute("aria-live", "off");

  const header = html("header", classes.header);
  const heading = html("h2", classes.heading, "Context ledger");
  heading.id = headingId;
  heading.setAttribute("id", headingId);
  const position = html("span", classes.position);
  position.setAttribute("data-inspector-field", "position");
  const navigation = html("nav", classes.navigation);
  navigation.setAttribute("aria-label", "Browse visualization targets");
  const previous = html("button", classes.previous, "Previous");
  previous.type = "button";
  previous.setAttribute("data-inspector-action", "previous");
  const next = html("button", classes.next, "Next");
  next.type = "button";
  next.setAttribute("data-inspector-action", "next");
  const close = html("button", classes.close, "Close");
  close.type = "button";
  close.setAttribute("data-inspector-action", "close");
  close.setAttribute("aria-label", "Close context pin");
  navigation.append(previous, next, close);
  header.append(heading, position, navigation);
  const body = html("div", classes.body);
  ledger.append(header, body);

  const selectedNodeKey = selectedNodeId === null
    ? null
    : inspectionTargetKey({ kind: "node", nodeId: String(selectedNodeId) });
  const selectedMarkKey = list(selectedMarkIds)
    .map((markId) => inspectionTargetKey({ kind: "mark", markId: String(markId) }))
    .find((key) => byKey.has(key)) ?? null;
  let pinnedKey = byKey.has(selectedNodeKey) ? selectedNodeKey : selectedMarkKey;
  let pointerKey = null;
  let focusKey = null;

  function setControlState(state) {
    const traversable = keys.length > 1;
    previous.disabled = !traversable;
    next.disabled = !traversable;
    previous.setAttribute("aria-disabled", String(!traversable));
    next.setAttribute("aria-disabled", String(!traversable));
    close.disabled = state === "rest";
    close.setAttribute("aria-disabled", String(state === "rest"));
  }

  function renderRest() {
    ledger.setAttribute("data-inspector-state", "rest");
    position.textContent = `${keys.length} target${keys.length === 1 ? "" : "s"}`;
    const message = html(
      "p",
      classes.rest,
      "Hover or focus a target to preview its context. Tap or click to pin it here.",
    );
    message.setAttribute("data-inspector-field", "rest");
    body.replaceChildren(message);
    setControlState("rest");
  }

  function renderEntry(key, state) {
    const entry = byKey.get(key);
    if (!entry) {
      renderRest();
      return;
    }
    ledger.setAttribute("data-inspector-state", state);
    const entryIndex = keys.indexOf(key);
    position.textContent = `${entryIndex + 1} of ${keys.length}`;
    const kind = html("p", classes.kind, targetLabel(entry.target));
    kind.setAttribute("data-inspector-field", "kind");
    const label = html("h3", classes.label, entry.label);
    label.setAttribute("data-inspector-field", "label");
    const content = [kind, label];
    if (entry.summary) {
      const summary = html("p", classes.summary, entry.summary);
      summary.setAttribute("data-inspector-field", "summary");
      content.push(summary);
    }
    const valueEntries = Object.entries(entry.values);
    if (valueEntries.length) {
      const values = html("dl", classes.values);
      valueEntries.forEach(([name, value]) => {
        const row = html("div", classes.value);
        row.append(html("dt", undefined, name), html("dd", undefined, formattedValue(value)));
        values.append(row);
      });
      content.push(values);
    }
    const evidence = html(
      "p",
      classes.evidence,
      `${entry.evidenceCount} evidence reference${entry.evidenceCount === 1 ? "" : "s"}`,
    );
    evidence.setAttribute("data-inspector-field", "evidence");
    content.push(evidence);
    if (entry.relations.length) {
      const relations = html("section", classes.relations);
      const relationsHeading = html("h4", classes.relationsHeading, "Relationships");
      const relationsList = html("ol", classes.relationsList);
      entry.relations.forEach((relation) => {
        relationsList.append(html(
          "li",
          classes.relation,
          `${relation.label} · ${relation.evidenceCount} evidence reference${relation.evidenceCount === 1 ? "" : "s"}`,
        ));
      });
      relations.append(relationsHeading, relationsList);
      content.push(relations);
    }
    body.replaceChildren(...content);
    setControlState(state);
  }

  function refresh() {
    const previewKey = focusKey ?? pointerKey;
    if (previewKey) renderEntry(previewKey, "preview");
    else if (pinnedKey) renderEntry(pinnedKey, "pinned");
    else renderRest();
  }

  function pin(key) {
    if (!byKey.has(key)) return;
    pinnedKey = key;
    pointerKey = null;
    focusKey = null;
    refresh();
  }

  function bind(element, key) {
    if (!byKey.has(key)) return;
    element.addEventListener("pointerenter", () => {
      pointerKey = key;
      refresh();
    });
    element.addEventListener("pointerleave", () => {
      if (pointerKey === key) pointerKey = null;
      refresh();
    });
    element.addEventListener("focus", () => {
      focusKey = key;
      refresh();
    });
    element.addEventListener("blur", () => {
      if (focusKey === key) focusKey = null;
      refresh();
    });
    element.addEventListener("click", () => pin(key));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") pin(key);
    });
  }

  for (const mark of root.querySelectorAll("[data-mark-id]")) {
    bind(mark, inspectionTargetKey({ kind: "mark", markId: String(mark.getAttribute("data-mark-id") ?? "") }));
  }
  for (const node of root.querySelectorAll("[data-node-id]")) {
    bind(node, inspectionTargetKey({ kind: "node", nodeId: String(node.getAttribute("data-node-id") ?? "") }));
  }
  for (const node of root.querySelectorAll("[data-inspection-node-id]")) {
    bind(node, inspectionTargetKey({
      kind: "node",
      nodeId: String(node.getAttribute("data-inspection-node-id") ?? ""),
    }));
  }

  function traverse(offset) {
    if (!keys.length) return;
    const currentKey = focusKey ?? pointerKey ?? pinnedKey;
    const currentIndex = keys.indexOf(currentKey);
    const nextIndex = currentIndex === -1
      ? offset > 0 ? 0 : keys.length - 1
      : (currentIndex + offset + keys.length) % keys.length;
    pin(keys[nextIndex]);
  }

  previous.addEventListener("click", () => traverse(-1));
  next.addEventListener("click", () => traverse(1));
  close.addEventListener("click", () => {
    pinnedKey = null;
    pointerKey = null;
    focusKey = null;
    refresh();
  });

  refresh();
  root.append(ledger);
  return { element: ledger, index };
}
