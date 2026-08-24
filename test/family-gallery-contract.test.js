import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLibraryServer } from "../src/server.js";
import { compileMap, compileMapWithEvidence } from "../src/pipeline/compile.js";
import {
  canonicalJson,
  isOpaqueEvidenceReferenceId,
  verifyDataPackageHashes,
} from "../src/pipeline/data-package.js";
import {
  CANONICAL_INPUT_MEDIA,
  MAP_FAMILIES,
} from "../src/map-families/registry.js";
import SAMPLE_SOURCES from "../viewer/family-datasets.js";
import { toCompilerRequest } from "../viewer/family-compiler-adapter.js";
import { RENDERER_IDS } from "../viewer/family-renderers.js";

const ATTEND_ROOT = fileURLToPath(new URL("../", import.meta.url));
const VIEWER_ROOT = fileURLToPath(new URL("../viewer/", import.meta.url));

const FAMILY_IDS = Object.freeze([
  "rank",
  "distribution",
  "composition",
  "profile",
  "passage-comparison",
  "trend",
  "timeline",
  "sequence",
  "relationship",
  "matrix",
  "hierarchy",
  "network",
  "flow",
  "mechanism",
  "region-map",
  "point-map",
  "field",
  "collection-atlas",
  "annotated-specimen",
]);

const INPUT_MEDIA = Object.freeze([
  "structured",
  "text",
  "image",
  "video",
  "audio",
  "document",
  "geography",
  "mixed",
]);

const FAMILY_HTTP_ASSETS = Object.freeze([
  ["", "text/html; charset=utf-8"],
  ["index.html", "text/html; charset=utf-8"],
  ["family-lab.js", "text/javascript; charset=utf-8"],
  ["family-lab.css", "text/css; charset=utf-8"],
  ["family-datasets.js", "text/javascript; charset=utf-8"],
  ["family-compiler-adapter.js", "text/javascript; charset=utf-8"],
  ["package-model.js", "text/javascript; charset=utf-8"],
  ["package-renderer.js", "text/javascript; charset=utf-8"],
  ["family-renderers.js", "text/javascript; charset=utf-8"],
  ["core/map-families/registry.js", "text/javascript; charset=utf-8"],
  ["core/map-families/index.js", "text/javascript; charset=utf-8"],
  ["core/geography.js", "text/javascript; charset=utf-8"],
  ["core/pipeline/data-package.js", "text/javascript; charset=utf-8"],
  ["core/pipeline/compile.js", "text/javascript; charset=utf-8"],
  ["core/pipeline/index.js", "text/javascript; charset=utf-8"],
  ["vendor/d3.min.js", "text/javascript; charset=utf-8"],
  ["vendor/topojson-client.min.js", "text/javascript; charset=utf-8"],
  ["vendor/us-states.json", "application/json; charset=utf-8"],
  ["vendor/us-counties.json", "application/json; charset=utf-8"],
  ["vendor/world-countries.json", "application/json; charset=utf-8"],
]);

const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right));
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function assertNormalizedRegion(locator, label) {
  for (const field of ["x", "y", "width", "height"]) {
    assert.equal(typeof locator[field], "number", `${label}.${field} must be numeric`);
    assert.ok(locator[field] >= 0 && locator[field] <= 1, `${label}.${field} must be normalized`);
  }
  assert.ok(locator.x + locator.width <= 1, `${label} must fit within the source width`);
  assert.ok(locator.y + locator.height <= 1, `${label} must fit within the source height`);
}

