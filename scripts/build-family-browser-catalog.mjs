import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CATALOG_COUNTS,
  CATALOG_FAMILIES,
  CATALOG_VERSION,
  HISTORICAL_CATALOG_RECEIPTS,
  historicalPresentationVariantForMember,
} from "../src/catalog/index.js";
import { AUTHORED_FAMILY_ATLAS_CONTENT } from "../src/catalog/snapshot.js";
import { evaluateFormEligibility } from "../src/forms/index.js";
import { GOVERNED_FORM_MODULES } from "../src/forms/governed.js";
import { HISTORICAL_PACKAGE_CONTRACTS } from "../src/pipeline/historical-package-contracts.js";
import {
  CANONICAL_INPUT_MEDIA,
  MAP_FAMILIES,
  MAP_FAMILY_GROUPS,
} from "../src/map-families/registry.js";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(SCRIPT_DIRECTORY, "../viewer/family-catalog.js");
const BROWSER_RUNTIME_OUTPUT_PATH = resolve(SCRIPT_DIRECTORY, "../viewer/form-runtime-generated.js");
const NODE_RUNTIME_OUTPUT_PATH = resolve(SCRIPT_DIRECTORY, "../src/catalog/generated-form-runtime.js");
const VIEWER_DIRECTORY = resolve(SCRIPT_DIRECTORY, "../viewer");
const FAMILY_LAB_CORE_ASSETS = Object.freeze([
  ["core/catalog/index.js", "../src/catalog/index.js"],
  ["core/catalog/snapshot.js", "../src/catalog/snapshot.js"],
  ["core/forms/index.js", "../src/forms/index.js"],
  ["core/forms/sha256.js", "../src/forms/sha256.js"],
  ["core/geography.js", "../src/geography.js"],
  ["core/map-families/index.js", "../src/map-families/index.js"],
  ["core/map-families/registry.js", "../src/map-families/registry.js"],
  ["core/pipeline/compile.js", "../src/pipeline/compile.js"],
  ["core/pipeline/data-package.js", "../src/pipeline/data-package.js"],
  ["core/pipeline/historical-package-contracts.js", "../src/pipeline/historical-package-contracts.js"],
  ["core/pipeline/index.js", "../src/pipeline/index.js"],
  ["core/representation-intent.js", "../src/representation-intent.js"],
].map(([route, file]) => Object.freeze({ route, file })));
const HTML_ENTITIES = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
});

function decodeHtmlEntity(entity, body) {
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const codePoint = Number.parseInt(body.slice(2), 16);
    if (Number.isInteger(codePoint) && codePoint <= 0x10ffff) return String.fromCodePoint(codePoint);
    return entity;
  }
  if (body.startsWith("#")) {
    const codePoint = Number.parseInt(body.slice(1), 10);
    if (Number.isInteger(codePoint) && codePoint <= 0x10ffff) return String.fromCodePoint(codePoint);
    return entity;
  }
  return HTML_ENTITIES[body.toLowerCase()] ?? entity;
}

function plainText(text) {
  return text
    .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|nbsp|quot);/giu, decodeHtmlEntity)
    .replace(/<[^>]*>/gu, "");
}

function toPlainData(value) {
  if (typeof value === "string") return plainText(value);
  if (Array.isArray(value)) return value.map(toPlainData);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toPlainData(child)]));
  }
  return value;
}

function requireIndexed(index, id, label) {
  const value = index.get(id);
  if (value) return value;
  throw new Error(`Missing ${label} for family ${id}`);
}

function browserMember(catalogMember, authoredMember) {
  return {
    id: catalogMember.id,
    name: catalogMember.name,
    authoredStatus: authoredMember.status,
    authoredQuantityBand: catalogMember.authoredBand ?? authoredMember.band,
    executableQuantityBand: catalogMember.executableBand ?? [],
    status: catalogMember.status,
    when: catalogMember.when,
    rationale: catalogMember.rationale,
    band: catalogMember.band,
    lineage: catalogMember.lineage,
    rejectionReason: catalogMember.rejectionReason ?? null,
    unavailableReason: catalogMember.unavailableReason ?? null,
    requirements: catalogMember.requirements ?? [],
    roles: catalogMember.roleSchema ?? null,
    guidance: catalogMember.guidance ?? null,
    sourcePolicy: catalogMember.sourcePolicy ?? null,
    projector: catalogMember.projector ?? null,
    payload: catalogMember.payload ?? null,
    selectionPolicy: catalogMember.selectionPolicy ?? null,
    representationCapabilities: catalogMember.representationCapabilities ?? null,
    renderer: catalogMember.rendererId
      ? {
          id: catalogMember.rendererId,
          version: catalogMember.rendererVersion,
          variantId: catalogMember.rendererVariantId,
        }
      : null,
    mediaPolicy: catalogMember.mediaPolicy ?? null,
    fixtureId: catalogMember.fixtureId ?? null,
  };
}

