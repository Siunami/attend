# Attend Local release site

This directory publishes a versioned npm tarball and its SHA-256 receipt as a
Cloudflare Workers static-assets site. It never contains a corpus, session,
private evidence store, npm credentials, or repository checkout.

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