function assertEvidenceLocator(locator, label) {
  assert.ok(locator && typeof locator === "object", `${label} needs a locator`);
  assert.ok(nonEmptyString(locator.kind), `${label} needs a locator kind`);
  assert.ok(nonEmptyString(locator.path), `${label} needs a source path`);

  switch (locator.kind) {
    case "text-range":
      assert.ok(Number.isSafeInteger(locator.startLine) && locator.startLine >= 1, `${label} needs a positive start line`);
      assert.ok(Number.isSafeInteger(locator.endLine) && locator.endLine >= locator.startLine, `${label} needs an ordered end line`);
      break;
    case "row":
      assert.ok(Number.isSafeInteger(locator.row) && locator.row >= 1, `${label} needs a positive row`);
      break;
    case "feature":
      assert.ok(nonEmptyString(locator.featureId), `${label} needs a feature id`);
      break;
    case "coordinate-feature":
      assert.ok(nonEmptyString(locator.featureId), `${label} needs a feature id`);
      assert.ok(Array.isArray(locator.coordinates) && locator.coordinates.length === 2, `${label} needs a coordinate pair`);
      assert.ok(locator.coordinates.every(Number.isFinite), `${label} coordinates must be finite`);
      break;
    case "time-range":
      assert.ok(Number.isFinite(locator.startSeconds) && locator.startSeconds >= 0, `${label} needs a non-negative start time`);
      assert.ok(Number.isFinite(locator.endSeconds) && locator.endSeconds > locator.startSeconds, `${label} needs an ordered end time`);
      break;
    case "normalized-region":
      assert.equal(locator.coordinateSpace, "normalized", `${label} must name its coordinate space`);
      assertNormalizedRegion(locator, label);
      break;
    case "page-region":
      assert.ok(Number.isSafeInteger(locator.page) && locator.page >= 1, `${label} needs a positive page`);
      assert.equal(locator.coordinateSpace, "normalized", `${label} must name its coordinate space`);
      assertNormalizedRegion(locator, label);
      break;
    default:
      assert.fail(`${label} uses unsupported locator kind ${String(locator.kind)}`);
  }
}

function sourceContainsLocator(source, locator) {
  const sourcePath = source.locator?.path;
  if (!nonEmptyString(sourcePath)) return false;
  if (sourcePath.endsWith("/") || String(source.kind).endsWith("-folder")) {
    return locator.path.startsWith(sourcePath);
  }
  return locator.path === sourcePath;
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `could not isolate ${start}`);
  return source.slice(startIndex, endIndex);
}

function assertFamilyAssetHeaders(response, contentType, label) {
  assert.equal(response.headers.get("content-type"), contentType, `${label} needs the declared content type`);
  assert.equal(response.headers.get("cache-control"), "no-store", `${label} cannot be cached`);
  const csp = response.headers.get("content-security-policy") ?? "";
  for (const directive of [
    "default-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
  ]) {
    assert.match(csp, new RegExp(`(?:^|; )${directive}(?:;|$)`, "u"), `${label} needs ${directive}`);
  }
  assert.match(csp, /(?:^|; )object-src 'none'(?:;|$)/u, `${label} must disable objects`);
  assert.match(csp, /(?:^|; )frame-ancestors 'none'(?:;|$)/u, `${label} must disable framing`);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/u, `${label} CSP cannot admit inline or remote code`);
}

test("registry, sample data, and renderers have exact 19-family parity", () => {
  const expected = sorted(FAMILY_IDS);
  const registryIds = MAP_FAMILIES.map((family) => family.id);
  const datasetIds = Object.keys(SAMPLE_SOURCES);

  assert.equal(FAMILY_IDS.length, 19);
  assertUnique(registryIds, "registry family ids");
  assertUnique(datasetIds, "sample dataset ids");
  assertUnique(RENDERER_IDS, "renderer ids");
  assert.deepEqual(sorted(registryIds), expected, "registry must contain the canonical 19 families");
  assert.deepEqual(sorted(datasetIds), expected, "gallery data must cover every canonical family once");
  assert.deepEqual(sorted(RENDERER_IDS), expected, "renderers must cover every canonical family once");

  for (const [datasetId, dataset] of Object.entries(SAMPLE_SOURCES)) {
    assert.equal(dataset.familyId, datasetId, `${datasetId} fixture must identify its registry family`);
  }
});