function browserFamily(catalogFamily, authoredFamily, manifest) {
  const authoredMembers = new Map(authoredFamily.members.map((member) => [member.id, member]));
  return {
    id: catalogFamily.id,
    version: manifest.version,
    title: catalogFamily.title,
    group: catalogFamily.group,
    question: catalogFamily.question,
    oneLine: catalogFamily.oneLine,
    summary: catalogFamily.summary,
    executableMemberIds: catalogFamily.executableMemberIds,
    maturity: manifest.maturity,
    renderer: manifest.renderer,
    questions: manifest.questions,
    roles: {
      required: catalogFamily.requiredRoles,
      optional: catalogFamily.optionalRoles,
      minimumRecords: manifest.data.minimumRecords,
      maximumRecords: manifest.data.maximumRecords,
    },
    grammar: manifest.grammar,
    transformations: {
      deterministic: manifest.transformation,
      enrichment: manifest.enrichment,
    },
    validation: manifest.validation,
    evidence: manifest.evidence,
    variants: manifest.variants,
    multiples: manifest.multiples,
    controls: manifest.controls,
    selections: manifest.selections,
    followUps: manifest.followUps,
    mediaAdapters: manifest.mediaAdapters,
    abstention: catalogFamily.abstention,
    members: catalogFamily.members.map((member) => browserMember(
      member,
      requireIndexed(authoredMembers, member.id, "authored member"),
    )),
  };
}

export function buildFormRuntimeProjection() {
  const governedModules = new Map(
    GOVERNED_FORM_MODULES.map((module) => [module.descriptor?.key, module]),
  );
  const forms = CATALOG_FAMILIES.flatMap((family) => family.members
    .filter((member) => member.status === "executable")
    .map((member) => {
      if (member.status === "rejected") {
        throw new Error(`Rejected member cannot enter the runtime: ${family.id}/${member.id}`);
      }
      if (
        typeof member.browserRendererModule !== "string"
        || !/^\.\/forms\/[a-z0-9-]+\/[a-z0-9-]+\.js$/u.test(member.browserRendererModule)
      ) {
        throw new Error(`Executable form ${family.id}/${member.id} has no governed browser handler`);
      }
      if (typeof member.fixtureId !== "string" || !member.fixtureId) {
        throw new Error(`Executable form ${family.id}/${member.id} has no governed fixture`);
      }
      const key = `${family.id}/${member.id}`;
      const governedModule = governedModules.get(key);
      if (!governedModule) throw new Error(`Executable form ${key} has no governed module`);
      return {
        key,
        familyId: family.id,
        memberId: member.id,
        receipt: {
          version: CATALOG_VERSION,
          family: family.id,
          member: member.id,
          rendererId: member.rendererId,
          rendererVersion: member.rendererVersion,
          rendererVariantId: member.rendererVariantId,
        },
        rendererModule: member.browserRendererModule,
        packageContract: {
          roles: governedModule.descriptor.roles,
          payload: governedModule.descriptor.payload,
        },
        fixtureId: member.fixtureId,
        fixture: governedModule.fixture,
        staticAssets: member.staticAssets ?? [],
      };
    }));
  const keys = new Set();
  const fixtures = new Set();
  for (const form of forms) {
    if (keys.has(form.key)) throw new Error(`Duplicate executable form key ${form.key}`);
    if (fixtures.has(form.fixtureId)) throw new Error(`Duplicate executable fixture ${form.fixtureId}`);
    keys.add(form.key);
    fixtures.add(form.fixtureId);
  }
  if (forms.length !== CATALOG_COUNTS.executable) {
    throw new Error(`Runtime form count ${forms.length} does not match catalog count ${CATALOG_COUNTS.executable}`);
  }
  const historicalReceipts = Object.entries(HISTORICAL_CATALOG_RECEIPTS)
    .flatMap(([version, table]) => Object.values(table).map((receipt) => ({ version, ...receipt })))
    .sort((left, right) => `${left.version}/${left.family}/${left.member}`.localeCompare(`${right.version}/${right.family}/${right.member}`));
  const historicalPresentationVariants = Object.fromEntries(historicalReceipts.map((receipt) => [
    `${receipt.version}/${receipt.family}/${receipt.member}`,
    historicalPresentationVariantForMember(receipt.version, receipt.family, receipt.member),
  ]));
  return toPlainData({
    schemaVersion: 1,
    catalogVersion: CATALOG_VERSION,
    counts: CATALOG_COUNTS,
    forms,
    historicalReceipts,
    historicalPackageContracts: HISTORICAL_PACKAGE_CONTRACTS,
    historicalPresentationVariants,
    rendererImports: Object.fromEntries(forms.map((form) => [form.key, form.rendererModule])),
    fixtureIndex: Object.fromEntries(forms.map((form) => [form.key, form.fixtureId])),
    staticAssets: [...new Set([
      "./family-catalog.js",
      "./form-registry.js",
      "./form-renderers.js",
      "./form-runtime-generated.js",
      "./forms/legacy.js",
      "./forms/shared.js",
      "./forms/hierarchy/partition.js",
      ...forms.map((form) => form.rendererModule),
      ...forms.flatMap((form) => form.staticAssets),
    ])].sort(),
    familyLabCoreAssets: FAMILY_LAB_CORE_ASSETS,
  });
}

