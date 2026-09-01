#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = Object.freeze([
  "package.json",
  "package-lock.json",
  "src/constants.js",
  "agent-skill/attend-visualize/SKILL.md",
  "system-atlas/data.js",
  "README.md",
  "test/server.test.js",
  "test/service.test.js",
  "test/distribution.test.js",
  "test/npm-release.test.js",
  "test/mcp-server.test.js",
  "test/opportunity-store.test.js",
  "test/opportunity-cli.test.js",
]);

const SEMVER = /^\d+\.\d+\.\d+$/u;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const next = args.find((arg) => !arg.startsWith("--"));

if (!next || !SEMVER.test(next)) {
  console.error("Usage: node scripts/set-version.mjs <major.minor.patch> [--apply]");
  process.exit(1);
}

const current = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
if (current === next) {
  console.log(`Already at ${next}. Nothing to do.`);
  process.exit(0);
}

const escaped = current.replace(/\./gu, "\\.");
const pattern = new RegExp(escaped, "gu");
// A version written inside a regex literal carries escaped dots in the source
// text, which the literal pattern above cannot see. Rewrite it to the escaped
// next version so the replacement stays a valid regex rather than a wildcard.
const sourceEscapedPattern = new RegExp(escaped.replace(/\\\./gu, "\\\\\\."), "gu");
const nextEscaped = next.replace(/\./gu, "\\.");
const changes = [];

for (const relative of TARGETS) {
  const file = path.join(ROOT, relative);
  const before = readFileSync(file, "utf8");
  const after = before.replace(sourceEscapedPattern, nextEscaped).replace(pattern, next);
  if (before === after) continue;
  const hits = (before.match(pattern)?.length ?? 0) + (before.match(sourceEscapedPattern)?.length ?? 0);
  changes.push({ relative, hits });
  if (apply) writeFileSync(file, after);
}

const stale = TARGETS.filter((relative) => !changes.some((change) => change.relative === relative));

console.log(`${apply ? "Set" : "Would set"} version ${current} to ${next}:`);
for (const { relative, hits } of changes) console.log(`  ${relative} (${hits})`);
if (stale.length) console.log(`\nNo occurrence found in:\n  ${stale.join("\n  ")}`);

console.log(
  apply
    ? "\nCHANGELOG.md is untouched by design. Move its Unreleased entries under a new release heading by hand, then run npm run verify."
    : "\nRe-run with --apply to write.",
);
