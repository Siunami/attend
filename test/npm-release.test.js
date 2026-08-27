import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the public package leads with a human-readable coding-agent install", async () => {
  const [manifest, readme] = await Promise.all([
    readFile(`${PACKAGE_ROOT}/package.json`, "utf8").then(JSON.parse),
    readFile(`${PACKAGE_ROOT}/README.md`, "utf8"),
  ]);

  assert.equal(manifest.version, "0.5.1");
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.equal(manifest.homepage, "https://www.npmjs.com/package/attend-local");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/Siunami/attend-local.git",
  });
  const agentHeading = "## Install with a coding agent";
  const terminalHeading = "## Install from a terminal";
  assert.ok(readme.indexOf(agentHeading) < readme.indexOf(terminalHeading));

  const prompt = readme.match(
    /## Install with a coding agent[\s\S]*?```text\n(?<prompt>[\s\S]*?)\n```/u,
  )?.groups?.prompt;
  assert.ok(prompt, "coding-agent prompt is missing");
  assert.ok(prompt.split(/\s+/u).length <= 180, "coding-agent prompt is too long");
  assert.match(prompt, /npm install --global attend-local@0\.5\.1/u);
  assert.match(prompt, /attend bootstrap --yes/u);
  assert.match(prompt, /show me the output/iu);
  assert.match(prompt, /show me the actual error/iu);
  assert.match(prompt, /roughly 12 GB/u);
  assert.doesNotMatch(
    prompt,
    /--json|ok: true|packageVersion|doctor\.ok|readiness|catalog counts/iu,
  );
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
