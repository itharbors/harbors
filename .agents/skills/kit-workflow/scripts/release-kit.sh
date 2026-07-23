#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
. "$script_dir/_kit-workflow-lib.sh"

test "$#" -eq 2 || kit_workflow_fail 'usage: release-kit.sh <kit> <version>'
kit=$1
version=$2
kit_workflow_validate_kit_name "$kit"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || kit_workflow_fail "invalid Stable version: $version"

repo_root=$(kit_workflow_repo_root)
branch=$(git -C "$repo_root" branch --show-current)
target_branch="kit/$kit"
test "$branch" = "$target_branch" || kit_workflow_fail "release must run from $target_branch, got ${branch:-detached HEAD}"
test -z "$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)" || kit_workflow_fail 'working tree is not clean'
git -C "$repo_root" remote get-url origin >/dev/null 2>&1 || kit_workflow_fail 'origin remote is missing'
git -C "$repo_root" fetch origin --prune
target_ref="refs/remotes/origin/$target_branch"
git -C "$repo_root" show-ref --verify --quiet "$target_ref" || kit_workflow_fail "origin/$target_branch is missing"
commit=$(git -C "$repo_root" rev-parse HEAD)
test "$commit" = "$(git -C "$repo_root" rev-parse "$target_ref")" || kit_workflow_fail "current Commit is not origin/$target_branch"
kit_workflow_validate_product "$repo_root" "$kit" stable
manifest_version=$(node -p "require(process.argv[1]).version" "$repo_root/kit.json")
test "$manifest_version" = "$version" || kit_workflow_fail "release version mismatch: manifest is $manifest_version"

tag="$target_branch/v$version"
git -C "$repo_root" show-ref --verify --quiet "refs/tags/$tag" && kit_workflow_fail "release Tag already exists locally: $tag"
if git -C "$repo_root" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  kit_workflow_fail "release Tag already exists on origin: $tag"
fi
confirmation="$tag@$commit"
printf 'RELEASE_KIT=%s\nRELEASE_VERSION=%s\nRELEASE_COMMIT=%s\nRELEASE_TAG=%s\nRELEASE_CONFIRM=%s\n' \
  "$kit" "$version" "$commit" "$tag" "$confirmation"
test "${HARBORS_KIT_RELEASE_CONFIRM:-}" = "$confirmation" \
  || kit_workflow_fail "Stable release requires explicit confirmation: set HARBORS_KIT_RELEASE_CONFIRM=$confirmation"

pack_dir=$(mktemp -d "${TMPDIR:-/tmp}/kit-workflow-release.XXXXXX")
trap 'rm -rf -- "$pack_dir"' EXIT
kit_workflow_run_product_checks "$repo_root" "$pack_dir"
git -C "$repo_root" tag "$tag" "$commit"
git -C "$repo_root" push origin "refs/tags/$tag"