test("every gallery fixture compiles through the canonical pipeline deterministically", async () => {
  for (const manifest of MAP_FAMILIES) {
    const dataset = SAMPLE_SOURCES[manifest.id];
    const request = await toCompilerRequest(dataset, manifest, { availableWidth: 1_024 });
    const { dataPackage: first, evidenceReferences } = await compileMapWithEvidence(request);
    const second = await compileMap(request);
    assert.equal(first.kind, "attend-data-package", `${manifest.id} must use the canonical package kind`);
    assert.equal(first.schemaVersion, 2, `${manifest.id} must use schema version 2`);
    assert.equal(first.family.id, manifest.id);
    assert.equal(first.marks.length, request.sourceBundle.records.length);
    assert.equal(first.hashes.package, second.hashes.package, `${manifest.id} fixture compilation must be deterministic`);
    assert.equal(await verifyDataPackageHashes(first), true, `${manifest.id} package hashes must verify`);
    const compiledEvidence = new Set(first.marks.flatMap((mark) => mark.evidenceRefs));
    assert.ok([...compiledEvidence].every(isOpaqueEvidenceReferenceId), `${manifest.id} must expose only opaque evidence reference ids`);
    for (const evidence of dataset.evidence) {
      assert.ok(evidenceReferences.some((reference) =>
        reference.sourceId === evidence.sourceId
        && canonicalJson(reference.locator) === canonicalJson(evidence.locator)
        && reference.quote === evidence.excerpt
      ), `${manifest.id}/${evidence.id} must remain available in the private evidence store`);
    }
    assert.doesNotMatch(JSON.stringify(first.marks), /"(?:sourceId|recordId|locator|excerpt|quote)"/u, `${manifest.id} public marks cannot disclose evidence linkage`);
  }
});

test("pipeline mode calls the canonical compiler and does not invent a second package contract", async () => {
  const [app, html] = await Promise.all([
    readFile(`${VIEWER_ROOT}/family-lab.js`, "utf8"),
    readFile(`${VIEWER_ROOT}/family-lab.html`, "utf8"),
  ]);
  assert.match(app, /import \{ compileMap \} from "\.\/core\/pipeline\/compile\.js"/u);
  assert.match(app, /await compileMap\(request\)/u);
  assert.doesNotMatch(app, /attend-map-data-package/u);
  assert.doesNotMatch(html, /renderer[^.]*receives the same versioned package/iu);
});

