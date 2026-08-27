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

ATTEND_NODE=$(command -v node) || fail "Node.js 22 or newer is required."
ATTEND_NPM=$(command -v npm) || fail "npm is required."
case "$ATTEND_NODE:$ATTEND_NPM" in
  /*:/*) ;;
  *) fail "Node.js and npm must resolve to absolute executable paths." ;;
esac

ATTEND_NODE_MAJOR=$("$ATTEND_NODE" -p 'Number(process.versions.node.split(".")[0])')
case "$ATTEND_NODE_MAJOR" in
  ''|*[!0-9]*) fail "Could not read the Node.js version." ;;
esac
[ "$ATTEND_NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required."

prefix_is_writable() {
  [ -n "$1" ] || return 1
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  [ -d "$1" ] && [ -w "$1" ] && [ -x "$1" ] || return 1
  for ATTEND_PREFIX_PATH in "$1/bin" "$1/lib" "$1/lib/node_modules"; do
    if [ -e "$ATTEND_PREFIX_PATH" ]; then
      [ -d "$ATTEND_PREFIX_PATH" ] &&
        [ -w "$ATTEND_PREFIX_PATH" ] &&
        [ -x "$ATTEND_PREFIX_PATH" ] || return 1
    fi
  done
}

ATTEND_ORIGINAL_PATH=$PATH
ATTEND_NPM_PREFIX=$("$ATTEND_NPM" config get prefix 2>/dev/null) || fail "Could not read npm's global prefix."
if ! prefix_is_writable "$ATTEND_NPM_PREFIX"; then
  [ -n "${HOME:-}" ] || fail "HOME is required for a user-owned npm installation."
  ATTEND_NPM_PREFIX="$HOME/.local"
  mkdir -p "$ATTEND_NPM_PREFIX/bin" "$ATTEND_NPM_PREFIX/lib/node_modules" ||
    fail "Could not create the user-owned npm prefix $ATTEND_NPM_PREFIX."
  prefix_is_writable "$ATTEND_NPM_PREFIX" ||
    fail "The user-owned npm prefix $ATTEND_NPM_PREFIX is not writable."
fi
ATTEND_BIN_DIR="$ATTEND_NPM_PREFIX/bin"

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

"$ATTEND_NPM" install --global --prefix "$ATTEND_NPM_PREFIX" "$ATTEND_TARBALL"
ATTEND_BIN="$ATTEND_BIN_DIR/attend"
[ -x "$ATTEND_BIN" ] || fail "npm finished, but did not create $ATTEND_BIN."
[ "$("$ATTEND_NODE" "$ATTEND_BIN" --version)" = "$ATTEND_VERSION" ] || fail "The installed Attend version does not match this installer."

ATTEND_SETUP="$ATTEND_TMP/setup.json"
ATTEND_MODEL="$ATTEND_TMP/model.json"
ATTEND_DOCTOR="$ATTEND_TMP/doctor.json"
ATTEND_FAMILIES="$ATTEND_TMP/families.json"
"$ATTEND_NODE" "$ATTEND_BIN" setup --json >"$ATTEND_SETUP"
printf '%s\n' "Attend will now download and load the roughly 12 GB gpt-oss-20b model." >&2
"$ATTEND_NODE" "$ATTEND_BIN" model install --json >"$ATTEND_MODEL"
"$ATTEND_NODE" "$ATTEND_BIN" doctor --json >"$ATTEND_DOCTOR"
"$ATTEND_NODE" "$ATTEND_BIN" families --json >"$ATTEND_FAMILIES"

"$ATTEND_NODE" - "$ATTEND_SETUP" "$ATTEND_MODEL" "$ATTEND_DOCTOR" "$ATTEND_FAMILIES" "$ATTEND_CATALOG_RECEIPT" <<'NODE'
const fs = require("node:fs");

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const setup = readJson(process.argv[2]);
const model = readJson(process.argv[3]);
const doctor = readJson(process.argv[4]);
const catalog = readJson(process.argv[5]);
const expected = JSON.parse(process.argv[6]);

if (setup.ok !== true || setup.conflicts?.length) {
  throw new Error("Attend setup did not complete cleanly.");
}
if (model.ok !== true || model.model?.model !== "gpt-oss-20b") {
  throw new Error("Attend did not install gpt-oss-20b.");
}
if (doctor.ok !== true || doctor.checks?.some((check) => check.status === "fail")) {
  throw new Error("Attend doctor reported a failed check.");
}
for (const id of [
  "project",
  "agent-skill-agents",
  "agent-skill-claude",
  "chat-route",
  "local-model",
]) {
  if (!doctor.checks?.some((check) => check.id === id && check.status === "pass")) {
    throw new Error(`Attend doctor did not pass ${id}.`);
  }
}
if (doctor.readiness?.core !== true) {
  throw new Error("Attend doctor did not report core visualization readiness.");
}
if (doctor.readiness?.localModel?.ready !== true) {
  throw new Error("Attend doctor did not report local-model readiness.");
}
const selectedRoute = doctor.chat?.route;
if (
  selectedRoute?.kind !== "host" &&
  !(selectedRoute?.kind === "local" && selectedRoute.model === "gpt-oss-20b") &&
  !(selectedRoute?.kind === "detached" &&
    (selectedRoute.adapter === "codex-cli" || selectedRoute.adapter === "claude-cli"))
) {
  throw new Error("Attend doctor did not report a valid selected chat route.");
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

const detachedAdapters = doctor.checks
  .filter((check) => check.id === "adapter:codex-cli" || check.id === "adapter:claude-cli")
  .map((check) => {
    const label = check.id === "adapter:claude-cli" ? "Claude CLI" : "Codex CLI";
    return `${label}: ${check.status === "info" ? "not probed" : check.status}`;
  });
console.log(
  `Attend ${setup.packageVersion ?? "{{VERSION}}"} installed: ` +
  `${catalog.counts.families} families, ${catalog.counts.executable} executable, ` +
  `${catalog.counts.unavailable ?? 0} unavailable.`,
);
if (selectedRoute.kind === "local") {
  console.log("Chat route: private gpt-oss-20b on this machine.");
} else if (selectedRoute.kind === "host") {
  console.log("Chat route: host attached. Sidebar questions return to the coding agent that opens the view.");
} else {
  const provider = selectedRoute.adapter === "claude-cli" ? "Claude CLI" : "Codex CLI";
  console.log(`Chat route: explicit detached fallback ${provider} remains selected. Sidebar questions do not return to the opening coding agent unless the route is explicitly changed to host.`);
}
console.log(
  "Optional detached fallbacks (not required): " +
  (detachedAdapters.length ? detachedAdapters.join(", ") : "not probed") +
  ".",
);
NODE

case ":$ATTEND_ORIGINAL_PATH:" in
  *":$ATTEND_BIN_DIR:"*) ;;
  *) printf '%s\n' "Add $ATTEND_BIN_DIR to PATH before using attend in a new shell." ;;
esac
