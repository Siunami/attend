import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { CATALOG_COUNTS, listCatalogFamilies } from "../src/catalog/index.js";

const DISTRIBUTION_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(DISTRIBUTION_ROOT, "..");
const DEFAULT_OUTPUT = join(DISTRIBUTION_ROOT, ".deploy");
const DEFAULT_BASE_URL = "https://attend-cli.matthewwilsonsiu.workers.dev";
const TOKEN = /\{\{([A-Z0-9_]+)\}\}/gu;
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function parseArguments(argv) {
  const options = { output: DEFAULT_OUTPUT, baseUrl: DEFAULT_BASE_URL };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output" || argument === "--base-url" || argument === "--retain-from") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(argument + " requires a value");
      const key = argument === "--output"
        ? "output"
        : argument === "--base-url"
          ? "baseUrl"
          : "retainFrom";
      options[key] = value;
      index += 1;
      continue;
    }
    throw new Error("Unknown argument: " + argument);
  }
  const baseUrl = String(options.baseUrl).replace(/\/+$/u, "");
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/iu.test(baseUrl)) {
    throw new Error("--base-url must be an HTTPS origin without a path");
  }
  return {
    output: resolve(options.output),
    baseUrl,
    ...(options.retainFrom ? { retainFrom: resolve(options.retainFrom) } : {}),
  };
}

function npmPack(destination) {
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "npm pack failed");
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack returned an unexpected result");
  }
  return parsed[0];
}

