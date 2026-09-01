import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { auditPackage } from "./package-audit.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "attend-packed-release-"));
let viewer;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`);
  }
  return result.stdout;
}

async function importFrom(root, relativePath) {
  return import(pathToFileURL(join(root, relativePath)).href);
}

async function requireOk(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response;
}

try {
  const parsed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temporaryRoot]));
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack returned an unexpected result");
  }
  const pack = parsed[0];
  auditPackage(pack, packageJson);
  if (pack.name !== packageJson.name || pack.version !== packageJson.version) {
    throw new Error("npm pack identity does not match package.json");
  }

  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot);
  run("tar", ["-xzf", join(temporaryRoot, pack.filename), "-C", extractedRoot]);
  const installedRoot = join(extractedRoot, "package");
  await access(join(installedRoot, "package.json"));
  await access(join(installedRoot, "node_modules")).then(
    () => { throw new Error("packed release unexpectedly contains node_modules"); },
    () => {},
  );

  const [{ catalogReceiptForMember }, { governedFormModule }, { compileMap }, sessionStore, serverModule, browserModel] = await Promise.all([
    importFrom(installedRoot, "src/catalog/index.js"),
    importFrom(installedRoot, "src/forms/governed.js"),
    importFrom(installedRoot, "src/pipeline/compile.js"),
    importFrom(installedRoot, "src/session-store.js"),
    importFrom(installedRoot, "src/server.js"),
    importFrom(installedRoot, "viewer/package-model.js"),
  ]);
  const governed = governedFormModule("rank", "bar-list");
  const sourceId = "source_packed_release";
  const sourceBundle = {
    kind: "attend-normalized-source-bundle",
    schemaVersion: 1,
    adapter: { id: "evidenced-records-v1", version: 1 },
    medium: "structured",
    requestedInputs: ["fixtures/packed-release.jsonl"],
    sources: [{
      id: sourceId,
      displayPath: "fixtures/packed-release.jsonl",
      sha256: "a".repeat(64),
      kind: "normalized-records",
      byteLength: 4_096,
    }],
    records: governed.fixture.records.map((fields, index) => ({
      id: `record_packed_${String(index + 1).padStart(3, "0")}`,
      sourceId,
      fields,
      evidenceRefs: [{
        sourceId,
        locator: { kind: "row", index },
        quote: Object.values(fields).map(String).join(" · "),
      }],
    })),
  };
  const presentRoles = new Set(governed.fixture.records.flatMap((record) => Object.keys(record)));
  const roleMapping = Object.fromEntries(
    [...governed.descriptor.roles.required, ...governed.descriptor.roles.optional]
      .map((role) => role.id)
      .filter((role) => presentRoles.has(role))
      .map((role) => [role, role]),
  );
  const dataPackage = await compileMap({
    familyId: "rank",
    catalog: catalogReceiptForMember("rank", "bar-list"),
    question: { text: "Which packed fixture values rank highest?", target: "Packed release" },
    sourceBundle,
    roleMapping,
  });
  if (!browserModel.isAtlasPackage(dataPackage)) {
    throw new Error("packed browser package model rejected its compiled exact-form package");
  }

  const projectRoot = join(temporaryRoot, "project");
  await mkdir(projectRoot);
  const session = await sessionStore.createSession({
    root: projectRoot,
    id: "packed_release_smoke",
    dataPackage,
  });
  viewer = await serverModule.createViewerServer({
    root: projectRoot,
    assetsDir: join(installedRoot, "viewer"),
    token: "packed-release-token-0123456789",
    instanceId: "packed-release-instance-0123456789",
    chatCapability: async () => ({
      defaultRoute: "host",
      active: {
        kind: "host",
        label: "Packed release smoke",
        ownership: "unattached",
        listener: "not-listening",
        registered: false,
        disclosure: "Packed release smoke test.",
      },
    }),
  });
  const sessionUrl = new URL(`s/${session.id}/`, viewer.libraryUrl);
  const [page, catalogAsset, runtimeAsset, rendererAsset, coreAsset, packageResponse] = await Promise.all([
    requireOk(sessionUrl, "packed viewer page"),
    requireOk(new URL("family-catalog.js", sessionUrl), "packed browser catalog"),
    requireOk(new URL("form-runtime-generated.js", sessionUrl), "packed form runtime"),
    requireOk(new URL("form-renderers.js", sessionUrl), "packed form renderers"),
    requireOk(new URL("families/core/catalog/index.js", viewer.libraryUrl), "packed browser compiler core"),
    requireOk(new URL("api/data", sessionUrl), "packed package API"),
  ]);
  if (!(await page.text()).includes("Attend")) throw new Error("packed viewer page is not the Attend shell");
  if (!(await catalogAsset.text()).includes("FAMILY_BROWSER_CATALOG")) throw new Error("packed browser catalog is malformed");
  if (!(await runtimeAsset.text()).includes("GENERATED_FORM_RUNTIME")) throw new Error("packed form runtime is malformed");
  if (!(await rendererAsset.text()).includes("renderCatalogForm")) throw new Error("packed form renderer registry is malformed");
  if (!(await coreAsset.text()).includes("CATALOG_VERSION")) throw new Error("packed browser compiler core is malformed");
  const servedPackage = await packageResponse.json();
  if (servedPackage?.catalog?.family !== "rank" || servedPackage?.catalog?.member !== "bar-list") {
    throw new Error("packed package API returned the wrong exact form");
  }

  process.stdout.write(
    `${pack.name}@${pack.version}: ${pack.entryCount} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes; extracted viewer smoke passed without node_modules\n`,
  );
} finally {
  await viewer?.close().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true });
}
