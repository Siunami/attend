import {
  appendVisualizationInspector,
  buildVisualizationInspectionIndex,
  inspectionTargetKey,
} from "./visualization-inspector.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 960;
const HEIGHT = 450;
const MAX_NODE_SELECTION_MARKS = 50;
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
    role: "group",
    "aria-roledescription": "visualization",
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
  if (record?.markId !== undefined && record?.markId !== null) return String(record.markId);
  return String(record?.[role(dataset, "id", "id")] ?? record?.id ?? "");
}

function linkedLabel(dataset, identifier) {
  const record = dataset.records.find((candidate) => id(candidate, dataset) === String(identifier));
  return record ? label(record, dataset) : String(identifier);
}

function formatNumber(number) {
  const normalized = Object.is(number, -0) ? 0 : number;
  return new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(normalized);
}

function numericValue(record, field) {
  const result = Number(record?.[field]);
  return Number.isFinite(result) ? result : null;
}

function observedDomain(values, fallback = [0, 1]) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return fallback;
  return [Math.min(...finite), Math.max(...finite)];
}

function observedScale(domain, range) {
  if (domain[0] === domain[1]) {
    const middle = (range[0] + range[1]) / 2;
    return () => middle;
  }
  return linear(domain, range);
}

function observedTicks(domain, count = 5) {
  if (domain[0] === domain[1]) return [domain[0]];
  return Array.from({ length: count }, (_, index) => (
    domain[0] + ((domain[1] - domain[0]) * index) / (count - 1)
  ));
}

