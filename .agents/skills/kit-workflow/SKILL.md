---
name: kit-workflow
description: Use when starting, continuing, finishing, or releasing an independently published Harbors Kit in the harbors monorepo.
---

# Kit Workflow

Kit source lives at `main:kits/<kit>`. `main` is the only long-lived development branch. A market Kit change PR carries
its version increase, and merging that PR authorizes automatic Tag and Release publication. Framework and builtin Kit
changes do not enter this independent Kit release path. A release Tag selects exactly one Kit directory.

| Intent | Action | Success evidence |
| --- | --- | --- |
| Start | `scripts/start-kit-change.sh <kit> <type> <slug>` | `TARGET_BRANCH=main`, branch, worktree, and locked `BASE_COMMIT` |
| Continue | Work only in the emitted worktree | `kit-change/<kit>/<type>/<slug>` |
| Finish | `scripts/finish-kit-change.sh <kit> <summary> <body-file>` | Verified open PR targeting `main` |
| Recover release | `scripts/release-kit.sh <kit> <version>` | First shows identity; confirmed run pushes a missing `kit/<kit>/v<version>` |

Types map to `[Feature]`, `[Bug]`, `[Docs]`, `[Refactor]`, `[Optimize]`, `[Test]`, and `[Chore]`.

## Develop

Run start from the primary worktree. It verifies repository-local identity and branch conflicts, fetches and locks
`origin/main`, creates `.worktrees/kit-<kit>-<type>-<slug>`, runs root `npm ci`, then validates the official Kit with
the same SemVer dependency as Kit Core. Inspect status and diffs, stage only relevant files, and keep every commit
label consistent with the branch type.
Before finishing a market Kit change, update `kits/<kit>/kit.json`, `kits/<kit>/package.json`, and
`kits/<kit>/package-lock.json` to one strictly higher canonical SemVer. Plain SemVer is Stable; a prerelease segment is
Preview; build metadata is forbidden.

## Finish

Use a clean linked worktree and a body containing `## Summary` and `## Testing`. Finish verifies commits since
`origin/main`, runs `npm run kit:check -- <kit>` with an isolated output directory, pushes normally, then creates and
verifies an open PR whose base is exactly `main`.
Finish and Kit CI both reject a directly changed market Kit whose three version records do not agree or do not increase.
The PR check lists the Tag intents. PR 合并即发布授权: after merge, GitHub creates each exact Tag and dispatches the
immutable publisher. Preview proceeds automatically; Stable retains the `kit-stable` Environment approval.

## Release recovery

Normal publication is automatic after merge. Use `release-kit.sh` only to recover a missing automatic Tag from an
already reviewed and merged `main` Commit. Recovery runs only from a clean local `main` whose HEAD exactly equals
`origin/main`. The Tag version, `kits/<kit>/kit.json`,
`kits/<kit>/package.json`, lockfile identity, and channel must agree. Plain SemVer is Stable; prerelease SemVer is
Preview; build metadata is forbidden. The Tag must not exist locally or remotely.

First run without confirmation and present the emitted `RELEASE_CONFIRM=kit/<kit>/v<version>@<40-char-commit>` to the
user. Only after explicit recovery approval rerun with `HARBORS_KIT_RELEASE_CONFIRM=<exact-token>`. Never use recovery
to replace, move, or overwrite an existing Tag or Release.

## Hard boundaries

Do not stash, pull, merge, rebase, hard reset, force push, delete worktrees, reuse a change branch, override the
`origin/main` base, publish from another branch or Commit, or treat a successful push/compare URL as a created PR.
