const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 960;
const HEIGHT = 450;
let chartCounter = 0;

function element(name, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function htmlElement(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function canvas(root, title, description, height = HEIGHT) {
  root.replaceChildren();
  chartCounter += 1;
  const titleId = `family-chart-title-${chartCounter}`;
  const descriptionId = `family-chart-description-${chartCounter}`;
  const svg = element("svg", {
    viewBox: `0 0 ${WIDTH} ${height}`,
    role: "img",
    "aria-labelledby": `${titleId} ${descriptionId}`,
  });
  svg.append(
    element("title", { id: titleId }, title),
    element("desc", { id: descriptionId }, description),
  );
  root.append(svg);
  return svg;
}

function role(dataset, name, fallback) {
  return dataset.roles?.[name] ?? fallback;
}

function value(record, field, fallback = 0) {
  const result = Number(record?.[field]);
  return Number.isFinite(result) ? result : fallback;
}

function label(record, dataset) {
  const field = role(dataset, "label", "label");
  return String(record?.[field] ?? record?.label ?? record?.id ?? "Untitled");
}

function id(record, dataset) {
  return String(record?.[role(dataset, "id", "id")] ?? record?.id ?? "");
}

function linkedLabel(dataset, identifier) {
  const record = dataset.records.find((candidate) => id(candidate, dataset) === String(identifier));
  return record ? label(record, dataset) : String(identifier);
}

function formatNumber(number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(number);
}

function markClass(markId, selectedId, base = "mark-primary") {
  return `${base}${markId === selectedId ? " is-selected" : ""}`;
}

function appendText(parent, x, y, text, className, anchor) {
  const node = element("text", {
    x,
    y,
    ...(className ? { class: className } : {}),
    ...(anchor ? { "text-anchor": anchor } : {}),
  }, text);
  parent.append(node);
  return node;
}

function extent(values, fallback = [0, 1]) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return fallback;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return min === max ? [Math.min(0, min), max || 1] : [min, max];
}

function linear(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (input) => r0 + ((input - d0) / span) * (r1 - r0);
}

function seriesClass(index) {
  return ["mark-primary", "mark-secondary", "mark-tertiary", "mark-quaternary"][index % 4];
}

function evidenceCount(dataset) {
  return Array.isArray(dataset.evidence) ? dataset.evidence.length : 0;
}

function renderRank(root, dataset, selectedId) {
  const records = [...dataset.records];
  const valueField = role(dataset, "value", "value");
  const values = records.map((record) => value(record, valueField));
  const max = Math.max(...values, 1);
  const svg = canvas(root, dataset.title, `${records.length} ranked items. The longest bar has value ${max}.`);
  const left = 220;
  const top = 26;
  const rowHeight = Math.min(58, 360 / Math.max(records.length, 1));
  const x = linear([0, max], [left, 875]);

  [0, 0.25, 0.5, 0.75, 1].forEach((fraction) => {
    const px = left + (875 - left) * fraction;
    svg.append(element("line", { x1: px, x2: px, y1: top, y2: top + rowHeight * records.length, class: "grid-line" }));
    appendText(svg, px, top + rowHeight * records.length + 25, formatNumber(max * fraction), "axis-label", "middle");
  });

  records.forEach((record, index) => {
    const markId = id(record, dataset);
    const y = top + index * rowHeight + rowHeight * 0.23;
    appendText(svg, left - 14, y + rowHeight * 0.29, label(record, dataset), undefined, "end");
    const bar = element("rect", {
      x: left,
      y,
      width: Math.max(2, x(value(record, valueField)) - left),
      height: rowHeight * 0.46,
      rx: 2,
      class: markClass(markId, selectedId, index === 0 ? "mark-secondary" : "mark-primary"),
      "data-mark-id": markId,
      "aria-label": `${label(record, dataset)}: ${value(record, valueField)}`,
    });
    svg.append(bar);
    appendText(svg, x(value(record, valueField)) + 9, y + rowHeight * 0.31, formatNumber(value(record, valueField)), undefined);
  });
}

function renderDistribution(root, dataset, selectedId) {
  const records = dataset.records;
  const valueField = role(dataset, "value", "value");
  const groupField = role(dataset, "group", "group");
  const groups = [...new Set(records.map((record) => String(record[groupField])))];
  const values = records.map((record) => value(record, valueField));
  const domain = [0, Math.ceil(Math.max(...values, 1) / 20) * 20];
  const x = linear(domain, [165, 900]);
  const svg = canvas(root, dataset.title, `A grouped strip plot of ${records.length} observations across ${groups.length} work types.`);
  const rowHeight = 100;

  for (let tick = 0; tick <= domain[1]; tick += 20) {
    const px = x(tick);
    svg.append(element("line", { x1: px, x2: px, y1: 28, y2: 352, class: "grid-line" }));
    appendText(svg, px, 378, tick, "axis-label", "middle");
  }
  appendText(svg, 900, 408, "minutes", "axis-label", "end");

  groups.forEach((group, groupIndex) => {
    const cy = 75 + groupIndex * rowHeight;
    const groupRecords = records.filter((record) => record[groupField] === group);
    appendText(svg, 142, cy + 4, group, undefined, "end");
    svg.append(element("line", { x1: 165, x2: 900, y1: cy, y2: cy, class: "baseline" }));
    const sorted = groupRecords.map((record) => value(record, valueField)).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    svg.append(element("line", { x1: x(median), x2: x(median), y1: cy - 23, y2: cy + 23, class: "median-line" }));
    groupRecords.forEach((record, recordIndex) => {
      const markId = id(record, dataset);
      const jitter = ((recordIndex % 3) - 1) * 13;
      svg.append(element("circle", {
        cx: x(value(record, valueField)),
        cy: cy + jitter,
        r: 7,
        class: markClass(markId, selectedId, seriesClass(groupIndex)),
        "data-mark-id": markId,
        "aria-label": `${group}: ${value(record, valueField)} minutes`,
      }));
    });
  });
}

function renderComposition(root, dataset, selectedId) {
  const records = dataset.records;
  const seriesField = role(dataset, "series", "series");
  const partField = role(dataset, "part", "part");
  const valueField = role(dataset, "value", "value");
  const series = [...new Set(records.map((record) => String(record[seriesField])))];
  const parts = [...new Set(records.map((record) => String(record[partField])))];
  const svg = canvas(root, dataset.title, `Two 100 percent bars compare ${parts.length} activity categories.`);
  const left = 150;
  const right = 900;
  const width = right - left;

  parts.forEach((part, index) => {
    const x = left + index * (width / parts.length);
    svg.append(element("rect", { x, y: 394, width: 12, height: 12, class: seriesClass(index) }));
    appendText(svg, x + 18, 405, part, "axis-label");
  });

  series.forEach((seriesName, seriesIndex) => {
    const y = 92 + seriesIndex * 150;
    const selected = records.filter((record) => String(record[seriesField]) === seriesName);
    const total = selected.reduce((sum, record) => sum + value(record, valueField), 0) || 1;
    appendText(svg, left - 18, y + 34, seriesName, undefined, "end");
    let cursor = left;
    selected.forEach((record, partIndex) => {
      const amount = value(record, valueField);
      const segmentWidth = width * (amount / total);
      const markId = id(record, dataset);
      svg.append(element("rect", {
        x: cursor,
        y,
        width: segmentWidth,
        height: 56,
        class: markClass(markId, selectedId, seriesClass(partIndex)),
        "data-mark-id": markId,
        "aria-label": `${record[partField]}: ${amount} of ${total}`,
      }));
      if (segmentWidth > 62) appendText(svg, cursor + segmentWidth / 2, y + 34, amount, "inside-label", "middle");
      cursor += segmentWidth;
    });
    appendText(svg, right, y + 82, `${total} hours`, "axis-label", "end");
  });
}

function renderProfile(root, dataset, selectedId) {
  const records = dataset.records;
  const measures = role(dataset, "measures", []);
  const svg = canvas(root, dataset.title, `${records.length} profiles compared on ${measures.length} shared measures.`);
  const left = 180;
  const right = 900;
  const xFor = (index) => left + index * ((right - left) / Math.max(1, measures.length - 1));
  const y = linear([0, 10], [370, 50]);

  measures.forEach((measure, index) => {
    const x = xFor(index);
    svg.append(element("line", { x1: x, x2: x, y1: 50, y2: 370, class: "grid-line" }));
    appendText(svg, x, 400, measure, "axis-label", "middle");
  });

  records.forEach((record, recordIndex) => {
    const markId = id(record, dataset);
    const points = measures.map((measure, index) => `${xFor(index)},${y(value(record, measure))}`).join(" ");
    svg.append(element("polyline", {
      points,
      fill: "none",
      class: markClass(markId, selectedId, `${seriesClass(recordIndex)} profile-line`),
      "data-mark-id": markId,
      "aria-label": `${label(record, dataset)} profile`,
    }));
    measures.forEach((measure, index) => {
      svg.append(element("circle", {
        cx: xFor(index),
        cy: y(value(record, measure)),
        r: 4,
        class: markClass(markId, selectedId, seriesClass(recordIndex)),
        "data-mark-id": markId,
      }));
    });
    appendText(svg, 166, y(value(record, measures[0])) + 4, label(record, dataset), recordIndex > 3 ? "muted-label" : undefined, "end");
  });
}

function renderPassageComparison(root, dataset, selectedId) {
  root.replaceChildren();
  const list = htmlElement("ol", "passage-columns");
  const textField = role(dataset, "text", "text");
  const sourceField = role(dataset, "source", "source");
  const versionField = role(dataset, "version", "version");
  dataset.records.forEach((record) => {
    const item = htmlElement("li", id(record, dataset) === selectedId ? "passage-row is-selected" : "passage-row");
    item.dataset.markId = id(record, dataset);
    const metadata = htmlElement("div", "passage-meta");
    const time = htmlElement("time", undefined, record.date);
    time.setAttribute("datetime", String(record.date));
    metadata.append(
      htmlElement("strong", undefined, record[versionField]),
      htmlElement("span", undefined, record[sourceField]),
      time,
    );
    const quote = document.createElement("blockquote");
    quote.textContent = record[textField];
    item.append(metadata, quote);
    list.append(item);
  });
  root.append(list);
}

function renderTrend(root, dataset, selectedId) {
  const records = dataset.records;
  const xField = role(dataset, "x", "x");
  const yField = role(dataset, "y", "y");
  const seriesField = role(dataset, "series", "series");
  const dates = [...new Set(records.map((record) => String(record[xField])))].sort();
  const series = [...new Set(records.map((record) => String(record[seriesField])))];
  const max = Math.ceil(Math.max(...records.map((record) => value(record, yField)), 1) / 5) * 5;
  const x = linear([0, Math.max(dates.length - 1, 1)], [90, 890]);
  const y = linear([0, max], [370, 40]);
  const svg = canvas(root, dataset.title, `${series.length} weekly series shown on one shared time scale.`);

  for (let tick = 0; tick <= max; tick += 5) {
    svg.append(element("line", { x1: 90, x2: 890, y1: y(tick), y2: y(tick), class: "grid-line" }));
    appendText(svg, 75, y(tick) + 4, tick, "axis-label", "end");
  }
  dates.forEach((date, index) => {
    if (index % 2 === 0 || dates.length < 7) appendText(svg, x(index), 405, date.slice(5), "axis-label", "middle");
  });

  series.forEach((seriesName, seriesIndex) => {
    const lineRecords = records.filter((record) => record[seriesField] === seriesName).sort((a, b) => String(a[xField]).localeCompare(String(b[xField])));
    const points = lineRecords.map((record) => `${x(dates.indexOf(String(record[xField])))},${y(value(record, yField))}`).join(" ");
    svg.append(element("polyline", { points, fill: "none", class: `${seriesClass(seriesIndex)} trend-line` }));
    lineRecords.forEach((record) => {
      const markId = id(record, dataset);
      svg.append(element("circle", {
        cx: x(dates.indexOf(String(record[xField]))),
        cy: y(value(record, yField)),
        r: 5,
        class: markClass(markId, selectedId, seriesClass(seriesIndex)),
        "data-mark-id": markId,
      }));
    });
    const last = lineRecords.at(-1);
    appendText(svg, 901, y(value(last, yField)) + 4, seriesName, undefined);
  });
}

function renderTimeline(root, dataset, selectedId) {
  const records = dataset.records;
  const startField = role(dataset, "start", "start");
  const endField = role(dataset, "end", "end");
  const groupField = role(dataset, "group", "group");
  const starts = records.map((record) => new Date(record[startField]).valueOf());
  const ends = records.map((record) => new Date(record[endField] ?? record[startField]).valueOf());
  const x = linear([Math.min(...starts), Math.max(...ends)], [220, 900]);
  const svg = canvas(root, dataset.title, `${records.length} intervals aligned on one time axis.`);
  const rowHeight = Math.min(46, 330 / records.length);

  records.forEach((record, index) => {
    const y = 42 + index * rowHeight;
    const markId = id(record, dataset);
    const start = new Date(record[startField]).valueOf();
    const end = new Date(record[endField] ?? record[startField]).valueOf();
    appendText(svg, 205, y + 8, label(record, dataset), undefined, "end");
    svg.append(element("line", { x1: 220, x2: 900, y1: y + 4, y2: y + 4, class: "grid-line" }));
    const width = Math.max(9, x(end) - x(start));
    svg.append(element("rect", {
      x: x(start),
      y: y - 5,
      width,
      height: 18,
      rx: 4,
      class: markClass(markId, selectedId, seriesClass(index)),
      "data-mark-id": markId,
      "aria-label": `${label(record, dataset)}, ${record[startField]} to ${record[endField]}`,
    }));
    appendText(svg, 915, y + 8, record[groupField], "axis-label");
  });
}

function renderSequence(root, dataset, selectedId) {
  const records = [...dataset.records].sort((a, b) => value(a, role(dataset, "order", "order")) - value(b, role(dataset, "order", "order")));
  const svg = canvas(root, dataset.title, `A storyboard of ${records.length} changes, each retaining a source frame or page.`);
  const columns = 4;
  const tileWidth = 200;
  const tileHeight = 160;
  records.forEach((record, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = 55 + column * 225;
    const y = 32 + row * 205;
    const markId = id(record, dataset);
    const previewClass = record.mediaType === "video" ? "mark-quaternary" : seriesClass(index);
    svg.append(element("rect", {
      x,
      y,
      width: tileWidth,
      height: 105,
      rx: 3,
      class: markClass(markId, selectedId, `${previewClass} sequence-frame`),
      "data-mark-id": markId,
    }));
    appendText(svg, x, y + 126, `${index + 1}. ${label(record, dataset)}`);
    appendText(svg, x, y + 145, record.date, "axis-label");
    if (column < columns - 1 && index < records.length - 1) {
      svg.append(element("line", { x1: x + tileWidth + 7, x2: x + tileWidth + 18, y1: y + 52, y2: y + 52, class: "sequence-arrow" }));
    }
  });
}

function renderRelationship(root, dataset, selectedId) {
  const records = dataset.records;
  const xField = role(dataset, "x", "x");
  const yField = role(dataset, "y", "y");
  const xDomain = extent(records.map((record) => value(record, xField)));
  const yDomain = extent(records.map((record) => value(record, yField)));
  const x = linear([Math.min(0, xDomain[0]), xDomain[1]], [100, 890]);
  const y = linear([Math.min(0, yDomain[0]), yDomain[1]], [370, 40]);
  const svg = canvas(root, dataset.title, `${records.length} observations compare ${xField} with ${yField}.`);

  for (let step = 0; step <= 4; step += 1) {
    const px = 100 + step * (790 / 4);
    const py = 370 - step * (330 / 4);
    svg.append(element("line", { x1: px, x2: px, y1: 40, y2: 370, class: "grid-line" }));
    svg.append(element("line", { x1: 100, x2: 890, y1: py, y2: py, class: "grid-line" }));
    appendText(svg, px, 400, formatNumber((xDomain[1] * step) / 4), "axis-label", "middle");
    appendText(svg, 84, py + 4, formatNumber((yDomain[1] * step) / 4), "axis-label", "end");
  }
  appendText(svg, 890, 430, xField, "axis-label", "end");
  appendText(svg, 100, 24, yField, "axis-label");

  records.forEach((record, index) => {
    const markId = id(record, dataset);
    svg.append(element("circle", {
      cx: x(value(record, xField)),
      cy: y(value(record, yField)),
      r: 9,
      class: markClass(markId, selectedId, seriesClass(index)),
      "data-mark-id": markId,
    }));
    if (index === 0 || index === records.length - 1 || markId === selectedId) {
      appendText(svg, x(value(record, xField)) + 12, y(value(record, yField)) - 10, label(record, dataset), undefined);
    }
  });
}

function renderMatrix(root, dataset, selectedId) {
  const records = dataset.records;
  const rowField = role(dataset, "row", "row");
  const columnField = role(dataset, "column", "column");
  const valueField = role(dataset, "value", "value");
  const rows = [...new Set(records.map((record) => String(record[rowField])))];
  const columns = [...new Set(records.map((record) => String(record[columnField])))];
  const max = Math.max(...records.map((record) => value(record, valueField)), 1);
  const svg = canvas(root, dataset.title, `${rows.length} by ${columns.length} evidence matrix with directly labeled values.`);
  const left = 190;
  const top = 70;
  const cellWidth = Math.min(120, 700 / columns.length);
  const cellHeight = Math.min(62, 310 / rows.length);

  columns.forEach((column, index) => appendText(svg, left + index * cellWidth + cellWidth / 2, 48, column, "axis-label", "middle"));
  rows.forEach((row, rowIndex) => {
    appendText(svg, left - 14, top + rowIndex * cellHeight + cellHeight / 2 + 4, row, undefined, "end");
    columns.forEach((column, columnIndex) => {
      const record = records.find((candidate) => candidate[rowField] === row && candidate[columnField] === column);
      if (!record) return;
      const markId = id(record, dataset);
      const level = Math.max(1, Math.ceil((value(record, valueField) / max) * 5));
      svg.append(element("rect", {
        x: left + columnIndex * cellWidth + 2,
        y: top + rowIndex * cellHeight + 2,
        width: cellWidth - 4,
        height: cellHeight - 4,
        rx: 2,
        class: markClass(markId, selectedId, `matrix-cell level-${level}`),
        "data-mark-id": markId,
      }));
      appendText(svg, left + columnIndex * cellWidth + cellWidth / 2, top + rowIndex * cellHeight + cellHeight / 2 + 4, value(record, valueField), "matrix-value", "middle");
    });
  });
}

function renderHierarchy(root, dataset, selectedId) {
  const d3 = globalThis.d3;
  const parentField = role(dataset, "parent", "parentId");
  const valueField = role(dataset, "value", "value");
  const stratify = d3.stratify().id((record) => id(record, dataset)).parentId((record) => record[parentField]);
  const hierarchy = stratify(dataset.records);
  d3.tree().size([360, 690])(hierarchy);
  const svg = canvas(root, dataset.title, `A tree of ${dataset.records.length} nested collection sections.`);
  const group = element("g", { transform: "translate(185 42)" });
  svg.append(group);

  hierarchy.links().forEach((link) => {
    group.append(element("path", {
      d: `M${link.source.y},${link.source.x} C${(link.source.y + link.target.y) / 2},${link.source.x} ${(link.source.y + link.target.y) / 2},${link.target.x} ${link.target.y},${link.target.x}`,
      class: "hierarchy-link",
    }));
  });
  hierarchy.descendants().forEach((node) => {
    const record = node.data;
    const markId = id(record, dataset);
    group.append(element("circle", {
      cx: node.y,
      cy: node.x,
      r: Math.max(5, Math.min(14, Math.sqrt(value(record, valueField)) / 2)),
      class: markClass(markId, selectedId, node.depth === 0 ? "mark-secondary" : "mark-primary"),
      "data-mark-id": markId,
    }));
    appendText(group, node.y + 12, node.x + 4, label(record, dataset), node.depth > 1 ? "muted-label" : undefined);
  });
}

function radialPositions(records, dataset, radius = 155) {
  const center = { x: 480, y: 220 };
  return new Map(records.map((record, index) => {
    const angle = -Math.PI / 2 + (index / records.length) * Math.PI * 2;
    return [id(record, dataset), { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }];
  }));
}

function renderNetwork(root, dataset, selectedId) {
  const records = dataset.records;
  const positions = radialPositions(records, dataset, 160);
  const svg = canvas(root, dataset.title, `${records.length} concepts connected by ${dataset.links.length} typed relationships.`);
  dataset.links.forEach((link) => {
    const source = positions.get(String(link.source));
    const target = positions.get(String(link.target));
    if (!source || !target) return;
    const markId = String(link.id);
    svg.append(element("line", {
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      class: markClass(markId, selectedId, `network-link strength-${Math.min(5, value(link, "strength", 1))}`),
      "data-mark-id": markId,
      "aria-label": `${linkedLabel(dataset, link.source)} ${String(link.type ?? "connects")} ${linkedLabel(dataset, link.target)}`,
    }));
  });
  records.forEach((record, index) => {
    const position = positions.get(id(record, dataset));
    const markId = id(record, dataset);
    svg.append(element("circle", {
      cx: position.x,
      cy: position.y,
      r: 14,
      class: markClass(markId, selectedId, seriesClass(index)),
      "data-mark-id": markId,
    }));
    const anchor = position.x < 480 ? "end" : "start";
    appendText(svg, position.x + (position.x < 480 ? -20 : 20), position.y + 4, label(record, dataset), undefined, anchor);
  });
}

function stagePositions(records, dataset) {
  const stageField = role(dataset, "stage", "stage");
  const stages = [...new Set(records.map((record) => value(record, stageField)))].sort((a, b) => a - b);
  const map = new Map();
  stages.forEach((stage, stageIndex) => {
    const nodes = records.filter((record) => value(record, stageField) === stage);
    nodes.forEach((record, nodeIndex) => {
      map.set(id(record, dataset), {
        x: 85 + stageIndex * (790 / Math.max(stages.length - 1, 1)),
        y: 80 + nodeIndex * (290 / Math.max(nodes.length, 1)),
      });
    });
  });
  return map;
}

function renderFlow(root, dataset, selectedId) {
  const positions = stagePositions(dataset.records, dataset);
  const max = Math.max(...dataset.links.map((link) => value(link, "items", value(link, "value", 1))), 1);
  const svg = canvas(root, dataset.title, `${dataset.links.length} proportional flows connect ${dataset.records.length} stages.`);
  dataset.links.forEach((link) => {
    const source = positions.get(String(link.source));
    const target = positions.get(String(link.target));
    if (!source || !target) return;
    const amount = value(link, "items", value(link, "value", 1));
    const markId = String(link.id);
    const path = `M${source.x + 54},${source.y + 18} C${(source.x + target.x) / 2},${source.y + 18} ${(source.x + target.x) / 2},${target.y + 18} ${target.x - 54},${target.y + 18}`;
    svg.append(element("path", {
      d: path,
      class: markClass(markId, selectedId, "flow-link"),
      "stroke-width": 2 + (amount / max) * 16,
      "data-mark-id": markId,
      "aria-label": `${linkedLabel(dataset, link.source)} to ${linkedLabel(dataset, link.target)}: ${formatNumber(amount)} items`,
    }));
  });
  dataset.records.forEach((record, index) => {
    const position = positions.get(id(record, dataset));
    const markId = id(record, dataset);
    svg.append(element("rect", {
      x: position.x - 54,
      y: position.y,
      width: 108,
      height: 36,
      rx: 3,
      class: markClass(markId, selectedId, seriesClass(index)),
      "data-mark-id": markId,
    }));
    appendText(svg, position.x, position.y + 58, label(record, dataset), "axis-label", "middle");
  });
}

function renderMechanism(root, dataset, selectedId) {
  const layerField = role(dataset, "group", "layer");
  const layers = [...new Set(dataset.records.map((record) => String(record[layerField])))];
  const positions = new Map();
  layers.forEach((layer, layerIndex) => {
    const records = dataset.records.filter((record) => record[layerField] === layer);
    records.forEach((record, recordIndex) => {
      positions.set(id(record, dataset), {
        x: 100 + layerIndex * (760 / Math.max(layers.length - 1, 1)),
        y: 95 + recordIndex * 170,
      });
    });
  });
  const svg = canvas(root, dataset.title, `A typed mechanism diagram with ${dataset.records.length} components and ${dataset.links.length} evidential links.`);
  const marker = element("marker", { id: `arrow-${chartCounter}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
  marker.append(element("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "arrow-head" }));
  const defs = element("defs");
  defs.append(marker);
  svg.append(defs);
  layers.forEach((layer, index) => appendText(svg, 100 + index * (760 / Math.max(layers.length - 1, 1)), 38, layer, "axis-label", "middle"));
  dataset.links.forEach((link) => {
    const source = positions.get(String(link.source));
    const target = positions.get(String(link.target));
    if (!source || !target) return;
    const markId = String(link.id);
    svg.append(element("path", {
      d: `M${source.x + 52},${source.y + 25} C${(source.x + target.x) / 2},${source.y + 25} ${(source.x + target.x) / 2},${target.y + 25} ${target.x - 58},${target.y + 25}`,
      class: markClass(markId, selectedId, "mechanism-link"),
      "marker-end": `url(#arrow-${chartCounter})`,
      "data-mark-id": markId,
      "aria-label": `${linkedLabel(dataset, link.source)} ${String(link.type ?? "connects")} ${linkedLabel(dataset, link.target)}`,
    }));
  });
  dataset.records.forEach((record, index) => {
    const position = positions.get(id(record, dataset));
    const markId = id(record, dataset);
    svg.append(element("rect", {
      x: position.x - 58,
      y: position.y,
      width: 116,
      height: 50,
      rx: 3,
      class: markClass(markId, selectedId, seriesClass(index)),
      "data-mark-id": markId,
    }));
    appendText(svg, position.x, position.y + 72, label(record, dataset), undefined, "middle");
  });
}