function observedTicksWithZero(domain, count = 5) {
  const ticks = observedTicks(domain, count);
  if (domain[0] < 0 && domain[1] > 0) ticks.push(0);
  return [...new Set(ticks)].sort((left, right) => left - right);
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function markClass(markId, selectedId, base = "mark-primary") {
  return `${base}${isSelected(markId, selectedId) ? " is-selected" : ""}`;
}

function isSelected(markId, selectedId) {
  if (selectedId instanceof Set) return selectedId.has(String(markId));
  if (Array.isArray(selectedId)) return selectedId.some((value) => String(value) === String(markId));
  return String(markId) === String(selectedId ?? "");
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

function wrappedLabelLines(text, maximumCharacters, maximumLines = 2) {
  const words = String(text).trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (current !== undefined && `${current} ${word}`.length <= maximumCharacters) {
      lines[lines.length - 1] = `${current} ${word}`;
    } else {
      lines.push(word);
    }
  }
  if (lines.length > maximumLines) {
    const retained = lines.slice(0, maximumLines - 1);
    retained.push(lines.slice(maximumLines - 1).join(" "));
    lines.splice(0, lines.length, ...retained);
  }
  return lines.map((line, index) => (
    index === lines.length - 1 && line.length > maximumCharacters
      ? `${line.slice(0, Math.max(1, maximumCharacters - 1)).trimEnd()}…`
      : line
  ));
}

function appendWrappedText(parent, {
  x,
  centerY,
  text,
  maximumCharacters,
  maximumLines = 2,
  className,
  anchor = "middle",
  lineHeight = 14,
}) {
  const lines = wrappedLabelLines(text, maximumCharacters, maximumLines);
  const node = element("text", {
    x,
    class: className,
    "text-anchor": anchor,
    "aria-hidden": "true",
  });
  const firstY = centerY - ((lines.length - 1) * lineHeight) / 2 + 4;
  lines.forEach((line, index) => {
    node.append(element("tspan", { x, y: firstY + index * lineHeight }, line));
  });
  parent.append(node);
  return { node, lines };
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
  const values = records.map((record) => numericValue(record, valueField));
  const observed = observedDomain(values);
  const domain = [Math.min(0, observed[0]), Math.max(0, observed[1])];
  const domainDescription = observed[0] === observed[1]
    ? `Every supplied value is ${formatNumber(observed[0])}.`
    : `The supplied value extent is ${formatNumber(observed[0])} to ${formatNumber(observed[1])}.`;
  const svg = canvas(root, dataset.title, `${countLabel(records.length, "ranked item")}. ${domainDescription}`);
  const left = 220;
  const top = 26;
  const rowHeight = Math.min(58, 360 / Math.max(records.length, 1));
  const x = observedScale(domain, [left, 875]);
  const zero = x(0);
  svg.setAttribute("data-value-domain", `${domain[0]},${domain[1]}`);

  observedTicks(domain).forEach((tick) => {
    const px = x(tick);
    svg.append(element("line", { x1: px, x2: px, y1: top, y2: top + rowHeight * records.length, class: "grid-line" }));
    appendText(svg, px, top + rowHeight * records.length + 25, formatNumber(tick), "axis-label", "middle");
  });

  records.forEach((record, index) => {
    const markId = id(record, dataset);
    const amount = numericValue(record, valueField);
    const endpoint = x(amount);
    const y = top + index * rowHeight + rowHeight * 0.23;
    appendText(svg, left - 14, y + rowHeight * 0.29, label(record, dataset), undefined, "end");
    const bar = element("rect", {
      x: Math.min(zero, endpoint),
      y,
      width: Math.max(2, Math.abs(endpoint - zero)),
      height: rowHeight * 0.46,
      rx: 2,
      class: markClass(markId, selectedId, index === 0 ? "mark-secondary" : "mark-primary"),
      "data-mark-id": markId,
      "aria-label": `${label(record, dataset)}: ${formatNumber(amount)}`,
    });
    svg.append(bar);
    appendText(
      svg,
      endpoint + (amount < 0 ? -9 : 9),
      y + rowHeight * 0.31,
      formatNumber(amount),
      undefined,
      amount < 0 ? "end" : undefined,
    );
  });
}

function renderDistribution(root, dataset, selectedId) {
  const records = dataset.records;
  const valueField = role(dataset, "value", "value");
  const groupField = role(dataset, "group", "group");
  const groupName = (record) => String(record?.[groupField] ?? "All observations");
  const groups = [...new Set(records.map(groupName))];
  const values = records.map((record) => numericValue(record, valueField)).filter(Number.isFinite);
  const domain = observedDomain(values);
  const x = observedScale(domain, [165, 900]);
  const rowHeight = 62;
  const plotBottom = 42 + groups.length * rowHeight;
  const chartHeight = Math.max(HEIGHT, plotBottom + 76);
  const domainDescription = domain[0] === domain[1]
    ? `Every supplied value is ${formatNumber(domain[0])}.`
    : `The supplied value extent is ${formatNumber(domain[0])} to ${formatNumber(domain[1])}.`;
  const svg = canvas(
    root,
    dataset.title,
    `A grouped strip plot of ${countLabel(records.length, "observation")} across ${countLabel(groups.length, "group")}. ${domainDescription}`,
    chartHeight,
  );

  for (const tick of observedTicks(domain)) {
    const px = x(tick);
    svg.append(element("line", { x1: px, x2: px, y1: 28, y2: plotBottom, class: "grid-line" }));
    appendText(svg, px, plotBottom + 24, formatNumber(tick), "axis-label", "middle");
  }
  appendText(svg, 900, plotBottom + 52, "Observed value", "axis-label", "end");

  groups.forEach((group, groupIndex) => {
    const cy = 58 + groupIndex * rowHeight;
    const groupRecords = records.filter((record) => groupName(record) === group);
    appendText(svg, 142, cy + 4, group, undefined, "end");
    svg.append(element("line", { x1: 165, x2: 900, y1: cy, y2: cy, class: "baseline" }));
    const sorted = groupRecords.map((record) => numericValue(record, valueField)).filter(Number.isFinite).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
    svg.append(element("line", { x1: x(median), x2: x(median), y1: cy - 23, y2: cy + 23, class: "median-line" }));
    groupRecords.forEach((record, recordIndex) => {
      const markId = id(record, dataset);
      const jitter = ((recordIndex % 3) - 1) * 13;
      const observation = numericValue(record, valueField);
      svg.append(element("circle", {
        cx: x(observation),
        cy: cy + jitter,
        r: 7,
        class: markClass(markId, selectedId, seriesClass(groupIndex)),
        "data-mark-id": markId,
        "aria-label": `${label(record, dataset)}: ${formatNumber(observation)}; group ${group}`,
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
  const rowPitch = 112;
  const chartHeight = Math.max(HEIGHT, 70 + series.length * rowPitch);
  const svg = canvas(
    root,
    dataset.title,
    `${countLabel(series.length, "observed whole")} shown as normalized bars with ${countLabel(parts.length, "part")} and an explicit total for every whole.`,
    chartHeight,
  );
  const left = 150;
  const right = 900;
  const width = right - left;

  series.forEach((seriesName, seriesIndex) => {
    const y = 52 + seriesIndex * rowPitch;
    const selected = records.filter((record) => String(record[seriesField]) === seriesName);
    const total = selected.reduce((sum, record) => sum + value(record, valueField), 0);
    appendText(svg, left - 18, y + 34, seriesName, undefined, "end");
    let cursor = left;
    selected.forEach((record) => {
      const amount = value(record, valueField);
      const segmentWidth = total > 0 ? width * (amount / total) : 0;
      const markId = id(record, dataset);
      const part = String(record[partField]);
      const className = seriesClass(parts.indexOf(part));
      const attributes = {
        class: markClass(markId, selectedId, className),
        "data-mark-id": markId,
        "aria-label": `${part}: ${formatNumber(amount)} of ${formatNumber(total)}`,
      };
      if (segmentWidth > 0) {
        svg.append(element("rect", { x: cursor, y, width: segmentWidth, height: 56, ...attributes }));
        if (segmentWidth >= 72) appendText(svg, cursor + segmentWidth / 2, y + 34, formatNumber(amount), "inside-label", "middle");
        appendText(svg, cursor + segmentWidth / 2, y - 10, part, "axis-label", "middle");
      } else {
        svg.append(element("circle", { cx: cursor, cy: y + 28, r: 4, ...attributes }));
        appendText(svg, cursor, y - 10, part, "axis-label", "middle");
      }
      cursor += segmentWidth;
    });
    appendText(
      svg,
      right,
      y + 82,
      total > 0 ? `Total ${formatNumber(total)}` : "Total 0; shares undefined",
      "axis-label",
      "end",
    );
  });
}

function renderProfile(root, dataset, selectedId) {
  const records = dataset.records;
  const measures = role(dataset, "measures", []);
  const left = 180;
  const right = 900;
  const xFor = (index) => measures.length === 1
    ? (left + right) / 2
    : left + index * ((right - left) / (measures.length - 1));

  const entityField = role(dataset, "entity", "entity");
  const dimensionField = role(dataset, "dimension", "dimension");
  const isLongProfile = measures.length > 0 && records.some((record) => record[dimensionField] !== undefined);
  const profiles = isLongProfile
    ? [...new Map(records.map((record) => [String(record[entityField] ?? record.id), String(record[entityField] ?? record.id)])).keys()]
      .map((entity) => ({
        entity,
        records: records.filter((record) => String(record[entityField] ?? record.id) === entity),
      }))
    : records.map((record) => ({ entity: label(record, dataset), records: [record] }));

  const valueField = role(dataset, "value", "value");
  const profileValue = (profile, measure) => {
    if (isLongProfile) {
      const record = profile.records.find((candidate) => String(candidate[dimensionField]) === String(measure));
      return { record, number: numericValue(record, valueField) };
    }
    const record = profile.records[0];
    return { record, number: numericValue(record, measure) };
  };
  const domains = new Map(measures.map((measure) => [measure, observedDomain(
    profiles.map((profile) => profileValue(profile, measure).number).filter(Number.isFinite),
  )]));
  const scales = new Map(measures.map((measure) => [measure, observedScale(domains.get(measure), [370, 50])]));
  const svg = canvas(
    root,
    dataset.title,
    `${countLabel(profiles.length, "profile")} compared across ${countLabel(measures.length, "independently scaled measure")}. Missing measurements remain unconnected.`,
  );

  measures.forEach((measure, index) => {
    const x = xFor(index);
    const domain = domains.get(measure);
    svg.append(element("line", { x1: x, x2: x, y1: 50, y2: 370, class: "grid-line" }));
    appendText(svg, x, 28, formatNumber(domain[1]), "axis-label", "middle");
    if (domain[0] !== domain[1]) appendText(svg, x, 386, formatNumber(domain[0]), "axis-label", "middle");
    appendText(svg, x, 416, measure, "axis-label", "middle");
  });

  profiles.forEach((profile, recordIndex) => {
    const points = measures.map((measure, index) => {
      const measurement = profileValue(profile, measure);
      return measurement.record && Number.isFinite(measurement.number)
        ? { ...measurement, index, measure, x: xFor(index), y: scales.get(measure)(measurement.number) }
        : null;
    });
    let run = [];
    const drawRun = () => {
      if (run.length >= 2) {
        svg.append(element("polyline", {
          points: run.map((point) => `${point.x},${point.y}`).join(" "),
          fill: "none",
          class: `${seriesClass(recordIndex)} profile-line`,
          "aria-label": `${profile.entity} profile`,
        }));
      }
      run = [];
    };
    for (const point of [...points, null]) {
      if (point) run.push(point);
      else drawRun();
    }
    points.forEach((point) => {
      if (!point) return;
      const markId = id(point.record, dataset);
      svg.append(element("circle", {
        cx: point.x,
        cy: point.y,
        r: 4,
        class: markClass(markId, selectedId, seriesClass(recordIndex)),
        "data-mark-id": markId,
        "aria-label": `${profile.entity}, ${point.measure}: ${formatNumber(point.number)}`,
      }));
    });
    const firstPoint = points.find(Boolean);
    if (firstPoint) appendText(svg, firstPoint.x - 12, firstPoint.y + 4, profile.entity, recordIndex > 3 ? "muted-label" : undefined, "end");
  });
}

function renderPassageComparison(root, dataset, selectedId) {
  root.replaceChildren();
  const textField = role(dataset, "text", "text");
  const versionField = role(dataset, "version", "version");
  const labelField = role(dataset, "label", "label");
  const orderField = role(dataset, "order", "order");
  const versions = [...new Set(dataset.records.map((record) => String(record[versionField])))];
  if (versions.length > 2) {
    const notice = htmlElement("div", "aggregate-message");
    notice.setAttribute("data-render-state", "abstained");
    notice.append(
      htmlElement("strong", undefined, "Passage comparison abstained"),
      htmlElement("p", undefined, `The fixed parallel-text renderer requires exactly two witnesses; ${versions.length} were supplied.`),
    );
    root.append(notice);
    return;
  }
  const witnesses = versions.length === 2 ? versions : [versions[0], "Witness not supplied"];
  const rows = new Map();
  dataset.records.forEach((record, index) => {
    const order = numericValue(record, orderField);
    const suppliedLabel = record?.[labelField];
    const alignmentLabel = suppliedLabel === undefined || suppliedLabel === null || suppliedLabel === ""
      ? null
      : String(suppliedLabel);
    const explicit = Number.isFinite(order)
      ? { key: `order:${order}`, sort: [0, order], label: alignmentLabel ?? `Order ${formatNumber(order)}` }
      : alignmentLabel
        ? { key: `label:${alignmentLabel}`, sort: [1, alignmentLabel], label: alignmentLabel }
        : { key: `unaligned:${id(record, dataset)}`, sort: [2, index], label: "Alignment key unavailable" };
    const row = rows.get(explicit.key) ?? { ...explicit, recordsByWitness: new Map() };
    const witness = String(record[versionField]);
    const records = row.recordsByWitness.get(witness) ?? [];
    records.push(record);
    row.recordsByWitness.set(witness, records);
    rows.set(explicit.key, row);
  });
  const orderedRows = [...rows.values()].sort((left, right) => {
    if (left.sort[0] !== right.sort[0]) return left.sort[0] - right.sort[0];
    if (typeof left.sort[1] === "number" && typeof right.sort[1] === "number") return left.sort[1] - right.sort[1];
    return String(left.sort[1]).localeCompare(String(right.sort[1]));
  });
  const table = htmlElement("table", "passage-columns");
  table.setAttribute("data-layout", "parallel-witnesses");
  table.setAttribute("data-witness-columns", "2");
  const caption = htmlElement("caption", "passage-comparison-caption", `${countLabel(orderedRows.length, "aligned passage row")} across two witness columns.`);
  const head = htmlElement("thead");
  const headingRow = htmlElement("tr");
  witnesses.forEach((witness) => {
    const heading = htmlElement("th", "passage-witness-heading", witness);
    heading.setAttribute("scope", "col");
    headingRow.append(heading);
  });
  head.append(headingRow);
  const rowGroups = [];
  orderedRows.forEach((row) => {
    const rowGroup = htmlElement("tbody", "passage-alignment-group");
    const labelRow = htmlElement("tr", "passage-alignment-label");
    const rowHeading = htmlElement("th", undefined, row.label);
    rowHeading.setAttribute("colspan", "2");
    rowHeading.setAttribute("scope", "rowgroup");
    labelRow.append(rowHeading);
    const witnessRow = htmlElement("tr", "passage-alignment-row");
    witnesses.forEach((witness) => {
      const cell = htmlElement("td", "passage-witness-column");
      const records = row.recordsByWitness.get(witness) ?? [];
      if (!records.length) {
        cell.append(htmlElement("div", "passage-missing", "Not supplied for this witness."));
      } else {
        records.forEach((record) => {
          const item = htmlElement("article", markClass(id(record, dataset), selectedId, "passage-row"));
          item.dataset.markId = id(record, dataset);
          const metadata = htmlElement("div", "passage-meta");
          metadata.append(
            htmlElement("strong", undefined, record[versionField] ?? "Unversioned"),
            htmlElement("span", undefined, row.label),
          );
          const quote = document.createElement("blockquote");
          quote.textContent = record[textField] ?? "No passage supplied";
          item.append(metadata, quote);
          cell.append(item);
        });
      }
      witnessRow.append(cell);
    });
    rowGroup.append(labelRow, witnessRow);
    rowGroups.push(rowGroup);
  });
  table.append(caption, head, ...rowGroups);
  root.append(table);
}

function renderTrend(root, dataset, selectedId) {
  const records = dataset.records;
  const xField = role(dataset, "x", "x");
  const yField = role(dataset, "y", "y");
  const seriesField = role(dataset, "series", "series");
  const compareTime = (left, right) => {
    const leftNumber = typeof left === "number" ? left : Date.parse(left);
    const rightNumber = typeof right === "number" ? right : Date.parse(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return String(left).localeCompare(String(right));
  };
  const dates = [...new Map(records.map((record) => [String(record[xField]), record[xField]])).values()].sort(compareTime);
  const dateIndex = new Map(dates.map((date, index) => [String(date), index]));
  const seriesName = (record) => String(record?.[seriesField] ?? "Series 1");
  const series = [...new Set(records.map(seriesName))];
  const yDomain = observedDomain(records.map((record) => numericValue(record, yField)));
  const x = linear([0, Math.max(dates.length - 1, 1)], [90, 890]);
  const y = observedScale(yDomain, [370, 40]);
  const svg = canvas(
    root,
    dataset.title,
    `${countLabel(series.length, "series")} shown on one shared time scale and the supplied value extent ${formatNumber(yDomain[0])} to ${formatNumber(yDomain[1])}.`,
  );
  svg.setAttribute("data-value-domain", `${yDomain[0]},${yDomain[1]}`);

  for (const tick of observedTicksWithZero(yDomain)) {
    svg.append(element("line", { x1: 90, x2: 890, y1: y(tick), y2: y(tick), class: "grid-line" }));
    appendText(svg, 75, y(tick) + 4, formatNumber(tick), "axis-label", "end");
  }
  dates.forEach((date, index) => {
    if (index % 2 === 0 || dates.length < 7) appendText(svg, x(index), 405, String(date), "axis-label", "middle");
  });

  series.forEach((name, seriesIndex) => {
    const lineRecords = records.filter((record) => seriesName(record) === name).sort((a, b) => compareTime(a[xField], b[xField]));
    const points = lineRecords.map((record) => `${x(dateIndex.get(String(record[xField])))},${y(numericValue(record, yField))}`).join(" ");
    svg.append(element("polyline", { points, fill: "none", class: `${seriesClass(seriesIndex)} trend-line`, "aria-label": `${name} observed trend` }));
    lineRecords.forEach((record) => {
      const markId = id(record, dataset);
      svg.append(element("circle", {
        cx: x(dateIndex.get(String(record[xField]))),
        cy: y(numericValue(record, yField)),
        r: 5,
        class: markClass(markId, selectedId, seriesClass(seriesIndex)),
        "data-mark-id": markId,
        "aria-label": `${name}, ${String(record[xField])}: ${formatNumber(numericValue(record, yField))}`,
      }));
    });
    const last = lineRecords.at(-1);
    appendText(svg, 901, y(numericValue(last, yField)) + 4, name, undefined);
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
      "aria-label": `${label(record, dataset)}, ${record[startField]} to ${record[endField] ?? record[startField]}`,
    }));
    appendText(svg, 915, y + 8, record[groupField], "axis-label");
  });
}

function renderSequence(root, dataset, selectedId) {
  const records = [...dataset.records].sort((a, b) => value(a, role(dataset, "order", "order")) - value(b, role(dataset, "order", "order")));
  const rows = Math.ceil(records.length / 4);
  const svg = canvas(
    root,
    dataset.title,
    `${countLabel(records.length, "categorical step")} in supplied order. Equal spacing shows succession only; it does not imply duration or causality.`,
    Math.max(HEIGHT, 42 + rows * 116),
  );
  svg.setAttribute("data-layout", "step-strip");
  const columns = 4;
  const tileWidth = 200;
  const tileHeight = 72;
  records.forEach((record, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = 55 + column * 225;
    const y = 28 + row * 116;
    const markId = id(record, dataset);
    svg.append(element("rect", {
      x,
      y,
      width: tileWidth,
      height: tileHeight,
      rx: 3,
      class: markClass(markId, selectedId, `${seriesClass(index)} sequence-step`),
      "data-mark-id": markId,
      "aria-label": `Step ${index + 1}: ${label(record, dataset)}`,
    }));
    appendText(svg, x + 14, y + 28, `Step ${index + 1}`, "axis-label");
    appendText(svg, x + 14, y + 52, label(record, dataset));
    if (column < columns - 1 && index < records.length - 1) {
      svg.append(element("line", { x1: x + tileWidth + 7, x2: x + tileWidth + 18, y1: y + tileHeight / 2, y2: y + tileHeight / 2, class: "sequence-arrow" }));
    }
  });
}

function renderRelationship(root, dataset, selectedId) {
  const records = dataset.records;
  const xField = role(dataset, "x", "x");
  const yField = role(dataset, "y", "y");
  const xDomain = observedDomain(records.map((record) => numericValue(record, xField)));
  const yDomain = observedDomain(records.map((record) => numericValue(record, yField)));
  const x = observedScale(xDomain, [100, 890]);
  const y = observedScale(yDomain, [370, 40]);
  const svg = canvas(
    root,
    dataset.title,
    `${countLabel(records.length, "paired observation")} compare ${xField} from ${formatNumber(xDomain[0])} to ${formatNumber(xDomain[1])} with ${yField} from ${formatNumber(yDomain[0])} to ${formatNumber(yDomain[1])}.`,
  );
  svg.setAttribute("data-x-domain", `${xDomain[0]},${xDomain[1]}`);
  svg.setAttribute("data-y-domain", `${yDomain[0]},${yDomain[1]}`);

  for (const tick of observedTicksWithZero(xDomain)) {
    const px = x(tick);
    svg.append(element("line", { x1: px, x2: px, y1: 40, y2: 370, class: "grid-line" }));
    appendText(svg, px, 400, formatNumber(tick), "axis-label", "middle");
  }
  for (const tick of observedTicksWithZero(yDomain)) {
    const py = y(tick);
    svg.append(element("line", { x1: 100, x2: 890, y1: py, y2: py, class: "grid-line" }));
    appendText(svg, 84, py + 4, formatNumber(tick), "axis-label", "end");
  }
  appendText(svg, 890, 430, xField, "axis-label", "end");
  appendText(svg, 100, 24, yField, "axis-label");

  records.forEach((record, index) => {
    const markId = id(record, dataset);
    const xValue = numericValue(record, xField);
    const yValue = numericValue(record, yField);
    svg.append(element("circle", {
      cx: x(xValue),
      cy: y(yValue),
      r: 9,
      class: markClass(markId, selectedId, seriesClass(index)),
      "data-mark-id": markId,
      "aria-label": `${label(record, dataset)}: ${xField} ${formatNumber(xValue)}, ${yField} ${formatNumber(yValue)}`,
    }));
    if (index === 0 || index === records.length - 1 || isSelected(markId, selectedId)) {
      appendText(svg, x(xValue) + 12, y(yValue) - 10, label(record, dataset), undefined);
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
  const nodeIdField = role(dataset, "nodeId", "id");
  const parentField = role(dataset, "parent", "parentId");
  const valueField = role(dataset, "value", "value");
  const stratify = d3.stratify()
    .id((record) => String(record[nodeIdField] ?? record.id))
    .parentId((record) => record[parentField]);
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
    const relationship = element("g", {
      class: "network-relationship",
      "data-mark-id": markId,
      "aria-label": `${linkedLabel(dataset, link.source)} ${String(link.type ?? "connects")} ${linkedLabel(dataset, link.target)}`,
    });
    const lineAttributes = {
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
    };
    relationship.append(element("line", {
      ...lineAttributes,
      class: "network-link-hit",
    }));
    relationship.append(element("line", {
      ...lineAttributes,
      class: markClass(markId, selectedId, `network-link strength-${Math.min(5, value(link, "strength", 1))}`),
    }));
    svg.append(relationship);
  });
  records.forEach((record, index) => {
    const position = positions.get(id(record, dataset));
    const nodeId = id(record, dataset);
    svg.append(element("circle", {
      cx: position.x,
      cy: position.y,
      r: 14,
      class: seriesClass(index),
      "data-node-id": nodeId,
    }));
    const anchor = position.x < 480 ? "end" : "start";
    appendText(svg, position.x + (position.x < 480 ? -20 : 20), position.y + 4, label(record, dataset), undefined, anchor);
  });
}

function stagePositions(records, dataset) {
  const stageField = role(dataset, "stage", "stage");
  const stages = [...new Set(records.map((record) => value(record, stageField, 0)))].sort((a, b) => a - b);
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
  const stages = new Set(dataset.records.map((record) => value(record, role(dataset, "stage", "stage"), 0)));
  const intermediateGaps = dataset.records.filter((record) => (
    value(record, "inflow", 0) > 0
    && value(record, "outflow", 0) > 0
    && Math.abs(value(record, "balanceGap", 0)) > 1e-9
  ));
  const svg = canvas(
    root,
    dataset.title,
    `${countLabel(dataset.links.length, "evidence-bearing directed flow")} cross ${countLabel(stages.size, "derived topological stage")}. Node labels report supplied inflow, outflow, and any intermediate conservation gap.`,
  );
  svg.setAttribute("data-stage-derivation", "topological-depth");
  svg.setAttribute("data-conservation-gaps", String(intermediateGaps.length));
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
      "aria-label": `${linkedLabel(dataset, link.source)} to ${linkedLabel(dataset, link.target)}: value ${formatNumber(amount)}`,
    }));
  });
  dataset.records.forEach((record, index) => {
    const position = positions.get(id(record, dataset));
    const inflow = value(record, "inflow", 0);
    const outflow = value(record, "outflow", 0);
    const balanceGap = value(record, "balanceGap", 0);
    const balanceLabel = inflow === 0
      ? `source · out ${formatNumber(outflow)}`
      : outflow === 0
        ? `sink · in ${formatNumber(inflow)}`
        : `in ${formatNumber(inflow)} · out ${formatNumber(outflow)}${Math.abs(balanceGap) > 1e-9 ? ` · gap ${balanceGap > 0 ? "+" : ""}${formatNumber(balanceGap)}` : ""}`;
    svg.append(element("rect", {
      x: position.x - 54,
      y: position.y,
      width: 108,
      height: 36,
      rx: 3,
      class: seriesClass(index),
      "data-balance-gap": balanceGap,
      "data-node-id": id(record, dataset),
    }));
    appendText(svg, position.x, position.y + 55, label(record, dataset), undefined, "middle");
    appendText(svg, position.x, position.y + 72, balanceLabel, "axis-label", "middle");
  });
}

function renderMechanism(root, dataset, selectedId, { selectedNodeId = null } = {}) {
  const layerField = role(dataset, "group", "layer");
  const stageField = role(dataset, "stage", "stage");
  const firstSeen = new Map();
  const recordsByLayer = new Map();
  dataset.records.forEach((record, index) => {
    const layer = String(record[layerField] ?? "Layer");
    if (!firstSeen.has(layer)) firstSeen.set(layer, index);
    const records = recordsByLayer.get(layer) ?? [];
    records.push(record);
    recordsByLayer.set(layer, records);
  });
  const layers = [...recordsByLayer.keys()].sort((left, right) => {
    const stage = (layer) => {
      const declared = Math.min(...recordsByLayer.get(layer).map((record) => {
        const value = Number(record[stageField]);
        return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
      }));
      if (Number.isFinite(declared)) return declared;
      const numbered = /^Stage\s+(\d+)$/iu.exec(layer);
      return numbered ? Number(numbered[1]) - 1 : Number.POSITIVE_INFINITY;
    };
    const leftStage = stage(left);
    const rightStage = stage(right);
    if (leftStage !== rightStage) return leftStage - rightStage;
    return firstSeen.get(left) - firstSeen.get(right);
  });
  const top = 86;
  const rowGap = 82;
  const nodeHeight = 58;
  const dense = dataset.links.length >= 12 || dataset.records.length >= 12;
  const maximumRows = Math.max(1, ...layers.map((layer) => recordsByLayer.get(layer).length));
  const wrappedGrid = layers.length === 1 && maximumRows > 7;
  const gridColumns = wrappedGrid ? Math.min(4, Math.ceil(maximumRows / 6)) : 1;
  const gridRows = wrappedGrid ? Math.ceil(maximumRows / gridColumns) : maximumRows;
  const height = Math.max(HEIGHT, top + (gridRows - 1) * rowGap + nodeHeight + 64);
  const verticalCenter = top + ((maximumRows - 1) * rowGap) / 2;
  const horizontalGap = layers.length > 1 ? 736 / (layers.length - 1) : 0;
  const nodeWidth = Math.min(168, Math.max(112, horizontalGap ? horizontalGap - 34 : 168));
  const positions = new Map();
  layers.forEach((layer, layerIndex) => {
    const records = recordsByLayer.get(layer);
    if (wrappedGrid) {
      const gridGap = 736 / Math.max(gridColumns - 1, 1);
      records.forEach((record, recordIndex) => {
        positions.set(id(record, dataset), {
          x: gridColumns === 1 ? WIDTH / 2 : 112 + (recordIndex % gridColumns) * gridGap,
          y: top + Math.floor(recordIndex / gridColumns) * rowGap,
          layer,
        });
      });
      return;
    }
    const layerTop = verticalCenter - ((records.length - 1) * rowGap) / 2;
    records.forEach((record, recordIndex) => {
      positions.set(id(record, dataset), {
        x: layers.length === 1 ? WIDTH / 2 : 112 + layerIndex * horizontalGap,
        y: layerTop + recordIndex * rowGap,
        layer,
      });
    });
  });
  const svg = canvas(root, dataset.title, `An evidence flowchart with ${dataset.records.length} named components and ${dataset.links.length} typed links. Dependency layers read from left to right; feedback links route around their layer. Position shows reading order, not causal strength.`, height);
  svg.setAttribute("data-layout", "evidence-flowchart");
  svg.setAttribute("class", "mechanism-canvas");
  svg.setAttribute("data-reading-order", layers.length > 1 ? "left-to-right" : "within-layer");
  svg.setAttribute("data-density-treatment", dense ? "focus-and-context" : "always-labelled");
  svg.setAttribute("data-cycle-layout", wrappedGrid ? "wrapped-grid" : "layer-rails");
  const marker = element("marker", { id: `arrow-${chartCounter}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
  marker.append(element("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "arrow-head" }));
  const defs = element("defs");
  defs.append(marker);
  svg.append(defs);
  layers.forEach((layer, index) => {
    const x = layers.length === 1 ? WIDTH / 2 : 112 + index * horizontalGap;
    appendText(svg, x, 34, layer, "mechanism-layer-label", "middle");
    if (!wrappedGrid) {
      svg.append(element("line", {
        x1: x,
        x2: x,
        y1: 50,
        y2: height - 22,
        class: "mechanism-layer-guide",
      }));
    }
  });
  const selectedMarks = new Set(Array.isArray(selectedId) ? selectedId.map(String) : [String(selectedId ?? "")]);
  const selectedNode = selectedNodeId === null ? null : String(selectedNodeId);
  const relatedNodeIds = new Set(selectedNode ? [selectedNode] : []);
  if (selectedNode) {
    dataset.links.forEach((link) => {
      if (String(link.source) === selectedNode || String(link.target) === selectedNode) {
        relatedNodeIds.add(String(link.source));
        relatedNodeIds.add(String(link.target));
      }
    });
  }
  dataset.links.forEach((link, linkIndex) => {
    const source = positions.get(String(link.source));
    const target = positions.get(String(link.target));
    if (!source || !target) return;
    const markId = String(link.id);
    const sameLayer = source.layer === target.layer;
    const sourceY = source.y + nodeHeight / 2;
    const targetY = target.y + nodeHeight / 2;
    let path;
    let labelX;
    let labelY;
    let labelAnchor = "middle";
    if (sameLayer) {
      const rightRail = linkIndex % 2 === 0;
      const railOffset = nodeWidth / 2 + 18 + (linkIndex % 4) * 9;
      const railX = wrappedGrid
        ? rightRail ? WIDTH - railOffset + nodeWidth / 2 : railOffset - nodeWidth / 2
        : source.x + (rightRail ? railOffset : -railOffset);
      const edgeX = rightRail ? nodeWidth / 2 : -nodeWidth / 2;
      path = `M${source.x + edgeX},${sourceY} C${railX},${sourceY} ${railX},${targetY} ${target.x + edgeX},${targetY}`;
      labelX = rightRail ? railX - 8 : railX + 8;
      labelY = (sourceY + targetY) / 2;
      labelAnchor = rightRail ? "end" : "start";
    } else {
      const direction = target.x >= source.x ? 1 : -1;
      const sourceX = source.x + direction * nodeWidth / 2;
      const targetX = target.x - direction * nodeWidth / 2;
      const middleX = (sourceX + targetX) / 2;
      path = `M${sourceX},${sourceY} C${middleX},${sourceY} ${middleX},${targetY} ${targetX},${targetY}`;
      labelX = middleX;
      labelY = (sourceY + targetY) / 2;
    }
    const related = selectedNode !== null && (
      String(link.source) === selectedNode || String(link.target) === selectedNode
    );
    const selected = selectedMarks.has(markId);
    const relationship = element("g", {
      class: `mechanism-relationship${related ? " is-related" : ""}${selectedNode !== null && !related ? " is-muted" : ""}${selected ? " is-selected" : ""}${!dense || (selected && selectedNode === null) ? " show-label" : ""}`,
      "data-mark-id": markId,
      "data-route": sameLayer ? "same-layer-rail" : "cross-layer",
      "aria-label": `${linkedLabel(dataset, link.source)} ${String(link.type ?? "connects")} ${linkedLabel(dataset, link.target)}`,
    });
    relationship.append(element("title", {}, `${linkedLabel(dataset, link.source)} ${String(link.type ?? "connects")} ${linkedLabel(dataset, link.target)}`));
    relationship.append(element("path", {
      d: path,
      class: "mechanism-link-hit",
      fill: "none",
      stroke: "transparent",
      "stroke-width": 14,
    }));
    relationship.append(element("path", {
      d: path,
      class: markClass(markId, selectedId, "mechanism-link"),
      "marker-end": `url(#arrow-${chartCounter})`,
    }));
    const relation = String(link.type ?? "connects");
    const relationLines = wrappedLabelLines(relation, 25, 2);
    const longestLine = Math.max(...relationLines.map((line) => line.length));
    const labelWidth = Math.min(176, longestLine * 6.2 + 14);
    const labelHeight = relationLines.length * 14 + 8;
    const labelLeft = labelAnchor === "start"
      ? labelX - 6
      : labelAnchor === "end" ? labelX - labelWidth + 6 : labelX - labelWidth / 2;
    relationship.append(element("rect", {
      x: labelLeft,
      y: labelY - labelHeight / 2,
      width: labelWidth,
      height: labelHeight,
      rx: 4,
      class: "mechanism-link-label-bg",
      opacity: 0,
    }));
    const relationLabel = appendWrappedText(relationship, {
      x: labelX,
      centerY: labelY,
      text: relation,
      maximumCharacters: 25,
      className: "mechanism-link-label",
      anchor: labelAnchor,
    });
    relationLabel.node.setAttribute("opacity", 0);
    svg.append(relationship);
  });
  dataset.records.forEach((record) => {
    const position = positions.get(id(record, dataset));
    const nodeId = id(record, dataset);
    const relationCount = dataset.links.filter(
      (link) => String(link.source) === nodeId || String(link.target) === nodeId,
    ).length;
    const node = element("g", {
      class: `mechanism-node${selectedNode === nodeId ? " is-selected" : ""}${selectedNode !== null && !relatedNodeIds.has(nodeId) ? " is-muted" : ""}`,
      "data-node-id": nodeId,
      "aria-label": `${label(record, dataset)}${record.cyclic ? ", feedback" : ""} component with ${countLabel(relationCount, "connected relationship")}`,
    });
    node.append(element("rect", {
      x: position.x - nodeWidth / 2,
      y: position.y,
      width: nodeWidth,
      height: nodeHeight,
      rx: 8,
      class: "mechanism-node-card",
    }));
    appendWrappedText(node, {
      x: position.x,
      centerY: position.y + nodeHeight / 2,
      text: label(record, dataset),
      maximumCharacters: Math.max(13, Math.floor(nodeWidth / 7.2)),
      className: "mechanism-node-label",
    });
    if (record.cyclic) appendText(node, position.x + nodeWidth / 2 - 11, position.y + 15, "↺", "mechanism-feedback-badge", "middle");
    svg.append(node);
  });
}