test("every sample mark and relationship closes over exact source evidence", () => {
  for (const [familyId, dataset] of Object.entries(SAMPLE_SOURCES)) {
    assert.ok(Array.isArray(dataset.sources) && dataset.sources.length > 0, `${familyId} needs sources`);
    assert.ok(Array.isArray(dataset.records) && dataset.records.length > 0, `${familyId} needs records`);
    assert.ok(Array.isArray(dataset.evidence) && dataset.evidence.length > 0, `${familyId} needs evidence`);

    const sourceIds = dataset.sources.map((source) => source.id);
    const evidenceIds = dataset.evidence.map((evidence) => evidence.id);
    const idField = dataset.roles?.id ?? "id";
    const evidenceField = dataset.roles?.evidence ?? "evidenceRefs";
    const recordIds = dataset.records.map((record) => String(record[idField]));
    assertUnique(sourceIds, `${familyId} source ids`);
    assertUnique(evidenceIds, `${familyId} evidence ids`);
    assertUnique(recordIds, `${familyId} record ids`);
    assert.ok(sourceIds.every(nonEmptyString), `${familyId} source ids must be non-empty`);
    assert.ok(evidenceIds.every(nonEmptyString), `${familyId} evidence ids must be non-empty`);
    assert.ok(recordIds.every(nonEmptyString), `${familyId} record ids must be non-empty`);

    const sourceById = new Map(dataset.sources.map((source) => [source.id, source]));
    const evidenceById = new Map(dataset.evidence.map((evidence) => [evidence.id, evidence]));
    const referencedEvidence = new Set();

    for (const source of dataset.sources) {
      assert.equal(source.locator?.kind, "local-path", `${familyId}/${source.id} must retain a local source locator`);
      assert.ok(nonEmptyString(source.locator?.path), `${familyId}/${source.id} needs a local source path`);
    }

    for (const evidence of dataset.evidence) {
      const label = `${familyId}/${evidence.id}`;
      const source = sourceById.get(evidence.sourceId);
      assert.ok(source, `${label} references unknown source ${String(evidence.sourceId)}`);
      assert.equal(evidence.mediaType, source.mediaType, `${label} must retain the source medium`);
      assert.ok(INPUT_MEDIA.includes(evidence.mediaType), `${label} uses an unknown evidence medium`);
      assert.ok(nonEmptyString(evidence.excerpt), `${label} needs a bounded evidence description`);
      assertEvidenceLocator(evidence.locator, label);
      assert.ok(sourceContainsLocator(source, evidence.locator), `${label} locator must remain inside its declared source`);
    }

    const evidenceOwners = [
      ...dataset.records.map((record) => ({ kind: "record", value: record })),
      ...(dataset.links ?? []).map((link) => ({ kind: "link", value: link })),
    ];
    for (const owner of evidenceOwners) {
      const ownerId = String(owner.value[idField] ?? owner.value.id);
      const references = owner.value[evidenceField] ?? owner.value.evidenceRefs;
      assert.ok(Array.isArray(references) && references.length > 0, `${familyId}/${owner.kind}/${ownerId} needs evidence references`);
      assertUnique(references, `${familyId}/${owner.kind}/${ownerId} evidence references`);
      for (const evidenceId of references) {
        assert.ok(evidenceById.has(evidenceId), `${familyId}/${owner.kind}/${ownerId} references unknown evidence ${String(evidenceId)}`);
        referencedEvidence.add(evidenceId);
      }
    }
    assert.deepEqual(sorted(referencedEvidence), sorted(evidenceIds), `${familyId} must not ship orphan evidence`);

    const recordIdSet = new Set(recordIds);
    const linkIds = (dataset.links ?? []).map((link) => String(link.id));
    assertUnique(linkIds, `${familyId} link ids`);
    assert.ok(linkIds.every(nonEmptyString), `${familyId} link ids must be non-empty`);
    assert.ok(linkIds.every((linkId) => !recordIdSet.has(linkId)), `${familyId} link ids cannot collide with record ids`);
    for (const link of dataset.links ?? []) {
      assert.ok(recordIdSet.has(String(link.source)), `${familyId}/${link.id} references unknown source record`);
      assert.ok(recordIdSet.has(String(link.target)), `${familyId}/${link.id} references unknown target record`);
    }
    const parentField = dataset.roles?.parent;
    if (parentField) {
      for (const record of dataset.records) {
        if (record[parentField] !== null && record[parentField] !== undefined) {
          assert.ok(recordIdSet.has(String(record[parentField])), `${familyId}/${record[idField]} references unknown parent record`);
        }
      }
    }
    if (dataset.specimen?.sourceId) {
      assert.ok(sourceById.has(dataset.specimen.sourceId), `${familyId} specimen references an unknown source`);
    }
  }
});

