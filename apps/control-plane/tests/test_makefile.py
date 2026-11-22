"""Exercise Makefile targets without building an image or starting anything."""

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
            "    output.write(json.dumps({'program': os.environ.get('TEST_PROGRAM'), "
            "'args': sys.argv[1:], 'image': os.environ.get('FACTORY_AGENT_IMAGE'), "
            "'session': os.environ.get('HERDR_SESSION')}) + '\\n')\n"
            "if sys.argv[1:3] == ['container', 'ls']:\n"
            "    print(os.environ.get('TEST_CONTAINERS', ''))\n"
            "    sys.exit(int(os.environ.get('TEST_LIST_STATUS', '0')))\n"
            "if sys.argv[1:3] == ['container', 'rm']:\n"
            "    sys.exit(int(os.environ.get('TEST_REMOVE_STATUS', '0')))\n"
        )
        self.make_fake("docker", "exec \"$TEST_PYTHON\" \"$TEST_RECORDER\" \"$@\"")
        for name in ("python3", "herdr", "npm", "node"):
            self.make_fake(name, "exec \"$TEST_PYTHON\" \"$TEST_RECORDER\" \"$@\"")

    def make_fake(self, name, command):
        executable = self.bin / name
        executable.write_text(f"#!/bin/sh\nexport TEST_PROGRAM={name}\n{command}\n")
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

    def test_agent_image_builds_the_configured_tag(self):
        result = self.run_make("agent-image", "IMAGE=example.test/agent:1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call["args"] for call in self.calls()],
                         [["build", "--load", "-t", "example.test/agent:1", "."]])

    def test_default_builds_the_dashboard_then_starts_the_server(self):
        result = self.run_make("SESSION=ci")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual([(call["program"], call["args"]) for call in calls],
                         [("npm", ["run", "build"]), ("npm", ["start"])])
        self.assertEqual(calls[1]["image"], "localhost/factory-agent:latest")
        self.assertEqual(calls[1]["session"], "ci")

    def test_herdr_and_smoke_use_the_same_session(self):
        for target, expected in (("herdr", ("herdr", ["--session", "factory", "server"])),
                                 ("smoke", ("node", ["scripts/smoke.ts", "factory"]))):
            with self.subTest(target=target):
                self.capture.unlink(missing_ok=True)
                result = self.run_make(target)
                self.assertEqual(result.returncode, 0, result.stderr)
                call = self.calls()[0]
                self.assertEqual((call["program"], call["args"]), expected)

    def test_open_uses_python_webbrowser_for_fixed_local_url(self):
        result = self.run_make("open")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[0]["args"], ["-m", "webbrowser", "http://localhost:3775"])


if __name__ == "__main__":
    unittest.main()
