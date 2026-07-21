---
name: notify-user
description: Use when an Agent completes long-running work, encounters an asynchronous failure, or needs the user to notice or act on an important state outside the active conversation.
---

# Notify User

## Overview

Send desktop notifications through the ITHARBORS Notification Host. Always use the bundled script so notifications participate in unread counts, desktop toasts, and Notification Kit history.

## Send a Notification

Run from the repository root:

```bash
node .agents/skills/notify-user/scripts/notify.mjs \
  --title "Task completed" \
  --body "Build and tests passed" \
  --level success
```

Treat `Notification sent: <id>` and exit code 0 as success. If the command fails, report that notification delivery failed. Do not replace it with `osascript`, `notify-send`, PowerShell, or hand-written HTTP, and do not claim the user was notified.

## Choose Delivery

| Situation | Options |
| --- | --- |
| Significant completion or useful background update | Default transient notification |
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
node .agents/skills/notify-user/scripts/notify.mjs \
  --title "Approval required" \
  --body "The release is waiting for production approval" \
  --level warning \
  --persistent
```

The Electron desktop app must be running. The script uses `127.0.0.1` and reads `HARBORS_NOTIFICATION_PORT`, defaulting to `17896`.

## Common Mistakes

- Sending frequent progress notifications creates noise; reserve them for meaningful state changes.
- A persistent toast is for user action, not simply a longer informational message.
- A successful final chat response does not prove desktop delivery; check the script result.
