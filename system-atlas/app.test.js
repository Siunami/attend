import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const atlasDirectory = new URL("./", import.meta.url);

async function loadModel() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("data.js", atlasDirectory), "utf8"), sandbox);
  return sandbox.window.ATTEND_SYSTEM;
}

test("the current plate compresses every audited component into one owner", async () => {
  const model = await loadModel();
  const componentIds = new Set(model.components.map(({ id }) => id));
  const owners = new Map();

  for (const module of model.modules) {
    for (const id of module.members) {
      assert.ok(componentIds.has(id), `${module.id} names unknown component ${id}`);
      assert.equal(owners.has(id), false, `${id} has more than one owner`);
      owners.set(id, module.id);
    }
  }

  assert.equal(model.components.length, 21);
  assert.equal(model.modules.filter(({ status }) => status !== "proposed").length, 13);
  assert.deepEqual(
    Array.from(componentIds).filter((id) => !owners.has(id)),
    [],
  );
});

test("current and proposed behavior cannot be confused", async () => {
  const model = await loadModel();
  const proposed = model.modules.filter(({ status }) => status === "proposed");

  assert.equal(model.meta.activeObservers, 0);
  assert.deepEqual(Array.from(proposed, ({ id }) => id), ["hostevents", "observer", "impact"]);
  assert.ok(proposed.every(({ members }) => members.length === 0));
  assert.ok(model.edges.filter(({ proposed: isProposed }) => isProposed).every(({ from, to }) =>
    proposed.some(({ id }) => id === from || id === to)));
});

test("all relation endpoints, trace steps, and evidence paths resolve", async () => {
  const model = await loadModel();
  const moduleIds = new Set(model.modules.map(({ id }) => id));

  for (const edge of model.edges) {
    assert.ok(moduleIds.has(edge.from), `${edge.id} source must resolve`);
    assert.ok(moduleIds.has(edge.to), `${edge.id} target must resolve`);
    assert.ok(edge.label.trim(), `${edge.id} must expose its verb in the inspector`);
  }
  for (const trace of model.traces) {
    assert.ok(trace.steps.length >= 4, `${trace.id} must be a meaningful route`);
    assert.ok(trace.steps.every((id) => moduleIds.has(id)));
  }
  for (const module of model.modules) {
    for (const source of module.sources) await access(new URL(source.path, atlasDirectory));
  }
});

test("the inspector overlays the map without resizing its camera surface", async () => {
  const styles = await readFile(new URL("styles.css", atlasDirectory), "utf8");
  const app = await readFile(new URL("app.js", atlasDirectory), "utf8");

  assert.match(styles, /\.frame\s*\{[\s\S]*grid-template-columns:\s*var\(--rail-width\)\s+minmax\(0,\s*1fr\)/u);
  assert.match(styles, /\.drawer\s*\{[\s\S]*position:\s*absolute/u);
  assert.match(styles, /transform:\s*translate3d\(100%,\s*0,\s*0\)/u);
  assert.match(styles, /\.frame\[data-drawer-open="true"\]\s+\.drawer\s*\{\s*transform:\s*translate3d\(0,\s*0,\s*0\)/u);
  assert.doesNotMatch(styles, /margin-inline-end|grid-template-columns:[^;]*var\(--drawer-width\)/u);
  assert.match(app, /const DEFAULT_CAMERA = Object\.freeze\(/u);
  assert.match(app, /let camera = \{ \.\.\.DEFAULT_CAMERA \}/u);
  assert.match(app, /camera = \{ \.\.\.DEFAULT_CAMERA \};\s*traceStep/u);
});

test("explicit unsupported forms route back to just-in-time host visualization", async () => {
  const model = await loadModel();
  const question = model.interrogations.find(({ id }) => id === "why-defer");

  assert.ok(question);
  assert.match(question.answer, /no substitute artifact/u);
  assert.match(question.answer, /coding agent/u);
  assert.match(question.answer, /repository precedent/u);
});

test("proposal modes default to their own trace and quiet unrelated routes", async () => {
  const app = await readFile(new URL("app.js", atlasDirectory), "utf8");

  assert.match(app, /activeTraceId = nextMode === "current" \? "direct" : "observer"/u);
  assert.match(app, /mode === "observer"[^\n]+edge\.route === "observe" \? " lit" : " mode-dim"/u);
});
