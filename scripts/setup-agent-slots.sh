#!/usr/bin/env bash
# Creates the fixed parallel-agent slots: git worktrees wt1..wt3 under
# ../agents/, each with its own dependencies, dev build, and Obsidian test
# vault ("S2B WT1".."S2B WT3") whose plugin dir symlinks into that slot's
# build output. Idempotent — safe to re-run (it refreshes symlinks, deps,
# and vault registration but never overwrites an existing slot vault).
#
# See AGENTS.md "Parallel agent slots" for the workflow.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve the MAIN checkout even when this script runs from inside a slot
# worktree (where ../ would point at agents/, not s2b-dev/).
REPO_ROOT="$(dirname "$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir)")"
AGENTS_DIR="$(dirname "$REPO_ROOT")/agents"
TEMPLATE_VAULT="$REPO_ROOT/integration/S2B Test Vault"
PLUGIN_ID="smart-second-brain"
SLOTS=(wt1 wt2 wt3)
OBSIDIAN_JSON="$HOME/Library/Application Support/obsidian/obsidian.json"

mkdir -p "$AGENTS_DIR/.locks"

# New slots start from the latest main; fetch once so origin/main is current.
git -C "$REPO_ROOT" fetch --quiet origin main

for slot in "${SLOTS[@]}"; do
  worktree="$AGENTS_DIR/$slot"
  vault_name="S2B ${slot/wt/WT}"
  vault_dir="$AGENTS_DIR/$vault_name"
  build_dir="$worktree/build/smart-second-brain"

  echo "=== Slot $slot ==="

  # 1. Worktree (detached so slots never fight over branch checkouts;
  #    agents create their own task branches inside). Prune first so a slot
  #    whose directory was deleted by hand can be recreated.
  if [[ ! -d "$worktree" ]]; then
    git -C "$REPO_ROOT" worktree prune
    git -C "$REPO_ROOT" worktree add --detach "$worktree" origin/main
  else
    echo "worktree exists: $worktree"
  fi

  # 2. Dependencies + a first dev build so the vault symlinks resolve.
  (cd "$worktree" && bun install --frozen-lockfile)
  (cd "$worktree" && bunx vite build --mode development)
  node --check "$build_dir/main.js"

  # 3. Vault clone (only on first setup — slot vaults accumulate their own
  #    state afterwards and must not be clobbered by a re-run).
  if [[ ! -d "$vault_dir" ]]; then
    rsync -a \
      --exclude ".obsidian/plugins/$PLUGIN_ID" \
      "$TEMPLATE_VAULT/" "$vault_dir/"
    echo "vault created: $vault_dir"
  else
    echo "vault exists: $vault_dir"
  fi

  # 4. Plugin symlinks → this slot's build output (absolute; refreshed every run).
  plugin_dir="$vault_dir/.obsidian/plugins/$PLUGIN_ID"
  mkdir -p "$plugin_dir"
  # Keep plugin settings from the template on first setup.
  if [[ ! -f "$plugin_dir/data.json" && -f "$TEMPLATE_VAULT/.obsidian/plugins/$PLUGIN_ID/data.json" ]]; then
    cp "$TEMPLATE_VAULT/.obsidian/plugins/$PLUGIN_ID/data.json" "$plugin_dir/data.json"
  fi
  for file in main.js styles.css manifest.json; do
    ln -sf "$build_dir/$file" "$plugin_dir/$file"
  done

  # 5. Make sure the plugin is enabled in the clone.
  cp_json="$vault_dir/.obsidian/community-plugins.json"
  if [[ ! -f "$cp_json" ]]; then
    echo "[\"$PLUGIN_ID\"]" > "$cp_json"
  elif ! grep -q "\"$PLUGIN_ID\"" "$cp_json"; then
    content=$(cat "$cp_json")
    echo "${content/]/, \"$PLUGIN_ID\"]}" > "$cp_json"
  fi
done

# 6. Register the slot vaults with Obsidian. The registry file is rewritten
#    by Obsidian itself, so only touch it while Obsidian is closed.
if pgrep -x Obsidian >/dev/null; then
  echo ""
  echo "Obsidian is running — skipped vault registration."
  echo "Either quit Obsidian and re-run this script, or open each slot vault"
  echo "once by hand (Open folder as vault):"
  for slot in "${SLOTS[@]}"; do
    echo "  $AGENTS_DIR/S2B ${slot/wt/WT}"
  done
else
  node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const [jsonPath, ...vaultPaths] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    data.vaults ??= {};
    for (const p of vaultPaths) {
      if (Object.values(data.vaults).some((v) => v.path === p)) continue;
      data.vaults[crypto.randomBytes(8).toString("hex")] = { path: p, ts: Date.now() };
      console.log("registered:", p);
    }
    fs.writeFileSync(jsonPath, JSON.stringify(data));
  ' "$OBSIDIAN_JSON" "$AGENTS_DIR/S2B WT1" "$AGENTS_DIR/S2B WT2" "$AGENTS_DIR/S2B WT3"
fi

echo ""
echo "Done. Slots live under $AGENTS_DIR (claim one with scripts/claim-slot.sh)."