let usGeographyPromise;
let worldGeographyPromise;

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

async function loadWorldGeography() {
  worldGeographyPromise ??= fetch("./vendor/world-countries.json").then(async (response) => {
    if (!response.ok) throw new Error("World geography failed to load");
    const topology = await response.json();
    return globalThis.topojson.feature(topology, topology.objects.land);
  });
  return worldGeographyPromise;
}

function geographyFailure(root, message) {
  root.replaceChildren();
  const notice = htmlElement("div", "aggregate-message");
  notice.append(htmlElement("strong", undefined, "Geography view abstained"), htmlElement("p", undefined, message));
  root.append(notice);
}

async function renderRegionMap(root, dataset, selectedId) {
  try {
    const d3 = globalThis.d3;
    const { states } = await loadUsGeography();
    const featureCollection = { type: "FeatureCollection", features: states };
    const projection = d3.geoAlbersUsa().fitExtent([[45, 30], [910, 360]], featureCollection);
    const path = d3.geoPath(projection);
    const regionField = role(dataset, "region", "geoId");
    const regionLabelField = role(dataset, "regionLabel", "stateId");
    const stateFeatureIds = new Set(states.map((feature) => String(feature.id).padStart(2, "0")));
    const unsupported = dataset.records
      .map((record) => String(record[regionField]).padStart(2, "0"))
      .filter((featureId) => !stateFeatureIds.has(featureId));
    if (unsupported.length) {
      throw new Error(`Only bundled US state feature IDs are supported in this release; unsupported IDs: ${[...new Set(unsupported)].join(", ")}.`);
    }
    const recordById = new Map(dataset.records.map((record) => [String(record[regionField]).padStart(2, "0"), record]));
    const valueField = role(dataset, "value", "value");
    const baselineField = role(dataset, "baseline", "baseline");
    const observed = observedDomain(dataset.records.map((record) => numericValue(record, valueField)));
    const svg = canvas(
      root,
      dataset.title,
      `A United States choropleth with ${dataset.records.length} observed regions. Normalized values span ${formatNumber(observed[0] * 100)}% to ${formatNumber(observed[1] * 100)}% and use five fixed equal intervals from 0% to 100%. Unobserved regions retain the no-data fill. Boundaries: us-atlas 3.0.1 states-10m.`,
    );
    svg.setAttribute("data-classification", "five-equal-intervals-0-1");
    svg.setAttribute("data-boundary-version", "us-atlas-3.0.1-states-10m");
    svg.setAttribute("data-observed-range", `${observed[0]},${observed[1]}`);
    states.forEach((feature) => {
      const featureId = String(feature.id).padStart(2, "0");
      const record = recordById.get(featureId);
      const measured = record ? value(record, valueField) : null;
      const level = record ? Math.min(5, Math.floor(measured * 5) + 1) : 0;
      const markId = record ? id(record, dataset) : null;
      svg.append(element("path", {
        d: path(feature),
        class: record ? markClass(markId, selectedId, `map-region level-${level}`) : "map-land",
        ...(markId ? {
          "data-mark-id": markId,
          "aria-label": `${label(record, dataset)}: ${formatNumber(measured * 100)}%; denominator ${formatNumber(value(record, baselineField))}`,
        } : {}),
      }));
      if (record) {
        const centroid = path.centroid(feature);
        appendText(svg, centroid[0], centroid[1] + 4, record[regionLabelField] ?? label(record, dataset), "map-label", "middle");
      }
    });
    const legendX = 420;
    const legendY = 390;
    appendText(svg, 45, legendY + 12, `Observed ${formatNumber(observed[0] * 100)}%–${formatNumber(observed[1] * 100)}%`, "axis-label");
    for (let index = 0; index < 5; index += 1) {
      const x = legendX + index * 78;
      svg.append(element("rect", { x, y: legendY, width: 18, height: 14, class: `map-region level-${index + 1}` }));
      appendText(svg, x + 23, legendY + 12, `${index * 20}–${(index + 1) * 20}%`, "axis-label");
    }
    svg.append(element("rect", { x: 810, y: 420, width: 18, height: 14, class: "map-land" }));
    appendText(svg, 833, 432, "No data", "axis-label");
    appendText(svg, 45, 432, "US state boundaries · us-atlas 3.0.1", "axis-label");
  } catch (error) {
    geographyFailure(root, error.message);
  }
}

