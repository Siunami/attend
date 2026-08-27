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

  assert.equal(manifest.version, "0.5.2");
  assert.equal(manifest.name, "@siunami/attend");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.author, "Siunami");
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/Siunami/attend/issues",
  });
  assert.ok(manifest.files.includes("CHANGELOG.md"));
  assert.ok(manifest.files.includes("LICENSE"));
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
    provenance: true,
  });
  assert.equal(manifest.homepage, "https://github.com/Siunami/attend#readme");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/Siunami/attend.git",
  });
  const agentHeading = "## Install with a coding agent";
  const terminalHeading = "## Install from a terminal";
  assert.ok(readme.indexOf(agentHeading) < readme.indexOf(terminalHeading));

  const prompt = readme.match(
    /## Install with a coding agent[\s\S]*?```text\n(?<prompt>[\s\S]*?)\n```/u,
  )?.groups?.prompt;
  assert.ok(prompt, "coding-agent prompt is missing");
  assert.ok(prompt.split(/\s+/u).length <= 180, "coding-agent prompt is too long");
  assert.match(prompt, /npm install --global @siunami\/attend@0\.5\.2/u);
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

test("the public package states its license and release history", async () => {
  const [license, changelog, readme] = await Promise.all([
    readFile(`${PACKAGE_ROOT}/LICENSE`, "utf8"),
    readFile(`${PACKAGE_ROOT}/CHANGELOG.md`, "utf8"),
    readFile(`${PACKAGE_ROOT}/README.md`, "utf8"),
  ]);

  assert.match(license, /^MIT License$/mu);
  assert.match(license, /Copyright \(c\) 2026 Siunami/u);
  assert.match(changelog, /## \[0\.5\.2\] - 2026-08-27/u);
  assert.match(readme, /## License[\s\S]*\[MIT License\]\(LICENSE\)/u);
});

test("the canonical release workflow publishes verified tags with npm OIDC", async () => {
  const workflow = await readFile(
    `${PACKAGE_ROOT}/.github/workflows/publish.yml`,
    "utf8",
  );

  assert.match(workflow, /release:\s*\n\s+types: \[published\]/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /npm run verify/u);
  assert.match(workflow, /npm publish --access public/u);
  assert.match(workflow, /npm@\^11\.5\.1/u);
  assert.match(workflow, /npm view "\$package_name@\$package_version" version/u);
  assert.match(workflow, /already-published=true/u);
  assert.match(workflow, /already-published != 'true'/u);
  assert.match(workflow, /GITHUB_REF_NAME/u);
  assert.match(workflow, /github\.repository == 'Siunami\/attend'/u);
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40}/u);
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/u);
  assert.doesNotMatch(workflow, /Siunami\/attend-local/u);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/u);
});

test("continuous verification runs the package gate on supported Node versions", async () => {
  const workflow = await readFile(
    `${PACKAGE_ROOT}/.github/workflows/ci.yml`,
    "utf8",
  );

  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /branches: \[main\]/u);
  assert.match(workflow, /node: \["22", "24"\]/u);
  assert.match(workflow, /npm audit --omit=dev/u);
  assert.match(workflow, /npm run verify/u);
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40}/u);
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40}/u);
  assert.doesNotMatch(workflow, /pull_request_target|write-all/u);
});

test("the repository offers private security reporting", async () => {
  const policy = await readFile(
    `${PACKAGE_ROOT}/.github/SECURITY.md`,
    "utf8",
  );

  assert.match(policy, /security\/advisories\/new/u);
  assert.match(policy, /Do not open a public issue/u);
  assert.doesNotMatch(policy, /@gmail\.|@icloud\.|@me\./iu);
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
