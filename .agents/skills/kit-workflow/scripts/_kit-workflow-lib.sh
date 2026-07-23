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

kit_workflow_validate_product() {
  local repo_root=$1 kit=$2 required_channel=${3:-any} npm_version current_node_version
  test -f "$repo_root/kit.json" || kit_workflow_fail 'kit.json is missing from product root'
  test -f "$repo_root/package.json" || kit_workflow_fail 'package.json is missing from product root'
  test -f "$repo_root/package-lock.json" || kit_workflow_fail 'package-lock.json is missing from product root'
  npm_version=$(npm --version)
  current_node_version=$(node --version)
  node - "$repo_root" "$kit" "$required_channel" "${current_node_version#v}" "$npm_version" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [root, kit, requiredChannel, actualNode, actualNpm] = process.argv.slice(2);
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const manifest = read('kit.json');
const pkg = read('package.json');
const lock = read('package-lock.json');
const expectedId = `@itharbors/kit-${kit}`;
const stop = (message) => { console.error(`error: ${message}`); process.exit(1); };

if (manifest.id !== expectedId || pkg.name !== expectedId) stop(`Kit identity mismatch: expected ${expectedId}`);
if (manifest.version !== pkg.version) stop('Kit manifest and package versions do not match');
if (requiredChannel !== 'any' && manifest.channel !== requiredChannel) {
  stop(`${requiredChannel} channel is required, got ${String(manifest.channel)}`);
}
if (pkg.engines?.node !== actualNode) stop(`Node version mismatch: expected ${String(pkg.engines?.node)}, got ${actualNode}`);
if (pkg.engines?.npm !== actualNpm) stop(`npm version mismatch: expected ${String(pkg.engines?.npm)}, got ${actualNpm}`);
const kitCli = pkg.harbors?.kitCli;
if (typeof kitCli !== 'string' || kitCli.length === 0) stop('package.json harbors.kitCli pin is missing');
if (pkg.devDependencies?.['@itharbors/kit-cli'] !== kitCli) stop('Kit CLI dependency does not match harbors.kitCli pin');
const rootLock = lock.packages?.[''];
if (rootLock?.name !== pkg.name || rootLock?.version !== pkg.version) stop('package-lock root identity does not match package.json');
if (rootLock?.devDependencies?.['@itharbors/kit-cli'] !== kitCli) stop('package-lock Kit CLI pin does not match package.json');
NODE
}

kit_workflow_run_product_checks() {
  local repo_root=$1 pack_dir=$2
  (cd "$repo_root" && npm run check)
  (cd "$repo_root" && npm run kit:validate)
  (cd "$repo_root" && npm run kit:pack -- --output "$pack_dir/product.hkit")
}