async function renderPointMap(root, dataset, selectedId) {
  try {
    const d3 = globalThis.d3;
    const worldLand = await loadWorldGeography();
    const latitudeField = role(dataset, "latitude", "latitude");
    const longitudeField = role(dataset, "longitude", "longitude");
    const points = dataset.records.map((record) => {
      const latitude = Number(record[latitudeField]);
      const longitude = Number(record[longitudeField]);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new Error("Point map abstained: every point needs a finite latitude between -90 and 90 and longitude between -180 and 180.");
      }
      return { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [longitude, latitude] } };
    });
    if (!points.length) throw new Error("Point map abstained: no bounded latitude/longitude records were supplied.");
    const projection = d3.geoNaturalEarth1().fitExtent([[35, 24], [925, 410]], { type: "Sphere" });
    const path = d3.geoPath(projection);
    const valueField = role(dataset, "value", "value");
    const magnitudes = dataset.records.map((record) => numericValue(record, valueField));
    const svg = canvas(
      root,
      dataset.title,
      `${countLabel(dataset.records.length, "exact point record")} on one fixed Natural Earth world projection. Every observation uses the same visible mark size; optional values remain available in evidence but do not change this exact-point design.`,
    );
    svg.setAttribute("data-projection", "natural-earth-1-world");
    svg.setAttribute("data-size-encoding", "constant");
    svg.append(element("path", { d: path(worldLand), class: "map-land" }));
    dataset.records.forEach((record, index) => {
      const point = projection([
        Number(record[longitudeField]),
        Number(record[latitudeField]),
      ]);
      if (!point?.every(Number.isFinite)) return;
      const markId = id(record, dataset);
      const magnitude = magnitudes[index];
      const pointLabel = Number.isFinite(magnitude)
        ? `${label(record, dataset)}: ${formatNumber(Number(record[latitudeField]))}, ${formatNumber(Number(record[longitudeField]))}; supplied value ${formatNumber(magnitude)} is not size-encoded`
        : `${label(record, dataset)}: ${formatNumber(Number(record[latitudeField]))}, ${formatNumber(Number(record[longitudeField]))}`;
      svg.append(element("circle", {
        cx: point[0],
        cy: point[1],
        r: 7,
        class: markClass(markId, selectedId, "map-point"),
        "data-mark-id": markId,
        "aria-label": pointLabel,
      }));
      if (dataset.records.length <= 12 || isSelected(markId, selectedId)) {
        appendText(svg, point[0] + 12, point[1] - 9, label(record, dataset), "map-label");
      }
    });
    appendText(svg, 45, 438, "Natural Earth projection · world-atlas 2.0.2 · equal-size exact points", "axis-label");
  } catch (error) {
    geographyFailure(root, error.message);
  }
}

