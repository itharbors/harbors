---
name: app-workflow
description: Use when validating or locally publishing a Harbors desktop app tag, including preview and stable app releases. Enforces the canonical app tag format, a clean fetched main branch, local Git identity, exact confirmation, and local product checks before the only tag push.
---

# App Workflow

Publish only with the bundled guardrail script:

```bash
.agents/skills/app-workflow/scripts/release-app.sh <version>
```

1. Start from a clean local `main` that exactly matches fetched `origin/main`.
2. Give the script the exact `packages/desktop/package.json` version. It accepts canonical SemVer without build metadata and publishes `app/v<version>`.
3. Run once without confirmation. Read the emitted `RELEASE_CONFIRM=app/v<version>@<40-char-commit>` token to the user.
4. Only after explicit approval, rerun with the exact token:

```bash
HARBORS_APP_RELEASE_CONFIRM='app/v<version>@<40-char-commit>' \
  .agents/skills/app-workflow/scripts/release-app.sh <version>
```

The script validates the local Git identity (`VisualSJ <devhacker520@hotmail.com>`), version, and local/remote tag availability before it runs `npm run check` and `npm run desktop:prepare`. After those checks it creates one annotated tag and pushes only `refs/tags/app/v<version>`.

Never create a branch, GitHub Release, or force push as part of this workflow.
