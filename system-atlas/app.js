(function () {
  "use strict";

  const D = window.ATTEND_SYSTEM;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const W = 1240;
  const H = 760;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = document.querySelector("#frame");
  const metrics = document.querySelector("#metrics");
  const views = document.querySelector("#views");
  const modulesById = Object.fromEntries(D.modules.map((module) => [module.id, module]));
  const componentsById = Object.fromEntries(D.components.map((component) => [component.id, component]));

  const VIEW_MODES = [
    ["current", "Current runtime"],
    ["observer", "Observer proposal"],
    ["impact", "Impact model"],
  ];

  const DEFAULT_CAMERA = Object.freeze({ x: -45, y: 8, zoom: .9 });

  let camera = { ...DEFAULT_CAMERA };
  let drawerOpen = true;
  let inspectorTab = "explain";
  let activeTraceId = "direct";
  let traceStep = -1;
  let flowRunning = false;
  let activeQuestionId = null;
  let raf = null;

  validateModel();

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseHash() {
    const [rawMode, rawSelection] = location.hash.replace(/^#/, "").split("/");
    const mode = VIEW_MODES.some(([id]) => id === rawMode) ? rawMode : "current";
    const selection = modulesById[rawSelection] ? rawSelection : null;
    return { mode, selection };
  }

  function setHash(mode, selection = null) {
    const next = `#${mode}${selection ? `/${selection}` : ""}`;
    if (location.hash === next) render();
    else location.hash = next;
  }

  function validateModel() {
    const owners = new Map();
    const componentIds = new Set(D.components.map(({ id }) => id));
    const moduleIds = new Set(D.modules.map(({ id }) => id));
    for (const module of D.modules) {
      for (const componentId of module.members) {
        if (!componentIds.has(componentId)) throw new Error(`${module.id} names unknown component ${componentId}`);
        if (owners.has(componentId)) throw new Error(`${componentId} belongs to two modules`);
        owners.set(componentId, module.id);
      }
    }
    const unowned = D.components.filter(({ id }) => !owners.has(id));
    if (unowned.length) throw new Error(`Unowned components: ${unowned.map(({ id }) => id).join(", ")}`);
    for (const edge of D.edges) {
      if (!moduleIds.has(edge.from) || !moduleIds.has(edge.to)) throw new Error(`Edge ${edge.id} has an unknown endpoint`);
    }
    for (const trace of D.traces) {
      for (const step of trace.steps) if (!moduleIds.has(step)) throw new Error(`Trace ${trace.id} names unknown module ${step}`);
    }
  }

  function renderChrome(mode) {
    metrics.innerHTML = `
      <div><span>Source modules</span><b>${D.meta.sourceModules}</b></div>
      <div><span>Mapped components</span><b>${D.meta.conceptualComponents}</b></div>
      <div><span>Response routes</span><b>${D.meta.responseRoutes}</b></div>
      <div><span>Active observers</span><b>${D.meta.activeObservers}</b></div>`;
    views.innerHTML = VIEW_MODES.map(([id, label]) =>
      `<button data-view="${id}" aria-current="${id === mode}">${esc(label)}</button>`).join("");
    views.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextMode = button.dataset.view;
        if (nextMode !== mode) {
          activeTraceId = nextMode === "current" ? "direct" : "observer";
          traceStep = -1;
        }
        setHash(nextMode);
      });
    });
  }

  function visibleModules(mode) {
    return D.modules.filter((module) => mode !== "current" || module.status !== "proposed");
  }

  function tracesForMode(mode) {
    return D.traces.filter((trace) => mode !== "current" || trace.id !== "observer");
  }

  function activeTrace(mode) {
    const available = tracesForMode(mode);
    let trace = available.find(({ id }) => id === activeTraceId);
    if (!trace) {
      trace = available[0];
      activeTraceId = trace.id;
      traceStep = -1;
    }
    return trace;
  }

  function render() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    const { mode, selection } = parseHash();
    const selected = selection ? modulesById[selection] : null;
    if (selected?.status === "proposed" && mode === "current") {
      setHash("observer", selection);
      return;
    }
    const trace = activeTrace(mode);
    renderChrome(mode);
    frame.dataset.drawerOpen = String(drawerOpen);
    frame.innerHTML = `
      <nav class="rail" id="rail" aria-label="Attend architecture modules"></nav>
      <section class="stage" id="stage" aria-label="Isometric Attend architecture map">
        <div class="map-controls" aria-label="Map controls">
          <button id="flowToggle">${flowRunning ? "Ⅱ PAUSE THE FLOW" : "▶ RESUME THE FLOW"}</button>
          <button id="traceStep">TRACE ONE STEP</button>
          <button id="resetMap">RESET VIEW</button>
        </div>
        <button class="inspector-peek" id="inspectorPeek">OPEN INSPECTOR</button>
        <div class="zoom-controls" aria-label="Zoom controls">
          <button id="zoomIn" aria-label="Zoom in">+</button>
          <button id="zoomOut" aria-label="Zoom out">−</button>
        </div>
        <div class="route-key" aria-label="Route legend">
          <span><i></i> build request</span>
          <span><i class="experiment"></i> experiment state</span>
          <span><i class="question"></i> sidebar question</span>
          <span><i class="host"></i> host-attached</span>
          ${mode !== "current" ? "<span><i class=\"observe\"></i> proposed</span>" : ""}
        </div>
        ${mode === "impact" ? impactLadder() : ""}
        <div class="hint">drag to pan · scroll to zoom · hover to isolate · click to inspect</div>
      </section>
      <aside class="drawer" id="drawer" aria-label="Architecture inspector">
        <div class="drawer-scroll" id="drawerScroll"></div>
      </aside>`;

    renderRail(mode, selected, trace);
    drawMap($("#stage"), { mode, selectedId: selected?.id || null, trace });
    bindControls(mode, trace);
    renderDrawer(selected, mode);
  }

  function renderRail(mode, selected, trace) {
    const rail = $("#rail");
    const phaseMarkup = D.phases.map((phase) => {
      const modules = visibleModules(mode).filter((module) => module.phase === phase.id);
      if (!modules.length) return "";
      return `<h2>${esc(phase.name)} <em>${esc(phase.note)}</em></h2>${modules.map((module) => `
        <button class="module-row ${module.status === "proposed" ? "proposed" : ""}"
          data-module="${module.id}" aria-current="${selected?.id === module.id}">
          <span class="row-code">${esc(module.code)}</span>
          <span>${esc(module.name)}</span>
          <span class="row-count">${module.members.length || "P"}</span>
        </button>`).join("")}`;
    }).join("");
    rail.innerHTML = `
      <div class="rail-title">Attend ${esc(D.meta.version)}</div>
      <div class="rail-subtitle">A governed compiler with a reactive viewer service.</div>
      ${phaseMarkup}
      <h2>Trace a route <em>${trace.steps.length} steps</em></h2>
      ${tracesForMode(mode).map((candidate) => `
        <button class="trace-row" data-trace="${candidate.id}" aria-current="${candidate.id === trace.id}">
          ${esc(candidate.name)}
        </button>`).join("")}
      <div class="rail-note"><b>${visibleModules(mode).length} modules on this plate</b><br>
        ${mode === "current" ? "No observer is running." : "Dashed structures are proposed, not shipped."}
      </div>`;
    rail.querySelectorAll("[data-module]").forEach((button) => {
      button.addEventListener("click", () => {
        drawerOpen = true;
        setHash(mode, button.dataset.module);
      });
    });
    rail.querySelectorAll("[data-trace]").forEach((button) => {
      button.addEventListener("click", () => {
        activeTraceId = button.dataset.trace;
        traceStep = -1;
        render();
      });
    });
  }

  function impactLadder() {
    return `<div class="impact-ladder" aria-label="Impact evidence ladder">${D.impactStates.map((state) => `
      <article>
        <span>${esc(state.current)}</span>
        <b>${esc(state.name)}</b>
        <p>${esc(state.meaning)}</p>
      </article>`).join("")}</div>`;
  }

  function svgEl(tag, attributes = {}, text = null) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text != null) node.textContent = text;
    return node;
  }

  function drawMap(stage, { mode, selectedId, trace }) {
    const modules = visibleModules(mode).sort((left, right) => (left.x + left.y) - (right.x + right.y));
    const visibleIds = new Set(modules.map(({ id }) => id));
    const svg = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-labelledby": "mapTitle mapDescription",
    });
    svg.append(
      svgEl("title", { id: "mapTitle" }, mode === "current" ? "Attend current runtime" : "Attend current runtime with proposed observer"),
      svgEl("desc", { id: "mapDescription" }, "An isometric map of Attend's host invocation, governed map compilation, visualization state, page service, and question response routes. Dashed structures are proposed observer and impact components."),
    );
    const defs = svgEl("defs");
    defs.innerHTML = `
      <pattern id="sideHatch" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 1H4"/></pattern>
      <pattern id="proposedHatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><path d="M0 0V7"/></pattern>
      <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L8 4L0 8Z"/></marker>`;
    svg.append(defs);
    const viewport = svgEl("g", { id: "systemViewport" });
    svg.append(viewport);
    stage.prepend(svg);

    drawIsoGrid(viewport);
    drawDistrict(viewport, { x: .3, y: .3, w: 4.6, d: 3.1, label: "HOST INVOCATION BOUNDARY", className: "entry" });
    drawDistrict(viewport, { x: 4.65, y: .25, w: 7.65, d: 6.55, label: "GOVERNED COMPILATION", className: "compile" });
    drawDistrict(viewport, { x: 1.45, y: 6.25, w: 9.5, d: 3.35, label: "PROJECT-LOCAL VIEW + SESSION RUNTIME", className: "runtime" });
    drawDistrict(viewport, { x: .25, y: 9.25, w: 9.25, d: 3.15, label: "REACTIVE QUESTION ROUTES", className: "answer" });
    if (mode !== "current") {
      drawDistrict(viewport, { x: 11.7, y: .65, w: 3.55, d: 9.25, label: "PROPOSED OBSERVER + IMPACT PROTOCOL", className: "proposed" });
    }

    const related = new Set(selectedId ? [selectedId] : []);
    for (const edge of D.edges) {
      if (edge.from === selectedId) related.add(edge.to);
      if (edge.to === selectedId) related.add(edge.from);
    }
    const tracePairs = new Set();
    for (let index = 0; index < trace.steps.length - 1; index += 1) {
      tracePairs.add(`${trace.steps[index]}→${trace.steps[index + 1]}`);
    }
    const impactModules = new Set(["host", "experiments", "viewer", "hostevents", "observer", "impact"]);
    const edgeElements = [];
    for (const edge of D.edges) {
      if (!visibleIds.has(edge.from) || !visibleIds.has(edge.to)) continue;
      const from = modulesById[edge.from];
      const to = modulesById[edge.to];
      const path = svgEl("path", {
        d: edgePath(from, to, edge),
        "marker-end": "url(#arrow)",
      });
      let className = `system-edge route-${edge.route}`;
      if (selectedId) className += edge.from === selectedId || edge.to === selectedId ? " lit" : " dim";
      if (mode === "observer") className += edge.route === "observe" ? " lit" : " mode-dim";
      if (mode === "impact") className += edge.route === "impact" ? " lit" : " mode-dim";
      if (traceStep >= 0) className += tracePairs.has(`${edge.from}→${edge.to}`) ? " trace-lit" : " mode-dim";
      const traceFrom = trace.steps[traceStep];
      const traceTo = trace.steps[traceStep + 1];
      if (edge.from === traceFrom && edge.to === traceTo) className += " tracing";
      path.setAttribute("class", className);
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      path.append(svgEl("title", {}, `${from.name} → ${to.name}: ${edge.label}`));
      viewport.append(path);
      edgeElements.push({ edge, path });
    }

    for (const module of modules) {
      const group = drawModule(viewport, module, {
        selected: module.id === selectedId,
        dim: !!selectedId && !related.has(module.id),
        modeDim: mode === "impact" && !impactModules.has(module.id),
        tracing: trace.steps[traceStep] === module.id,
      });
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", `${module.name}. ${module.purpose}`);
      const activate = (event) => {
        if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        if (svg.dataset.dragged === "true") return;
        drawerOpen = true;
        setHash(mode, module.id);
      };
      group.addEventListener("click", activate);
      group.addEventListener("keydown", activate);
      group.addEventListener("pointerenter", () => applyHover(svg, module.id));
      group.addEventListener("pointerleave", () => applyHover(svg, null));
      group.addEventListener("focus", () => applyHover(svg, module.id));
      group.addEventListener("blur", () => applyHover(svg, null));
    }

    if (!REDUCED) animateFlowDots(viewport, edgeElements, trace, selectedId);
    bindViewport(svg);
    updateCamera();
  }

  function applyHover(svg, moduleId) {
    const edges = [...svg.querySelectorAll(".system-edge")];
    const modules = [...svg.querySelectorAll(".system-module")];
    edges.forEach((edge) => edge.classList.remove("hover-lit", "hover-dim"));
    modules.forEach((module) => module.classList.remove("hover-lit", "hover-dim"));
    if (!moduleId) return;
    const related = new Set([moduleId]);
    edges.forEach((edge) => {
      const touches = edge.dataset.from === moduleId || edge.dataset.to === moduleId;
      edge.classList.add(touches ? "hover-lit" : "hover-dim");
      if (touches) related.add(edge.dataset.from === moduleId ? edge.dataset.to : edge.dataset.from);
    });
    modules.forEach((module) => module.classList.add(related.has(module.dataset.module) ? "hover-lit" : "hover-dim"));
  }

  function isoPoint(x, y, z = 0) {
    return { x: 430 + (x - y) * 32, y: 48 + (x + y) * 25 - z };
  }

  function pointList(points) {
    return points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  }

  function polygon(parent, points, className) {
    const shape = svgEl("polygon", { points: pointList(points), class: className });
    parent.append(shape);
    return shape;
  }

  function drawIsoGrid(parent) {
    const group = svgEl("g", { class: "iso-grid" });
    for (let x = -1; x <= 16; x += 1) {
      const from = isoPoint(x, -.5);
      const to = isoPoint(x, 13.5);
      group.append(svgEl("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y }));
    }
    for (let y = -1; y <= 14; y += 1) {
      const from = isoPoint(-.5, y);
      const to = isoPoint(15.5, y);
      group.append(svgEl("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y }));
    }
    parent.append(group);
  }

  function drawDistrict(parent, district) {
    const group = svgEl("g", { class: `district ${district.className}` });
    polygon(group, [
      isoPoint(district.x, district.y),
      isoPoint(district.x + district.w, district.y),
      isoPoint(district.x + district.w, district.y + district.d),
      isoPoint(district.x, district.y + district.d),
    ], "district-floor");
    const labelPoint = isoPoint(district.x + .12, district.y + district.d + .16);
    group.append(svgEl("text", { x: labelPoint.x, y: labelPoint.y, class: "district-label" }, district.label));
    parent.append(group);
  }

  function modulePoint(module) {
    return isoPoint(module.x + module.w / 2, module.y + module.d / 2, module.h + 8);
  }

  function edgePath(from, to, edge) {
    const fromCenter = { x: from.x + from.w / 2, y: from.y + from.d / 2 };
    const toCenter = { x: to.x + to.w / 2, y: to.y + to.d / 2 };
    const dx = toCenter.x - fromCenter.x;
    const dy = toCenter.y - fromCenter.y;
    const overlapX = Math.min(from.x + from.w, to.x + to.w) - Math.max(from.x, to.x);
    const overlapY = Math.min(from.y + from.d, to.y + to.d) - Math.max(from.y, to.y);
    let worldPoints = null;
    if (overlapY > 0 && overlapX <= 0) {
      const y = (Math.max(from.y, to.y) + Math.min(from.y + from.d, to.y + to.d)) / 2;
      worldPoints = [
        { x: dx >= 0 ? from.x + from.w : from.x, y },
        { x: dx >= 0 ? to.x : to.x + to.w, y },
      ];
    } else if (overlapX > 0 && overlapY <= 0) {
      const x = (Math.max(from.x, to.x) + Math.min(from.x + from.w, to.x + to.w)) / 2;
      worldPoints = [
        { x, y: dy >= 0 ? from.y + from.d : from.y },
        { x, y: dy >= 0 ? to.y : to.y + to.d },
      ];
    }
    const yFirst = ["experiment", "host", "observe", "impact"].includes(edge.route);
    if (!worldPoints && yFirst) {
      worldPoints = [
        { x: fromCenter.x, y: dy >= 0 ? from.y + from.d : from.y },
        { x: fromCenter.x, y: toCenter.y },
        { x: dx >= 0 ? to.x : to.x + to.w, y: toCenter.y },
      ];
    } else if (!worldPoints) {
      worldPoints = [
        { x: dx >= 0 ? from.x + from.w : from.x, y: fromCenter.y },
        { x: toCenter.x, y: fromCenter.y },
        { x: toCenter.x, y: dy >= 0 ? to.y : to.y + to.d },
      ];
    }
    const points = worldPoints.map(({ x, y }) => isoPoint(x, y, 4));
    return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  }

  function drawModule(parent, module, state) {
    const group = svgEl("g");
    let className = `system-module status-${module.status}`;
    if (state.selected) className += " selected";
    else if (state.dim) className += " dim";
    if (state.modeDim) className += " mode-dim";
    if (state.tracing) className += " tracing";
    group.setAttribute("class", className);
    group.dataset.module = module.id;

    const base = [
      isoPoint(module.x, module.y),
      isoPoint(module.x + module.w, module.y),
      isoPoint(module.x + module.w, module.y + module.d),
      isoPoint(module.x, module.y + module.d),
    ];
    const top = [
      isoPoint(module.x, module.y, module.h),
      isoPoint(module.x + module.w, module.y, module.h),
      isoPoint(module.x + module.w, module.y + module.d, module.h),
      isoPoint(module.x, module.y + module.d, module.h),
    ];
    polygon(group, [top[1], top[2], base[2], base[1]], "face side-a");
    polygon(group, [top[2], top[3], base[3], base[2]], "face side-b");
    polygon(group, top, "face top");

    if (module.stack) {
      for (let index = 1; index < module.stack; index += 1) {
        const z = (module.h / (module.stack + 1)) * index;
        const a = isoPoint(module.x + module.w, module.y, z);
        const b = isoPoint(module.x + module.w, module.y + module.d, z);
        const c = isoPoint(module.x, module.y + module.d, z);
        group.append(svgEl("path", { d: `M${a.x},${a.y}L${b.x},${b.y}L${c.x},${c.y}`, class: "stack-line" }));
      }
    }

    const center = modulePoint(module);
    group.append(svgEl("text", { x: center.x, y: center.y - 5, class: "module-code" }, module.code));
    const name = svgEl("text", { x: center.x, y: center.y + 11, class: "module-name" });
    const words = module.name.toUpperCase().split(/\s+/);
    const splitAt = words.length > 3 ? Math.ceil(words.length / 2) : words.length;
    [words.slice(0, splitAt).join(" "), words.slice(splitAt).join(" ")].filter(Boolean).forEach((line, index) => {
      name.append(svgEl("tspan", { x: center.x, dy: index ? 10 : 0 }, line));
    });
    group.append(name);
    const countPoint = isoPoint(module.x + module.w - .12, module.y + .14, module.h + 2);
    group.append(svgEl("text", { x: countPoint.x, y: countPoint.y, class: "module-count" }, module.members.length || "P"));
    group.append(svgEl("title", {}, `${module.name} — ${module.purpose}`));
    parent.append(group);
    return group;
  }

  function animateFlowDots(viewport, edgeElements, trace, selectedId) {
    const pairs = new Set();
    for (let index = 0; index < trace.steps.length - 1; index += 1) {
      pairs.add(`${trace.steps[index]}→${trace.steps[index + 1]}`);
    }
    const dots = edgeElements.filter(({ edge }) => pairs.has(`${edge.from}→${edge.to}`)).map(({ edge, path }, index) => {
      const circle = svgEl("circle", { r: 3.1, class: `flowdot route-${edge.route}` });
      if (selectedId && edge.from !== selectedId && edge.to !== selectedId) circle.setAttribute("opacity", ".08");
      viewport.append(circle);
      return { circle, path, length: path.getTotalLength(), phase: (index * .193) % 1, speed: .06 + (index % 3) * .007 };
    });
    let last = performance.now();
    const tick = (now) => {
      const delta = Math.min(.1, (now - last) / 1000);
      last = now;
      for (const dot of dots) {
        if (flowRunning) dot.phase = (dot.phase + delta * dot.speed) % 1;
        const point = dot.path.getPointAtLength(dot.phase * dot.length);
        dot.circle.setAttribute("cx", point.x);
        dot.circle.setAttribute("cy", point.y);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function bindViewport(svg) {
    let drag = null;
    svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, panX: camera.x, panY: camera.y, moved: false };
      svg.setPointerCapture(event.pointerId);
      svg.classList.add("panning");
    });
    svg.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const rect = svg.getBoundingClientRect();
      const scale = W / rect.width;
      const dx = (event.clientX - drag.x) * scale;
      const dy = (event.clientY - drag.y) * scale;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      camera.x = drag.panX + dx;
      camera.y = drag.panY + dy;
      updateCamera();
    });
    const finish = (event) => {
      if (!drag) return;
      svg.dataset.dragged = drag.moved ? "true" : "false";
      setTimeout(() => { svg.dataset.dragged = "false"; }, 0);
      drag = null;
      svg.classList.remove("panning");
      if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);
    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      camera.zoom = Math.max(.65, Math.min(1.9, camera.zoom * (event.deltaY > 0 ? .9 : 1.1)));
      updateCamera();
    }, { passive: false });
  }

  function updateCamera() {
    const viewport = $("#systemViewport");
    if (!viewport) return;
    viewport.setAttribute("transform", `translate(${camera.x} ${camera.y}) translate(500 380) scale(${camera.zoom}) translate(-500 -380)`);
  }

  function bindControls(mode, trace) {
    $("#flowToggle").addEventListener("click", (event) => {
      flowRunning = !flowRunning;
      event.currentTarget.textContent = flowRunning ? "Ⅱ PAUSE THE FLOW" : "▶ RESUME THE FLOW";
    });
    $("#traceStep").addEventListener("click", () => {
      traceStep = (traceStep + 1) % trace.steps.length;
      drawerOpen = true;
      setHash(mode, trace.steps[traceStep]);
    });
    $("#resetMap").addEventListener("click", () => {
      camera = { ...DEFAULT_CAMERA };
      traceStep = -1;
      flowRunning = false;
      setHash(mode);
    });
    $("#zoomIn").addEventListener("click", () => {
      camera.zoom = Math.min(1.9, camera.zoom * 1.15);
      updateCamera();
    });
    $("#zoomOut").addEventListener("click", () => {
      camera.zoom = Math.max(.65, camera.zoom / 1.15);
      updateCamera();
    });
    $("#inspectorPeek").addEventListener("click", () => setDrawerOpen(true));
  }

  function setDrawerOpen(open) {
    drawerOpen = open;
    frame.dataset.drawerOpen = String(open);
  }

  function inspectorTabs() {
    return `<div class="inspector-tabs" role="tablist" aria-label="Inspector view">
      <button role="tab" data-tab="explain" aria-selected="${inspectorTab === "explain"}">WHAT IT DOES</button>
      <button role="tab" data-tab="evidence" aria-selected="${inspectorTab === "evidence"}">HOW IT'S BUILT</button>
      <button role="tab" data-tab="questions" aria-selected="${inspectorTab === "questions"}">INTERROGATE</button>
    </div>`;
  }

  function bindDrawer(selected, mode) {
    const drawer = $("#drawerScroll");
    drawer.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        inspectorTab = button.dataset.tab;
        renderDrawer(selected, mode);
      });
    });
    const close = $(".drawer-close", drawer);
    if (close) close.addEventListener("click", () => setDrawerOpen(false));
    drawer.querySelectorAll("[data-jump]").forEach((button) => {
      button.addEventListener("click", () => {
        drawerOpen = true;
        setHash(mode, button.dataset.jump);
      });
    });
    drawer.querySelectorAll("[data-question]").forEach((button) => {
      button.addEventListener("click", () => {
        const question = D.interrogations.find(({ id }) => id === button.dataset.question);
        activeQuestionId = question.id;
        inspectorTab = "questions";
        drawerOpen = true;
        setHash(question.mode, question.target);
      });
    });
  }

  function renderDrawer(selected, mode) {
    const drawer = $("#drawerScroll");
    drawer.innerHTML = inspectorTabs() + (selected ? moduleDrawer(selected, mode) : overviewDrawer(mode));
    bindDrawer(selected, mode);
  }

  function overviewDrawer(mode) {
    const copy = {
      current: {
        kicker: "Current implementation · reactive",
        title: "A governed compiler with a page service—not an observer",
        intro: "The host coding agent notices the opportunity and invokes a one-shot CLI. Attend compiles verified data into a fixed renderer, persists a visualization session, and starts a reactive daemon for the page and questions.",
      },
      observer: {
        kicker: "Proposed architecture · not shipped",
        title: "A dedicated observer can be logical, bounded, and session-scoped",
        intro: "One project daemon can host isolated ObserverSessions fed by authenticated lifecycle events. Start in shadow mode; do not grant ambient transcript, filesystem, browser, or host-mutation authority.",
      },
      impact: {
        kicker: "Measurement model · proposed",
        title: "Log the chain without pretending activity is impact",
        intro: "Existing Attend records are strong on activity. A cross-boundary ledger is needed to prove delivery, explicit use, immutable experiment assignment, and measured outcome without copying private content.",
      },
    }[mode];
    if (inspectorTab === "questions") return questionsMarkup(copy.kicker, copy.title);
    if (inspectorTab === "evidence") {
      return `<div class="inspector-body">
        <button class="drawer-close" aria-label="Close inspector">×</button>
        <div class="kicker">Evidence + compression</div>
        <h2>Twenty-one components, thirteen current modules</h2>
        <p class="intro">The map is curated from the runtime boundaries, not mechanically drawn from every import. Static inspection found ${D.meta.sourceModules} JavaScript modules; the plate groups the ${D.meta.conceptualComponents} components that carry the user-visible lifecycle.</p>
        <h3>Why it stays readable</h3>
        <p>Edges are drawn without always-on prose. Hover or select a module to isolate its neighbors; the full verb moves into this inspector. Exact implementation paths sit under each module.</p>
        <h3>What is current</h3>
        <div class="state-table">
          <div class="state-row"><b>Trigger</b><span>Managed host-agent policy</span></div>
          <div class="state-row"><b>Compile</b><span>One-shot CLI + strict catalog compiler</span></div>
          <div class="state-row"><b>Session</b><span>Durable application state, not provider context</span></div>
          <div class="state-row"><b>Daemon</b><span>Reactive page and question service</span></div>
          <div class="state-row"><b>Observer</b><span>None</span></div>
        </div>
        <h3>Source note</h3>
        <p>Claims were inspected on ${esc(D.meta.inspectedAt)}. Proposed structures link to <a href="observer-design.md" target="_blank" rel="noopener">the reviewed design</a> and remain dashed everywhere.</p>
      </div>`;
    }
    return `<div class="inspector-body">
      <button class="drawer-close" aria-label="Close inspector">×</button>
      <div class="kicker">${esc(copy.kicker)}</div>
      <h2>${esc(copy.title)}</h2>
      <p class="intro">${esc(copy.intro)}</p>
      ${mode === "current" ? `
        <h3>Two different lifetimes</h3>
        <div class="state-table">
          <div class="state-row"><b>CLI</b><span>Runs one command and exits.</span></div>
          <div class="state-row"><b>Service</b><span>May remain alive to serve pages and queued questions.</span></div>
          <div class="state-row"><b>Model</b><span>Local can persist; detached providers start fresh per answer.</span></div>
          <div class="state-row"><b>Observer</b><span>Does not exist today.</span></div>
        </div>
        <h3>Where the first view went wrong</h3>
        <p>The request named an existing isometric architecture form. Mapping only its analytical topic to <mark>mechanism / flowchart</mark> discarded a hard representation constraint. Attend should have deferred to the coding agent's normal just-in-time visualization path.</p>` : mode === "observer" ? `
        <h3>Safe rollout</h3>
        <div class="state-table">
          <div class="state-row"><b>Shadow</b><span>Evaluate and log; never interrupt or compile.</span></div>
          <div class="state-row"><b>Suggest</b><span>Surface bounded proposals under a budget.</span></div>
          <div class="state-row"><b>Stage</b><span>Deferred until a scoped transform worker exists.</span></div>
        </div>
        <div class="limit">The observer never broadens source scope, writes project files, or mutates the project-global current pointer.</div>` : `
        <h3>Four claims, four evidence standards</h3>
        <div class="state-table">${D.impactStates.map((state) => `<div class="state-row"><b>${esc(state.name)}</b><span>${esc(state.meaning)} Current: ${esc(state.current)}.</span></div>`).join("")}</div>
        <div class="limit">Causal language is reserved for outcomes tied to an immutable pre-result assignment, metric, baseline, and observation window.</div>`}
    </div>`;
  }

  function moduleDrawer(module, mode) {
    const phase = D.phases.find(({ id }) => id === module.phase);
    const connections = D.edges.filter((edge) => edge.from === module.id || edge.to === module.id)
      .filter((edge) => mode !== "current" || !edge.proposed);
    const members = module.members.map((id) => componentsById[id]);
    if (inspectorTab === "questions") return questionsMarkup(`${module.code} · ${module.name}`, module.name);
    if (inspectorTab === "evidence") {
      return `<div class="inspector-body">
        <button class="drawer-close" aria-label="Close inspector">×</button>
        <div class="kicker">${esc(phase?.name || module.phase)} · ${esc(module.status)}</div>
        <h2>${esc(module.name)}</h2>
        <div class="module-meta"><span>${esc(module.code)}</span><span class="${module.status === "proposed" ? "proposed" : ""}">${members.length || "design-only"} implementation ${members.length === 1 ? "part" : "parts"}</span></div>
        <h3>How it's built</h3>
        <p class="intro">${esc(module.build)}</p>
        ${members.length ? `<h3>Inside this structure</h3><div class="source-list">${members.map((component) => `<a href="${esc(component.path)}" target="_blank" rel="noopener"><strong>${esc(component.name)}</strong><span>${esc(component.path)}</span></a>`).join("")}</div>` : ""}
        <h3>Evidence paths</h3>
        <div class="source-list">${module.sources.map((source) => `<a href="${esc(source.path)}" target="_blank" rel="noopener"><strong>${esc(source.path)}</strong><span>${esc(source.note)}</span></a>`).join("")}</div>
        <div class="limit">${esc(module.limit)}</div>
      </div>`;
    }
    return `<div class="inspector-body">
      <button class="drawer-close" aria-label="Close inspector">×</button>
      <div class="kicker">${esc(phase?.name || module.phase)} · ${esc(module.status)}</div>
      <h2>${esc(module.name)}</h2>
      <div class="module-meta"><span>${esc(module.code)}</span><span class="${module.status === "proposed" ? "proposed" : ""}">${module.status === "proposed" ? "not current behavior" : `${module.members.length} mapped ${module.members.length === 1 ? "component" : "components"}`}</span></div>
      <h3>What it does</h3>
      <p class="intro">${esc(module.purpose)}</p>
      <h3>What matters</h3>
      <div class="fact-list">${module.facts.map((fact, index) => `<div><b>${String(index + 1).padStart(2, "0")}</b><span>${esc(fact)}</span></div>`).join("")}</div>
      <h3>Its place in the system</h3>
      <div class="connection-list">${connections.map((edge) => {
        const outgoing = edge.from === module.id;
        const other = modulesById[outgoing ? edge.to : edge.from];
        return `<button data-jump="${other.id}"><span>${outgoing ? "SENDS" : "RECEIVES"}</span><b>${esc(other.name)}</b><em>${esc(edge.label)}</em></button>`;
      }).join("")}</div>
      <div class="limit">${esc(module.limit)}</div>
    </div>`;
  }

  function questionsMarkup(kicker, title) {
    const active = D.interrogations.find(({ id }) => id === activeQuestionId);
    return `<div class="inspector-body">
      <button class="drawer-close" aria-label="Close inspector">×</button>
      <div class="kicker">${esc(kicker)} · interrogate the map</div>
      <h2>${esc(title)}</h2>
      ${active ? `<div class="answer"><b>${esc(active.question)}</b><br><br>${esc(active.answer)}</div>` : `<p class="intro">Choose a pressure-test. The answer changes the map view and selects the boundary carrying the claim.</p>`}
      <div class="question-list">${D.interrogations.map((question) => `
        <button class="question-card" data-question="${question.id}" aria-current="${question.id === activeQuestionId}">
          <b>${esc(question.question)}</b><span>${esc(question.mode)} → ${esc(modulesById[question.target].name)}</span>
        </button>`).join("")}</div>
    </div>`;
  }

  addEventListener("hashchange", render);
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const { mode, selection } = parseHash();
    if (selection) setHash(mode);
    else setDrawerOpen(false);
  });
  if (!location.hash) history.replaceState(null, "", "#current");
  render();
}());