async function assertRendererHandlers(runtime) {
  await Promise.all(runtime.staticAssets
    .filter((asset) => asset !== "./form-runtime-generated.js")
    .map(async (asset) => {
    if (typeof asset !== "string" || !asset.startsWith("./") || asset.split("/").includes("..")) {
      throw new Error(`Unsafe governed browser asset path: ${String(asset)}`);
    }
    const path = resolve(VIEWER_DIRECTORY, asset.slice(2));
    try {
      await access(path);
    } catch {
      throw new Error(`Missing governed browser asset: ${asset}`);
    }
  }));
  await Promise.all(runtime.forms.map(async (form) => {
    const path = resolve(VIEWER_DIRECTORY, form.rendererModule.slice(2));
    const module = await import(pathToFileURL(path).href);
    if (typeof module.default !== "function") {
      throw new Error(`Governed browser handler ${form.key} has no default renderer`);
    }
    const descriptor = module.descriptor;
    if (
      descriptor?.familyId !== form.familyId
      || descriptor?.memberId !== form.memberId
      || descriptor?.fixtureId !== form.fixtureId
    ) {
      throw new Error(`Governed browser handler is cross-wired for ${form.key}`);
    }
  }));
  await Promise.all(runtime.familyLabCoreAssets.map(async ({ route, file }) => {
    if (
      !/^core\/[a-z0-9-/]+\.js$/u.test(route)
      || !/^\.\.\/src\/[a-z0-9-/]+\.js$/u.test(file)
    ) {
      throw new Error(`Unsafe generated Family Lab core asset: ${route} -> ${file}`);
    }
    const path = resolve(VIEWER_DIRECTORY, file);
    const source = await readFile(path, "utf8").catch(() => null);
    if (source === null) throw new Error(`Missing generated Family Lab core asset: ${file}`);
    if (/(?:from\s+|import\()["']node:/u.test(source)) {
      throw new Error(`Family Lab core asset is not browser-safe: ${file}`);
    }
  }));
}

async function assertGovernedFormModules(runtime) {
  const modules = new Map(GOVERNED_FORM_MODULES.map((module) => [module.descriptor?.key, module]));
  if (modules.size !== runtime.forms.length || GOVERNED_FORM_MODULES.length !== runtime.forms.length) {
    throw new Error("Governed form module count does not match the generated runtime");
  }
  for (const form of runtime.forms) {
    const module = modules.get(form.key);
    if (!module) throw new Error(`Missing governed form module for ${form.key}`);
    const { descriptor, fixture } = module;
    if (
      descriptor.familyId !== form.familyId
      || descriptor.memberId !== form.memberId
      || descriptor.fixtureId !== form.fixtureId
      || fixture?.id !== form.fixtureId
      || fixture?.familyId !== form.familyId
      || fixture?.memberId !== form.memberId
      || !Array.isArray(fixture?.records)
      || fixture.records.length === 0
    ) {
      throw new Error(`Governed form module or fixture is cross-wired for ${form.key}`);
    }
    if (typeof module.projector !== "function" || typeof module.targetResolver !== "function") {
      throw new Error(`Governed form module ${form.key} is missing its projector or target resolver`);
    }
    const observations = fixture.records.map((roles, index) => ({
      id: `fixture_${index}`,
      markId: `mark_fixture_${index}`,
      sourceId: "source_fixture",
      roles,
      evidenceRefs: [`evidence_fixture_${index}`],
      media: form.key === "collection-atlas/contact-atlas"
        ? { type: "image", mimeType: "image/jpeg" }
        : { type: "numeric-chart" },
    }));
    const eligibility = evaluateFormEligibility(
      descriptor,
      observations,
      { adapter: { id: fixture.adapter, version: 1 } },
    );
    if (!eligibility.eligible) {
      throw new Error(`Governed fixture is ineligible for ${form.key}: ${eligibility.failedRequirements.map((item) => item.id).join(", ")}`);
    }
    const payload = await module.projector(observations);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`Governed projector returned no payload for ${form.key}`);
    }
  }
}