let usGeographyPromise;

async function loadUsGeography() {
  usGeographyPromise ??= Promise.all([
    fetch("./vendor/us-states.json").then((response) => {
      if (!response.ok) throw new Error("State geometry failed to load");
      return response.json();
    }),
    fetch("./vendor/us-counties.json").then((response) => {
      if (!response.ok) throw new Error("County geometry failed to load");
      return response.json();
    }),
  ]).then(([states, counties]) => ({
    states: globalThis.topojson.feature(states, states.objects.states).features,
    counties: globalThis.topojson.feature(counties, counties.objects.counties).features,
  }));
  return usGeographyPromise;
}

function geographyFailure(root, message) {
  root.replaceChildren();
  const notice = htmlElement("div", "aggregate-message");
  notice.append(htmlElement("strong", undefined, "Published geometry unavailable"), htmlElement("p", undefined, message));
  root.append(notice);
}

async function renderRegionMap(root, dataset, selectedId) {
  try {
    const d3 = globalThis.d3;
    const { states } = await loadUsGeography();
    const featureCollection = { type: "FeatureCollection", features: states };
    const projection = d3.geoAlbersUsa().fitExtent([[45, 30], [910, 415]], featureCollection);
    const path = d3.geoPath(projection);
    const regionField = role(dataset, "region", "geoId");
    const regionLabelField = role(dataset, "regionLabel", "stateId");
    const recordById = new Map(dataset.records.map((record) => [String(record[regionField]).padStart(2, "0"), record]));
    const valueField = role(dataset, "value", "value");
    const max = Math.max(...dataset.records.map((record) => value(record, valueField)), 1);
    const svg = canvas(root, dataset.title, `A projected United States region map. ${dataset.records.length} states carry values.`);
    states.forEach((feature) => {
      const featureId = String(feature.id).padStart(2, "0");
      const record = recordById.get(featureId);
      const level = record ? Math.max(1, Math.ceil((value(record, valueField) / max) * 5)) : 0;
      const markId = record ? id(record, dataset) : null;
      svg.append(element("path", {
        d: path(feature),
        class: record ? markClass(markId, selectedId, `map-region level-${level}`) : "map-land",
        ...(markId ? { "data-mark-id": markId, "aria-label": `${label(record, dataset)}: ${value(record, valueField)}` } : {}),
      }));
      if (record) {
        const centroid = path.centroid(feature);
        appendText(svg, centroid[0], centroid[1] + 4, record[regionLabelField] ?? label(record, dataset), "map-label", "middle");
      }
    });
  } catch (error) {
    geographyFailure(root, error.message);
  }
}

