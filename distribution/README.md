# Legacy Attend release site

Attend 0.5.0 and later publishes through npm. The release workflow in
`.github/workflows/publish.yml` verifies a GitHub release tag, runs the full
test and package audit, and publishes with npm trusted publishing.

## Cutting a release

The version string is pinned in eighteen places across thirteen files, including
`src/constants.js`, the managed `SKILL.md`, the README install commands, and seven
test files. Do not edit them by hand:

    node scripts/set-version.mjs <major.minor.patch>          # dry run
    node scripts/set-version.mjs <major.minor.patch> --apply

It leaves `CHANGELOG.md` alone by design. Move the `Unreleased` entries under a new
dated heading yourself, then run `npm run verify`.

The published tarball is defined by `files` in `package.json` and enforced by
`REQUIRED_PACKAGE_FILES` in `package-audit.mjs`. The audit fails closed on any
`.attend`, `.context`, `.git`, `distribution`, `test`, or `node_modules` path, so a
private corpus cannot reach npm. Add a new user-facing document to both lists or it
will not ship.

Publishing runs from this repository. Commit, tag `v<version>`, push, and then
create a GitHub Release for that tag. The release is required:
`.github/workflows/publish.yml` triggers on `release: published`, not on a tag push,
so pushing a tag by itself publishes nothing. The workflow refuses any release whose
tag does not equal the `package.json` version, runs the full test and package audit,
skips cleanly when the version is already on npm, and otherwise publishes with npm
trusted publishing. When this repository is maintained
as a mirror of a larger working tree, mirror it with a script that excludes
`.attend`, `.context`, and `node_modules`, never a hand-typed `rsync`. A stray copy
can put a private corpus into a public repository.

## Legacy static site

Keep this directory for the immutable `attend-local` release URLs issued before
the npm cutover. Do not remove an existing release or republish a released version.
The staged site never contains a corpus, session, private evidence store, npm
credentials, or repository checkout.

To verify the npm package without publishing it, run:

    npm run verify

This builds and extracts the real tarball, starts the extracted viewer without
`node_modules`, checks its published module graph, and then runs the exact-form
browser matrix in addition to the Node test suite.

The commands below rebuild the legacy static site only. Do not use them for a
new npm release.

Run these commands from attend-cli:

    node distribution/stage-release.mjs
    cd distribution
    npx --yes wrangler@4.34.0 deploy --dry-run
    npx --yes wrangler@4.34.0 deploy

The staging command runs npm pack, audits the package file list, and creates the
ignored distribution/.deploy directory. It writes the versioned tarball,
manifest, checksum file, versioned installer and prompt, latest installer and
prompt, and release page in one pass. Existing validated releases in `.deploy/releases/`
survive later staging runs. A same-version archive or prompt cannot change;
bump the package version instead. The Cloudflare deployment is pure static
assets with 404 handling, so an unknown version cannot fall through to the
latest tarball.

For an isolated verification build, pass a directory that does not exist:

    node distribution/stage-release.mjs --output /tmp/attend-release-check

To carry releases from a different validated deployment directory into a new
output directory, pass it explicitly:

    node distribution/stage-release.mjs \
      --output /tmp/attend-release-next \
      --retain-from /tmp/attend-release-previous
