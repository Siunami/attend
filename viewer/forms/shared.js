const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 960;
let chartCounter = 0;

export function svgElement(name, attributes = {}, content) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  if (content !== undefined) node.textContent = String(content);
  return node;
}

export function htmlElement(name, className, content) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

export function canvas(root, dataset, description, height = 450) {
  root.replaceChildren();
  chartCounter += 1;
  const titleId = `form-chart-title-${chartCounter}`;
  const descriptionId = `form-chart-description-${chartCounter}`;
  const svg = svgElement("svg", {
    viewBox: `0 0 ${WIDTH} ${height}`,
    role: "group",
    "aria-roledescription": "visualization",
    "aria-labelledby": `${titleId} ${descriptionId}`,
    "data-form-id": `${dataset.familyId}/${dataset.memberId}`,
  });
  svg.append(
    svgElement("title", { id: titleId }, dataset.title),
    svgElement("desc", { id: descriptionId }, description),
  );
  root.append(svg);
  return svg;
}

export function array(value) {
  return Array.isArray(value) ? value : [];
}

export function objects(value) {
  return array(value).filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

export function records(dataset, key, fallbacks = []) {
  for (const candidate of [key, ...fallbacks]) {
    const values = objects(dataset.payload?.[candidate]);
    if (values.length) return values;
  }
  return objects(dataset.records);
}

export function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

export function finite(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function text(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

export function format(value) {
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(number(value));
}

export function extent(values, fallback = [0, 1]) {
  const valid = values.map(finite).filter((value) => value !== null);
  if (!valid.length) return fallback;
  return [Math.min(...valid), Math.max(...valid)];
}

export function scale([domainStart, domainEnd], [rangeStart, rangeEnd]) {
  const span = domainEnd - domainStart;
  if (!span) return () => (rangeStart + rangeEnd) / 2;
  return (value) => rangeStart + ((value - domainStart) / span) * (rangeEnd - rangeStart);
}

export function formLabel(item) {
  return text(item.label ?? item.item ?? item.entity ?? item.part ?? item.state ?? item.period ?? item.time ?? item.region ?? item.id ?? item.markId, "Untitled");
}

export function markId(item) {
  const value = item.markId ?? item.id;
  return value === undefined || value === null ? null : String(value);
}

export function targetId(item) {
  const value = item.targetId ?? item.visualTargetId;
  return value === undefined || value === null ? null : String(value);
}

export function selectable(item) {
  const target = targetId(item);
  if (target) return { "data-target-id": target };
  const mark = markId(item);
  return mark ? { "data-mark-id": mark } : {};
}

export function selectedClass(item, selection, base = "mark-primary") {
  const target = targetId(item);
  const mark = markId(item);
  const chosen = target
    ? target === selection.selectedTargetId
    : mark && selection.selectedMarkIds.has(mark);
  return `${base}${chosen ? " is-selected" : ""}`;
}

// Glyph advances as a fraction of the font size, calibrated against Helvetica /
// Arial metrics, which the viewer's sans-serif stack resolves to. Every renderer
// also runs headless under node:test, where no layout engine can measure text.
const NARROW_GLYPHS = new Set([..." .,:;'`!|()[]{}/\\-·ijlftIr"]);
const WIDE_GLYPHS = new Set([..."mwMW%@"]);
const ELLIPSIS = "…";

function glyphAdvance(character) {
  if (character === ELLIPSIS) return 1;
  if (character.codePointAt(0) > 0x2e7f) return 1;
  if (NARROW_GLYPHS.has(character)) return 0.28;
  if (WIDE_GLYPHS.has(character)) return 0.86;
  if (character >= "A" && character <= "Z") return 0.69;
  if (character >= "0" && character <= "9") return 0.56;
  if (character >= "a" && character <= "z") return 0.53;
  return 0.6;
}

export function estimateTextWidth(value, fontSize = 12) {
  let advance = 0;
  for (const character of String(value ?? "")) advance += glyphAdvance(character);
  return advance * fontSize;
}

export function labelInterval(position, value, { anchor = "middle", fontSize = 12 } = {}) {
  const width = estimateTextWidth(value, fontSize);
  if (anchor === "end") return [position - width, position];
  if (anchor === "start") return [position, position + width];
  return [position - width / 2, position + width / 2];
}

export function truncateToWidth(value, maxUnits, fontSize = 12) {
  const source = String(value ?? "");
  if (!source) return "";
  if (estimateTextWidth(source, fontSize) <= maxUnits) return source;
  const ellipsisWidth = glyphAdvance(ELLIPSIS) * fontSize;
  if (maxUnits < ellipsisWidth) return "";
  let width = 0;
  let kept = "";
  for (const character of source) {
    const next = width + glyphAdvance(character) * fontSize;
    if (next + ellipsisWidth > maxUnits) break;
    width = next;
    kept += character;
  }
  return `${kept.trimEnd()}${ELLIPSIS}`;
}

export function thinLabels(entries, { minGap = 8 } = {}) {
  const measured = entries.map((entry, index) => {
    const fontSize = number(entry.fontSize, 12);
    const size = Number.isFinite(Number(entry.size)) ? Number(entry.size) : estimateTextWidth(entry.text, fontSize);
    const anchor = entry.anchor ?? "middle";
    const start = anchor === "end" ? entry.position - size : anchor === "start" ? entry.position : entry.position - size / 2;
    return { index, start, end: start + size, keep: Boolean(entry.keep) };
  });
  const byPosition = [...measured].sort((left, right) => left.start - right.start || left.index - right.index);
  const required = (candidate) => candidate.keep || candidate.index === 0 || candidate.index === measured.length - 1;
  const kept = byPosition.filter(required);
  const fits = (candidate) => kept.every((chosen) => (
    candidate.end + minGap <= chosen.start || chosen.end + minGap <= candidate.start
  ));
  for (const candidate of byPosition) {
    if (!required(candidate) && fits(candidate)) kept.push(candidate);
  }
  return new Set(kept.map((candidate) => candidate.index));
}

function niceStep(rawStep) {
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

export function niceTicks(domain, { maxTicks = 5, pixels, fontSize = 12, format: formatTick = format } = {}) {
  const [start, end] = domain;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  if (start === end) return [start];
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  let limit = Math.max(2, Math.floor(maxTicks));
  if (Number.isFinite(pixels) && pixels > 0) {
    const widest = Math.max(
      estimateTextWidth(formatTick(low), fontSize),
      estimateTextWidth(formatTick(high), fontSize),
    );
    limit = Math.min(limit, Math.max(2, Math.floor(pixels / (widest + 16))));
  }
  const step = niceStep((high - low) / limit);
  const ticks = [];
  // A nice step always lands on zero, so a straddling domain gets its zero tick
  // without the near-coincident duplicate an appended zero would produce.
  for (let index = Math.ceil(low / step - 1e-9); index * step <= high + step * 1e-9; index += 1) {
    ticks.push(Number((index * step).toPrecision(12)));
  }
  return ticks.length ? ticks : [low, high];
}

export function horizontalAxis(svg, domain, x, y, { label, fontSize = 12 } = {}) {
  svg.append(svgElement("line", { x1: x(domain[0]), x2: x(domain[1]), y1: y, y2: y, class: "axis-line" }));
  const span = Math.abs(x(domain[1]) - x(domain[0]));
  const ticks = niceTicks(domain, { maxTicks: 8, pixels: span, fontSize })
    .map((tick) => ({ tick, position: x(tick), text: format(tick), fontSize }));
  const kept = thinLabels(ticks, { minGap: 6 });
  ticks.forEach(({ position, text }, index) => {
    svg.append(svgElement("line", { x1: position, x2: position, y1: y, y2: y + 6, class: "axis-line" }));
    if (!kept.has(index)) return;
    const [left, right] = labelInterval(position, text, { fontSize });
    const shift = left < 4 ? 4 - left : right > WIDTH - 4 ? WIDTH - 4 - right : 0;
    svg.append(svgElement("text", { x: position + shift, y: y + 22, class: "axis-label", "text-anchor": "middle" }, text));
  });
  if (label) svg.append(svgElement("text", { x: (x(domain[0]) + x(domain[1])) / 2, y: y + 43, class: "axis-label", "text-anchor": "middle" }, label));
}

export function binBounds(bin, index) {
  return {
    lower: number(bin.lower ?? bin.x0 ?? bin.min ?? index),
    upper: number(bin.upper ?? bin.x1 ?? bin.max ?? index + 1),
    count: number(bin.count ?? bin.frequency ?? bin.value),
  };
}

export function hierarchyDepthById(nodes) {
  const byId = new Map(nodes.map((node) => [text(node.nodeId ?? node.id), node]));
  const parentById = new Map(nodes.map((node) => [
    text(node.nodeId ?? node.id),
    node.parentId ?? node.parent,
  ]));
  const depths = new Map();
  for (const nodeId of byId.keys()) {
    if (depths.has(nodeId)) continue;
    const trail = [];
    const visited = new Set();
    let cursor = nodeId;
    let anchorDepth = -1;
    while (byId.has(cursor) && !depths.has(cursor) && !visited.has(cursor)) {
      visited.add(cursor);
      trail.push(cursor);
      const parent = parentById.get(cursor);
      if (parent === undefined || parent === null || parent === "" || !byId.has(text(parent))) break;
      cursor = text(parent);
    }
    if (depths.has(cursor)) anchorDepth = depths.get(cursor);
    for (let index = trail.length - 1; index >= 0; index -= 1) {
      anchorDepth += 1;
      depths.set(trail[index], anchorDepth);
    }
  }
  return depths;
}