async function renderPointMap(root, dataset, selectedId) {
  try {
    const d3 = globalThis.d3;
    const { counties } = await loadUsGeography();
    const bayCountyIds = new Set(["06001", "06013", "06041", "06055", "06075", "06081", "06085", "06095", "06097"]);
    const features = counties.filter((feature) => bayCountyIds.has(String(feature.id).padStart(5, "0")));
    const featureCollection = { type: "FeatureCollection", features };
    const projection = d3.geoMercator().fitExtent([[55, 28], [905, 420]], featureCollection);
    const path = d3.geoPath(projection);
    const valueField = role(dataset, "value", "value");
    const radius = linear([0, Math.max(...dataset.records.map((record) => Math.sqrt(value(record, valueField))), 1)], [3, 19]);
    const svg = canvas(root, dataset.title, `A published Bay Area county basemap with ${dataset.records.length} exact point records.`);
    features.forEach((feature) => svg.append(element("path", { d: path(feature), class: "map-land map-county" })));
    dataset.records.forEach((record) => {
      const point = projection([value(record, role(dataset, "longitude", "longitude")), value(record, role(dataset, "latitude", "latitude"))]);
      if (!point) return;
      const markId = id(record, dataset);
      svg.append(element("circle", {
        cx: point[0],
        cy: point[1],
        r: radius(Math.sqrt(value(record, valueField))),
        class: markClass(markId, selectedId, "map-point"),
        "data-mark-id": markId,
        "aria-label": `${label(record, dataset)}: ${value(record, valueField)} sessions`,
      }));
      if (value(record, valueField) >= 9 || markId === selectedId) appendText(svg, point[0] + 12, point[1] - 9, label(record, dataset), "map-label");
    });
    appendText(svg, 55, 438, "Published county boundaries · points retain source coordinates", "axis-label");
  } catch (error) {
    geographyFailure(root, error.message);
  }
}