export function buildFamilyBrowserCatalog() {
  const authoredFamilies = new Map(AUTHORED_FAMILY_ATLAS_CONTENT.map((family) => [family.id, family]));
  const manifests = new Map(MAP_FAMILIES.map((family) => [family.id, family]));
  return toPlainData({
    schemaVersion: 1,
    catalogVersion: CATALOG_VERSION,
    counts: CATALOG_COUNTS,
    groups: MAP_FAMILY_GROUPS,
    media: CANONICAL_INPUT_MEDIA,
    families: CATALOG_FAMILIES.map((family) => browserFamily(
      family,
      requireIndexed(authoredFamilies, family.id, "authored content"),
      requireIndexed(manifests, family.id, "production manifest"),
    )),
  });
}

export function renderFamilyBrowserCatalogModule(catalog = buildFamilyBrowserCatalog()) {
  const json = JSON.stringify(catalog, null, 2);
  return `// Generated by scripts/build-family-browser-catalog.mjs. Do not edit.

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const FAMILY_BROWSER_CATALOG = deepFreeze(${json});

export default FAMILY_BROWSER_CATALOG;
`;
}

function renderRuntimeModule(runtime, target) {
  const json = JSON.stringify(runtime, null, 2);
  return `// Generated by scripts/build-family-browser-catalog.mjs for ${target}. Do not edit.\n\n` +
    "function deepFreeze(value) {\n  if (!value || typeof value !== \"object\" || Object.isFrozen(value)) return value;\n  for (const child of Object.values(value)) deepFreeze(child);\n  return Object.freeze(value);\n}\n\n" +
    `export const GENERATED_FORM_RUNTIME = deepFreeze(${json});\n\n` +
    "export default GENERATED_FORM_RUNTIME;\n";
}

export function renderBrowserFormRuntimeModule(runtime = buildFormRuntimeProjection()) {
  return renderRuntimeModule(runtime, "browser");
}

export function renderNodeFormRuntimeModule(runtime = buildFormRuntimeProjection()) {
  return renderRuntimeModule(runtime, "Node");
}

async function checkGeneratedModule(path, expected) {
  let actual;
  try {
    actual = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    actual = null;
  }
  if (actual === expected) return;
  process.stderr.write(`${path} is out of date. Run node scripts/build-family-browser-catalog.mjs.\n`);
  process.exitCode = 1;
}

async function main(arguments_) {
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
    throw new Error("Usage: node scripts/build-family-browser-catalog.mjs [--check]");
  }
  const runtime = buildFormRuntimeProjection();
  await assertGovernedFormModules(runtime);
  await assertRendererHandlers(runtime);
  const outputs = [
    [OUTPUT_PATH, renderFamilyBrowserCatalogModule()],
    [BROWSER_RUNTIME_OUTPUT_PATH, renderBrowserFormRuntimeModule(runtime)],
    [NODE_RUNTIME_OUTPUT_PATH, renderNodeFormRuntimeModule(runtime)],
  ];
  if (arguments_[0] === "--check") {
    await Promise.all(outputs.map(([path, source]) => checkGeneratedModule(path, source)));
    return;
  }
  await Promise.all(outputs.map(([path, source]) => writeFile(path, source, "utf8")));
  process.stdout.write("Wrote Attend's Node and browser form-runtime projections.\n");
}

const isDirectRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
