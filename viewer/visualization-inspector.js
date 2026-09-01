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

// The panel below a visualization is the underlying data itself: every
// clickable element filters this list down to the rows it stands for.
export const VISUALIZATION_DATA_LIST_CLASSES = Object.freeze({
  root: "visualization-data-list",
  header: "visualization-data-list-header",
  heading: "visualization-data-list-heading",
  status: "visualization-data-list-status",
  clear: "visualization-data-list-clear",
  rows: "visualization-data-list-rows",
  row: "visualization-data-list-row",
  rowButton: "visualization-data-list-row-button",
  rowLabel: "visualization-data-list-row-label",
  rowValues: "visualization-data-list-row-values",
  rowEvidence: "visualization-data-list-row-evidence",
  detail: "visualization-data-list-detail",
  detailValues: "visualization-data-list-detail-values",
  detailValue: "visualization-data-list-detail-value",
  relations: "visualization-data-list-relations",
  note: "visualization-data-list-note",
  navigation: "visualization-data-list-navigation",
  scrollRegion: "visualization-scroll-region",
  scrollHint: "visualization-scroll-hint",
});

const ALL_ROWS_LIMIT = 100;

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

function markEntry(dataset, markId, labels, { recordByMarkId, linkByMarkId }) {
  const mark = object(dataset?.markById?.[markId]) ? dataset.markById[markId] : {};
  const record = recordByMarkId.get(markId);
  const link = linkByMarkId.get(markId);
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
  const records = list(dataset?.records);
  const links = list(dataset?.links);
  const recordByMarkId = new Map(records.map((record) => [markIdentifier(record), record]));
  const linkByMarkId = new Map(links.map((link) => [markIdentifier(link), link]));
  const linkedNodeIds = new Set(links
    .filter((link) => markIdSet.has(markIdentifier(link)))
    .flatMap((link) => [String(link.source ?? ""), String(link.target ?? "")])
    .filter(Boolean));
  const orderedNodes = unique([
    ...records.map(nodeIdentifier).filter((nodeId) => linkedNodeIds.has(nodeId)),
    ...linkedNodeIds,
  ]);
  const entries = [
    ...markIds.map((markId) => markEntry(dataset, markId, labels, { recordByMarkId, linkByMarkId })),
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

function formattedValue(value) {
  if (typeof value === "string") return value;
  if (value === null) return "None";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

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

function inlineValues(values) {
  return Object.entries(values)
    .map(([name, value]) => `${name} ${formattedValue(value)}`)
    .join(" · ");
}

let dataListCounter = 0;

export function appendVisualizationDataList({
  root,
  dataset,
  index = buildVisualizationInspectionIndex(dataset),
  selectedMarkIds = [],
  selectedNodeId = null,
  selectedTargetId = null,
  onSelect,
  onClear,
  loadTargetMembers,
} = {}) {
  dataListCounter += 1;
  const classes = VISUALIZATION_DATA_LIST_CLASSES;
  wrapVisualizationCanvas(root, classes);

  const markEntries = index.entries.filter((entry) => entry.target.kind === "mark");
  const entryByMarkId = new Map(markEntries.map((entry) => [entry.target.markId, entry]));
  const totalCount = markEntries.length;
  const selectedIds = unique(selectedMarkIds).filter((markId) => entryByMarkId.has(markId));
  const nodeKey = selectedNodeId === null ? null : String(selectedNodeId);
  const target = selectedTargetId === null
    ? null
    : (object(dataset?.targetById?.[String(selectedTargetId)]) ? dataset.targetById[String(selectedTargetId)] : null);

  const headingId = `visualization-data-list-heading-${dataListCounter}`;
  const panel = html("section", classes.root);
  panel.setAttribute("data-visualization-data-list", "");
  panel.setAttribute("aria-labelledby", headingId);
  panel.setAttribute("aria-live", "off");

  const header = html("header", classes.header);
  const heading = html("h2", classes.heading, "Data");
  heading.id = headingId;
  const status = html("p", classes.status);
  status.setAttribute("data-list-field", "status");
  header.append(heading, status);
  const filtered = Boolean(selectedIds.length || nodeKey || target);
  if (filtered) {
    const clear = html("button", classes.clear, "Show all");
    clear.type = "button";
    clear.setAttribute("data-list-action", "clear");
    clear.addEventListener("click", () => onClear?.());
    header.append(clear);
  }
  const rows = html("ol", classes.rows);
  rows.setAttribute("data-list-field", "rows");
  panel.append(header, rows);

  function rowFor(entry, { expanded = false } = {}) {
    const item = html("li", classes.row);
    const markId = entry.target.markId;
    item.setAttribute("data-list-mark-id", markId);
    const button = html("button", classes.rowButton);
    button.type = "button";
    const selected = selectedIds.includes(markId);
    button.setAttribute("aria-pressed", String(selected));
    const line = html("span", classes.rowLabel, entry.label);
    button.append(line);
    // The expanded detail grid already lists every value.
    const values = expanded ? "" : inlineValues(entry.values);
    if (values) button.append(html("span", classes.rowValues, values));
    button.append(html(
      "span",
      classes.rowEvidence,
      `${entry.evidenceCount} evidence reference${entry.evidenceCount === 1 ? "" : "s"}`,
    ));
    // Clicking the selected row again widens back out; anything else narrows.
    button.addEventListener("click", () => {
      if (selected && selectedIds.length === 1 && !nodeKey && !target) onClear?.();
      else onSelect?.({ kind: "mark", markId });
    });
    item.append(button);
    if (expanded) {
      const detail = html("div", classes.detail);
      detail.setAttribute("data-list-field", "detail");
      if (entry.summary) detail.append(html("p", undefined, entry.summary));
      const valueEntries = Object.entries(entry.values);
      if (valueEntries.length) {
        const definitions = html("dl", classes.detailValues);
        valueEntries.forEach(([name, value]) => {
          const pair = html("div", classes.detailValue);
          pair.append(html("dt", undefined, name), html("dd", undefined, formattedValue(value)));
          definitions.append(pair);
        });
        detail.append(definitions);
      }
      if (entry.relations.length) {
        const relations = html("ul", classes.relations);
        entry.relations.forEach((relation) => {
          relations.append(html(
            "li",
            undefined,
            `${relation.label} · ${relation.evidenceCount} evidence reference${relation.evidenceCount === 1 ? "" : "s"}`,
          ));
        });
        detail.append(relations);
      }
      item.append(detail);
    }
    return item;
  }

  function renderEntries(entries, { expanded = false, note = null } = {}) {
    rows.replaceChildren(...entries.map((entry) => rowFor(entry, { expanded })));
    if (note) {
      const notice = html("p", classes.note, note);
      notice.setAttribute("data-list-field", "note");
      rows.after(notice);
    }
  }

  if (target) {
    const targetLabel = String(target.label ?? target.id);
    const memberCount = Number.isInteger(target.count) ? target.count : 0;
    panel.setAttribute("data-list-state", "target");
    status.textContent = `${targetLabel} · ${memberCount} member${memberCount === 1 ? "" : "s"} of ${totalCount}`;
    if (typeof loadTargetMembers === "function") {
      let revision = 0;
      const renderMemberPage = async (offset) => {
        const requested = ++revision;
        rows.replaceChildren(html("li", classes.note, "Resolving members…"));
        try {
          const page = await loadTargetMembers({ targetId: String(target.id), offset });
          if (requested !== revision || !panel.isConnected) return;
          const entries = list(page?.markIds)
            .map((markId) => entryByMarkId.get(String(markId)))
            .filter(Boolean);
          rows.replaceChildren(...entries.map((entry) => rowFor(entry)));
          const navigation = panel.querySelector(`.${classes.navigation}`);
          navigation?.remove();
          const shownFrom = entries.length ? offset + 1 : 0;
          const shownTo = offset + entries.length;
          const nav = html("nav", classes.navigation);
          nav.setAttribute("aria-label", "Aggregate member pages");
          nav.append(html("span", classes.note, `Showing ${shownFrom}–${shownTo} of ${memberCount}`));
          const pageSize = Number.isSafeInteger(page?.limit) && page.limit > 0
            ? page.limit
            : Math.max(entries.length, 1);
          const previous = html("button", undefined, "Previous");
          previous.type = "button";
          previous.disabled = offset === 0;
          previous.addEventListener("click", () => renderMemberPage(Math.max(0, offset - pageSize)));
          const nextOffset = Number.isSafeInteger(page?.nextOffset) ? page.nextOffset : null;
          const next = html("button", undefined, "Next");
          next.type = "button";
          next.disabled = nextOffset === null;
          next.addEventListener("click", () => {
            if (nextOffset !== null) renderMemberPage(nextOffset);
          });
          nav.append(previous, next);
          panel.append(nav);
        } catch {
          if (requested !== revision || !panel.isConnected) return;
          rows.replaceChildren(html("li", classes.note, "The member list could not be loaded."));
        }
      };
      renderMemberPage(0);
    } else {
      renderEntries([], { note: "Members resolve in the session viewer." });
    }
  } else if (nodeKey) {
    const links = list(dataset?.links).filter((link) => (
      String(link.source ?? "") === nodeKey || String(link.target ?? "") === nodeKey
    ));
    const connectedIds = unique(links.map(markIdentifier)).filter((markId) => entryByMarkId.has(markId));
    const entries = connectedIds.map((markId) => entryByMarkId.get(markId));
    const labels = nodeLabels(dataset);
    panel.setAttribute("data-list-state", "node");
    status.textContent = `${labels.get(nodeKey) ?? nodeKey} · ${entries.length} of ${totalCount}`;
    renderEntries(entries);
  } else if (selectedIds.length) {
    const entries = selectedIds.map((markId) => entryByMarkId.get(markId));
    panel.setAttribute("data-list-state", "filtered");
    status.textContent = selectedIds.length === 1
      ? `1 of ${totalCount}`
      : `${selectedIds.length} of ${totalCount}`;
    renderEntries(entries, { expanded: true });
  } else {
    const entries = markEntries.slice(0, ALL_ROWS_LIMIT);
    panel.setAttribute("data-list-state", "all");
    status.textContent = `${totalCount} item${totalCount === 1 ? "" : "s"} · click a point or a row to filter`;
    renderEntries(entries, {
      note: totalCount > ALL_ROWS_LIMIT
        ? `Showing the first ${ALL_ROWS_LIMIT} of ${totalCount}. Click any element in the visualization to filter.`
        : null,
    });
  }

  root.append(panel);
  return { element: panel, index };
}