function renderField(root, dataset, selectedId) {
  const records = dataset.records;
  const xField = role(dataset, "x", "x");
  const yField = role(dataset, "y", "y");
  const valueField = role(dataset, "value", "value");
  const xs = [...new Set(records.map((record) => value(record, xField)))].sort((a, b) => a - b);
  const ys = [...new Set(records.map((record) => value(record, yField)))].sort((a, b) => a - b);
  const max = Math.max(...records.map((record) => value(record, valueField)), 1);
  const left = 155;
  const top = 38;
  const cellWidth = 720 / xs.length;
  const cellHeight = 330 / ys.length;
  const svg = canvas(root, dataset.title, `A ${ys.length} by ${xs.length} measured field. Color shows attention value.`);
  records.forEach((record) => {
    const markId = id(record, dataset);
    const column = xs.indexOf(value(record, xField));
    const row = ys.indexOf(value(record, yField));
    const level = Math.max(1, Math.ceil((value(record, valueField) / max) * 5));
    svg.append(element("rect", {
      x: left + column * cellWidth + 1,
      y: top + row * cellHeight + 1,
      width: cellWidth - 2,
      height: cellHeight - 2,
      class: markClass(markId, selectedId, `field-cell level-${level}`),
      "data-mark-id": markId,
    }));
  });
  xs.forEach((hour, index) => appendText(svg, left + index * cellWidth + cellWidth / 2, 395, `${hour}:00`, "axis-label", "middle"));
  ys.forEach((weekday, index) => {
    const record = records.find((candidate) => value(candidate, yField) === weekday);
    appendText(svg, left - 14, top + index * cellHeight + cellHeight / 2 + 4, record?.weekday ?? weekday, undefined, "end");
  });
}

