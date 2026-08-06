import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import type { WatchdogEntry } from './watchdog-protocol.js';

interface RecoveryWatchdogOptions {
  verify(entry: WatchdogEntry): Promise<boolean>;
  signal(pid: number, signal: 'SIGCONT'): void | Promise<void>;
}

export function createRecoveryWatchdog(options: RecoveryWatchdogOptions) {
  let entries: WatchdogEntry[] = [];
  let clean = false;
  let recovered = false;
  return {
    update(next: readonly WatchdogEntry[]) {
      if (clean || recovered) return;
      entries = next.slice(0, 256).map((entry) => ({ ...entry }));
    },
    heartbeat() {
      if (clean || recovered) return false;
      return true;
    },
    async cleanShutdown() {
      clean = true;
      entries = [];
    },
    async closeHeartbeatUnexpectedly() {
      if (clean || recovered) return;
      recovered = true;
      for (const entry of entries) {
        if (await options.verify(entry)) await options.signal(entry.pid, 'SIGCONT');
      }
      entries = [];
    },
  };
}

interface WatchdogClientOptions {
  spawn?: typeof nodeSpawn;
  scheduleInterval?: typeof setInterval;
  clearScheduledInterval?: typeof clearInterval;
}

export function createWatchdogClient(options: WatchdogClientOptions) {
  const spawn = options.spawn ?? nodeSpawn;
  const child = spawn('/bin/sh', ['-c', WATCHDOG_SCRIPT], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { PATH: '/usr/bin:/bin' },
  });
  child.unref();
  const schedule = options.scheduleInterval ?? setInterval;
  const clear = options.clearScheduledInterval ?? clearInterval;
  let terminalError: Error | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const markUnavailable = (error: unknown) => {
    terminalError ??= error instanceof Error ? error : new Error(String(error));
    if (timer) clear(timer);
  };
  const sendRequired = async (message: string) => {
    if (terminalError) throw terminalError;
    try {
      await send(child, message);
    } catch (error) {
      markUnavailable(error);
      throw terminalError;
    }
  };
  timer = schedule(() => {
    void sendRequired('H\n').catch(() => undefined);
  }, 2_000);
  timer.unref?.();
  child.stdin?.on('error', markUnavailable);
  child.once('exit', () => markUnavailable(watchdogUnavailableError()));
  let closed = false;
  return {
    pid: child.pid,
    update(entries: readonly WatchdogEntry[]) {
      const lines = entries.slice(0, 256).map((entry) => {
        const identity = Buffer.from(entry.executableIdentity, 'utf8').toString('base64');
        return `E\t${entry.pid}\t${entry.processStartTime}\t${identity}\n`;
      });
      return sendRequired(`B\n${lines.join('')}C\n`);
    },
    async recover() {
      if (closed) return;
      closed = true;
      if (timer) clear(timer);
      await sendRequired('R\n');
      child.stdin?.end();
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      if (timer) clear(timer);
      await sendRequired('S\n');
      child.stdin?.end();
    },
  };
}

function send(child: ChildProcess, message: string): Promise<void> {
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
    return Promise.reject(watchdogUnavailableError());
  }
  return new Promise((resolve, reject) => {
    child.stdin!.write(message, (error) => error ? reject(error) : resolve());
  });
}

function watchdogUnavailableError(): Error & { code: 'WATCHDOG_UNAVAILABLE' } {
  return Object.assign(new Error('Watchdog pipe is unavailable'), { code: 'WATCHDOG_UNAVAILABLE' as const });
}

const WATCHDOG_SCRIPT = String.raw`
set -f
ledger=$(/usr/bin/mktemp -t harbors-agent-guard-watchdog)
next="$ledger.next"
clean=0
missed=0
tab=$(/usr/bin/printf '\t')
recover() {
  [ "$clean" -eq 0 ] || return
  [ -f "$ledger" ] || return
  while IFS="$tab" read -r pid started encoded; do
    case "$pid:$started" in *[!0-9:]*|:*|*:) continue ;; esac
    case "$encoded" in *[!A-Za-z0-9+/=]*) continue ;; esac
    identity=$(/usr/bin/printf '%s' "$encoded" | /usr/bin/base64 -D 2>/dev/null) || continue
    row=$(/bin/ps -p "$pid" -o pid=,ppid=,pgid=,lstart=,comm= 2>/dev/null) || continue
    set -- $row
    [ "$#" -ge 9 ] || continue
    [ "$1" = "$pid" ] || continue
    shift 3
    started_text="$1 $2 $3 $4 $5"
    shift 5
    live_executable="$*"
    live_started=$(/bin/date -j -f '%a %b %e %T %Y' "$started_text" '+%s000' 2>/dev/null) || continue
    [ "$live_started" = "$started" ] || continue
    [ "path:$live_executable" = "$identity" ] || continue
    /bin/kill -CONT "$pid" 2>/dev/null || true
  done < "$ledger"
}
trap 'recover; /bin/rm -f "$ledger" "$next"' EXIT HUP INT TERM
while true; do
  if IFS= read -r -t 3 line; then
    missed=0
    case "$line" in
      H) ;;
      B) : > "$next" ;;
      E"$tab"*) /usr/bin/printf '%s\n' "${'${'}line#E"$tab"}" >> "$next" ;;
      C) /bin/mv -f "$next" "$ledger" ;;
      R) break ;;
      S) clean=1; break ;;
      *) break ;;
    esac
  else
    missed=$((missed + 1))
    [ "$missed" -lt 4 ] || break
  fi
done
exit 0
`;
