---
name: kit-workflow
description: Use when starting, continuing, finishing, or releasing an independently published Harbors Kit in the harbors monorepo.
---

# Kit Workflow

Kit source lives at `main:kits/<kit>`. `main` is the only long-lived development branch; ordinary merges never publish
a Kit or the Framework. A release Tag selects exactly one Kit directory.

| Intent | Action | Success evidence |
| --- | --- | --- |
| Start | `scripts/start-kit-change.sh <kit> <type> <slug>` | `TARGET_BRANCH=main`, branch, worktree, and locked `BASE_COMMIT` |
| Continue | Work only in the emitted worktree | `kit-change/<kit>/<type>/<slug>` |
| Finish | `scripts/finish-kit-change.sh <kit> <summary> <body-file>` | Verified open PR targeting `main` |
| Release | `scripts/release-kit.sh <kit> <version>` | First shows identity; confirmed run pushes `kit/<kit>/v<version>` |

Types map to `[Feature]`, `[Bug]`, `[Docs]`, `[Refactor]`, `[Optimize]`, `[Test]`, and `[Chore]`.

## Develop

Run start from the primary worktree. It fetches and locks `origin/main`, validates the official Kit, repository-local
identity, and branch conflicts, creates `.worktrees/kit-<kit>-<type>-<slug>`, then runs root `npm ci`. Inspect status and
diffs, stage only relevant files, and keep every commit label consistent with the branch type.

## Finish

Use a clean linked worktree and a body containing `## Summary` and `## Testing`. Finish verifies commits since
`origin/main`, runs `npm run kit:check -- <kit>` with an isolated output directory, pushes normally, then creates and
verifies an open PR whose base is exactly `main`.

## Release

Release only from a clean local `main` whose HEAD exactly equals `origin/main`. The Tag version, `kits/<kit>/kit.json`,
`kits/<kit>/package.json`, lockfile identity, and channel must agree. Plain SemVer is Stable; prerelease SemVer is
Preview; build metadata is forbidden. The Tag must not exist locally or remotely.

First run without confirmation and present the emitted `RELEASE_CONFIRM=kit/<kit>/v<version>@<40-char-commit>` to the
user. Only after explicit approval rerun with `HARBORS_KIT_RELEASE_CONFIRM=<exact-token>`. This approval is separate
from approval to implement or merge code.

## Hard boundaries

Do not stash, pull, merge, rebase, hard reset, force push, delete worktrees, reuse a change branch, override the
`origin/main` base, publish from another branch or Commit, or treat a successful push/compare URL as a created PR.