function auditPackage(pack, packageJson) {
  const files = Array.isArray(pack.files) ? pack.files.map((file) => file.path) : [];
  const forbidden = files.filter((path) =>
    /(^|\/)(?:\.attend|\.context|\.git|distribution|test|node_modules)(?:\/|$)/u.test(path),
  );
  if (forbidden.length) {
    throw new Error("Refusing to release private or development files: " + forbidden.join(", "));
  }
  const required = [
    "package.json",
    "README.md",
    "bin/attend.js",
    "agent-skill/attend-visualize/SKILL.md",
    "viewer/index.html",
    "viewer/app.js",
    "viewer/styles.css",
    "viewer/package-model.js",
    "viewer/package-renderer.js",
    "viewer/family-renderers.js",
    "viewer/vendor/d3.min.js",
    "viewer/vendor/topojson-client.min.js",
    "viewer/vendor/us-states.json",
    "viewer/vendor/us-counties.json",
    "viewer/vendor/world-countries.json",
    "viewer/vendor/THIRD_PARTY_NOTICES.md",
    "viewer/vendor/licenses/d3-7.9.0.txt",
    "viewer/vendor/licenses/topojson-client-3.1.0.txt",
    "viewer/vendor/licenses/us-atlas-3.0.1.txt",
    "viewer/vendor/licenses/world-atlas-2.0.2.txt",
  ];
  const missing = required.filter((path) => !files.includes(path));
  if (missing.length) {
    throw new Error("Release package is missing required files: " + missing.join(", "));
  }
  if (Object.keys(packageJson.dependencies ?? {}).length) {
    throw new Error("Release package must not require runtime npm dependencies");
  }
  if (packageJson.license !== "UNLICENSED") {
    throw new Error("Release package license must remain UNLICENSED");
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function releaseManifest(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Retained release has an invalid manifest at ${path}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Retained release manifest must be an object: ${path}`);
  }
  return value;
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Retained release entry must be a regular file: ${path}`);
  return info;
}

function releaseUrlPath(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Retained release ${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.search || url.hash) {
    throw new Error(`Retained release ${label} must be a plain HTTPS URL`);
  }
  return url.pathname;
}

async function validateRetainedRelease(directory, version) {
  const manifestPath = join(directory, "manifest.json");
  const manifest = await releaseManifest(manifestPath);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "attend-cli-release" ||
    manifest.package !== "attend-local" ||
    manifest.version !== version
  ) {
    throw new Error(`Retained release manifest does not match releases/${version}`);
  }

  const filename = `attend-local-${version}.tgz`;
  if (manifest.tarball?.filename !== filename) {
    throw new Error(`Retained release ${version} has an unexpected tarball filename`);
  }
  if (releaseUrlPath(manifest.tarball?.url, "tarball URL") !== `/releases/${version}/${filename}`) {
    throw new Error(`Retained release ${version} tarball URL does not match its version`);
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.tarball?.sha256 ?? "")) {
    throw new Error(`Retained release ${version} has an invalid SHA-256 digest`);
  }
  if (!Number.isSafeInteger(manifest.tarball?.bytes) || manifest.tarball.bytes < 1) {
    throw new Error(`Retained release ${version} has an invalid byte count`);
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
  const promptName = "install-prompt.txt";
  const scriptName = "install.sh";
  const hasPrompt = names.includes(promptName);
  const hasScript = names.includes(scriptName);
  if (hasPrompt !== hasScript) {
    throw new Error(`Retained release ${version} must keep its prompt and installer together`);
  }
  const expected = ["SHA256SUMS", filename, "manifest.json"];
  if (hasPrompt) expected.push(promptName, scriptName);
  expected.sort((left, right) => left.localeCompare(right));
  if (
    entries.some((entry) => !entry.isFile()) ||
    names.length !== expected.length ||
    names.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`Retained release ${version} contains an unexpected entry`);
  }

  await Promise.all(names.map((name) => assertRegularFile(join(directory, name))));
  const archivePath = join(directory, filename);
  const archiveInfo = await lstat(archivePath);
  if (archiveInfo.size !== manifest.tarball.bytes) {
    throw new Error(`Retained release ${version} byte count does not match its archive`);
  }
  if (await sha256(archivePath) !== manifest.tarball.sha256) {
    throw new Error(`Retained release ${version} digest does not match its archive`);
  }
  const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
  if (sums !== `${manifest.tarball.sha256}  ${filename}\n`) {
    throw new Error(`Retained release ${version} has an invalid SHA256SUMS file`);
  }

  const promptPath = join(directory, promptName);
  if (hasPrompt) {
    if (
      releaseUrlPath(manifest.installPromptUrl, "install prompt URL") !==
      `/releases/${version}/${promptName}`
    ) {
      throw new Error(`Retained release ${version} prompt URL does not match its version`);
    }
    const prompt = await readFile(promptPath, "utf8");
    if (!prompt.trim() || Buffer.byteLength(prompt) > 64 * 1024) {
      throw new Error(`Retained release ${version} has an invalid install prompt`);
    }
    if (
      releaseUrlPath(manifest.installScriptUrl, "install script URL") !==
      `/releases/${version}/${scriptName}`
    ) {
      throw new Error(`Retained release ${version} installer URL does not match its version`);
    }
    const script = await readFile(join(directory, scriptName), "utf8");
    if (!script.startsWith("#!/bin/sh\n") || Buffer.byteLength(script) > 128 * 1024) {
      throw new Error(`Retained release ${version} has an invalid install script`);
    }
  } else if (
    releaseUrlPath(manifest.installPromptUrl, "legacy install prompt URL") !== "/install-prompt.txt" ||
    manifest.installScriptUrl !== undefined
  ) {
    throw new Error(`Retained legacy release ${version} has an invalid install prompt URL`);
  }

  return { directory, manifest, names };
}

