#!/usr/bin/env bash
# Regenerates what the plugin takes from upstream verbatim or near it:
#   plugin/skills/   upstream/skills/** with patches/*.patch applied, in name order
#   plugin/assets/   upstream/assets/template.html and logo.webp (the browser dashboard)
#
#   scripts/sync-upstream.sh               regenerate
#   scripts/sync-upstream.sh --check       fail if the plugin's copies differ from a regeneration
#   scripts/sync-upstream.sh --check SHA   also list what upstream changed by SHA (a commit,
#                                          branch or tag of upstream's repository) in the
#                                          regions the port took (scripts/upstream-drift.mjs)
#
# Every text edit to upstream lives in patches/ as its own patch, so a subtree pull
# followed by this script shows exactly which edits still apply.

set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
upstream="$root/upstream"
plugin="$root/plugin"

stage=$(mktemp -d "${TMPDIR:-/tmp}/autoresearch-sync-XXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

mkdir -p "$stage/skills" "$stage/assets"
cp -R "$upstream/skills/." "$stage/skills/"
for patch in "$root"/patches/*.patch; do
  [ -e "$patch" ] || continue
  if ! patch --silent --forward -p1 -d "$stage/skills" <"$patch"; then
    echo "sync-upstream: $(basename "$patch") no longer applies to upstream/skills" >&2
    exit 1
  fi
done
find "$stage/skills" \( -name '*.orig' -o -name '*.rej' \) -delete
cp "$upstream/assets/template.html" "$upstream/assets/logo.webp" "$stage/assets/"

if [ "${1:-}" = "--check" ]; then
  status=0
  diff -r "$stage/skills" "$plugin/skills" >/dev/null || { echo "plugin/skills differs from upstream + patches" >&2; status=1; }
  for asset in template.html logo.webp; do
    cmp -s "$stage/assets/$asset" "$plugin/assets/$asset" || { echo "plugin/assets/$asset differs from upstream" >&2; status=1; }
  done
  if [ -n "${2:-}" ]; then
    node "$root/scripts/upstream-drift.mjs" "$2" || status=1
  fi
  exit "$status"
fi

# Replace the generated folders (moved to the trash where there is one).
discard() {
  [ -e "$1" ] || return 0
  if command -v trash >/dev/null 2>&1; then trash "$1"; else rm -rf "$1"; fi
}
discard "$plugin/skills"
mkdir -p "$plugin/assets"
cp -R "$stage/skills" "$plugin/skills"
cp "$stage/assets/template.html" "$stage/assets/logo.webp" "$plugin/assets/"
echo "synced plugin/skills and plugin/assets from upstream @ $(git -C "$root" log -1 --format=%h -- upstream)"
