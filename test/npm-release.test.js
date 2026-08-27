import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the public package and coding-agent prompt use npm as the only install origin", async () => {
  const [manifest, readme] = await Promise.all([
    readFile(`${PACKAGE_ROOT}/package.json`, "utf8").then(JSON.parse),
    readFile(`${PACKAGE_ROOT}/README.md`, "utf8"),
  ]);

  assert.equal(manifest.version, "0.5.0");
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.equal(manifest.homepage, "https://www.npmjs.com/package/attend-local");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/Siunami/attend-local.git",
  });
  assert.match(readme, /npm install --global attend-local@0\.5\.0/u);
  assert.match(readme, /attend bootstrap --yes --json/u);
  assert.match(readme, /roughly 12 GB/u);
  assert.match(readme, /## Install with a coding agent/u);
  assert.doesNotMatch(readme, /workers\.dev|curl -fsSL/u);
});

test("the dedicated release workflow publishes verified tags with npm OIDC", async () => {
  const workflow = await readFile(
    `${PACKAGE_ROOT}/.github/workflows/publish.yml`,
    "utf8",
  );

  assert.match(workflow, /release:\s*\n\s+types: \[published\]/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /npm run verify/u);
  assert.match(workflow, /npm publish --access public/u);
  assert.match(workflow, /GITHUB_REF_NAME/u);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/u);
});