async function snapshotRetainedReleases(source, destination, { optional = false } = {}) {
  if (!source) return new Map();
  let entries;
  try {
    entries = await readdir(join(source, "releases"), { withFileTypes: true });
  } catch (error) {
    if (optional && error?.code === "ENOENT") return new Map();
    throw new Error(`Cannot read retained releases from ${source}: ${error.message}`);
  }
  if (entries.some((entry) => !entry.isDirectory() || !RELEASE_VERSION.test(entry.name))) {
    throw new Error(`Retained releases at ${source} contain an invalid version directory`);
  }

  const retained = new Map();
  await mkdir(destination, { recursive: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const release = await validateRetainedRelease(join(source, "releases", entry.name), entry.name);
    const copied = join(destination, entry.name);
    await cp(release.directory, copied, { recursive: true, dereference: false, errorOnExist: true });
    retained.set(entry.name, { ...release, directory: copied });
  }
  return retained;
}

function render(template, values) {
  return template.replace(TOKEN, (_match, key) => {
    if (!Object.hasOwn(values, key)) throw new Error("Unknown release template token: " + key);
    return values[key];
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function catalogReleaseReceipt() {
  return {
    counts: { ...CATALOG_COUNTS },
    families: listCatalogFamilies().map((family) => {
      const member = family.members.find(
        (candidate) => candidate.status === "executable" || candidate.status === "unavailable",
      );
      if (!member) throw new Error(`Catalog family ${family.id} has no release status`);
      return {
        id: family.id,
        member: member.id,
        status: member.status,
      };
    }),
  };
}

function installPrompt({ version, installScriptUrl, digest, catalog }) {
  const counts = catalog.counts;
  const catalogSummary = [
    `${counts.families} families`,
    `${counts.executable} executable`,
    `${counts.unavailable ?? 0} unavailable`,
  ].join(", ");
  return [
    "Install Attend Local " + version + " in this project for me.",
    "",
    "Treat the current repository as the only project root. Do not upload its files or scan outside it.",
    "",
    "1. Check that Node.js 22 or newer and npm are available. If not, stop and tell me what is missing.",
    "2. From this project's root, run exactly: curl -fsSL " + installScriptUrl + " | sh",
    "3. Require the installer to exit successfully. It downloads the pinned tarball and requires its SHA-256 digest to equal " + digest + ". Do not bypass or reimplement those checks. If it fails, stop and report the failure.",
    "4. Check codex --version and codex login status. Attend's automatic sidebar chat requires an installed, signed-in Codex CLI. If Codex is missing, use the official installation guidance at https://developers.openai.com/codex/cli/. If interactive sign-in is required, pause and ask me to complete it.",
    "5. Use attend when it is on PATH; otherwise use $HOME/.local/bin/attend. From this project's root, run attend setup --json, attend doctor --json, and attend families --json.",
    "6. Confirm that attend --version reports " + version + ", setup installed the managed attend-visualize skill at both .agents/skills/ and .claude/skills/, the catalog receipt is exactly " + catalogSummary + ", doctor returns ok: true, and its codex-chat check passes. One explicit capability abstention is expected in this release; do not describe it as executable. Do not call automatic sidebar chat ready when the Codex check only warns.",
    "7. Keep the skill installed. For future visualization questions, follow it: inspect the full 19-family Attend catalog, choose only a member marked executable, transform explicitly authorized local evidence into its declarative request, run Attend, and open the returned local artifact URL. Preserve any explicit capability abstention. Never generate custom chart code.",
    "",
    "Report the installed version and any failed check. Do not substitute another package, repository checkout, or visualization library.",
  ].join("\n");
}

async function prepareOutput(output) {
  if (output === DEFAULT_OUTPUT) {
    await rm(output, { recursive: true, force: true });
  } else {
    await stat(output)
      .then(() => {
        throw new Error("Refusing to replace explicit output directory: " + output);
      })
      .catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
  }
  await mkdir(output, { recursive: true });
}

async function assertSameVersionRelease(release, { manifest, prompt, installer, checksum }) {
  if (!release.names.includes("install-prompt.txt") || !release.names.includes("install.sh")) {
    throw new Error(
      `Release ${manifest.version} already exists without a versioned install prompt; bump the package version`,
    );
  }
  const retainedPrompt = await readFile(join(release.directory, "install-prompt.txt"), "utf8");
  const retainedInstaller = await readFile(join(release.directory, "install.sh"), "utf8");
  const retainedChecksum = await readFile(join(release.directory, "SHA256SUMS"), "utf8");
  if (
    JSON.stringify(release.manifest) !== JSON.stringify(manifest) ||
    retainedPrompt !== prompt + "\n" ||
    retainedInstaller !== installer ||
    retainedChecksum !== checksum
  ) {
    throw new Error(
      `Release ${manifest.version} already exists with different contents; bump the package version`,
    );
  }
}

async function main() {
  const { output, baseUrl, retainFrom } = parseArguments(process.argv.slice(2));
  const temporary = await mkdtemp(join(tmpdir(), "attend-release-"));
  try {
    const packageJson = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
    const pack = npmPack(temporary);
    auditPackage(pack, packageJson);
    if (pack.name !== packageJson.name || pack.version !== packageJson.version) {
      throw new Error("npm pack identity does not match package.json");
    }

    const archiveSource = join(temporary, pack.filename);
    const digest = await sha256(archiveSource);
    const versionDirectory = "releases/" + packageJson.version;
    const tarballPath = versionDirectory + "/" + pack.filename;
    const tarballUrl = baseUrl + "/" + tarballPath;
    const manifestUrl = baseUrl + "/" + versionDirectory + "/manifest.json";
    const installScriptUrl = baseUrl + "/" + versionDirectory + "/install.sh";
    const catalog = catalogReleaseReceipt();
    const prompt = installPrompt({
      version: packageJson.version,
      tarballUrl,
      manifestUrl,
      installScriptUrl,
      digest,
      catalog,
    });
    const installerTemplate = await readFile(
      join(DISTRIBUTION_ROOT, "site", "install.template.sh"),
      "utf8",
    );
    const installer = render(installerTemplate, {
      VERSION: packageJson.version,
      SHA256: digest,
      TARBALL_URL: tarballUrl,
      CATALOG_RECEIPT: JSON.stringify(catalog),
    });
    const manifest = {
      schemaVersion: 1,
      kind: "attend-cli-release",
      package: packageJson.name,
      version: packageJson.version,
      engines: packageJson.engines,
      tarball: {
        filename: pack.filename,
        url: tarballUrl,
        sha256: digest,
        bytes: pack.size,
        integrity: pack.integrity,
      },
      catalog,
      installPromptUrl: baseUrl + "/" + versionDirectory + "/install-prompt.txt",
      installScriptUrl,
    };

    const encodedManifest = JSON.stringify(manifest, null, 2) + "\n";
    const checksum = digest + "  " + pack.filename + "\n";
    const retentionSource = retainFrom ?? (output === DEFAULT_OUTPUT ? output : undefined);
    const retained = await snapshotRetainedReleases(
      retentionSource,
      join(temporary, "retained-releases"),
      { optional: retainFrom === undefined },
    );
    const sameVersion = retained.get(packageJson.version);
    if (sameVersion) {
      await assertSameVersionRelease(sameVersion, { manifest, prompt, installer, checksum });
    }

    await prepareOutput(output);
    await cp(join(DISTRIBUTION_ROOT, "site"), output, { recursive: true });
    await mkdir(join(output, "releases"), { recursive: true });
    for (const [version, release] of retained) {
      await cp(release.directory, join(output, "releases", version), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
      });
    }
    if (!sameVersion) {
      await mkdir(join(output, versionDirectory), { recursive: true });
      await copyFile(archiveSource, join(output, tarballPath));
      await writeFile(join(output, versionDirectory, "manifest.json"), encodedManifest);
      await writeFile(join(output, versionDirectory, "SHA256SUMS"), checksum);
      await writeFile(join(output, versionDirectory, "install-prompt.txt"), prompt + "\n");
      await writeFile(join(output, versionDirectory, "install.sh"), installer);
    }
    await writeFile(join(output, "latest.json"), encodedManifest);
    await writeFile(join(output, "install-prompt.txt"), prompt + "\n");
    await writeFile(join(output, "install.sh"), installer);
    await rm(join(output, "install.template.sh"));

    const templatePath = join(output, "index.template.html");
    const template = await readFile(templatePath, "utf8");
    await writeFile(join(output, "index.html"), render(template, {
      VERSION: escapeHtml(packageJson.version),
      SHA256: escapeHtml(digest),
      TARBALL_URL: escapeHtml(tarballUrl),
      MANIFEST_URL: escapeHtml(manifestUrl),
      INSTALL_SCRIPT_URL: escapeHtml(installScriptUrl),
      INSTALL_PROMPT: escapeHtml(prompt),
    }));
    await rm(templatePath);

    process.stdout.write(JSON.stringify({
      output,
      retainedVersions: [...retained.keys()],
      manifest,
    }, null, 2) + "\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
