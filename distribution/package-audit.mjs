import { GENERATED_FORM_RUNTIME } from "../src/catalog/generated-form-runtime.js";

const REQUIRED_PACKAGE_FILES = Object.freeze([
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "docs/getting-started.md",
  "bin/attend.js",
  "agent-skill/attend-visualize/SKILL.md",
  "agent-skill/attend-visualize/agents/openai.yaml",
  "src/opportunity-store.js",
  "viewer/index.html",
  "viewer/app.js",
  "viewer/styles.css",
  "viewer/workspace.html",
  "viewer/workspace.js",
  "viewer/workspace.css",
  "viewer/package-model.js",
  "viewer/package-renderer.js",
  "viewer/family-renderers.js",
  "viewer/family-catalog.js",
  "viewer/form-runtime-generated.js",
  "src/catalog/generated-form-runtime.js",
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
  "src/media/vendor/exifr-7.1.3.esm.mjs",
  "viewer/vendor/licenses/exifr-7.1.3.txt",
  ...GENERATED_FORM_RUNTIME.staticAssets.map((path) => `viewer/${path.slice(2)}`),
  ...GENERATED_FORM_RUNTIME.familyLabCoreAssets.map(({ file }) => file.slice(3)),
]);

export function auditPackage(pack, packageJson) {
  const files = Array.isArray(pack.files) ? pack.files.map((file) => file.path) : [];
  const forbidden = files.filter((path) =>
    /^(?:\.attend|\.context|\.git|distribution|test|node_modules)(?:\/|$)/u.test(path) ||
    /\/(?:\.attend|\.context|\.git|node_modules)(?:\/|$)/u.test(path),
  );
  if (forbidden.length) {
    throw new Error(`Refusing to release private or development files: ${forbidden.join(", ")}`);
  }
  const missing = REQUIRED_PACKAGE_FILES.filter((path) => !files.includes(path));
  if (missing.length) {
    throw new Error(`Release package is missing required files: ${missing.join(", ")}`);
  }
  if (Object.keys(packageJson.dependencies ?? {}).length) {
    throw new Error("Release package must not require runtime npm dependencies");
  }
  if (packageJson.license !== "MIT") {
    throw new Error("Release package must declare the MIT license");
  }
}
