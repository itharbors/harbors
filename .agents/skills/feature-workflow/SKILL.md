---
name: feature-workflow
description: Use when starting, continuing, or finishing feature development in the Harbors repository, especially requests mentioning a new feature, feature worktree, feature branch, push, or GitHub pull request. Do not use for hotfixes on an existing branch, release branches, or work outside this repository.
---

# Feature Workflow

## Overview

Keep every feature isolated from the primary checkout. Let the bundled scripts enforce Git and GitHub invariants; use judgment only for slug naming, code changes, commit scope, and PR wording.

## Quick reference

| Intent | Action | Success evidence |
| --- | --- | --- |
| Start a feature | Run `scripts/start-feature.sh <slug>` | `WORKTREE_PATH=`, `BRANCH=`, `BASE_COMMIT=` |
| Continue work | Work only in the emitted worktree | Current branch equals emitted `codex/<slug>` |
| Finish and open PR | Run `scripts/finish-feature.sh <title> <body-file>` | Verified `PR_URL=` |

Resolve script paths relative to this `SKILL.md`.

## Start a feature

1. Convert the request to a short slug matching `^[a-z0-9]+(-[a-z0-9]+)*$`; omit the `codex/` prefix.
2. Run `scripts/start-feature.sh <slug>`.
3. If it stops, report the exact state. Require the user to reconcile a dirty, ahead, behind, or diverged `main`; do not bypass the gate.
4. On success, use the emitted `WORKTREE_PATH` as the working directory for every feature edit, test, and commit.

## Develop and commit

1. Confirm the current branch matches the emitted `BRANCH` before editing.
2. Follow repository instructions and run focused tests during development.
3. Before committing, inspect `git status --short`, `git diff`, and `git diff --cached`.
4. Stage only feature files. Never use `git add .`.
5. Follow `docs/guides/development-workflow.md`: `[Feature]` for features/docs/tests, `[Bug]` for fixes, `[Optimize]` for refactors/performance/structure. Keep commits reviewable.

## Finish and create a PR

1. Commit all intended changes and confirm the worktree is clean.
2. Create a PR body in a temporary file outside the repository with `## Summary` and `## Testing`. List only checks that actually ran.
3. Choose a concise PR title from the committed change.
4. Run `scripts/finish-feature.sh <title> <body-file>`. It must complete `npm run check` before push or PR creation.
5. Report success only when the script emits `PR_URL=`. Report check, authentication, push, creation, or verification failures as failures.
6. Keep the worktree and branches after PR creation. Remove them only on an explicit user request.

## Example

For “开始用户登录功能”, choose `user-login`, run the start script, and work in the emitted `.worktrees/user-login`. For “完成并提交 PR”, prepare the two-section PR body and run the finish script; return the verified URL.

## Common mistakes and hard boundaries

- Do not pull, reset, stash, merge, or rebase to make `main` pass the start gate.
- Do not use hard reset, force push, recursive deletion, or automatic worktree cleanup.
- Do not place the temporary PR body inside the worktree; it would make the tree dirty.
- Do not treat a compare URL, draft body, or successful push as a created PR.
- Do not install or copy this skill into a user-level skill directory.