function renderAnnotatedSpecimen(root, dataset, selectedId) {
  const suppliedAspectRatio = Number(dataset.specimen?.aspectRatio);
  const aspectRatio = Number.isFinite(suppliedAspectRatio) && suppliedAspectRatio > 0 ? suppliedAspectRatio : 4 / 3;
  const maximumWidth = 820;
  const maximumHeight = 370;
  const imageWidth = Math.min(maximumWidth, maximumHeight * aspectRatio);
  const imageHeight = imageWidth / aspectRatio;
  const imageX = (WIDTH - imageWidth) / 2;
  const imageY = 30;
  const svg = canvas(root, dataset.title, `${dataset.specimen?.preview?.alt ?? "A source image"} with ${dataset.records.length} evidence-bearing normalized regions.`);
  svg.append(element("rect", { x: imageX, y: imageY, width: imageWidth, height: imageHeight, class: "specimen-ground" }));
  const horizontalStep = (imageWidth - 48) / 8;
  const verticalStep = (imageHeight - 54) / 4;
  for (let column = 0; column < 8; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      const width = horizontalStep * (0.58 + ((column + row) % 3) * 0.12);
      svg.append(element("rect", {
        x: imageX + 24 + column * horizontalStep,
        y: imageY + 27 + row * verticalStep,
        width,
        height: Math.max(18, verticalStep * 0.62),
        rx: 1,
        class: `specimen-note ${seriesClass(column + row)}`,
      }));
    }
  }
  [...dataset.records]
    .sort((left, right) => value(right, role(dataset, "width", "width")) * value(right, role(dataset, "height", "height")) - value(left, role(dataset, "width", "width")) * value(left, role(dataset, "height", "height")))
    .forEach((record) => {
    const markId = id(record, dataset);
    svg.append(element("rect", {
      x: imageX + value(record, role(dataset, "x", "x")) * imageWidth,
      y: imageY + value(record, role(dataset, "y", "y")) * imageHeight,
      width: value(record, role(dataset, "width", "width")) * imageWidth,
      height: value(record, role(dataset, "height", "height")) * imageHeight,
      class: markClass(markId, selectedId, "annotation-region"),
      "data-mark-id": markId,
      "aria-label": label(record, dataset),
    }));
    });
}

