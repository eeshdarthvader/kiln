"""Test the agent image scripts without root, Docker, or network access."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
import unittest


BASH = shutil.which("bash") or "/bin/bash"

IMAGE = Path(__file__).resolve().parents[1] / "image"
HARNESS = r'''
exec() { "$TEST_PYTHON" "$TEST_RECORDER" "$@"; exit $?; }
source "$TEST_SCRIPT"
'''
RECORDER = '''
import json, os, sys
keys = {"HOME", "USER", "LOGNAME", "PATH", "GH_TOKEN",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy",
        "all_proxy", "NO_PROXY", "no_proxy", "GIT_SSL_NO_VERIFY",
        "SSL_CERT_FILE", "GIT_SSL_CAINFO"}
environment = {key: value for key, value in os.environ.items()
               if key in keys or key.startswith("GIT_CONFIG_")}
with open(os.environ["TEST_EVENTS"], "a") as events:
    events.write(json.dumps({"args": sys.argv[1:], "env": environment}) + "\\n")
'''


class ImageScriptTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.directory = Path(self.scratch.name).resolve()
        self.recorder = self.directory / "record.py"
        self.recorder.write_text(RECORDER)
        self.events = self.directory / "events.jsonl"
        self.ca = self.directory / "proxy.crt"
        self.ca.write_text("test CA placeholder")
        self.prompt = self.directory / "plan-1.prompt.md"
        self.prompt.write_text("# Stage: plan\n\nWrite the plan; don't ask \"questions\".\n")
        # The entrypoint configures git before it starts the agent; keep that off the real git.
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        fake_git = self.bin / "git"
        fake_git.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_GIT_LOG"\n')
        fake_git.chmod(0o755)
        self.git_log = self.directory / "git.log"

    def run_script(self, script, client, *args, **overrides):
        self.events.unlink(missing_ok=True)
        environment = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}" if script == "entrypoint.sh"
            else os.environ["PATH"],
            "HOME": str(self.directory), "USER": "agent", "LOGNAME": "agent",
            "TEST_SCRIPT": str(IMAGE / script), "TEST_GIT_LOG": str(self.git_log),
            "TEST_PYTHON": sys.executable, "TEST_RECORDER": str(self.recorder),
            "TEST_EVENTS": str(self.events), **overrides,
        }
        environment = {key: value for key, value in environment.items() if value is not None}
        # setup-python's Linux interpreter needs its library path in child processes.
        if "LD_LIBRARY_PATH" in os.environ:
            environment.setdefault("LD_LIBRARY_PATH", os.environ["LD_LIBRARY_PATH"])
        result = subprocess.run(
            [BASH, "-c", HARNESS, client, *args], cwd=self.directory,
            env=environment, capture_output=True, text=True, timeout=5,
        )
        events = [json.loads(line) for line in self.events.read_text().splitlines()] \
            if self.events.exists() else []
        return result, events

    def run_entrypoint(self, **overrides):
        return self.run_script("entrypoint.sh", "entrypoint", **{
            "FACTORY_STAGE": "plan", "FACTORY_MCP_URL": "http://host:3776/mcp/runs/r1/stages/plan",
            "FACTORY_PROMPT_FILE": str(self.prompt), "CLAUDE_CODE_OAUTH_TOKEN": "test-token",
            **overrides,
        })

    def test_entrypoint_starts_claude_with_the_prompt_and_only_the_factory_mcp_server(self):
        result, events = self.run_entrypoint()
        self.assertEqual(result.returncode, 0, result.stderr)
        args = events[0]["args"]
        self.assertEqual(args[0], "claude")
        self.assertEqual(args[1], "--dangerously-skip-permissions")
        self.assertEqual(args[-2:], ["--", self.prompt.read_text().rstrip("\n")])
        self.assertIn("--strict-mcp-config", args)
        self.assertNotIn("--print", args)
        self.assertNotIn("--model", args)
        config = json.loads(Path(args[args.index("--mcp-config") + 1]).read_text())
        self.assertEqual(config, {"mcpServers": {"factory": {
            "type": "http", "url": "http://host:3776/mcp/runs/r1/stages/plan"}}})
        first_run = json.loads((self.directory / ".claude.json").read_text())
        self.assertTrue(first_run["hasCompletedOnboarding"])
        self.assertTrue(first_run["projects"][str(self.directory)]["hasTrustDialogAccepted"])
        self.assertEqual(self.git_log.read_text().splitlines(), [
            "config --global user.name Software Factory",
            "config --global user.email software-factory@users.noreply.github.com",
        ])
        self.assertNotIn("test-token", json.dumps(events) + result.stdout + result.stderr)

    def test_entrypoint_print_mode_model_and_git_identity_are_configurable(self):
        result, events = self.run_entrypoint(
            FACTORY_AGENT_MODE="print", FACTORY_AGENT_MODEL="some-model",
            FACTORY_GIT_NAME="Robo Dev", FACTORY_GIT_EMAIL="robo@example.com",
            CLAUDE_CODE_OAUTH_TOKEN=None, ANTHROPIC_API_KEY="test-key",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        args = events[0]["args"]
        self.assertEqual(args[:2], ["claude", "--print"])
        self.assertEqual(args[args.index("--model") + 1], "some-model")
        self.assertFalse((self.directory / ".claude.json").exists())
        self.assertIn("config --global user.name Robo Dev", self.git_log.read_text())

    def test_entrypoint_refuses_to_start_without_its_inputs(self):
        for overrides, message in (
            ({"FACTORY_STAGE": None}, "FACTORY_STAGE is required"),
            ({"FACTORY_MCP_URL": None}, "FACTORY_MCP_URL is required"),
            ({"FACTORY_PROMPT_FILE": str(self.directory / "missing.md")}, "Cannot read"),
            ({"CLAUDE_CODE_OAUTH_TOKEN": None}, "CLAUDE_CODE_OAUTH_TOKEN"),
            ({"FACTORY_AGENT_MODE": "yolo"}, "FACTORY_AGENT_MODE must be"),
        ):
            with self.subTest(overrides=overrides):
                result, events = self.run_entrypoint(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(events, [])

    def test_direct_clients_preserve_credentials_and_existing_configuration(self):
        for client in ("git", "gh"):
            with self.subTest(client=client):
                result, events = self.run_script(
                    "github-cli.sh", client, "status", "two words",
                    GH_TOKEN="existing-token", GIT_CONFIG_COUNT="1",
                    GIT_CONFIG_KEY_0="example.key", GIT_CONFIG_VALUE_0="original",
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(events[0]["args"], [f"/usr/bin/{client}", "status", "two words"])
                self.assertEqual(events[0]["env"]["GH_TOKEN"], "existing-token")
                self.assertEqual(events[0]["env"]["GIT_CONFIG_COUNT"], "1")
                self.assertNotIn("HTTP_PROXY", events[0]["env"])

    def test_proxy_clients_append_configuration_and_apply_ca_and_token(self):
        for client in ("git", "gh"):
            with self.subTest(client=client):
                result, events = self.run_script(
                    "github-cli.sh", client, "status", GITHUB_EGRESS_PROXY="http://proxy:3128",
                    GITHUB_EGRESS_CA="proxy.crt", GIT_CONFIG_COUNT="000001",
                    GIT_CONFIG_KEY_0="example.key", GIT_CONFIG_VALUE_0="original",
                    GH_TOKEN="existing-token", GIT_SSL_NO_VERIFY="true", NO_PROXY="github.com",
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                environment = events[0]["env"]
                self.assertEqual(environment["GIT_CONFIG_COUNT"], "6")
                self.assertEqual(environment["GIT_CONFIG_VALUE_0"], "original")
                self.assertEqual(environment["GIT_CONFIG_KEY_1"], "http.proxy")
                self.assertEqual(environment["GIT_CONFIG_VALUE_1"], "http://proxy:3128")
                self.assertEqual(environment["GIT_CONFIG_KEY_5"], "http.sslCAInfo")
                self.assertEqual(environment["GIT_CONFIG_VALUE_5"], str(self.ca))
                self.assertEqual(environment["SSL_CERT_FILE"], str(self.ca))
                self.assertEqual(environment["GIT_SSL_CAINFO"], str(self.ca))
                self.assertEqual(environment["NO_PROXY"], "")
                self.assertNotIn("GIT_SSL_NO_VERIFY", environment)
                self.assertEqual(environment["GH_TOKEN"], "proxy-placeholder" if client == "gh" else "existing-token")
                for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
                    self.assertEqual(environment[key], "http://proxy:3128")

    def test_invalid_proxy_configuration_does_not_execute_client(self):
        for overrides, status in (({"GITHUB_EGRESS_CA": "missing.crt"}, 1),
                                  ({"GIT_CONFIG_COUNT": "invalid"}, 2)):
            with self.subTest(overrides=overrides):
                result, events = self.run_script(
                    "github-cli.sh", "git", "status", GITHUB_EGRESS_PROXY="http://proxy:3128",
                    **{"GITHUB_EGRESS_CA": str(self.ca), **overrides},
                )
                self.assertEqual(result.returncode, status)
                self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
