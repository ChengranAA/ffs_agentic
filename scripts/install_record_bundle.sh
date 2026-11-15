#!/usr/bin/env bash
# Install @local/ffs-record into the DSH desktop profile (link the checkout, add the bundle,
# refresh the profile's node_modules). This mutates the profile, so it supports --dry-run and
# prints exactly what would change. Run it yourself after reviewing the plan.
#
#   bash scripts/install_record_bundle.sh --dry-run
#   bash scripts/install_record_bundle.sh --apply
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="@local/ffs-record"
BUNDLE_DIR="$ROOT/ffs-record"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
PACKAGE_JSON="$PROFILE/package.json"
MODE="dry-run"
NO_DEPS="0"

for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --no-deps) NO_DEPS="1" ;;
    -h|--help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$BUNDLE_DIR" ]; then
  echo "error: bundle directory not found: $BUNDLE_DIR" >&2
  exit 1
fi
if [ ! -f "$PACKAGE_JSON" ]; then
  echo "error: profile package.json not found: $PACKAGE_JSON" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-node}"
DSH_PNPM="${DSH_PNPM:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs}"
PNPM=()
if [ "$MODE" = "apply" ] && [ "$NO_DEPS" != "1" ]; then
  if [ -n "${PNPM_BIN:-}" ]; then
    PNPM=("$PNPM_BIN")
  elif command -v pnpm >/dev/null 2>&1; then
    PNPM=(pnpm)
  elif [ -f "$DSH_PNPM" ]; then
    PNPM=("$NODE_BIN" "$DSH_PNPM")
  elif command -v corepack >/dev/null 2>&1; then
    PNPM=(corepack pnpm)
  else
    echo "error: pnpm/corepack not found; set PNPM_BIN or run --no-deps and install deps manually" >&2
    exit 1
  fi
fi

"$NODE_BIN" - "$PACKAGE_JSON" "$BUNDLE_DIR" "$BUNDLE" "$MODE" <<'NODE'
const fs = require('node:fs')
const [file, bundleDir, bundle, mode] = process.argv.slice(2)
const originalText = fs.readFileSync(file, 'utf8')
const pkg = JSON.parse(originalText)
pkg.dependencies = pkg.dependencies || {}
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []

const linked = `link:${bundleDir}`
const changes = []
if (pkg.dependencies[bundle] !== linked) {
  changes.push(`dependencies.${bundle}: ${pkg.dependencies[bundle] || '(absent)'} -> ${linked}`)
  pkg.dependencies[bundle] = linked
}
if (!pkg.dsh.profile.bundles.includes(bundle)) {
  const before = pkg.dsh.profile.bundles.length
  pkg.dsh.profile.bundles.push(bundle)
  changes.push(`dsh.profile.bundles: ${before} -> ${pkg.dsh.profile.bundles.length} (append ${bundle})`)
}
if (!changes.length) {
  console.log('profile already contains @local/ffs-record; nothing to change')
  process.exit(0)
}
const nextText = JSON.stringify(pkg, null, 2) + '\n'
console.log(`profile: ${file}`)
for (const change of changes) console.log(`  ${change}`)
if (mode === 'dry-run') {
  console.log('dry run: no file written; re-run with --apply to install')
  process.exit(0)
}
fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`)
fs.writeFileSync(file, nextText)
console.log('profile package.json updated (backup written next to it)')
NODE

if [ "$MODE" = "dry-run" ]; then
  echo "next: review the plan, then run: bash scripts/install_record_bundle.sh --apply"
  exit 0
fi

if [ "$NO_DEPS" = "1" ]; then
  echo "dependencies skipped (--no-deps)"
  exit 0
fi

cd "$PROFILE"
"${PNPM[@]}" install --config.confirmModulesPurge=false
echo "installed @local/ffs-record"
echo "now reload/restart DeepSeek Harness so the profile picks up the Host/Client halves."
echo "live GUI: $DSH_WEB_URL (reload the page after the Host restart)"