function renderCollectionAtlas(root, dataset, selectedId) {
  const xField = role(dataset, "x", "x");
  const yField = role(dataset, "y", "y");
  const sizeField = role(dataset, "value", "size");
  const x = linear([0, 100], [45, 915]);
  const y = linear([0, 100], [25, 420]);
  const size = linear(extent(dataset.records.map((record) => value(record, sizeField))), [6, 17]);
  const categories = [...new Set(dataset.records.map((record) => record.category))];
  const svg = canvas(root, dataset.title, `A mixed-media atlas of ${dataset.records.length} items arranged by similarity.`);
  categories.forEach((category, index) => {
    const group = dataset.records.filter((record) => record.category === category);
    const cx = group.reduce((sum, record) => sum + x(value(record, xField)), 0) / group.length;
    const cy = group.reduce((sum, record) => sum + y(value(record, yField)), 0) / group.length;
    appendText(svg, cx, cy - 38, category, "atlas-cluster-label", "middle");
  });
  dataset.records.forEach((record, index) => {
    const markId = id(record, dataset);
    const radius = size(value(record, sizeField));
    const className = record.mediaType === "video" ? "mark-quaternary" : record.mediaType === "audio" ? "mark-secondary" : seriesClass(categories.indexOf(record.category));
    svg.append(element(record.mediaType === "image" ? "rect" : "circle", record.mediaType === "image" ? {
      x: x(value(record, xField)) - radius,
      y: y(value(record, yField)) - radius,
      width: radius * 2,
      height: radius * 2,
      rx: 2,
      class: markClass(markId, selectedId, className),
      "data-mark-id": markId,
    } : {
      cx: x(value(record, xField)),
      cy: y(value(record, yField)),
      r: radius,
      class: markClass(markId, selectedId, record.mediaType === "text" ? `${className} atlas-text-mark` : className),
      "data-mark-id": markId,
    }));
    if (radius >= 15 || markId === selectedId) appendText(svg, x(value(record, xField)), y(value(record, yField)) + radius + 14, label(record, dataset), "atlas-item-label", "middle");
  });
}

