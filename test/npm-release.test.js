import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("the GitHub README links to a private-data-free visual gallery", async () => {
  const [readme, gallery] = await Promise.all([
    readFile(`${PACKAGE_ROOT}/README.md`, "utf8"),
    readFile(`${PACKAGE_ROOT}/docs/visual-gallery.md`, "utf8"),
  ]);
  const featured = ["distribution", "flow", "field", "collection-atlas"];
  const galleryImages = {
    "collection-atlas": "7ff208e538b3ab25acb365e2c330415d019aa4570781f6bf15098bf6e202f560",
    distribution: "3e3c523f1d33ff5fe10ff76109f44a0802d63cffdde25e202bf2e8fad4976414",
    field: "ca4af068473847de46239ed0007c7fc960f37b1df498b1e27432281428dcf527",
    flow: "1de447ca15e95bc8426c5d1b9f5c77d91f87956f4e49323e8c18a63b7ed3f743",
    network: "615f90d97b7e5e831ded00c59b18fe4d2f9deac59b9477f44a34afd1cf92c4ab",
    trend: "aaec7ecf759322ee8cefcda5024b6ba8b6331038ae82b6eca316da80bc474219",
  };

  assert.match(readme, /## What Attend can make/u);
  assert.match(readme, /Every label and value .* fabricated demo data/u);
  assert.match(readme, /No user files, accounts, or private sources/u);
  assert.match(readme, /\[Open the visual gallery\]\(docs\/visual-gallery\.md\)/u);
  for (const name of featured) {
    assert.match(readme, new RegExp(`docs/images/visual-gallery/${name}\\.png`, "u"));
  }
  for (const [name, expectedDigest] of Object.entries(galleryImages)) {
    const image = `${PACKAGE_ROOT}/docs/images/visual-gallery/${name}.png`;
    assert.match(gallery, new RegExp(`images/visual-gallery/${name}\\.png`, "u"));
    const contents = await readFile(image);
    assert.ok(contents.length > 10_000, `${name}.png is missing or empty`);
    const signature = contents.subarray(0, 8);
    assert.deepEqual(signature, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      expectedDigest,
      `${name}.png changed; complete a new privacy review before accepting it`,
    );
  }
  assert.doesNotMatch(
    readme + gallery,
    /\.context\/|Apple Notes|Meeting Lab|Bay Area|personal archive|\/Users\//iu,
  );
});
