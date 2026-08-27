import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const directory = new URL("./", import.meta.url);
const mode = process.argv[2] === "observer" ? "observer" : "current";
const output = resolve(process.argv[3] ?? `.context/attend-architecture/system-atlas-${mode}.svg`);
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(await readFile(new URL("data.js", directory), "utf8"), sandbox);
const model = sandbox.window.ATTEND_SYSTEM;
const modules = model.modules.filter((module) => mode !== "current" || module.status !== "proposed")
  .sort((left, right) => (left.x + left.y) - (right.x + right.y));
const byId = Object.fromEntries(modules.map((module) => [module.id, module]));

function point(x, y, z = 0) {
  return { x: 430 + (x - y) * 32, y: 48 + (x + y) * 25 - z };
}

function points(values) {
  return values.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

function escape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function district({ x, y, w, d, label, proposed = false }) {
  const corners = [point(x, y), point(x + w, y), point(x + w, y + d), point(x, y + d)];
  const labelPoint = point(x + .12, y + d + .16);
  return `<g class="district${proposed ? " proposed" : ""}"><polygon points="${points(corners)}"/><text x="${labelPoint.x}" y="${labelPoint.y}">${escape(label)}</text></g>`;
}

function edgePath(from, to, route) {
  const fc = { x: from.x + from.w / 2, y: from.y + from.d / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.d / 2 };
  const dx = tc.x - fc.x;
  const dy = tc.y - fc.y;
  const overlapX = Math.min(from.x + from.w, to.x + to.w) - Math.max(from.x, to.x);
  const overlapY = Math.min(from.y + from.d, to.y + to.d) - Math.max(from.y, to.y);
  let world = null;
  if (overlapY > 0 && overlapX <= 0) {
    const y = (Math.max(from.y, to.y) + Math.min(from.y + from.d, to.y + to.d)) / 2;
    world = [{ x: dx >= 0 ? from.x + from.w : from.x, y }, { x: dx >= 0 ? to.x : to.x + to.w, y }];
  } else if (overlapX > 0 && overlapY <= 0) {
    const x = (Math.max(from.x, to.x) + Math.min(from.x + from.w, to.x + to.w)) / 2;
    world = [{ x, y: dy >= 0 ? from.y + from.d : from.y }, { x, y: dy >= 0 ? to.y : to.y + to.d }];
  }
  const yFirst = ["experiment", "host", "observe", "impact"].includes(route);
  if (!world && yFirst) {
    world = [
      { x: fc.x, y: dy >= 0 ? from.y + from.d : from.y },
      { x: fc.x, y: tc.y },
      { x: dx >= 0 ? to.x : to.x + to.w, y: tc.y },
    ];
  } else if (!world) {
    world = [
      { x: dx >= 0 ? from.x + from.w : from.x, y: fc.y },
      { x: tc.x, y: fc.y },
      { x: tc.x, y: dy >= 0 ? to.y : to.y + to.d },
    ];
  }
  return world.map(({ x, y }, index) => {
    const projected = point(x, y, 4);
    return `${index ? "L" : "M"}${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
  }).join(" ");
}

function moduleShape(module) {
  const base = [point(module.x, module.y), point(module.x + module.w, module.y), point(module.x + module.w, module.y + module.d), point(module.x, module.y + module.d)];
  const top = [point(module.x, module.y, module.h), point(module.x + module.w, module.y, module.h), point(module.x + module.w, module.y + module.d, module.h), point(module.x, module.y + module.d, module.h)];
  const center = point(module.x + module.w / 2, module.y + module.d / 2, module.h + 8);
  const words = module.name.toUpperCase().split(/\s+/);
  const splitAt = words.length > 3 ? Math.ceil(words.length / 2) : words.length;
  const lines = [words.slice(0, splitAt).join(" "), words.slice(splitAt).join(" ")].filter(Boolean);
  const stackLines = [];
  for (let index = 1; index < (module.stack || 1); index += 1) {
    const z = (module.h / (module.stack + 1)) * index;
    const a = point(module.x + module.w, module.y, z);
    const b = point(module.x + module.w, module.y + module.d, z);
    const c = point(module.x, module.y + module.d, z);
    stackLines.push(`<path class="stack" d="M${a.x},${a.y}L${b.x},${b.y}L${c.x},${c.y}"/>`);
  }
  return `<g class="module ${module.status === "proposed" ? "proposed" : ""}">
    <polygon class="side" points="${points([top[1], top[2], base[2], base[1]])}"/>
    <polygon class="side" points="${points([top[2], top[3], base[3], base[2]])}"/>
    <polygon class="top" points="${points(top)}"/>
    ${stackLines.join("")}
    <text class="code" x="${center.x}" y="${center.y - 5}">${escape(module.code)}</text>
    <text class="name" x="${center.x}" y="${center.y + 10}">${lines.map((line, index) => `<tspan x="${center.x}" dy="${index ? 10 : 0}">${escape(line)}</tspan>`).join("")}</text>
  </g>`;
}

const districts = [
  district({ x: .3, y: .3, w: 4.6, d: 3.1, label: "HOST INVOCATION BOUNDARY" }),
  district({ x: 4.65, y: .25, w: 7.65, d: 6.55, label: "GOVERNED COMPILATION" }),
  district({ x: 1.45, y: 6.25, w: 9.5, d: 3.35, label: "PROJECT-LOCAL VIEW + SESSION RUNTIME" }),
  district({ x: .25, y: 9.25, w: 9.25, d: 3.15, label: "REACTIVE QUESTION ROUTES" }),
  mode === "observer" ? district({ x: 11.7, y: .65, w: 3.55, d: 9.25, label: "PROPOSED OBSERVER + IMPACT PROTOCOL", proposed: true }) : "",
].join("");

const edges = model.edges.filter(({ from, to }) => byId[from] && byId[to]).map((edge) =>
  `<path class="edge ${edge.proposed ? "proposed" : ""} ${edge.route === "question" ? "strong" : ""} ${mode === "observer" && edge.route !== "observe" ? "dim" : ""} ${mode === "observer" && edge.route === "observe" ? "lit" : ""}" d="${edgePath(byId[edge.from], byId[edge.to], edge.route)}" marker-end="url(#arrow)"/>`).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 720" width="1120" height="720">
  <title>Attend ${mode} system atlas</title>
  <defs>
    <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 1H4"/></pattern>
    <pattern id="planned" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><path d="M0 0V7"/></pattern>
    <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z"/></marker>
  </defs>
  <style>
    svg{background:#cec69c;color:#171713;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .grid{stroke:#171713;stroke-width:.6;opacity:.09}.district polygon{fill:#d8d0aa20;stroke:#171713;stroke-width:1}.district text{fill:#6f6a53;font-size:8px;letter-spacing:1.4px}.district.proposed polygon{stroke-dasharray:4 4}
    .edge{fill:none;stroke:#171713;stroke-width:1.2;opacity:.52}.edge.strong{stroke-width:2.4}.edge.proposed{stroke-dasharray:5 5}.edge.dim{opacity:.06}.edge.lit{stroke-width:2.2;opacity:.9}
    .module polygon{stroke:#171713;stroke-width:1.2}.module .top{fill:#d8d0aa}.module .side{fill:url(#hatch)}.module.proposed polygon{stroke-dasharray:5 4}.module.proposed .top{fill:url(#planned)}
    .stack{fill:none;stroke:#171713;stroke-width:1}.code{font-size:10px;font-weight:700;text-anchor:middle}.name{font-size:6.7px;text-anchor:middle;letter-spacing:.4px}
  </style>
  <g>${Array.from({ length: 18 }, (_, index) => { const a = point(index - 1, -.5); const b = point(index - 1, 13.5); return `<line class="grid" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`; }).join("")}${Array.from({ length: 16 }, (_, index) => { const a = point(-.5, index - 1); const b = point(15.5, index - 1); return `<line class="grid" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`; }).join("")}</g>
  ${districts}${edges}${modules.map(moduleShape).join("")}
</svg>`;

await mkdir(dirname(output), { recursive: true });
await writeFile(output, svg);
process.stdout.write(`${output}\n`);
