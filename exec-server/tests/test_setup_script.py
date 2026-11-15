"""Exercise the standalone installer without credentials, Docker, or network access."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "setup.sh"
REGISTRY = "123456789012.dkr.ecr.eu-central-1.amazonaws.com"
IMAGE = f"{REGISTRY}/software-factory-execution-server:v0.3"
CONTAINER = "software-factory-exec-server"
FAKE_CLI = r'''
import json, os, sys, tempfile
from pathlib import Path
tool, *args = sys.argv[1:]
root = Path(os.environ["TEST_ROOT"])
state_path = root / "state.json"
state = json.loads(state_path.read_text())
initial_state = json.dumps(state)

def save_state():
    content = json.dumps(state)
    if content == initial_state:
        return
    # Piped AWS/Docker helpers run concurrently; never expose a truncated file.
    with tempfile.NamedTemporaryFile("w", dir=root, delete=False) as output:
        output.write(content)
    os.replace(output.name, state_path)

with (root / "calls.jsonl").open("a") as output:
    output.write(json.dumps([tool, *args]) + "\n")
if os.environ.get("TEST_FAIL") == " ".join([tool, *args[:1]]):
    if tool == "gh" and args[0] == "api":
        print("Failed request with token " + os.environ["GH_TOKEN"], file=sys.stderr)
    sys.exit(1)
if tool == "gh":
    if args == ["api", "--hostname", "github.com", "--include", "--silent", "user"]:
        if "TEST_EXPECTED_GPR_TOKEN" in os.environ:
            assert os.environ["GH_TOKEN"] == os.environ["TEST_EXPECTED_GPR_TOKEN"]
        assert not os.environ.get("GH_DEBUG")
        print(os.environ.get("TEST_SCOPE_HEADERS", "X-OAuth-Scopes: repo, read:packages"))
    elif args in (["auth", "token"], ["auth", "token", "--hostname", "github.com"]):
        print(os.environ.get("TEST_GH_TOKEN", "github-test-token"))
    else:
        sys.exit("Unexpected gh command")
elif tool == "aws":
    print("ecr-test-password")
elif args[:2] == ["container", "ls"]:
    if state.get("container"):
        print(state.get("container_name", "software-factory-exec-server"))
elif args[:2] == ["image", "inspect"]:
    sys.exit(0 if state.get("image") else 1)
elif args[0] == "login":
    assert sys.stdin.read().strip() == "ecr-test-password"
elif args[0] == "pull":
    state["image"] = True
elif args[0] == "run" and "-d" in args:
    assert not state.get("container")
    environment = dict(line.split("=", 1) for line in
                       Path(args[args.index("--env-file") + 1]).read_text().splitlines()
                       if "=" in line and not line.startswith("#"))
    environment.update(args[index + 1].split("=", 1)
                       for index, arg in enumerate(args) if arg == "-e")
    state.update(container=True, container_name=args[args.index("--name") + 1],
                 status="running", image_name=args[-1],
                 environment=environment,
                 workspace=args[args.index("--label") + 1].split("=", 1)[1])
elif args[0] == "start":
    state["status"] = state.get("start_status", "running")
elif args[0] == "stop":
    state["status"] = "exited"
elif args[0] == "rm":
    assert state["status"] == "exited"
    state["container"] = False
elif args[0] == "exec":
    readiness = state.get("readiness", [True])
    is_ready = readiness.pop(0) if len(readiness) > 1 else readiness[0]
    state["readiness"] = readiness
    save_state()
    if not is_ready:
        sys.exit(1)
elif args[0] == "inspect":
    template = args[args.index("--format") + 1]
    if ".Config.Labels" in template:
        print(state.get("workspace", ""))
    elif ".Config.Image" in template:
        print(state.get("image_name", ""))
    elif ".Config.Env" in template:
        for key, value in state["environment"].items():
            print(f"{key}={value}")
    elif ".State.Health" in template:
        statuses = state.get("health", ["healthy"])
        health = statuses.pop(0) if len(statuses) > 1 else statuses[0]
        print(state["status"], health)
    else:
        print(state["status"])
save_state()
'''


class SetupScriptTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="software-factory setup ")
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name).resolve()
        # Keep optional Maven/Gradle settings isolated from the host user's home.
        self.home = self.directory / "home"
        self.home.mkdir()
        # Copy only the installer, proving it has no source-tree dependencies.
        self.script = self.directory / "setup.sh"
        shutil.copyfile(SCRIPT, self.script)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.recorder = self.directory / "fake.py"
        self.recorder.write_text(FAKE_CLI)
        self.capture = self.directory / "calls.jsonl"
        self.state = self.directory / "state.json"
        self.state.write_text("{}")
        self.env_file = self.directory / ".env"
        for tool in ("docker", "aws", "gh"):
            executable = self.bin / tool
            executable.write_text(
                '#!/bin/sh\nexec "$TEST_PYTHON" "$TEST_RECORDER" '
                f'{tool} "$@"\n'
            )
            executable.chmod(0o755)

    def run_setup(self, *args, input="bifrost-test-key\n", **overrides):
        environment = {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "HOME": str(self.home),
            "TEST_ROOT": str(self.directory), "TEST_PYTHON": sys.executable,
            "TEST_RECORDER": str(self.recorder), "AWS_PROFILE": "setup-test", **overrides,
        }
        environment = {key: value for key, value in environment.items() if value is not None}
        if "LD_LIBRARY_PATH" in os.environ:
            environment["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
        return subprocess.run(
            ["/bin/bash", str(self.script), *args], cwd=self.directory,
            env=environment, input=input, text=True, capture_output=True, timeout=10,
        )

    def calls(self):
        return [json.loads(line) for line in self.capture.read_text().splitlines()] \
            if self.capture.exists() else []

    def readiness_calls(self):
        return [call for call in self.calls()
                if call[:2] == ["docker", "exec"]]

    def runtime_environment(self):
        return {"MODEL_API_KEY": "saved-key", "GH_TOKEN": "saved-token",
                "GPR_TOKEN": "saved-package-token", "OPENCODE_PASSWORD": "tester",
                "START_DOCKER": "true", "PORT": "3775", "MCP_PORT": "3776",
                "WORKSPACE_ROOT": "/workspace/software-factory", "AWS_GATEWAY_URL": ""}

    def seed(self, **state):
        self.env_file.write_text("MODEL_API_KEY=saved-key\nGH_TOKEN=saved-token\n"
                                 "GPR_TOKEN=saved-package-token\n")
        state.setdefault("environment", self.runtime_environment())
        if state.get("container"):
            state.setdefault("image", True)
        self.state.write_text(json.dumps(state))

    def assert_recreated(self):
        calls = self.calls()
        run = next(call for call in calls if call[:3] == ["docker", "run", "-d"])
        stopped = calls.index(["docker", "stop", CONTAINER])
        removed = calls.index(["docker", "rm", CONTAINER])
        self.assertLess(stopped, removed)
        self.assertLess(removed, calls.index(run))
        self.assertNotIn(["docker", "start", CONTAINER], calls)
        self.assertEqual(json.loads(self.state.read_text())["status"], "running")

    def test_fresh_setup_saves_secrets_and_runs_published_image_with_mount(self):
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("https://ai-gateway.example.com/workspace/governance/virtual-keys",
                      result.stdout)
        self.assertEqual(self.env_file.read_text(),
                         "MODEL_API_KEY=bifrost-test-key\nGH_TOKEN=github-test-token\n"
                         "GPR_TOKEN=github-test-token\nOPENCODE_PASSWORD=tester\n")
        self.assertEqual(self.env_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.directory / "workspace").stat().st_mode & 0o777, 0o755)
        for secret in ("bifrost-test-key", "github-test-token", "ecr-test-password"):
            self.assertNotIn(secret, result.stdout + result.stderr)
        calls = self.calls()
        self.assertIn(["gh", "auth", "token"], calls)
        self.assertIn(["gh", "auth", "token", "--hostname", "github.com"], calls)
        self.assertIn(["aws", "ecr", "get-login-password", "--region", "eu-central-1"], calls)
        self.assertIn(["docker", "login", "--username", "AWS", "--password-stdin", REGISTRY], calls)
        self.assertIn(["docker", "pull", IMAGE], calls)
        run = next(call for call in calls if call[:3] == ["docker", "run", "-d"])
        self.assertEqual(run[-1], IMAGE)
        self.assertEqual(run[run.index("--env-file") + 1], str(self.env_file))
        self.assertIn("--name", run)
        self.assertEqual(run[run.index("--name") + 1], CONTAINER)
        self.assertIn(f"software-factory.workspace={self.directory}/workspace",
                      run)
        self.assertIn(f"type=bind,source={self.directory}/workspace,target=/workspace/software-factory", run)
        self.assertIn("--privileged", run)
        self.assertIn("START_DOCKER=true", run)
        self.assertIn("WORKSPACE_ROOT=/workspace/software-factory", run)
        self.assertEqual(json.loads(self.state.read_text())["environment"]["AWS_GATEWAY_URL"], "")
        self.assertEqual(json.loads(self.state.read_text())["environment"]["GPR_TOKEN"],
                         "github-test-token")
        self.assertIn("127.0.0.1:3773:3773", run)
        self.assertIn("127.0.0.1:3775:3775", run)
        self.assertNotIn("--rm", run)

    def test_rerun_preserves_env_and_workspace_without_repeating_steps(self):
        self.assertEqual(self.run_setup().returncode, 0)
        original = self.env_file.read_bytes()
        task_file = self.directory / "workspace" / "task.txt"
        task_file.write_text("keep me")
        self.capture.unlink()
        result = self.run_setup(input="", TEST_FAIL="gh auth", AWS_PROFILE=None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_file.read_bytes(), original)
        self.assertEqual(task_file.read_text(), "keep me")
        self.assertTrue(all(call[0] == "docker" or call[:2] == ["gh", "api"]
                            for call in self.calls()))
        self.assertFalse(any(call[1] in {"run", "start", "stop", "rm", "pull", "login"}
                             for call in self.calls()))

    def test_stopped_container_is_started_without_pulling(self):
        self.seed(container=True, status="exited", image_name=IMAGE,
                  workspace=str(self.directory / "workspace"))
        result = self.run_setup(input="", AWS_PROFILE=None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["docker", "start", CONTAINER], self.calls())
        self.assertFalse(any(call[1] in {"run", "pull", "login"} for call in self.calls()))

    def test_existing_settings_use_test_password_and_disable_gateway(self):
        self.seed(image=True)
        with self.env_file.open("a") as output:
            output.write("OPENCODE_PASSWORD=old\nOPENCODE_PASSWORD=other\n"
                         "AWS_GATEWAY_URL=https://example.com/mcp\n")
        result = self.run_setup(input="", AWS_GATEWAY_URL="https://host.example.com/mcp")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_file.read_text().count("OPENCODE_PASSWORD="), 1)
        self.assertIn("OPENCODE_PASSWORD=tester\n", self.env_file.read_text())
        environment = json.loads(self.state.read_text())["environment"]
        self.assertEqual(environment["OPENCODE_PASSWORD"], "tester")
        self.assertEqual(environment["AWS_GATEWAY_URL"], "")

    def test_changed_runtime_settings_recreate_container(self):
        for key, value in (("OPENCODE_PASSWORD", "old"), ("AWS_GATEWAY_URL", "https://example.com/mcp"),
                           ("MODEL_API_KEY", "old-model-key"), ("GH_TOKEN", "old-github-token"),
                           ("PORT", "4785")):
            for status in ("running", "exited"):
                with self.subTest(key=key, status=status):
                    environment = self.runtime_environment()
                    environment[key] = value
                    self.seed(container=True, status=status, image_name=IMAGE,
                              workspace=str(self.directory / "workspace"), environment=environment)
                    self.capture.unlink(missing_ok=True)
                    result = self.run_setup(input="")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assert_recreated()
                    self.assertEqual(json.loads(self.state.read_text())["environment"],
                                     self.runtime_environment())
                    self.assertNotIn(value, result.stdout + result.stderr)

    def test_existing_local_image_skips_aws_and_login(self):
        self.seed(image=True)
        result = self.run_setup(input="", TEST_FAIL="aws ecr", AWS_PROFILE=None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] == "aws" or call[1] in {"pull", "login"} for call in self.calls()))

    def test_image_pull_requires_nonempty_aws_profile(self):
        for profile in (None, ""):
            with self.subTest(profile=profile):
                self.seed()
                self.capture.unlink(missing_ok=True)
                result = self.run_setup(input="", AWS_PROFILE=profile)
                self.assertNotEqual(result.returncode, 0)
                calls = self.calls()
                self.assertIn(["docker", "image", "inspect", IMAGE], calls)
                self.assertFalse(any(call[0] == "aws" or call[1] in {"login", "pull", "run"}
                                     for call in calls))

    def test_custom_container_and_image_are_used(self):
        custom_container = "custom-execution-server"
        custom_image = f"{REGISTRY}/software-factory-execution-server:release-2"
        result = self.run_setup(CONTAINER=custom_container, IMAGE=custom_image)
        self.assertEqual(result.returncode, 0, result.stderr)
        run = next(call for call in self.calls() if call[:3] == ["docker", "run", "-d"])
        self.assertEqual(run[run.index("--name") + 1], custom_container)
        self.assertEqual(run[-1], custom_image)

    def test_blank_duplicate_env_keys_are_replaced_without_executing_env(self):
        self.env_file.write_text(
            "# Preserve this\nMODEL_API_KEY=\nGH_TOKEN=old\nGH_TOKEN=\n"
            "GPR_TOKEN=old\nGPR_TOKEN=\n"
            "EXAMPLE=$(touch injected)"
        )
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        content = self.env_file.read_text()
        self.assertIn("# Preserve this\n", content)
        self.assertIn("EXAMPLE=$(touch injected)\n", content)
        self.assertEqual(content.count("MODEL_API_KEY="), 1)
        self.assertEqual(content.count("GH_TOKEN="), 1)
        self.assertEqual(content.count("GPR_TOKEN="), 1)
        self.assertFalse((self.directory / "injected").exists())

    def test_package_token_prefers_exported_then_saved_value(self):
        for exported, expected in (("host-package-token", "host-package-token"),
                                   (None, "saved-package-token"), ("", "saved-package-token")):
            with self.subTest(exported=exported):
                self.seed(image=True)
                self.capture.unlink(missing_ok=True)
                result = self.run_setup(
                    input="", GPR_TOKEN=exported, GH_TOKEN="unrelated-token",
                    GITHUB_TOKEN="another-unrelated-token", GH_DEBUG="api",
                    TEST_EXPECTED_GPR_TOKEN=expected, TEST_FAIL="gh auth",
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"GPR_TOKEN={expected}\n", self.env_file.read_text())
                self.assertEqual(json.loads(self.state.read_text())["environment"]["GPR_TOKEN"],
                                 expected)
                self.assertNotIn(expected, result.stdout + result.stderr)
                self.assertFalse(any(call[:2] == ["gh", "auth"] for call in self.calls()))

    def test_package_scope_accepts_read_or_write_with_header_variations(self):
        for header in ("x-oauth-scopes: read:packages\r", "X-OAuth-Scopes: repo, write:packages",
                       "X-OAuth-Scopes:\tworkflow, read:packages, repo\r\nX-Other: value"):
            with self.subTest(header=header):
                self.seed(image=True)
                result = self.run_setup(input="", TEST_SCOPE_HEADERS=header)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_package_scope_failure_stops_with_manual_remediation_without_saving(self):
        for header in ("X-OAuth-Scopes: repo", "X-OAuth-Scopes:", "X-Other: read:packages",
                       "X-OAuth-Scopes: delete:packages", "X-OAuth-Scopes: unread:packages",
                       "X-OAuth-Scopes: read:packages-extra"):
            with self.subTest(header=header):
                self.seed(image=True)
                self.capture.unlink(missing_ok=True)
                result = self.run_setup(input="", GPR_TOKEN="new-package-token",
                                        TEST_SCOPE_HEADERS=header)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("gh auth refresh --hostname github.com --scopes read:packages",
                              result.stderr)
                self.assertIn("GPR_TOKEN=saved-package-token\n", self.env_file.read_text())
                self.assertNotIn("new-package-token", result.stdout + result.stderr)
                self.assertFalse(any(call[:3] == ["gh", "auth", "refresh"] or
                                     call[:2] == ["docker", "run"] for call in self.calls()))

    def test_package_scope_request_failure_hides_diagnostics_and_stops(self):
        self.seed(image=True)
        result = self.run_setup(input="", TEST_FAIL="gh api")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not verify GPR_TOKEN scopes", result.stderr)
        self.assertNotIn("saved-package-token", result.stdout + result.stderr)
        self.assertFalse(any(call[:2] == ["docker", "run"] for call in self.calls()))

    def test_invalid_package_token_is_not_sent_or_saved(self):
        for token in ("token\nINJECTED=value", "token with spaces", "token\t", "token\r"):
            with self.subTest(token=token):
                self.seed(image=True)
                self.capture.unlink(missing_ok=True)
                result = self.run_setup(input="", GPR_TOKEN=token)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("GPR_TOKEN must be", result.stderr)
                self.assertIn("GPR_TOKEN=saved-package-token\n", self.env_file.read_text())
                self.assertNotIn(token, result.stdout + result.stderr)
                self.assertFalse(any(call[:2] == ["gh", "api"] for call in self.calls()))

    def test_package_token_lookup_failure_can_be_resumed(self):
        self.env_file.write_text("MODEL_API_KEY=saved-key\nGH_TOKEN=saved-token\n")
        result = self.run_setup(input="", TEST_FAIL="gh auth")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("export GPR_TOKEN", result.stderr)
        self.assertNotIn("GPR_TOKEN=", self.env_file.read_text())
        result = self.run_setup(input="", TEST_EXPECTED_GPR_TOKEN="github-test-token")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_or_changed_container_package_token_recreates_container(self):
        for token in (None, "", "old-package-token"):
            for status in ("running", "exited"):
                with self.subTest(token=token, status=status):
                    environment = self.runtime_environment()
                    del environment["GPR_TOKEN"]
                    if token is not None:
                        environment["GPR_TOKEN"] = token
                    self.seed(container=True, status=status, image_name=IMAGE,
                              workspace=str(self.directory / "workspace"), environment=environment)
                    self.capture.unlink(missing_ok=True)
                    result = self.run_setup(input="")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assert_recreated()
                    self.assertEqual(json.loads(self.state.read_text())["environment"]["GPR_TOKEN"],
                                     "saved-package-token")
                    self.assertNotIn("saved-package-token", result.stdout + result.stderr)
                    self.assertNotIn("old-package-token", result.stdout + result.stderr)

    def test_changed_image_is_pulled_before_replacement_and_workspace_is_kept(self):
        self.seed(container=True, status="running", image=False, image_name=f"{REGISTRY}/old:v1",
                  workspace=str(self.directory / "workspace"))
        workspace = self.directory / "workspace"
        workspace.mkdir()
        task_file = workspace / "task.txt"
        task_file.write_text("keep me")
        result = self.run_setup(input="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_recreated()
        calls = self.calls()
        self.assertLess(calls.index(["docker", "pull", IMAGE]),
                        calls.index(["docker", "stop", CONTAINER]))
        self.assertEqual(json.loads(self.state.read_text())["image_name"], IMAGE)
        self.assertEqual(task_file.read_text(), "keep me")
        self.assertIn("MODEL_API_KEY=saved-key\n", self.env_file.read_text())

    def test_custom_env_assignment_change_recreates_container(self):
        self.seed(container=True, status="running", image_name=IMAGE,
                  workspace=str(self.directory / "workspace"))
        with self.env_file.open("a") as output:
            output.write("# Custom setting\nOPENCODE_MODEL=old\nOPENCODE_MODEL=new-model\r\n")
        result = self.run_setup(input="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_recreated()
        self.assertEqual(json.loads(self.state.read_text())["environment"]["OPENCODE_MODEL"],
                         "new-model")

    def test_replacement_failure_does_not_start_a_new_container(self):
        for failure in ("docker pull", "docker stop", "docker rm"):
            with self.subTest(failure=failure):
                self.seed(container=True, status="running", image=False,
                          image_name=f"{REGISTRY}/old:v1", workspace=str(self.directory / "workspace"))
                self.capture.unlink(missing_ok=True)
                result = self.run_setup(input="", TEST_FAIL=failure)
                self.assertNotEqual(result.returncode, 0)
                calls = self.calls()
                self.assertFalse(any(call[:3] == ["docker", "run", "-d"] for call in calls))
                if failure == "docker pull":
                    self.assertNotIn(["docker", "stop", CONTAINER], calls)
                    self.assertEqual(json.loads(self.state.read_text())["status"], "running")
                if failure != "docker rm":
                    self.assertNotIn(["docker", "rm", CONTAINER], calls)

    def test_partial_setup_resumes_after_github_login_failure(self):
        result = self.run_setup(TEST_FAIL="gh auth")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("bifrost-test-key", result.stdout + result.stderr)
        self.assertEqual(self.env_file.read_text(), "MODEL_API_KEY=bifrost-test-key\n")
        result = self.run_setup(input="")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_failed_docker_aws_login_pull_or_workspace_setup_does_not_start(self):
        for failure in ("docker info", "aws ecr", "docker login", "docker pull", "docker run"):
            with self.subTest(failure=failure):
                self.seed()
                self.capture.unlink(missing_ok=True)
                result = self.run_setup(TEST_FAIL=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call[:3] == ["docker", "run", "-d"] for call in self.calls()))

    def test_changed_workspace_recreates_selected_container(self):
        for status in ("running", "exited"):
            with self.subTest(status=status):
                self.seed(container=True, status=status, image_name=IMAGE, workspace="/other/workspace")
                self.capture.unlink(missing_ok=True)
                result = self.run_setup(input="")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_recreated()
                self.assertEqual(json.loads(self.state.read_text())["workspace"],
                                 str(self.directory / "workspace"))

    def test_nonrunning_container_fails_without_readiness_probe(self):
        self.seed(container=True, status="exited", start_status="exited", image_name=IMAGE,
                  workspace=str(self.directory / "workspace"), readiness=[True])
        result = self.run_setup(input="")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.readiness_calls(), [])

    def test_readiness_timeout_fails(self):
        bash_env = self.directory / "bash-env"
        bash_env.write_text('sleep() { SECONDS=$((SECONDS + 240)); }\n')
        self.seed(container=True, status="running", image_name=IMAGE,
                  workspace=str(self.directory / "workspace"), readiness=[False])
        result = self.run_setup(input="", BASH_ENV=str(bash_env))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.readiness_calls()), 1)

    def test_ready_endpoint_succeeds_with_stale_docker_health(self):
        self.seed(container=True, status="running", image_name=IMAGE,
                  workspace=str(self.directory / "workspace"),
                  health=["starting"], readiness=[True])
        result = self.run_setup(input="")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.readiness_calls()
        self.assertEqual(len(calls), 1)
        self.assertIn("curl", calls[0])
        self.assertIn("http://127.0.0.1:3775/readyz", calls[0])
        self.assertEqual(json.loads(self.state.read_text())["health"], ["starting"])

    def test_readiness_probe_retries_failures_until_success(self):
        bash_env = self.directory / "bash-env"
        bash_env.write_text('sleep() { SECONDS=$((SECONDS + 2)); }\n')
        self.seed(container=True, status="running", image_name=IMAGE,
                  workspace=str(self.directory / "workspace"),
                  readiness=[False, False, True])
        result = self.run_setup(input="", BASH_ENV=str(bash_env))
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.readiness_calls()
        self.assertEqual(len(calls), 3)
        for call in calls:
            self.assertIn("curl", call)
            self.assertIn("http://127.0.0.1:3775/readyz", call)

    def test_symlink_env_is_rejected_without_changing_target(self):
        target = self.directory / "private"
        target.write_text("unchanged")
        self.env_file.symlink_to(target)
        result = self.run_setup()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), "unchanged")

    def test_multiline_github_token_is_not_written(self):
        result = self.run_setup(TEST_GH_TOKEN="token\nINJECTED=value")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("GH_TOKEN=", self.env_file.read_text())
        self.assertNotIn("INJECTED=", self.env_file.read_text())

    def test_help_needs_no_docker_or_credentials(self):
        result = self.run_setup("--help", TEST_FAIL="docker info", AWS_PROFILE=None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.env_file.exists())
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