function renderField(root, dataset, selectedId) {
  const records = dataset.records;
  const xField = role(dataset, "x", "x");
  const yField = role(dataset, "y", "y");
  const valueField = role(dataset, "value", "value");
  const xs = [...new Set(records.map((record) => numericValue(record, xField)))].sort((a, b) => a - b);
  const ys = [...new Set(records.map((record) => numericValue(record, yField)))].sort((a, b) => a - b);
  const values = records.map((record) => numericValue(record, valueField));
  const valueDomain = observedDomain(values);
  const left = 155;
  const top = 38;
  const cellWidth = 720 / xs.length;
  const cellHeight = 330 / ys.length;
  const svg = canvas(
    root,
    dataset.title,
    `A ${ys.length} by ${xs.length} raster of supplied samples. The observed value range is ${formatNumber(valueDomain[0])} to ${formatNumber(valueDomain[1])}; unsupplied cells remain blank.`,
  );
  records.forEach((record) => {
    const markId = id(record, dataset);
    const xValue = numericValue(record, xField);
    const yValue = numericValue(record, yField);
    const measuredValue = numericValue(record, valueField);
    const column = xs.indexOf(xValue);
    const row = ys.indexOf(yValue);
    const normalized = valueDomain[0] === valueDomain[1]
      ? 0.5
      : (measuredValue - valueDomain[0]) / (valueDomain[1] - valueDomain[0]);
    const level = Math.max(1, Math.min(5, Math.floor(normalized * 5) + 1));
    svg.append(element("rect", {
      x: left + column * cellWidth + 1,
      y: top + row * cellHeight + 1,
      width: cellWidth - 2,
      height: cellHeight - 2,
      class: markClass(markId, selectedId, `field-cell level-${level}`),
      "data-mark-id": markId,
      "aria-label": `${label(record, dataset)}: x ${formatNumber(xValue)}, y ${formatNumber(yValue)}, value ${formatNumber(measuredValue)}`,
    }));
  });
  xs.forEach((coordinate, index) => appendText(svg, left + index * cellWidth + cellWidth / 2, 395, formatNumber(coordinate), "axis-label", "middle"));
  ys.forEach((coordinate, index) => appendText(svg, left - 14, top + index * cellHeight + cellHeight / 2 + 4, formatNumber(coordinate), undefined, "end"));
  appendText(svg, 875, 424, xField, "axis-label", "end");
  appendText(svg, 104, 25, yField, "axis-label", "middle");
  appendText(svg, 155, 424, `Value ${formatNumber(valueDomain[0])} to ${formatNumber(valueDomain[1])}`, "axis-label");
}

