import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
RUNNER = SKILL_DIR / "scripts" / "run_subagents.py"


def _sandbox_exec_works():
    if not Path("/usr/bin/sandbox-exec").is_file():
        return False
    try:
        completed = subprocess.run(
            [
                "/usr/bin/sandbox-exec",
                "-p",
                "(version 1)(allow default)",
                "/usr/bin/true",
            ],
            capture_output=True,
            timeout=5,
        )
        return completed.returncode == 0
    except Exception:
        return False


class RunSubagentsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.workdir = self.root / "worktree"
        self.workdir.mkdir()
        subprocess.run(
            ["git", "init", "--quiet"], cwd=self.workdir, check=True
        )
        self.capture = self.root / "capture.json"
        self.sandbox_capture = self.root / "sandbox.json"
        self.config = self.root / "config.json"
        self.fake_sandbox = self.root / "sandbox-exec"
        self.fake_sandbox.write_text(
            textwrap.dedent(
                f"""\
                #!/usr/bin/env python3
                import json
                import os
                import sys
                from pathlib import Path

                args = sys.argv[1:]
                profile_index = args.index("-p")
                Path({str(self.sandbox_capture)!r}).write_text(
                    json.dumps({{"profile": args[profile_index + 1]}}),
                    encoding="utf-8",
                )
                command = args[profile_index + 2:]
                os.execv(command[0], command)
                """
            ),
            encoding="utf-8",
        )
        self.fake_sandbox.chmod(0o755)
        self.fake = self.root / "codex"
        self.fake.write_text(
            textwrap.dedent(
                f"""\
                #!/usr/bin/env python3
                import json
                import os
                import sys
                import time
                from pathlib import Path

                args = sys.argv[1:]
                message = Path(args[args.index("--output-last-message") + 1])
                config_path = Path({str(self.config)!r})
                config = json.loads(config_path.read_text(encoding="utf-8"))
                if config["capture"]:
                    Path({str(self.capture)!r}).write_text(json.dumps({{
                            "args": args,
                            "secret_leaked": "SHOULD_NOT_LEAK" in os.environ,
                        }}), encoding="utf-8")
                peers = config["peers"]
                if peers > 1:
                    marker = message.parent.parent / (message.parent.name + ".started")
                    marker.write_text("started", encoding="utf-8")
                    deadline = time.monotonic() + 3
                    while len(list(message.parent.parent.glob("*.started"))) < peers:
                        if time.monotonic() > deadline:
                            raise SystemExit(9)
                        time.sleep(0.02)
                if config.get("write_path"):
                    target = Path(config["write_path"])
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("changed", encoding="utf-8")
                report = {{
                    "status": config["report_status"],
                    "summary": "done",
                    "changed_files": config.get("changed_files", []),
                    "checks": [],
                    "risks": [],
                    "open_questions": [],
                    "blockers": [],
                }}
                if config.get("extra_report_field"):
                    report["unexpected"] = True
                report_text = json.dumps(report)
                if config.get("fenced_report"):
                    report_text = "```json\\n" + report_text + "\\n```"
                message.write_text(report_text, encoding="utf-8")
                event = {{"type": "thread.started", "thread_id": message.stem}}
                print(json.dumps(event))
                """
            ),
            encoding="utf-8",
        )
        self.fake.chmod(0o755)

    def tearDown(self):
        self.temporary.cleanup()

    def write_brief(self, task_id, allowed_changes=None, mode="execute"):
        path = self.root / f"{task_id}.json"
        path.write_text(
            json.dumps(
                {
                    "task_id": task_id,
                    "mode": mode,
                    "objective": f"complete {task_id}",
                    "context": [],
                    "allowed_changes": allowed_changes or [],
                    "acceptance_checks": (
                        ["run focused test"] if mode == "execute" else []
                    ),
                    "prohibitions": (
                        ["do not touch unrelated files"] if mode == "execute" else []
                    ),
                }
            ),
            encoding="utf-8",
        )
        return path

    def run_runner(
        self,
        *briefs,
        peers=1,
        report_status="completed",
        write_path=None,
        changed_files=None,
        extra_report_field=False,
        fenced_report=False,
        sandbox_bin=None,
        capture=True,
    ):
        env = os.environ.copy()
        env["SHOULD_NOT_LEAK"] = "secret"
        self.config.write_text(
            json.dumps(
                {
                    "peers": peers,
                    "report_status": report_status,
                    "write_path": write_path,
                    "changed_files": changed_files or [],
                    "extra_report_field": extra_report_field,
                    "fenced_report": fenced_report,
                    "capture": capture,
                }
            ),
            encoding="utf-8",
        )
        command = [
            sys.executable,
            str(RUNNER),
            "--workdir",
            str(self.workdir),
            "--codex-bin",
            str(self.fake),
            "--sandbox-exec-bin",
            str(sandbox_bin or self.fake_sandbox),
        ]
        for brief in briefs:
            command.extend(["--brief", str(brief)])
        return subprocess.run(command, text=True, capture_output=True, env=env)

    def test_uses_fixed_model_and_execute_sandbox(self):
        result = self.run_runner(self.write_brief("implementation", ["src/app.ts"]))
        self.assertEqual(result.returncode, 0, result.stderr)
        capture = json.loads(self.capture.read_text(encoding="utf-8"))
        args = capture["args"]
        self.assertEqual(args[args.index("--profile") + 1], "relay-alwaysday1")
        self.assertEqual(args[args.index("--model") + 1], "auto_model/alwaysday1")
        self.assertEqual(args[args.index("--sandbox") + 1], "danger-full-access")
        self.assertEqual(args[args.index("--ask-for-approval") + 1], "never")
        self.assertFalse(capture["secret_leaked"])
        profile = json.loads(self.sandbox_capture.read_text(encoding="utf-8"))[
            "profile"
        ]
        self.assertIn(str((self.workdir / "src/app.ts").resolve()), profile)
        self.assertNotIn(f'(subpath "{self.workdir.resolve()}")', profile)

    def test_review_relies_on_outer_read_only_boundary(self):
        result = self.run_runner(self.write_brief("review", mode="review"))
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.capture.read_text(encoding="utf-8"))["args"]
        self.assertEqual(args[args.index("--sandbox") + 1], "danger-full-access")
        profile = json.loads(self.sandbox_capture.read_text(encoding="utf-8"))[
            "profile"
        ]
        self.assertNotIn(f'(subpath "{self.workdir.resolve()}")', profile)

    def test_disjoint_briefs_start_concurrently(self):
        first = self.write_brief("first", ["src/first.ts"])
        second = self.write_brief("second", ["src/second.ts"])
        result = self.run_runner(first, second, peers=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(
            {item["task_id"] for item in payload["results"]}, {"first", "second"}
        )

    def test_rejects_overlapping_write_boundaries(self):
        first = self.write_brief("first", ["src"])
        second = self.write_brief("second", ["src/app.ts"])
        result = self.run_runner(first, second)
        self.assertEqual(result.returncode, 2)
        self.assertIn("write boundary overlap", result.stdout)

    def test_rejects_review_writes(self):
        brief = self.write_brief("review", ["src/app.ts"], mode="review")
        result = self.run_runner(brief)
        self.assertEqual(result.returncode, 2)
        self.assertIn("review mode requires empty allowed_changes", result.stdout)

    def test_rejects_unsafe_task_id(self):
        brief = self.write_brief("unsafe")
        payload = json.loads(brief.read_text(encoding="utf-8"))
        payload["task_id"] = "../escape"
        brief.write_text(json.dumps(payload), encoding="utf-8")
        result = self.run_runner(brief)
        self.assertEqual(result.returncode, 2)
        self.assertIn("task_id contains unsafe characters", result.stdout)

    def test_blocked_report_blocks_batch(self):
        brief = self.write_brief("blocked", ["src/blocked.ts"])
        result = self.run_runner(brief, report_status="blocked")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)["status"], "blocked")

    def test_rejects_nonpositive_limits(self):
        brief = self.write_brief("limits", ["src/limits.ts"])
        result = subprocess.run(
            [
                sys.executable,
                str(RUNNER),
                "--workdir",
                str(self.workdir),
                "--brief",
                str(brief),
                "--max-workers",
                "0",
                "--sandbox-exec-bin",
                str(self.fake_sandbox),
            ],
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be positive", result.stdout)

    def test_detects_actual_change_outside_batch_boundaries(self):
        brief = self.write_brief("outside", ["src/allowed.ts"])
        result = self.run_runner(brief, write_path="unexpected.txt")
        self.assertEqual(result.returncode, 3)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "policy_error")
        self.assertEqual(payload["unexpected_changes"], ["unexpected.txt"])

    def test_accepts_actual_change_inside_batch_boundaries(self):
        brief = self.write_brief("inside", ["src/allowed.ts"])
        result = self.run_runner(
            brief,
            write_path="src/allowed.ts",
            changed_files=["src/allowed.ts"],
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["actual_changes"], ["src/allowed.ts"])
        self.assertTrue(payload["validation_required"])
        self.assertIn("duration_seconds", payload["results"][0])
        self.assertGreaterEqual(payload["results"][0]["duration_seconds"], 0)

    def test_rejects_report_that_does_not_match_schema(self):
        brief = self.write_brief("schema", ["src/schema.ts"])
        result = self.run_runner(brief, extra_report_field=True)
        self.assertEqual(result.returncode, 3)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["results"][0]["status"], "protocol_error")
        self.assertIn("duration_seconds", payload["results"][0])
        self.assertGreaterEqual(payload["results"][0]["duration_seconds"], 0)

    def test_accepts_one_complete_json_code_fence(self):
        brief = self.write_brief("fenced", ["src/fenced.ts"])
        result = self.run_runner(brief, fenced_report=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(
        _sandbox_exec_works(), "requires functional macOS sandbox-exec"
    )
    def test_real_sandbox_enforces_per_brief_write_boundary(self):
        (self.workdir / "src").mkdir()
        allowed = self.write_brief("allowed", ["src/allowed.ts"])
        accepted = self.run_runner(
            allowed,
            write_path="src/allowed.ts",
            changed_files=["src/allowed.ts"],
            sandbox_bin=Path("/usr/bin/sandbox-exec"),
            capture=False,
        )
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)

        denied = self.write_brief("denied", ["src/denied.ts"])
        rejected = self.run_runner(
            denied,
            write_path="outside.txt",
            sandbox_bin=Path("/usr/bin/sandbox-exec"),
            capture=False,
        )
        self.assertEqual(rejected.returncode, 3)
        self.assertFalse((self.workdir / "outside.txt").exists())


if __name__ == "__main__":
    unittest.main()
