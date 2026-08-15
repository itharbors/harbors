#!/usr/bin/env python3
"""Run bounded Codex CLI subagents concurrently and emit compact JSON."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


CODEX_PROFILE = "relay-alwaysday1"
DEFAULT_MODEL = "auto_model/alwaysday1"
DEFAULT_MAX_WORKERS = 4
BRIEF_FIELDS = {
    "task_id",
    "mode",
    "objective",
    "context",
    "allowed_changes",
    "acceptance_checks",
    "prohibitions",
}
REPORT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "status": {"type": "string", "enum": ["completed", "blocked", "failed"]},
        "summary": {"type": "string"},
        "changed_files": {"type": "array", "items": {"type": "string"}},
        "checks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "command": {"type": "string"},
                    "result": {"type": "string"},
                },
                "required": ["command", "result"],
            },
        },
        "risks": {"type": "array", "items": {"type": "string"}},
        "open_questions": {"type": "array", "items": {"type": "string"}},
        "blockers": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "status",
        "summary",
        "changed_files",
        "checks",
        "risks",
        "open_questions",
        "blockers",
    ],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", required=True, type=Path)
    parser.add_argument("--brief", required=True, action="append", type=Path)
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument("--sandbox-exec-bin", default="/usr/bin/sandbox-exec")
    parser.add_argument("--timeout-seconds", type=float, default=1800.0)
    parser.add_argument("--max-workers", type=int, default=DEFAULT_MAX_WORKERS)
    return parser.parse_args()


def matches_schema(value: Any, schema: dict[str, Any]) -> bool:
    expected = schema.get("type")
    if expected == "object":
        if not isinstance(value, dict):
            return False
        properties = schema.get("properties", {})
        if any(key not in value for key in schema.get("required", [])):
            return False
        if schema.get("additionalProperties") is False and any(
            key not in properties for key in value
        ):
            return False
        return all(
            key not in properties or matches_schema(item, properties[key])
            for key, item in value.items()
        )
    if expected == "array":
        return isinstance(value, list) and all(
            matches_schema(item, schema.get("items", {})) for item in value
        )
    if expected == "string":
        if not isinstance(value, str):
            return False
    if "enum" in schema and value not in schema["enum"]:
        return False
    return True


def child_environment(runtime_dir: Path | None = None) -> dict[str, str]:
    allowed = {
        "CODEX_HOME",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LOGNAME",
        "PATH",
        "SHELL",
        "TERM",
        "TMPDIR",
        "USER",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    if runtime_dir is not None:
        environment["TMPDIR"] = str(runtime_dir)
    return environment


def path_state(path: Path) -> str:
    try:
        metadata = path.lstat()
    except OSError:
        return "missing"
    if path.is_symlink():
        return f"symlink:{metadata.st_mode:o}:{os.readlink(path)}"
    if path.is_file():
        digest = hashlib.sha256()
        try:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError:
            return "unreadable"
        return f"file:{metadata.st_mode:o}:{digest.hexdigest()}"
    return f"other:{metadata.st_mode:o}"


def dirty_paths(workdir: Path) -> set[str]:
    completed = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=workdir,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError("workdir must be a readable Git worktree")
    records = completed.stdout.split(b"\0")
    paths: set[str] = set()
    index = 0
    while index < len(records) and records[index]:
        record = records[index].decode("utf-8", errors="surrogateescape")
        if len(record) < 4:
            raise ValueError("cannot parse Git worktree status")
        status = record[:2]
        paths.add(record[3:])
        if "R" in status or "C" in status:
            index += 1
            if index >= len(records) or not records[index]:
                raise ValueError("cannot parse renamed Git path")
            paths.add(records[index].decode("utf-8", errors="surrogateescape"))
        index += 1
    return paths


def workspace_snapshot(workdir: Path) -> dict[str, str]:
    return {
        relative: path_state(workdir / relative)
        for relative in dirty_paths(workdir)
    }


def changed_since(before: dict[str, str], after: dict[str, str]) -> list[str]:
    return sorted(
        path
        for path in before.keys() | after.keys()
        if before.get(path, "clean") != after.get(path, "clean")
    )


def is_allowed(path: Path, allowed: list[Path]) -> bool:
    return any(path == boundary or boundary in path.parents for boundary in allowed)


def sandbox_rule(kind: str, path: Path) -> str:
    return f"({kind} {json.dumps(str(path.resolve(strict=False)))})"


def build_write_sandbox(allowed_paths: list[Path], protocol_dir: Path) -> str:
    runtime_paths = [
        protocol_dir,
        Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")),
        Path("/dev/null"),
    ]
    write_rules: list[str] = []
    for path in [*runtime_paths, *allowed_paths]:
        write_rules.extend(
            [sandbox_rule("literal", path), sandbox_rule("subpath", path)]
        )
    return " ".join(
        [
            "(version 1)",
            "(deny default)",
            "(allow process*)",
            "(allow file-read*)",
            "(allow network*)",
            "(allow mach-lookup)",
            "(allow sysctl-read)",
            "(allow signal)",
            f"(allow file-write* {' '.join(write_rules)})",
        ]
    )


def run_command(
    command: list[str],
    prompt: str,
    workdir: Path,
    runtime_dir: Path,
    timeout_seconds: float,
) -> tuple[subprocess.CompletedProcess[str], bool]:
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
            cwd=workdir,
            env=child_environment(runtime_dir),
            start_new_session=True,
        )
        timed_out = False
        try:
            process.communicate(input=prompt, timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
        stdout_file.seek(0)
        stdout = stdout_file.read(1024 * 1024).decode("utf-8", errors="replace")
        stderr_file.seek(0, os.SEEK_END)
        stderr_size = stderr_file.tell()
        stderr_file.seek(max(0, stderr_size - 1024 * 1024))
        stderr = stderr_file.read().decode("utf-8", errors="replace")
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr), timed_out


def load_brief(path: Path, workdir: Path) -> tuple[dict[str, Any], list[Path]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"{path}: cannot read valid JSON: {error}") from error
    if not isinstance(value, dict) or set(value) != BRIEF_FIELDS:
        raise ValueError(f"{path}: fields do not match the Brief contract")
    if value["mode"] not in {"execute", "review"}:
        raise ValueError(f"{path}: mode must be execute or review")
    for field in ("task_id", "objective"):
        if not isinstance(value[field], str) or not value[field].strip():
            raise ValueError(f"{path}: {field} must be a nonempty string")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value["task_id"]):
        raise ValueError(f"{path}: task_id contains unsafe characters")
    for field in BRIEF_FIELDS - {"task_id", "mode", "objective"}:
        if not isinstance(value[field], list) or any(
            not isinstance(item, str) or not item.strip() for item in value[field]
        ):
            raise ValueError(f"{path}: {field} must be an array of nonempty strings")
    if value["mode"] == "review" and value["allowed_changes"]:
        raise ValueError(f"{path}: review mode requires empty allowed_changes")
    if value["mode"] == "execute" and any(
        not value[field]
        for field in ("allowed_changes", "acceptance_checks", "prohibitions")
    ):
        raise ValueError(
            f"{path}: execute mode requires changes, checks, and prohibitions"
        )

    root = workdir.resolve()
    resolved: list[Path] = []
    for item in value["allowed_changes"]:
        if any(character in item for character in "*?[]"):
            raise ValueError(f"{path}: allowed_changes cannot contain globs")
        candidate = Path(item)
        if not candidate.is_absolute():
            candidate = root / candidate
        candidate = candidate.resolve(strict=False)
        if candidate == root or root not in candidate.parents:
            raise ValueError(f"{path}: allowed_changes must stay below workdir")
        resolved.append(candidate)
    return value, resolved


def reject_overlaps(jobs: list[tuple[Path, dict[str, Any], list[Path]]]) -> None:
    claimed: list[tuple[str, Path]] = []
    for _, brief, paths in jobs:
        for path in paths:
            for other_task, other_path in claimed:
                if (
                    path == other_path
                    or path in other_path.parents
                    or other_path in path.parents
                ):
                    raise ValueError(
                        f"write boundary overlap: {brief['task_id']} and {other_task}"
                    )
            claimed.append((brief["task_id"], path))


def make_prompt(brief: dict[str, Any]) -> str:
    schema = json.dumps(REPORT_SCHEMA, ensure_ascii=False, separators=(",", ":"))
    payload = json.dumps(brief, ensure_ascii=False, indent=2)
    return (
        "Complete exactly the bounded task in TASK_BRIEF. Respect allowed_changes and "
        "prohibitions. Do not publish, deploy, merge, access credentials, expand "
        "permissions, or contact external people unless TASK_BRIEF explicitly authorizes "
        "it. If required work or checks cannot be completed, return blocked or failed, "
        "not completed. Return only one "
        "JSON object matching REPORT_SCHEMA; use empty arrays when applicable.\n"
        f"REPORT_SCHEMA\n{schema}\nTASK_BRIEF\n{payload}\n"
    )


def parse_session_id(stdout: str) -> str | None:
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            for key in ("thread_id", "threadId", "session_id", "sessionId"):
                if isinstance(event.get(key), str) and event[key]:
                    return event[key]
    return None


def parse_report(message_text: str) -> Any:
    try:
        return json.loads(message_text)
    except json.JSONDecodeError as original_error:
        fenced = re.fullmatch(
            r"\s*```(?:json)?\s*\n(?P<payload>.*)\n```\s*",
            message_text,
            flags=re.DOTALL,
        )
        if fenced is None:
            raise original_error
        return json.loads(fenced.group("payload"))


def run_job(
    path: Path,
    brief: dict[str, Any],
    allowed_paths: list[Path],
    args: argparse.Namespace,
    protocol_dir: Path,
) -> dict[str, Any]:
    start = time.monotonic()
    task_id = brief.get("task_id", "unknown")
    try:
        task_id = brief["task_id"]
        task_protocol_dir = protocol_dir / task_id
        task_protocol_dir.mkdir(mode=0o700)
        schema_path = task_protocol_dir / "schema.json"
        message_path = task_protocol_dir / "message.json"
        schema_path.write_text(json.dumps(REPORT_SCHEMA), encoding="utf-8")
        command = [
            args.codex_bin,
            "--profile",
            CODEX_PROFILE,
            "--model",
            DEFAULT_MODEL,
            "--ask-for-approval",
            "never",
            "exec",
            "--cd",
            str(args.workdir.resolve()),
            "--sandbox",
            "danger-full-access",
            "--skip-git-repo-check",
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(message_path),
            "--json",
            "--color",
            "never",
            "-",
        ]
        sandbox_profile = build_write_sandbox(allowed_paths, task_protocol_dir)
        command = [args.sandbox_exec_bin, "-p", sandbox_profile, *command]
        try:
            completed, timed_out = run_command(
                command,
                make_prompt(brief),
                args.workdir,
                task_protocol_dir,
                args.timeout_seconds,
            )
        except OSError as error:
            return {
                "task_id": task_id,
                "status": "launch_error",
                "message": str(error),
                "duration_seconds": round(time.monotonic() - start, 3),
            }
        if timed_out:
            return {
                "task_id": task_id,
                "status": "launch_error",
                "message": "timeout",
                "duration_seconds": round(time.monotonic() - start, 3),
            }
        if completed.returncode != 0:
            return {
                "task_id": task_id,
                "status": "launch_error",
                "exit_code": completed.returncode,
                "message": completed.stderr.strip()[-1000:],
                "duration_seconds": round(time.monotonic() - start, 3),
            }
        try:
            message_text = message_path.read_text(encoding="utf-8")
            report = parse_report(message_text)
        except (OSError, json.JSONDecodeError) as error:
            return {
                "task_id": task_id,
                "status": "protocol_error",
                "message": str(error),
                "message_preview": locals().get("message_text", "")[-1000:],
                "stdout_preview": completed.stdout[-1000:],
                "stderr_preview": completed.stderr[-1000:],
                "duration_seconds": round(time.monotonic() - start, 3),
            }
        if not matches_schema(report, REPORT_SCHEMA):
            return {
                "task_id": task_id,
                "status": "protocol_error",
                "message": "result does not match REPORT_SCHEMA",
                "duration_seconds": round(time.monotonic() - start, 3),
            }
        allowed = allowed_paths
        root = args.workdir.resolve()
        reported_outside = [
            item
            for item in report["changed_files"]
            if not is_allowed(
                ((root / item) if not Path(item).is_absolute() else Path(item)).resolve(),
                allowed,
            )
        ]
        if reported_outside:
            return {
                "task_id": task_id,
                "status": "policy_error",
                "message": "reported changed_files exceed allowed_changes",
                "paths": reported_outside,
                "duration_seconds": round(time.monotonic() - start, 3),
            }
        return {
            "task_id": task_id,
            "brief_path": str(path),
            "session_id": parse_session_id(completed.stdout),
            "report": report,
            "duration_seconds": round(time.monotonic() - start, 3),
        }
    except Exception as error:
        return {
            "task_id": task_id,
            "brief_path": str(path),
            "status": "worker_error",
            "message": str(error),
            "duration_seconds": round(time.monotonic() - start, 3),
        }


def main() -> int:
    args = parse_args()
    if not args.workdir.is_dir():
        print(
            json.dumps(
                {"status": "input_error", "message": "workdir is not a directory"}
            )
        )
        return 2
    if not Path(args.sandbox_exec_bin).is_file():
        print(
            json.dumps(
                {"status": "input_error", "message": "sandbox-exec is unavailable"}
            )
        )
        return 2
    if args.timeout_seconds <= 0 or args.max_workers <= 0:
        print(
            json.dumps(
                {
                    "status": "input_error",
                    "message": "timeouts and workers must be positive",
                }
            )
        )
        return 2
    try:
        jobs = []
        task_ids: set[str] = set()
        for path in args.brief:
            brief, paths = load_brief(path, args.workdir)
            if brief["task_id"] in task_ids:
                raise ValueError(f"duplicate task_id: {brief['task_id']}")
            task_ids.add(brief["task_id"])
            jobs.append((path, brief, paths))
        reject_overlaps(jobs)
        before = workspace_snapshot(args.workdir)
    except ValueError as error:
        print(json.dumps({"status": "input_error", "message": str(error)}))
        return 2

    with tempfile.TemporaryDirectory(prefix="codex-subagents-") as temporary:
        protocol_dir = Path(temporary)
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(len(jobs), args.max_workers)
        ) as executor:
            futures = []
            for path, brief, boundaries in jobs:
                started_at = time.monotonic()
                future = executor.submit(
                    run_job, path, brief, boundaries, args, protocol_dir
                )
                futures.append((path, brief, future, started_at))
            results = []
            for path, brief, future, started_at in futures:
                try:
                    results.append(future.result())
                except Exception as error:  # Keep the batch protocol intact.
                    results.append(
                        {
                            "task_id": brief["task_id"],
                            "brief_path": str(path),
                            "status": "worker_error",
                            "message": str(error),
                            "duration_seconds": round(
                                time.monotonic() - started_at, 3
                            ),
                        }
                    )
    try:
        after = workspace_snapshot(args.workdir)
    except ValueError as error:
        print(json.dumps({"status": "policy_error", "message": str(error)}))
        return 3
    actual_changes = changed_since(before, after)
    allowed_union = [boundary for _, _, boundaries in jobs for boundary in boundaries]
    outside_union = [
        relative
        for relative in actual_changes
        if not is_allowed((args.workdir.resolve() / relative).resolve(), allowed_union)
    ]
    if outside_union:
        print(
            json.dumps(
                {
                    "status": "policy_error",
                    "model": DEFAULT_MODEL,
                    "validation_required": True,
                    "unexpected_changes": outside_union,
                    "results": results,
                },
                ensure_ascii=False,
            )
        )
        return 3
    report_statuses = [
        result.get("report", {}).get("status") for result in results
    ]
    if all(status == "completed" for status in report_statuses):
        status = "completed"
    elif any(status == "failed" or status is None for status in report_statuses):
        status = "failed"
    else:
        status = "blocked"
    print(
        json.dumps(
            {
                "status": status,
                "model": DEFAULT_MODEL,
                "validation_required": True,
                "actual_changes": actual_changes,
                "results": results,
            },
            ensure_ascii=False,
        )
    )
    return 0 if status == "completed" else 3


if __name__ == "__main__":
    sys.exit(main())
