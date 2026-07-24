#!/usr/bin/env bash

set -euo pipefail

app_workflow_fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

test "$#" -eq 1 || app_workflow_fail 'usage: release-app.sh <version>'
version=$1
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel) \
  || app_workflow_fail 'unable to resolve repository root'

test -z "$(git -C "$repo_root" status --porcelain)" \
  || app_workflow_fail 'working tree is not clean'
branch=$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)
test "$branch" = main || app_workflow_fail "release must run from main, got ${branch:-detached HEAD}"
origin_url=$(git -C "$repo_root" remote get-url origin 2>/dev/null) \
  || app_workflow_fail 'origin remote is required'
test -n "$origin_url" || app_workflow_fail 'origin remote is required'
git -C "$repo_root" fetch origin --prune \
  || app_workflow_fail 'unable to fetch origin'
commit=$(git -C "$repo_root" rev-parse HEAD)
origin_main=$(git -C "$repo_root" rev-parse --verify refs/remotes/origin/main 2>/dev/null) \
  || app_workflow_fail 'unable to resolve fetched origin/main'
test "$commit" = "$origin_main" || app_workflow_fail 'current Commit is not origin/main'

git_name=$(git -C "$repo_root" config --local --get user.name || true)
git_email=$(git -C "$repo_root" config --local --get user.email || true)
test "$git_name" = VisualSJ || app_workflow_fail 'Git user.name must be VisualSJ'
test "$git_email" = devhacker520@hotmail.com \
  || app_workflow_fail 'Git user.email must be devhacker520@hotmail.com'

desktop_package="$repo_root/packages/desktop/package.json"
test -f "$desktop_package" || app_workflow_fail 'desktop package.json is missing'
package_version=$(node -e "const fs=require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).version)" "$desktop_package") \
  || app_workflow_fail 'unable to read desktop package version'
test "$package_version" = "$version" \
  || app_workflow_fail "desktop package version is $package_version, requested $version"

(
  cd "$repo_root"
  node --input-type=module - "$version" <<'NODE'
import semver from 'semver';

const version = process.argv[2];
if (semver.valid(version) !== version || version.includes('+')) process.exit(1);
NODE
) || app_workflow_fail 'release version must be canonical SemVer without build metadata'

tag="app/v$version"
if test -n "$(git -C "$repo_root" tag --list "$tag")"; then
  app_workflow_fail "release Tag already exists locally: $tag"
fi

if remote_tag_error=$(git -C "$repo_root" ls-remote --exit-code --refs --tags origin "refs/tags/$tag" 2>&1); then
  app_workflow_fail "release Tag already exists on origin: $tag"
else
  remote_tag_status=$?
fi
case "$remote_tag_status" in
  2) ;;
  *) app_workflow_fail "unable to query origin release Tag: ${remote_tag_error:-unknown Git error}" ;;
esac

if [[ "$version" == *-* ]]; then channel=preview; else channel=stable; fi
confirmation="$tag@$commit"
printf 'RELEASE_APP=desktop\nRELEASE_VERSION=%s\nRELEASE_CHANNEL=%s\nRELEASE_COMMIT=%s\nRELEASE_TAG=%s\nRELEASE_CONFIRM=%s\n' \
  "$version" "$channel" "$commit" "$tag" "$confirmation"
test "${HARBORS_APP_RELEASE_CONFIRM:-}" = "$confirmation" \
  || app_workflow_fail "App release requires explicit confirmation: set HARBORS_APP_RELEASE_CONFIRM=$confirmation"

npm --prefix "$repo_root" run check
npm --prefix "$repo_root" run desktop:prepare
git -C "$repo_root" tag -a "$tag" "$commit" -m "App release $tag"
git -C "$repo_root" push origin "refs/tags/$tag"
