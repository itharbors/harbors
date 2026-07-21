---
name: notify-user
description: Use when the user explicitly requests a desktop notification, or when an Agent completes meaningful long-running work, encounters an asynchronous failure or blocker, or needs the user to notice or act outside the active conversation.
---

# Notify User

## Overview

Send desktop notifications through the ITHARBORS Notification Host. Use the bundled script so notifications participate in unread counts, desktop toasts, and Notification Center history.

## Send a Notification

Locate the directory containing the loaded `SKILL.md`, then execute its bundled `scripts/notify.mjs` by absolute path. Never assume the current working directory is Harbors or the Skill installation directory.

```bash
node "<skill-directory>/scripts/notify.mjs" \
  --title "Task completed" \
  --body "Build and tests passed" \
  --level success \
  --source "Codex"
```

Replace `<skill-directory>` with the absolute directory containing this file; do not type the placeholder literally.

Treat exit code 0 together with `Notification sent: <id>` as success. If delivery fails, say so honestly and do not claim the user was notified. Unless notification delivery is itself the requested task, this failure does not make the completed main task fail.

## Choose Delivery

| Situation | Options |
| --- | --- |
| User explicitly asks to be notified, or meaningful long-running work completes | Default transient notification |
| Failure, blocker, approval, credential, or other required user action | Add `--persistent` and use `warning` or `error` |
| Routine progress already visible in the active conversation | Do not notify |

Avoid duplicate notifications for the same event. Keep the title specific and put the actionable result in the body.

## Options

- `--title <text>`: required, 1–120 characters.
- `--body <text>`: optional, up to 2,000 characters.
- `--level info|success|warning|error`: optional; defaults to `info`.
- `--source <name>`: optional; defaults to `Codex`.
- `--duration <milliseconds>`: optional transient duration from 1,000 to 60,000; defaults to 8,000.
- `--persistent`: keep the desktop toast until the user closes it.

For required attention:

```bash
node "<skill-directory>/scripts/notify.mjs" \
  --title "Approval required" \
  --body "The release is waiting for production approval" \
  --level warning \
  --persistent
```

The Harbors Electron desktop app must be running. The script uses `127.0.0.1` and reads `HARBORS_NOTIFICATION_PORT`, defaulting to `17896`.

## Common Mistakes

- Sending frequent progress notifications creates noise; reserve them for meaningful state changes.
- A persistent toast is for user action, not simply a longer informational message.
- A successful final chat response does not prove desktop delivery; check the script result.
- Do not replace the bundled script with hand-written HTTP, `osascript`, `notify-send`, or PowerShell.