const RENDERERS = Object.freeze({
  rank: renderRank,
  distribution: renderDistribution,
  composition: renderComposition,
  profile: renderProfile,
  "passage-comparison": renderPassageComparison,
  trend: renderTrend,
  timeline: renderTimeline,
  sequence: renderSequence,
  relationship: renderRelationship,
  matrix: renderMatrix,
  hierarchy: renderHierarchy,
  network: renderNetwork,
  flow: renderFlow,
  mechanism: renderMechanism,
  "region-map": renderRegionMap,
  "point-map": renderPointMap,
  field: renderField,
  "annotated-specimen": renderAnnotatedSpecimen,
  "collection-atlas": renderCollectionAtlas,
});

export const RENDERER_IDS = Object.freeze(Object.keys(RENDERERS));

export async function renderFamily({ root, dataset, selectedId = null }) {
  if (!(root instanceof HTMLElement)) throw new TypeError("renderer root must be an HTMLElement");
  const renderer = RENDERERS[dataset?.familyId];
  if (!renderer) throw new Error(`No renderer registered for ${String(dataset?.familyId)}`);
  await renderer(root, dataset, selectedId);
  return {
    familyId: dataset.familyId,
    markCount: dataset.records.length,
    evidenceCount: evidenceCount(dataset),
  };
}
