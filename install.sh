#!/usr/bin/env bash
# opencode-goal-loop installer
# Usage: curl -fsSL <raw-url>/install.sh | bash
#
# Copies the goal and loop plugins into ~/.config/opencode/plugins-local/,
# adds /goal and /loop commands, and registers the plugins in your opencode
# config (opencode.jsonc or opencode.json). Idempotent: safe to re-run.
set -euo pipefail

REPO="kartikkabadi/opencode-goal-loop"
BRANCH="${GOAL_LOOP_BRANCH:-main}"
OC_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
SRC_DIR="${GOAL_LOOP_SOURCE:-}" # local checkout override (for testing/dev)

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- fetch a file, preferring local source when provided ---------------------
fetch() { # fetch <repo-relative-path> <dest>
  mkdir -p "${2%/*}"
  if [ -n "$SRC_DIR" ]; then
    cp "$SRC_DIR/$1" "$2"
  else
    local url="https://raw.githubusercontent.com/$REPO/$BRANCH/$1"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$url" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$2" "$url"
    else
      fail "need curl or wget to download $url"
    fi
  fi
}

fetch_tree() { # fetch_tree <repo-relative-dir> <dest-dir> <file...>
  local src="$1" dst="$2"; shift 2
  mkdir -p "$dst"
  local f
  for f in "$@"; do
    fetch "$src/$f" "$dst/$f"
  done
}

command -v node >/dev/null 2>&1 || fail "node is required on PATH (https://nodejs.org)"

[ -d "$OC_DIR" ] || fail "opencode config dir not found at $OC_DIR — install/run opencode first"

CONFIG=""
for c in "$OC_DIR/opencode.jsonc" "$OC_DIR/opencode.json"; do
  [ -f "$c" ] && CONFIG="$c" && break
done

# --- copy plugin files -------------------------------------------------------
say "==> installing plugins into $OC_DIR/plugins-local"

fetch_tree "plugins/goal" "$OC_DIR/plugins-local/goal" \
  package.json index.js bundle.js \
  lib/state.js lib/engine.js lib/parse.js lib/prompts.js lib/gates.js

fetch_tree "plugins/loop" "$OC_DIR/plugins-local/loop" \
  package.json index.js bundle.js \
  lib/store.js lib/engine.js lib/parse.js

# --- command templates --------------------------------------------------------
mkdir -p "$OC_DIR/commands"
if [ ! -f "$OC_DIR/commands/goal.md" ]; then
  fetch "commands/goal.md" "$OC_DIR/commands/goal.md"
  say "==> added commands/goal.md"
fi
if [ ! -f "$OC_DIR/commands/loop.md" ]; then
  fetch "commands/loop.md" "$OC_DIR/commands/loop.md"
  say "==> added commands/loop.md"
fi

# --- register in the config's "plugin" array ----------------------------------
# Textual edit so existing JSONC comments are preserved.
register() {
  node - "$CONFIG" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
let text = fs.readFileSync(path, "utf8");

// Install dir name must match what loop's goal-detection import expects.
const entries = [
  `${path.replace(/\/[^/]*$/, "")}/plugins-local/goal`,
  `${path.replace(/\/[^/]*$/, "")}/plugins-local/loop`,
].map((p) => `    "${p}",`);

if (!/"plugin"\s*:/.test(text)) {
  // No plugin array yet: insert one before the final closing brace.
  const trimmed = text.replace(/\s+$/, "");
  const inner = trimmed.endsWith("}") ? trimmed.slice(0, -1).replace(/[,\s]+$/, "") : trimmed;
  text = `${inner},\n  "plugin": [\n${entries.join("\n").replace(/,$/, "")}\n  ]\n}\n`;
} else {
  for (let i = 0; i < entries.length; i++) {
    let e = entries[i];
    // Already registered? (match with or without trailing comma)
    const bare = e.replace(/,\s*$/, "").trim().replace(/^"|"$/g, "");
    if (text.includes(`"${bare}"`)) continue;
    // Insert after the opening bracket of the plugin array.
    const m = text.match(/"plugin"\s*:\s*\[/);
    if (!m) fail_with_node();
    const at = m.index + m[0].length;
    // If the array currently has no elements, drop our trailing comma.
    const rest = text.slice(at);
    if (/^\s*\]/.test(rest)) e = e.replace(/,\s*$/, "");
    text = text.slice(0, at) + `\n${e}` + text.slice(at);
  }
}
fs.writeFileSync(path, text);

function fail_with_node() {
  console.error('error: could not locate "plugin": [ in config');
  process.exit(1);
}
NODE
}

if [ -n "$CONFIG" ]; then
  say "==> registering plugins in $CONFIG"
  register
else
  say "!! no opencode.jsonc/json found — create one or add manually:"
  say "   \"plugin\": [\"$OC_DIR/plugins-local/goal\", \"$OC_DIR/plugins-local/loop\"]"
fi

say ""
say "installed:"
say "  /goal  — persistent objective that keeps working until evidence says done"
say "  /loop  — repeat a prompt on an interval or turn cadence"
say ""
say "restart opencode (or start a new session) to load them."
say "try: /goal ship the thing · /goal help   |   /loop 5m check CI · /loop help"
