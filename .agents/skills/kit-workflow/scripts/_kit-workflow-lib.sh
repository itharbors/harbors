#!/usr/bin/env bash

kit_workflow_fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

kit_workflow_validate_kit_name() {
  [[ "$1" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || kit_workflow_fail "invalid Kit name: $1"
}

kit_workflow_validate_change_type() {
  case "$1" in
    feature|bug|docs|refactor|optimize|test|chore) ;;
    *) kit_workflow_fail "invalid change type: $1" ;;
  esac
}

kit_workflow_label_for_type() {
  case "$1" in
    feature) printf 'Feature\n' ;; bug) printf 'Bug\n' ;; docs) printf 'Docs\n' ;;
    refactor) printf 'Refactor\n' ;; optimize) printf 'Optimize\n' ;;
    test) printf 'Test\n' ;; chore) printf 'Chore\n' ;;
    *) kit_workflow_fail "invalid change type: $1" ;;
  esac
}

kit_workflow_repo_root() {
  local script_dir
  script_dir=$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd -P)
  git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || kit_workflow_fail 'Skill is not inside a Git repository'
}

kit_workflow_validate_identity() {
  local repo_root=$1 actual_name actual_email
  actual_name=$(git -C "$repo_root" config --local --get user.name 2>/dev/null || true)
  actual_email=$(git -C "$repo_root" config --local --get user.email 2>/dev/null || true)
  test "$actual_name" = 'VisualSJ' \
    || kit_workflow_fail "Git user.name must be VisualSJ, got ${actual_name:-unset}"
  test "$actual_email" = 'devhacker520@hotmail.com' \
    || kit_workflow_fail "Git user.email must be devhacker520@hotmail.com, got ${actual_email:-unset}"
}

kit_workflow_channel_for_version() {
  node - "$1" <<'NODE'
const version = process.argv[2];
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const canonical = new RegExp(`^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-${identifier}(?:\\.${identifier})*)?$`, 'u');
if (!canonical.test(version)) {
  console.error(`error: version must be a canonical SemVer without build metadata: ${version}`);
  process.exit(1);
}
console.log(version.includes('-') ? 'preview' : 'stable');
NODE
}

kit_workflow_validate_product() {
  local repo_root=$1 kit=$2 required_channel=${3:-any}
  local manifest_path="$repo_root/kits/$kit/kit.json"
  local package_path="$repo_root/kits/$kit/package.json"
  local lock_path="$repo_root/package-lock.json"
  local policy_path="$repo_root/registry/policy.json"
  kit_workflow_validate_identity "$repo_root"
  test -f "$policy_path" || kit_workflow_fail 'registry/policy.json is missing from repository root'
  test -f "$lock_path" || kit_workflow_fail 'package-lock.json is missing from repository root'
  node - "$policy_path" "$kit" <<'NODE'
const fs = require('node:fs');
const [file, kit] = process.argv.slice(2);
let policy;
try { policy = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { console.error('error: registry/policy.json must contain valid JSON'); process.exit(1); }
if (!policy?.kits || !Object.prototype.hasOwnProperty.call(policy.kits, kit)) {
  console.error(`error: Kit is not listed in registry policy: ${kit}`);
  process.exit(1);
}
NODE
  test -f "$manifest_path" || kit_workflow_fail "kits/$kit/kit.json is missing"
  test -f "$package_path" || kit_workflow_fail "kits/$kit/package.json is missing"
  node - "$repo_root" "$kit" "$required_channel" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [root, kit, requiredChannel] = process.argv.slice(2);
const read = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); }
  catch { console.error(`error: ${name} must contain valid JSON`); process.exit(1); }
};
const manifest = read(`kits/${kit}/kit.json`);
const pkg = read(`kits/${kit}/package.json`);
const lock = read('package-lock.json');
const policy = read('registry/policy.json');
const expectedId = `@itharbors/kit-${kit}`;
const stop = (message) => { console.error(`error: ${message}`); process.exit(1); };
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const canonical = new RegExp(`^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-${identifier}(?:\\.${identifier})*)?$`, 'u');

if (policy.kits[kit]?.id !== expectedId) stop(`Kit policy identity mismatch: expected ${expectedId}`);
if (manifest.id !== expectedId || pkg.name !== expectedId) stop(`Kit identity mismatch: expected ${expectedId}`);
if (manifest.version !== pkg.version) stop('Kit manifest and package versions do not match');
if (typeof manifest.version !== 'string' || !canonical.test(manifest.version)) {
  stop(`Kit version must be a canonical SemVer without build metadata: ${String(manifest.version)}`);
}
const derivedChannel = manifest.version.includes('-') ? 'preview' : 'stable';
if (manifest.channel !== derivedChannel) stop(`${derivedChannel} channel is required for ${manifest.version}`);
if (requiredChannel !== 'any' && manifest.channel !== requiredChannel) {
  stop(`${requiredChannel} channel is required, got ${String(manifest.channel)}`);
}
const workspaceLock = lock.packages?.[`kits/${kit}`];
if (workspaceLock?.name !== pkg.name || workspaceLock?.version !== pkg.version) {
  stop(`package-lock identity for kits/${kit} does not match package.json`);
}
NODE
}

kit_workflow_run_product_checks() {
  local repo_root=$1 kit=$2 pack_dir=$3
  (cd "$repo_root" && npm run kit:check -- "$kit" --output-directory "$pack_dir")
}
