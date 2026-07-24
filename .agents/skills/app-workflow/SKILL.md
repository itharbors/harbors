---
name: app-workflow
description: Use when validating or locally publishing a Harbors desktop app release tag, including preview and stable releases.
---

# App Workflow

Publish only with the bundled guardrail script:

```bash
.agents/skills/app-workflow/scripts/release-app.sh <version>
```

1. Start from a clean local `main` that exactly matches fetched `origin/main`.
2. Require the protected remote `app-publish-v1` Tag and reject a same-named branch. The reusable workflow must be activated before any app release.
3. Give the script the exact `packages/desktop/package.json` version. It accepts canonical SemVer without build metadata and publishes updater-compatible `v<version>`.
4. Run once without confirmation. Read the emitted `RELEASE_CONFIRM=v<version>@<40-char-commit>` token to the user.
5. Only after explicit approval, rerun with the exact token:

```bash
HARBORS_APP_RELEASE_CONFIRM='v<version>@<40-char-commit>' \
  .agents/skills/app-workflow/scripts/release-app.sh <version>
```

The script validates the canonical `itharbors/harbors` origin, local Git identity (`VisualSJ <devhacker520@hotmail.com>`), version, toolchain identity, and local/remote tag availability before it runs `npm run check` and `npm run desktop:prepare`. After those checks it creates one annotated tag and pushes only `refs/tags/v<version>`.

Never create a branch, GitHub Release, or force push as part of this workflow.
