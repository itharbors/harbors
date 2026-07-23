---
name: kit-workflow
description: Use when starting, continuing, finishing, or preparing a Stable release for an independently published Harbors Kit, especially work involving Kit product branches, kit-change branches, worktrees, Kit pull requests, or release Tags. Do not use for Framework changes based on main.
---

# Kit Workflow

Keep Kit product work isolated from Framework `main`. The product baseline and PR base are always the matching
`origin/kit/<kit>`; never accept an arbitrary base override.

| Intent | Action | Success evidence |
| --- | --- | --- |
| Start | `scripts/start-kit-change.sh <kit> <type> <slug>` | `KIT=`, `TARGET_BRANCH=`, `BRANCH=`, `WORKTREE_PATH=`, `BASE_COMMIT=` |
| Continue | Work only in the emitted worktree | Branch is `kit-change/<kit>/<type>/<slug>` |
| Finish | `scripts/finish-kit-change.sh <kit> <summary> <body-file>` | Verified `PR_URL=` |
| Stable release | `scripts/release-kit.sh <kit> <version>` | First displays release identity; confirmed run emits `RELEASE_TAG=` |

Types map to `[Feature]`, `[Bug]`, `[Docs]`, `[Refactor]`, `[Optimize]`, `[Test]`, and `[Chore]`.
`[Init]` is only for the first independent product-branch snapshot.

## Start and develop

Run start from the primary worktree. It fetches and locks `origin/kit/<kit>`, checks branch conflicts, Kit identity,
lockfile, Node/npm pins, and Kit CLI pin, creates `.worktrees/kit-<kit>-<type>-<slug>`, then performs `npm ci`.
Use only the emitted worktree. Inspect status and diffs, stage relevant files explicitly, and keep every commit label
consistent with the change type.

## Finish

Require a clean linked worktree and a PR body containing `## Summary` and `## Testing`. The finish script verifies all
commits since the product baseline, runs `npm run check`, Kit validation and dry-run packing, performs an ordinary
push, then creates and verifies an open PR whose base is exactly `kit/<kit>`.

## Prepare a Stable release

Use release only from a clean local `kit/<kit>` whose HEAD equals `origin/kit/<kit>`. Package and manifest versions
must match, the manifest channel must be `stable`, and the Tag must not exist. First run without confirmation and show
the emitted Kit, version, Commit, and tag-plus-Commit confirmation token to the user. Only after explicit approval rerun with
`HARBORS_KIT_RELEASE_CONFIRM=<emitted token>`. Pushing the Tag triggers the Stable publishing workflow.

## Hard boundaries

Do not use this Skill for Framework work. Do not stash, pull, merge, rebase, hard reset, force push, delete worktrees,
change the product base, reuse an existing change branch, or infer Stable-release approval from approval to implement
code. A successful push or compare URL is not a created PR.
