---
name: change-workflow
description: Use when starting, continuing, or finishing feature, bug, docs, refactor, optimization, test, or maintenance work in the Harbors repository, especially requests mentioning a worktree, branch, push, or GitHub pull request. Do not use for release branches or work outside this repository.
---

# Change Workflow

Keep every change isolated from the primary checkout. Use the bundled scripts for Git and GitHub invariants.

| Intent | Action | Success evidence |
| --- | --- | --- |
| Start | `scripts/start-change.sh <type> <slug>` | `WORKTREE_PATH=`, `BRANCH=`, `CHANGE_TYPE=`, `BASE_COMMIT=` |
| Continue | Work only in the emitted worktree | Branch equals emitted `<type>/<slug>` |
| Finish | `scripts/finish-change.sh <summary> <body-file>` | Verified `PR_URL=` |

Types map to labels: `feature`/`[Feature]`, `bug`/`[Bug]`, `docs`/`[Docs]`, `refactor`/`[Refactor]`, `optimize`/`[Optimize]`, `test`/`[Test]`, and `chore`/`[Chore]`. `[Init]` is initialization-only.

## Start

Choose a slug matching `^[a-z0-9]+(-[a-z0-9]+)*$`, run the start script from the primary checkout, and use its emitted worktree for every edit. It locks fetched `origin/main`; never alter local `main` to make start pass. Report failures exactly.

## Develop and commit

Confirm the current branch before editing. Run focused tests, inspect `git status --short`, `git diff`, and `git diff --cached`, stage only relevant files, and never use `git add .`. Every commit uses the label matching its branch, with a concise Chinese summary and no trailing period.

## Finish and create a PR

Commit all work and require a clean worktree. Put `## Summary` and `## Testing` in a body file outside the repository and list only checks that ran. Call the finish script with an unlabelled single-line Chinese summary. Report success only after `PR_URL=`. Keep worktrees and branches unless removal is explicitly requested.

## Hard boundaries

Do not stash, pull, merge, rebase, hard reset, force push, recursively delete, automatically clean worktrees, continue an existing branch as new work, or treat a compare URL or successful push as a created PR. Do not install this Skill in a user-level directory.