test("every family has a complete, explicit eight-medium adaptation matrix", () => {
  assert.deepEqual(CANONICAL_INPUT_MEDIA, INPUT_MEDIA);
  assertUnique(CANONICAL_INPUT_MEDIA, "canonical input media");

  for (const family of MAP_FAMILIES) {
    assert.equal(family.mediaAdapters.length, INPUT_MEDIA.length, `${family.id} must declare eight media decisions`);
    assert.deepEqual(sorted(family.mediaAdapters.map((adapter) => adapter.medium)), sorted(INPUT_MEDIA), `${family.id} media coverage is incomplete`);

    const requiredRoles = family.data.requiredRoles.map((role) => role.id);
    for (const adapter of family.mediaAdapters) {
      const label = `${family.id}/${adapter.medium}`;
      assert.ok(["direct", "deterministic", "enrich", "abstain"].includes(adapter.decision), `${label} needs a principled decision`);
      assert.ok(nonEmptyString(adapter.reason), `${label} needs a rationale`);
      assert.ok(Array.isArray(adapter.fieldsExtracted), `${label} needs explicit extracted roles`);
      assert.ok(nonEmptyString(adapter.evidenceLocatorKind), `${label} needs an evidence-anchor policy`);
      assert.ok(nonEmptyString(adapter.previewTreatment), `${label} needs a preview policy`);

      if (adapter.decision === "abstain") {
        assert.deepEqual(adapter.fieldsExtracted, [], `${label} cannot extract roles while abstaining`);
        assert.equal(adapter.evidenceLocatorKind, "none", `${label} cannot claim an evidence anchor while abstaining`);
        assert.equal(adapter.previewTreatment, "none", `${label} cannot claim a preview while abstaining`);
      } else {
        for (const roleId of requiredRoles) {
          assert.ok(adapter.fieldsExtracted.includes(roleId), `${label} must extract required role ${roleId}`);
        }
        assert.notEqual(adapter.evidenceLocatorKind, "none", `${label} needs a resolvable evidence anchor`);
        assert.notEqual(adapter.previewTreatment, "none", `${label} needs a readable preview treatment`);
      }
    }
  }
});