function safePreviewUrl(preview) {
  const source = preview?.poster ?? preview?.src;
  if (typeof source !== "string" || source.length === 0 || /[\u0000-\u001f\u007f]/u.test(source)) return null;
  if (/^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/=]+$/iu.test(source)) return source;
  if (source.includes("\\") || source.startsWith("//") || source.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(source)) return null;
  const path = source.split(/[?#]/u, 1)[0].replaceAll("\\", "/");
  if (!path || path.split("/").includes("..")) return null;
  return source;
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
  const preview = dataset.specimen?.preview;
  const previewUrl = safePreviewUrl(preview);
  const description = previewUrl
    ? `${preview?.alt ?? "The supplied specimen preview"} with ${countLabel(dataset.records.length, "evidence-bearing normalized annotation")}.`
    : `No renderable specimen preview was supplied. ${countLabel(dataset.records.length, "evidence-bearing normalized annotation")} remain positioned on a neutral coordinate frame; no specimen features are fabricated.`;
  const svg = canvas(root, dataset.title, description);
  svg.setAttribute("data-preview-state", previewUrl ? "supplied" : "unavailable");
  svg.append(element("rect", { x: imageX, y: imageY, width: imageWidth, height: imageHeight, class: "specimen-ground" }));
  if (previewUrl) {
    svg.append(element("image", {
      x: imageX,
      y: imageY,
      width: imageWidth,
      height: imageHeight,
      href: previewUrl,
      preserveAspectRatio: "xMidYMid meet",
      "aria-label": preview?.alt ?? "Supplied specimen preview",
    }));
  } else {
    appendText(svg, WIDTH / 2, imageY + imageHeight / 2 - 8, "Specimen preview unavailable", "axis-label", "middle");
    appendText(svg, WIDTH / 2, imageY + imageHeight / 2 + 16, "Annotations use supplied normalized coordinates on a neutral frame.", "axis-label", "middle");
  }
  [...dataset.records]
    .sort((left, right) => value(right, role(dataset, "width", "width")) * value(right, role(dataset, "height", "height")) - value(left, role(dataset, "width", "width")) * value(left, role(dataset, "height", "height")))
    .forEach((record) => {
    const markId = id(record, dataset);
    const x = imageX + value(record, role(dataset, "x", "x")) * imageWidth;
    const y = imageY + value(record, role(dataset, "y", "y")) * imageHeight;
    const width = Number(record[role(dataset, "width", "width")]);
    const height = Number(record[role(dataset, "height", "height")]);
    const attributes = {
      class: markClass(markId, selectedId, "annotation-region"),
      "data-mark-id": markId,
      "aria-label": label(record, dataset),
    };
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      svg.append(element("rect", {
        ...attributes,
        x,
        y,
        width: width * imageWidth,
        height: height * imageHeight,
      }));
    } else {
      // Width/height are optional in the catalog schema. A required-only
      // annotation still needs a visible, selectable evidence anchor.
      svg.append(element("circle", {
        ...attributes,
        cx: x,
        cy: y,
        r: 8,
        class: markClass(markId, selectedId, "annotation-anchor"),
      }));
    }
    });
}

