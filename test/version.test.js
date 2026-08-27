import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PACKAGE_VERSION } from "../src/constants.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("runtime, package, and lockfile share one release identity", async () => {
  const [manifest, lock] = await Promise.all([
    readFile(`${PACKAGE_ROOT}/package.json`, "utf8").then(JSON.parse),
    readFile(`${PACKAGE_ROOT}/package-lock.json`, "utf8").then(JSON.parse),
  ]);
  assert.equal(PACKAGE_VERSION, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
});
