#!/bin/sh
set -eu

ATTEND_VERSION='{{VERSION}}'
ATTEND_TARBALL_URL='{{TARBALL_URL}}'
ATTEND_SHA256='{{SHA256}}'
ATTEND_CATALOG_RECEIPT='{{CATALOG_RECEIPT}}'

fail() {
  printf '%s\n' "Attend installer: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."

ATTEND_NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
case "$ATTEND_NODE_MAJOR" in
  ''|*[!0-9]*) fail "Could not read the Node.js version." ;;
esac
[ "$ATTEND_NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required."

ATTEND_TMP=$(mktemp -d "${TMPDIR:-/tmp}/attend-local.XXXXXX") || fail "Could not create a temporary directory."
cleanup() {
  rm -rf "$ATTEND_TMP"
}
trap cleanup 0
trap 'exit 1' 1 2 3 15

ATTEND_TARBALL="$ATTEND_TMP/attend-local-$ATTEND_VERSION.tgz"
if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error --location "$ATTEND_TARBALL_URL" --output "$ATTEND_TARBALL"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$ATTEND_TARBALL_URL" -O "$ATTEND_TARBALL"
else
  fail "curl or wget is required to download Attend."
fi

if command -v shasum >/dev/null 2>&1; then
  ATTEND_ACTUAL_SHA256=$(shasum -a 256 "$ATTEND_TARBALL" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  ATTEND_ACTUAL_SHA256=$(sha256sum "$ATTEND_TARBALL" | awk '{print $1}')
else
  fail "shasum or sha256sum is required to verify Attend."
fi
[ "$ATTEND_ACTUAL_SHA256" = "$ATTEND_SHA256" ] || fail "The downloaded tarball failed SHA-256 verification."

npm install --global "$ATTEND_TARBALL"
command -v attend >/dev/null 2>&1 || fail "npm finished, but attend is not on PATH."
[ "$(attend --version)" = "$ATTEND_VERSION" ] || fail "The installed Attend version does not match this installer."

ATTEND_SETUP="$ATTEND_TMP/setup.json"
ATTEND_DOCTOR="$ATTEND_TMP/doctor.json"
ATTEND_FAMILIES="$ATTEND_TMP/families.json"
attend setup --json >"$ATTEND_SETUP"
attend doctor --json >"$ATTEND_DOCTOR"
attend families --json >"$ATTEND_FAMILIES"

node - "$ATTEND_SETUP" "$ATTEND_DOCTOR" "$ATTEND_FAMILIES" "$ATTEND_CATALOG_RECEIPT" <<'NODE'
const fs = require("node:fs");

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const setup = readJson(process.argv[2]);
const doctor = readJson(process.argv[3]);
const catalog = readJson(process.argv[4]);
const expected = JSON.parse(process.argv[5]);

if (setup.ok !== true || setup.conflicts?.length) {
  throw new Error("Attend setup did not complete cleanly.");
}
if (doctor.ok !== true || doctor.checks?.some((check) => check.status === "fail")) {
  throw new Error("Attend doctor reported a failed check.");
}
for (const id of ["project", "agent-skill-agents", "agent-skill-claude"]) {
  if (!doctor.checks?.some((check) => check.id === id && check.status === "pass")) {
    throw new Error(`Attend doctor did not pass ${id}.`);
  }
}

const actualReceipt = {
  counts: catalog.counts,
  families: catalog.families.map((family) => {
    const member = family.members.find(
      (candidate) => candidate.status === "executable" || candidate.status === "unavailable",
    );
    return { id: family.id, member: member?.id, status: member?.status };
  }),
};
if (JSON.stringify(actualReceipt) !== JSON.stringify(expected)) {
  throw new Error("The installed Family Atlas catalog does not match this release.");
}

const codex = doctor.checks.find((check) => check.id === "codex-chat");
console.log(
  `Attend ${setup.packageVersion ?? "{{VERSION}}"} installed: ` +
  `${catalog.counts.families} families, ${catalog.counts.executable} executable, ` +
  `${catalog.counts.unavailable ?? 0} unavailable.`,
);
if (codex) console.log(`Codex chat: ${codex.status}. ${codex.detail}`);
NODE
