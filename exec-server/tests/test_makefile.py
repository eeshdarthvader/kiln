"""Exercise Makefile container arguments without building or starting a container."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class MakefileTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.directory = Path(self.scratch.name)
        self.capture = self.directory / "calls.jsonl"
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.recorder = self.directory / "record.py"
        self.recorder.write_text(
            "import json, os, sys\n"
            "with open(os.environ['TEST_CAPTURE'], 'a') as output:\n"
            "    output.write(json.dumps({'program': os.path.basename(sys.argv[0]), "
            "'args': sys.argv[1:]}) + '\\n')\n"
            "if sys.argv[1:3] == ['container', 'ls']:\n"
            "    print(os.environ.get('TEST_CONTAINERS', ''))\n"
            "    sys.exit(int(os.environ.get('TEST_LIST_STATUS', '0')))\n"
            "if sys.argv[1:3] == ['container', 'rm']:\n"
            "    sys.exit(int(os.environ.get('TEST_REMOVE_STATUS', '0')))\n"
        )
        self.make_fake("docker", "exec \"$TEST_PYTHON\" \"$TEST_RECORDER\" \"$@\"")
        self.make_fake("python3", "exec \"$TEST_PYTHON\" \"$TEST_RECORDER\" \"$@\"")

    def make_fake(self, name, command):
        executable = self.bin / name
        executable.write_text(f"#!/bin/sh\n{command}\n")
        executable.chmod(0o755)

    def run_make(self, *arguments, **environment_overrides):
        environment = os.environ.copy()
        environment.update({
            "PATH": f"{self.bin}{os.pathsep}{environment.get('PATH', '/usr/bin:/bin')}",
            "TEST_PYTHON": sys.executable,
            "TEST_RECORDER": str(self.recorder),
            "TEST_CAPTURE": str(self.capture),
        })
        environment.update(environment_overrides)
        return subprocess.run(
            ["make", "--no-print-directory", *arguments],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def calls(self):
        if not self.capture.exists():
            return []
        return [json.loads(line) for line in self.capture.read_text().splitlines()]

    def test_build_only_builds_image(self):
        result = self.run_make("build")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["args"], [
            "build", "--load", "-t", "localhost/sawd-exec-server:0.1.0", ".",
        ])

    def test_run_uses_existing_image_with_fixed_loopback_ports_and_image_cmd(self):
        result = self.run_make("run")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["args"], ["container", "ls", "-a", "--format", "{{.Names}}"])
        args = calls[1]["args"]
        self.assertEqual(args[:4], [
            "run", "-d", "--rm", "--name",
        ])
        self.assertEqual(args[4], "sawd-exec-server")
        self.assertEqual(args[5:13], [
            "--env-file", ".env",
            "--health-cmd", 'curl --fail --silent --max-time 2 "http://127.0.0.1:${PORT:-3775}/readyz" >/dev/null',
            "-p", "127.0.0.1:3773:3773",
            "-p", "127.0.0.1:3775:3775",
        ])
        self.assertEqual(args[13:], [
            "--privileged", "--user", "root", "-e", "START_DOCKER=true",
            "localhost/sawd-exec-server:0.1.0",
        ])

    def test_default_runs_without_building(self):
        result = self.run_make()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call["args"][0] for call in self.calls()], ["container", "run"])

    def test_run_replaces_only_the_exact_named_container(self):
        result = self.run_make(
            "run", "CONTAINER=custom.exec",
            TEST_CONTAINERS="customXexec\ncustom.exec\ncustom.exec-other\nunrelated",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1]["args"], ["container", "rm", "-f", "custom.exec"])
        self.assertEqual(calls[2]["args"][:5], ["run", "-d", "--rm", "--name", "custom.exec"])

    def test_run_stops_when_container_lookup_fails(self):
        result = self.run_make("run", TEST_LIST_STATUS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.calls()[0]["args"][:2], ["container", "ls"])

    def test_run_stops_when_container_removal_fails(self):
        result = self.run_make(
            "run", TEST_CONTAINERS="sawd-exec-server", TEST_REMOVE_STATUS="1",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual(self.calls()[1]["args"][:2], ["container", "rm"])

    def test_run_args_preserve_quoted_mount_path_and_environment_names(self):
        mount = self.directory / "local repos"
        run_args = f"-e API_KEY -e AWS_PROFILE -v '{mount}:/workspace/repos:rw'"
        result = self.run_make("run", f"RUN_ARGS={run_args}")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual([call["args"][0] for call in calls], ["container", "run"])
        self.assertEqual(calls[1]["args"][13:], [
            "-e", "API_KEY", "-e", "AWS_PROFILE", "-v",
            f"{mount}:/workspace/repos:rw",
            "--privileged", "--user", "root", "-e", "START_DOCKER=true",
            "localhost/sawd-exec-server:0.1.0",
        ])

    def test_image_and_container_overrides_apply_to_build_run_and_stop(self):
        image = "registry.example/custom-exec:dev"
        container = "custom-exec"
        result = self.run_make(
            "build", "run", f"IMAGE={image}", f"CONTAINER={container}",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(calls[0]["args"], ["build", "--load", "-t", image, "."])
        self.assertEqual(calls[2]["args"][4], container)
        self.assertEqual(calls[2]["args"][-1], image)

        self.capture.unlink()
        result = self.run_make("stop", f"CONTAINER={container}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[0]["args"], ["stop", container])

    def test_open_uses_python_webbrowser_for_fixed_local_url(self):
        result = self.run_make("open")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[0]["args"], [
            "-m", "webbrowser", "http://localhost:3775",
        ])


if __name__ == "__main__":
    unittest.main()