test("family-lab HTML satisfies strict self-only CSP and every queried DOM id exists", async () => {
  const [html, app, server] = await Promise.all([
    readFile(`${VIEWER_ROOT}/family-lab.html`, "utf8"),
    readFile(`${VIEWER_ROOT}/family-lab.js`, "utf8"),
    readFile(`${ATTEND_ROOT}/src/server.js`, "utf8"),
  ]);

  assert.doesNotMatch(html, /<style\b/iu, "styles must remain in the same-origin stylesheet");
  assert.doesNotMatch(html, /\sstyle\s*=/iu, "inline style attributes violate the lab CSP");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/iu, "inline event handlers violate the lab CSP");
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
  assert.ok(scriptTags.length > 0, "the lab must load its same-origin scripts");
  for (const [, attributes, body] of scriptTags) {
    assert.match(attributes, /\bsrc\s*=\s*["'][^"']+["']/iu, "scripts must be external");
    assert.equal(body.trim(), "", "external script tags cannot carry inline code");
  }
  assert.match(server, /"default-src 'self'"/u);
  assert.match(server, /"script-src 'self'"/u);
  assert.match(server, /"style-src 'self'"/u);
  assert.doesNotMatch(server, /unsafe-inline|unsafe-eval/u);

  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
  assertUnique(htmlIds, "family-lab DOM ids");
  const queriedIds = new Set([
    ...[...app.matchAll(/getElementById\("([^"]+)"\)/gu)].map((match) => match[1]),
    ...[...app.matchAll(/querySelector(?:All)?\("#([^"]+)"\)/gu)].map((match) => match[1]),
  ]);
  for (const id of queriedIds) {
    assert.ok(htmlIds.includes(id), `family-lab.js queries missing #${id}`);
  }
});

test("family, mark, and media choices use labeled native keyboard controls", async () => {
  const [html, app, renderers] = await Promise.all([
    readFile(`${VIEWER_ROOT}/family-lab.html`, "utf8"),
    readFile(`${VIEWER_ROOT}/family-lab.js`, "utf8"),
    readFile(`${VIEWER_ROOT}/family-renderers.js`, "utf8"),
  ]);

  for (const id of ["family-select", "mark-select", "media-select", "quantity-select"]) {
    assert.match(html, new RegExp(`<select\\b[^>]*\\bid="${id}"`, "u"), `#${id} must be a native select`);
    assert.match(html, new RegExp(`<label\\b[^>]*\\bfor="${id}"`, "u"), `#${id} must have a programmatic label`);
  }
  for (const control of ["familySelect", "markSelect", "mediaSelect", "quantitySelect"]) {
    assert.match(app, new RegExp(`elements\\.${control}\\.addEventListener\\("change"`, "u"), `${control} must use the native change event`);
  }

  const navigationSource = sourceBetween(app, "function renderNavigation()", "function contractSection");
  assert.match(navigationSource, /document\.createElement\("button"\)/u, "desktop family choices must be native buttons");
  assert.match(navigationSource, /button\.type = "button"/u, "family navigation buttons need an explicit non-submit type");
  assert.match(navigationSource, /button\.dataset\.familyId = familyId/u, "family buttons must identify their family");
  assert.match(app, /relationships\.label = "Relationships"/u, "evidence-bearing links must be available through the native inspector");
  for (const className of ["network-link", "flow-link", "mechanism-link"]) {
    assert.match(renderers, new RegExp(`markClass\\(markId, selectedId, [^\\n]*${className}`, "u"), `${className} marks must expose linked selection`);
  }
  assert.match(html, /<button\b[^>]*\btype="button"[^>]*\bdata-mode=/u, "lab modes must be native buttons");
  assert.doesNotMatch(html, /\brole="(?:button|combobox|listbox|option)"/u, "native controls must not be reimplemented with ARIA roles");
});

test("the library serves the complete family lab surface with strict HTTP semantics", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "attend-family-gallery-http-"));
  let library;
  t.after(async () => {
    try {
      await library?.close();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  library = await createLibraryServer({
    root: projectRoot,
    assetsDir: VIEWER_ROOT,
    token: "family-gallery-http-test-token",
    instanceId: "family-gallery-http-test-instance",
  });

  for (const [route, contentType] of FAMILY_HTTP_ASSETS) {
    const label = `families/${route || "(index)"}`;
    const url = new URL(`families/${route}`, library.url);

    const response = await fetch(url);
    assert.equal(response.status, 200, `${label} GET must succeed`);
    assertFamilyAssetHeaders(response, contentType, label);
    const body = await response.text();
    assert.ok(body.length > 0, `${label} GET must return its asset body`);
    if (contentType.startsWith("application/json")) {
      assert.doesNotThrow(() => JSON.parse(body), `${label} must return valid JSON`);
    }

    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200, `${label} HEAD must succeed`);
    assertFamilyAssetHeaders(head, contentType, `${label} HEAD`);
    assert.equal((await head.arrayBuffer()).byteLength, 0, `${label} HEAD cannot return a body`);
  }

  for (const route of [
    "not-a-family-asset.js",
    "core/not-a-published-module.js",
    "vendor/not-a-published-dataset.json",
  ]) {
    const response = await fetch(new URL(`families/${route}`, library.url));
    assert.equal(response.status, 404, `unknown families/${route} must remain private`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  }
});

test("the family lab browser module graph resolves every published static import", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "attend-family-gallery-graph-"));
  let library;
  t.after(async () => {
    try {
      await library?.close();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
  library = await createLibraryServer({
    root: projectRoot,
    assetsDir: VIEWER_ROOT,
    token: "family-gallery-graph-test-token",
    instanceId: "family-gallery-graph-test-instance",
  });

  const pending = ["family-lab.js"];
  const visited = new Set();
  const importPattern = /\b(?:import|export)\s+(?:[^"'()]*?\sfrom\s+)?["']([^"']+)["']/gu;
  while (pending.length) {
    const route = pending.pop();
    if (visited.has(route)) continue;
    visited.add(route);
    const moduleUrl = new URL(`families/${route}`, library.url);
    const response = await fetch(moduleUrl);
    assert.equal(response.status, 200, `static module ${route} must resolve`);
    const source = await response.text();
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const importedUrl = new URL(specifier, moduleUrl);
      assert.equal(importedUrl.origin, moduleUrl.origin, `${route} may only import same-origin modules`);
      const prefix = new URL("families/", library.url).pathname;
      assert.ok(importedUrl.pathname.startsWith(prefix), `${route} import ${specifier} must stay within /families`);
      pending.push(importedUrl.pathname.slice(prefix.length));
    }
  }
  assert.ok(visited.has("package-model.js"), "module graph must include browser package-model authority");
  assert.ok(visited.has("package-renderer.js"), "module graph must include package renderer");
  assert.ok(visited.has("core/pipeline/compile.js"), "module graph must include canonical compiler");
});

test("geographic views load published topology routes instead of hand-drawn outlines", async () => {
  const [renderers, app, server, statesRaw, countiesRaw, countriesRaw] = await Promise.all([
    readFile(`${VIEWER_ROOT}/family-renderers.js`, "utf8"),
    readFile(`${VIEWER_ROOT}/family-lab.js`, "utf8"),
    readFile(`${ATTEND_ROOT}/src/server.js`, "utf8"),
    readFile(`${VIEWER_ROOT}/vendor/us-states.json`, "utf8"),
    readFile(`${VIEWER_ROOT}/vendor/us-counties.json`, "utf8"),
    readFile(`${VIEWER_ROOT}/vendor/world-countries.json`, "utf8"),
  ]);

  assert.match(server, /"vendor\/us-states\.json"[^\n]+file: "vendor\/us-states\.json"/u);
  assert.match(server, /"vendor\/us-counties\.json"[^\n]+file: "vendor\/us-counties\.json"/u);
  assert.match(server, /"vendor\/world-countries\.json"[^\n]+file: "vendor\/world-countries\.json"/u);
  assert.doesNotMatch(server, /node_modules\/(?:us-atlas|world-atlas)/u);
  assert.match(renderers, /fetch\("\.\/vendor\/us-states\.json"\)/u);
  assert.match(renderers, /fetch\("\.\/vendor\/us-counties\.json"\)/u);

  const geographyLoader = sourceBetween(renderers, "async function loadUsGeography()", "function geographyFailure");
  const regionRenderer = sourceBetween(renderers, "async function renderRegionMap", "async function renderPointMap");
  const pointRenderer = sourceBetween(renderers, "async function renderPointMap", "function renderField");
  const repeatRenderer = sourceBetween(app, "async function loadWorldGeography", "function renderMixedPolicy");
  assert.match(geographyLoader, /topojson\.feature/u);
  assert.match(regionRenderer, /geoPath\(projection\)/u);
  assert.match(pointRenderer, /geoPath\(projection\)/u);
  assert.match(repeatRenderer, /fetch\("\.\/vendor\/world-countries\.json"\)/u);
  assert.match(repeatRenderer, /topojson\.feature/u);
  for (const source of [regionRenderer, pointRenderer, repeatRenderer]) {
    assert.doesNotMatch(source, /\bd\s*:\s*["'`]M[\s\d-]/u, "geographic outlines cannot be embedded SVG path drawings");
    assert.doesNotMatch(source, /createElement(?:NS)?\([^\n]+"polygon"/u, "geographic outlines must come from published geometry");
  }

  const states = JSON.parse(statesRaw);
  const counties = JSON.parse(countiesRaw);
  const countries = JSON.parse(countriesRaw);
  assert.equal(states.type, "Topology");
  assert.equal(counties.type, "Topology");
  assert.equal(countries.type, "Topology");
  assert.ok(states.objects.states.geometries.length >= 50, "state route must expose real state geometry");
  assert.ok(counties.objects.counties.geometries.length >= 3_000, "county route must expose real county geometry");
  assert.ok(countries.objects.countries.geometries.length >= 170, "world route must expose real country geometry");
  assert.ok(states.arcs.length >= 100 && counties.arcs.length >= 1_000 && countries.arcs.length >= 500, "map routes must not be placeholder outlines");
});