function renderCollectionAtlas(root, dataset, selectedId) {
  const categoryField = role(dataset, "category", "category");
  const mediaTypeField = role(dataset, "mediaType", "mediaType");
  const categories = [...new Set(dataset.records.map((record) => String(record[categoryField] ?? "Uncategorized")))];
  const tileWidth = 104;
  const tileHeight = 42;
  const columnGap = 10;
  const rowGap = 22;
  const columns = Math.max(1, Math.floor((WIDTH - 90 + columnGap) / (tileWidth + columnGap)));
  const facets = categories.map((category) => {
    const group = dataset.records
      .filter((record) => String(record[categoryField] ?? "Uncategorized") === category)
      .map((record, index) => ({ record, index }))
      .sort((left, right) => {
        const leftOrder = numericValue(left.record, "order");
        const rightOrder = numericValue(right.record, "order");
        if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.index - right.index;
      })
      .map(({ record }) => record);
    return { category, records: group, rows: Math.ceil(group.length / columns) };
  });
  const chartHeight = Math.max(HEIGHT, 28 + facets.reduce((height, facet) => height + 34 + facet.rows * (tileHeight + rowGap), 0));
  const svg = canvas(
    root,
    dataset.title,
    `A faceted atlas of ${countLabel(dataset.records.length, "item")} in ${countLabel(facets.length, "observed category")}. Every item uses the same tile size; facet names and counts precede their items.`,
    chartHeight,
  );
  svg.setAttribute("data-layout", "faceted-strips");
  let facetTop = 26;
  facets.forEach((facet, facetIndex) => {
    appendText(svg, 45, facetTop, facet.category, "atlas-cluster-label");
    appendText(svg, 915, facetTop, countLabel(facet.records.length, "item"), "axis-label", "end");
    facet.records.forEach((record, recordIndex) => {
      const column = recordIndex % columns;
      const row = Math.floor(recordIndex / columns);
      const x = 45 + column * (tileWidth + columnGap);
      const y = facetTop + 16 + row * (tileHeight + rowGap);
      const markId = id(record, dataset);
      const mediaType = String(record[mediaTypeField] ?? "text");
      const className = markClass(markId, selectedId, seriesClass(facetIndex));
      svg.append(element("rect", {
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        rx: 2,
        class: className,
        "data-mark-id": markId,
        "aria-label": `${label(record, dataset)}; ${facet.category}; ${mediaType}`,
      }));
      const itemLabel = label(record, dataset);
      appendText(svg, x + tileWidth / 2, y + tileHeight + 14, itemLabel.length > 18 ? `${itemLabel.slice(0, 17)}…` : itemLabel, "atlas-item-label", "middle");
    });
    facetTop += 34 + facet.rows * (tileHeight + rowGap);
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

function inspectionLabel(index, target) {
  const key = inspectionTargetKey(target);
  return index.entries.find((entry) => inspectionTargetKey(entry.target) === key)?.label ?? null;
}

function decorateSelectableMarks(root, {
  inspectionIndex,
  selectedIds = [],
  selectableMarkIds,
  onSelect,
} = {}) {
  const allowed = Array.isArray(selectableMarkIds) ? new Set(selectableMarkIds.map(String)) : null;
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds.map(String) : []);
  for (const mark of root.querySelectorAll("[data-mark-id]")) {
    const markId = String(mark.getAttribute("data-mark-id") ?? "");
    if (!markId || (allowed && !allowed.has(markId))) {
      mark.removeAttribute("data-mark-id");
      mark.removeAttribute("tabindex");
      mark.removeAttribute("role");
      mark.removeAttribute("aria-pressed");
      continue;
    }
    mark.setAttribute("tabindex", "-1");
    mark.setAttribute("role", "button");
    mark.setAttribute("aria-pressed", String(selected.has(markId)));
    if (!mark.getAttribute("aria-label")) {
      mark.setAttribute(
        "aria-label",
        inspectionLabel(inspectionIndex, { kind: "mark", markId }) ?? markId,
      );
    }
    mark.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (typeof onSelect === "function") onSelect(markId, event);
      else mark.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: globalThis.window }));
    });
    if (typeof onSelect === "function") mark.addEventListener("click", () => onSelect(markId));
  }
}

