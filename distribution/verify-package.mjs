import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditPackage } from "./package-audit.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageRoot,
  encoding: "utf8",
  env: process.env,
});
if (packed.status !== 0) {
  throw new Error(packed.stderr.trim() || packed.stdout.trim() || "npm pack --dry-run failed");
}
const parsed = JSON.parse(packed.stdout);
if (!Array.isArray(parsed) || parsed.length !== 1) {
  throw new Error("npm pack --dry-run returned an unexpected result");
}
const pack = parsed[0];
auditPackage(pack, packageJson);
if (pack.name !== packageJson.name || pack.version !== packageJson.version) {
  throw new Error("npm pack identity does not match package.json");
}
process.stdout.write(
  `${pack.name}@${pack.version}: ${pack.entryCount} files, ${pack.size} packed bytes, ${pack.unpackedSize} unpacked bytes\n`,
);