function decorateSelectableNodes(root, {
  dataset,
  inspectionIndex,
  selectedNodeId = null,
  selectableMarkIds,
  onSelect,
} = {}) {
  const allowed = new Set(Array.isArray(selectableMarkIds) ? selectableMarkIds.map(String) : []);
  for (const node of root.querySelectorAll("[data-node-id]")) {
    const nodeId = String(node.getAttribute("data-node-id") ?? "");
    const relatedMarkIds = dataset.links
      .filter((link) => String(link.source) === nodeId || String(link.target) === nodeId)
      .map((link) => String(link.id))
      .filter((markId) => allowed.has(markId));
    if (!nodeId || relatedMarkIds.length === 0) {
      node.removeAttribute("data-node-id");
      continue;
    }
    if (relatedMarkIds.length > MAX_NODE_SELECTION_MARKS) {
      node.removeAttribute("data-node-id");
      node.setAttribute("data-inspection-node-id", nodeId);
      node.setAttribute("tabindex", "-1");
      node.setAttribute("role", "button");
      node.setAttribute(
        "aria-label",
        `${inspectionLabel(inspectionIndex, { kind: "node", nodeId }) ?? nodeId}, inspect context only`,
      );
      continue;
    }
    const selected = nodeId === String(selectedNodeId ?? "");
    const classNames = new Set(String(node.getAttribute("class") ?? "").split(/\s+/u).filter(Boolean));
    if (selected) classNames.add("is-selected");
    else classNames.delete("is-selected");
    node.setAttribute("class", [...classNames].join(" "));
    node.setAttribute("tabindex", "-1");
    node.setAttribute("role", "button");
    node.setAttribute("aria-pressed", String(selected));
    if (!node.getAttribute("aria-label")) {
      node.setAttribute(
        "aria-label",
        inspectionLabel(inspectionIndex, { kind: "node", nodeId }) ?? nodeId,
      );
    }
    const select = () => onSelect?.({ kind: "node", nodeId });
    node.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select();
    });
    node.addEventListener("click", select);
  }
}

function decorateRovingTargets(root) {
  const targets = [
    ...root.querySelectorAll("[data-mark-id]"),
    ...root.querySelectorAll("[data-node-id]"),
    ...root.querySelectorAll("[data-inspection-node-id]"),
  ];
  if (targets.length === 0) return;
  let activeIndex = Math.max(0, targets.findIndex((target) => target.getAttribute("aria-pressed") === "true"));

  function activate(index, moveFocus = false) {
    activeIndex = (index + targets.length) % targets.length;
    targets.forEach((target, targetIndex) => {
      target.setAttribute("tabindex", targetIndex === activeIndex ? "0" : "-1");
    });
    if (moveFocus) targets[activeIndex].focus();
  }

  targets.forEach((target, index) => {
    target.addEventListener("focus", () => activate(index));
    target.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") activate(0, true);
      else if (event.key === "End") activate(targets.length - 1, true);
      else activate(index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1), true);
    });
  });
  activate(activeIndex);
}

export async function renderFamily({
  root,
  dataset,
  selectedId = null,
  selectedIds = selectedId === null ? [] : [selectedId],
  selectableMarkIds,
  selectedNodeId = null,
  onSelect,
}) {
  if (!(root instanceof HTMLElement)) throw new TypeError("renderer root must be an HTMLElement");
  const renderer = RENDERERS[dataset?.familyId];
  if (!renderer) throw new Error(`No renderer registered for ${String(dataset?.familyId)}`);
  const activeSelectedIds = Array.isArray(selectedIds) ? selectedIds : [selectedIds];
  const activeSelectableMarkIds = Array.isArray(selectableMarkIds)
    ? selectableMarkIds
    : dataset.selectableMarkIds;
  const rendererSelection = activeSelectedIds.length > 0 ? activeSelectedIds : selectedId;
  await renderer(root, dataset, rendererSelection, { selectedNodeId });
  const inspectionIndex = buildVisualizationInspectionIndex(dataset, {
    selectableMarkIds: activeSelectableMarkIds,
  });
  decorateSelectableMarks(root, {
    inspectionIndex,
    selectedIds: activeSelectedIds,
    selectableMarkIds: activeSelectableMarkIds,
    onSelect,
  });
  decorateSelectableNodes(root, {
    dataset,
    inspectionIndex,
    selectedNodeId,
    selectableMarkIds: activeSelectableMarkIds,
    onSelect,
  });
  decorateRovingTargets(root);
  appendVisualizationInspector({
    root,
    dataset,
    index: inspectionIndex,
    selectedMarkIds: activeSelectedIds,
    selectedNodeId,
  });
  const renderedMarkIds = [...new Set(
    [...root.querySelectorAll("[data-mark-id]")]
      .map((mark) => mark.getAttribute("data-mark-id"))
      .filter(Boolean),
  )];
  return {
    familyId: dataset.familyId,
    markCount: renderedMarkIds.length,
    evidenceCount: evidenceCount(dataset),
    selectableMarkIds: renderedMarkIds,
    selectableNodeIds: [...root.querySelectorAll("[data-node-id]")].map((node) => node.getAttribute("data-node-id")),
  };
}
