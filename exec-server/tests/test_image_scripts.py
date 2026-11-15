"""Test image bootstrap and client routing without root, Docker, or network access."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import shutil
import unittest


BASH = shutil.which("bash") or "/bin/bash"
REAL_NODE = shutil.which("node")


IMAGE = Path(__file__).resolve().parents[1] / "image"
HARNESS = r'''
id() { printf '%s\n' "$TEST_UID"; }
docker() { return "${TEST_DOCKER_INFO_STATUS:-1}"; }
docker-start() {
    "$TEST_PYTHON" "$TEST_RECORDER" docker-start
    return "${TEST_DOCKER_STATUS:-0}"
}
exec() { "$TEST_PYTHON" "$TEST_RECORDER" "$@"; exit $?; }
source "$TEST_SCRIPT"
'''
RECORDER = '''
import json, os, sys
keys = {"HOME", "USER", "LOGNAME", "PATH", "MODEL_API_KEY", "GH_TOKEN",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy",
        "all_proxy", "NO_PROXY", "no_proxy", "GIT_SSL_NO_VERIFY",
        "SSL_CERT_FILE", "GIT_SSL_CAINFO", "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_PASSWORD", "AWS_PROFILE", "AWS_SECRET_ACCESS_KEY",
        "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"}
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

    def run_script(self, script, client, *args, **overrides):
        self.events.unlink(missing_ok=True)
        environment = {
            "PATH": os.environ["PATH"], "HOME": str(self.directory), "USER": "agent",
            "LOGNAME": "agent", "MODEL_API_KEY": "test-key",
            "TEST_UID": "1000", "TEST_SCRIPT": str(IMAGE / script),
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

    def test_root_drops_privileges_with_agent_environment(self):
        result, events = self.run_script(
            "entrypoint.sh", "entrypoint", "--version", TEST_UID="0",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0]["args"], [
            "setpriv", "--reuid=agent", "--regid=agent", "--init-groups", "env",
            "HOME=/home/agent", "USER=agent", "LOGNAME=agent", "/usr/local/bin/entrypoint", "--version",
        ])

    def test_root_serve_reenters_entrypoint_as_agent(self):
        result, events = self.run_script(
            "entrypoint.sh", "entrypoint", "serve", "--hostname", "0.0.0.0", TEST_UID="0",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0]["args"], [
            "setpriv", "--reuid=agent", "--regid=agent", "--init-groups", "env",
            "HOME=/home/agent", "USER=agent", "LOGNAME=agent",
            "/usr/local/bin/entrypoint", "serve", "--hostname", "0.0.0.0",
        ])

    def test_docker_requires_root(self):
        result, events = self.run_script(
            "entrypoint.sh", "entrypoint", "serve", START_DOCKER="true",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--user root --privileged", result.stderr)
        self.assertEqual(events, [])

    def test_docker_starts_before_privilege_drop_and_failure_stops_startup(self):
        for status in ("0", "23"):
            with self.subTest(status=status):
                result, events = self.run_script(
                    "entrypoint.sh", "entrypoint", "serve", TEST_UID="0",
                    START_DOCKER="true", TEST_DOCKER_STATUS=status,
                )
                self.assertEqual(result.returncode, int(status), result.stderr)
                self.assertEqual(events[0]["args"], ["docker-start"])
                self.assertEqual(len(events), 2 if status == "0" else 1)

    def test_invalid_docker_flag_is_rejected(self):
        for flag in ("", "TRUE", "0", "yes"):
            with self.subTest(flag=flag):
                result, events = self.run_script(
                    "entrypoint.sh", "entrypoint", "serve", START_DOCKER=flag,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("must be true or false", result.stderr)
                self.assertEqual(events, [])

    def test_non_server_cli_arguments_get_opencode_prefix(self):
        for arguments in (["--version"], ["auth", "session", "list"]):
            with self.subTest(arguments=arguments):
                result, events = self.run_script("entrypoint.sh", "entrypoint", *arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(events[0]["args"], ["opencode", *arguments])

    def test_opencode_routes_gateway_and_registers_sawd(self):
        result, events = self.run_script(
            "opencode.sh", "opencode", "serve", OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS="true",
            OPENCODE_PASSWORD="test-password",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events[0]["env"]["OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"], "true")
        config = json.loads(events[0]["env"]["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(events[0]["args"], ["/opt/opencode/opencode", "serve"])
        self.assertEqual(config["enabled_providers"], ["gateway"])
        self.assertEqual(config["model"], "gateway/gpt-6-luna")
        self.assertEqual(set(config["provider"]["gateway"]["models"]),
                         {"gpt-6-luna", "gpt-6-sol", "gpt-6-astra"})
        self.assertEqual(config["provider"]["gateway"]["options"]["apiKey"], "{env:MODEL_API_KEY}")
        self.assertNotIn("permission", config)
        self.assertNotIn("plugin", config)
        self.assertEqual(config["mcp"]["sawd-execution"]["url"], "http://127.0.0.1:3776/mcp")
        self.assertEqual(config["mcp"]["mcp_catalog"], {
            "type": "remote", "url": "https://ai-gateway.example.com/mcp", "oauth": False,
            "headers": {"x-bf-vk": "{env:MODEL_API_KEY}"},
        })
        self.assertNotIn("aws-gateway", config["mcp"])
        self.assertNotIn("test-key", events[0]["env"]["OPENCODE_CONFIG_CONTENT"])

    def test_opencode_validates_token_caps_and_customizes_models(self):
        for limit in ("0", "abc", "1000000000"):
            with self.subTest(limit=limit):
                result, events = self.run_script("opencode.sh", "opencode", OPENCODE_CONTEXT_LIMIT=limit)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(events, [])
        result, events = self.run_script(
            "opencode.sh", "opencode", OPENCODE_MODEL="custom-model",
            OPENCODE_MODELS="extra-model", MCP_PORT="4776",
            OPENCODE_CONTEXT_LIMIT="64000", OPENCODE_OUTPUT_LIMIT="8000",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(events[0]["env"]["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(set(config["provider"]["gateway"]["models"]), {"custom-model", "extra-model"})
        self.assertEqual(config["provider"]["gateway"]["models"]["custom-model"]["limit"],
                         {"context": 64000, "output": 8000})
        self.assertEqual(config["mcp"]["sawd-execution"]["url"], "http://127.0.0.1:4776/mcp")

    def test_opencode_preserves_aws_gateway_arguments_without_storing_secrets(self):
        endpoint = 'https://example/mcp?literal=$(touch injected)&other=`touch injected` "two words"'
        result, events = self.run_script(
            "opencode.sh", "opencode", "serve", AWS_GATEWAY_URL=endpoint,
            AWS_SECRET_ACCESS_KEY="test-secret", AWS_SESSION_TOKEN="test-session",
            OPENCODE_PASSWORD="test-password",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(events[0]["env"]["OPENCODE_CONFIG_CONTENT"])
        gateway = config["mcp"]["aws-gateway"]
        for private_value in (endpoint, "test-secret", "test-session"):
            self.assertNotIn(private_value, json.dumps(config))
        self.assertEqual(gateway["type"], "local")
        self.assertEqual(gateway["timeout"], 60000)
        self.assertEqual(gateway["command"], ["/usr/local/bin/aws-mcp"])
        result, events = self.run_script(
            "aws-mcp.sh", "aws-mcp", AWS_GATEWAY_URL=endpoint,
            AWS_SECRET_ACCESS_KEY="test-secret", AWS_SESSION_TOKEN="test-session",
            AWS_PROFILE="test-profile",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        args = events[0]["args"]
        bridge_index = args.index("/opt/aws-mcp/bin/mcp-proxy-for-aws-cli")
        self.assertEqual(bridge_index, 0)
        self.assertEqual(args[bridge_index:], [
            "/opt/aws-mcp/bin/mcp-proxy-for-aws-cli", endpoint, "--service",
            "bedrock-agentcore", "--disable-telemetry",
        ])
        self.assertEqual(events[0]["env"]["AWS_SECRET_ACCESS_KEY"], "test-secret")
        self.assertEqual(events[0]["env"]["AWS_PROFILE"], "test-profile")
        self.assertNotIn("MODEL_API_KEY=test-key", args)
        self.assertFalse((self.directory / "injected").exists())

    def make_entrypoint_fakes(self):
        fake_bin = self.directory / "bin"
        fake_bin.mkdir()
        fake = fake_bin / "fake-child"
        fake.write_text(r'''#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time
from pathlib import Path
role = Path(sys.argv[0]).name
events_path = os.environ["TEST_EVENTS"]
def record(event, **values):
    with open(events_path, "a") as stream:
        stream.write(json.dumps({"role": role, "event": event, **values}) + "\n")
if role == "node" and sys.argv[1:2] == ["-e"]:
    os.execv(os.environ["TEST_REAL_NODE"], [os.environ["TEST_REAL_NODE"], *sys.argv[1:]])
def stop(signum, frame):
    record("stop", signal=signum)
    signal.signal(signum, signal.SIG_DFL)
    time.sleep(0.1)
    record("stopped")
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
record("start", pid=os.getpid(), group=os.getpgrp(), args=sys.argv[1:], password=os.environ.get("OPENCODE_PASSWORD"),
       env={key: value for key, value in os.environ.items() if key.startswith("SAWD_")})
if role in os.environ.get("TEST_SPAWN_DESCENDANT", "").split(","):
    subprocess.Popen([sys.executable, os.environ["TEST_DESCENDANT_SCRIPT"]])
exit_role = os.environ.get("TEST_EXIT_ROLE")
if exit_role == role:
    time.sleep(float(os.environ.get("TEST_EXIT_DELAY", "0.15")))
    raise SystemExit(int(os.environ.get("TEST_EXIT_STATUS", "17")))
while True:
    time.sleep(0.05)
''')
        fake.chmod(0o755)
        (fake_bin / "opencode").symlink_to(fake)
        (fake_bin / "node").symlink_to(fake)
        identity = fake_bin / "id"
        identity.write_text("#!/bin/sh\nprintf '1000\\n'\n")
        identity.chmod(0o755)
        curl = fake_bin / "curl"
        curl.write_text(r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
events_path = Path(os.environ["TEST_EVENTS"])
events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.exists() else []
checks = sum(item.get("role") == "curl" for item in events)
statuses = os.environ.get("TEST_CURL_STATUSES", "200").split(",")
status = statuses[min(checks, len(statuses) - 1)]
if not any(item.get("role") == "opencode" and item.get("event") == "start" for item in events):
    status = "000"
with events_path.open("a") as stream:
    stream.write(json.dumps({"role": "curl", "event": "check", "args": sys.argv[1:],
                            "status": status}) + "\n")
time.sleep(float(os.environ.get("TEST_CURL_DELAY", "0")))
sys.stdout.write("000" if status == "error" else status)
raise SystemExit(7 if status in {"error", "000"} else 0)
''')
        curl.chmod(0o755)
        descendant = self.directory / "descendant.py"
        descendant.write_text(r'''#!/usr/bin/env python3
import json, os, signal, time
def record(event, **values):
    with open(os.environ["TEST_EVENTS"], "a") as stream:
        stream.write(json.dumps({"role": "descendant", "event": event, **values}) + "\n")
def stop(signum, frame):
    record("stop", signal=signum)
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
record("start", pid=os.getpid())
while True:
    time.sleep(0.05)
''')
        return fake_bin

    def read_events(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] \
            if self.events.exists() else []

    def start_entrypoint(self, args=None, **overrides):
        self.events.unlink(missing_ok=True)
        fake_bin = self.make_entrypoint_fakes()
        environment = {
            "PATH": f"{fake_bin}:{os.environ['PATH']}", "HOME": str(self.directory),
            "USER": "agent", "LOGNAME": "agent", "TEST_EVENTS": str(self.events),
            "TEST_REAL_NODE": REAL_NODE,
            "TEST_DESCENDANT_SCRIPT": str(self.directory / "descendant.py"),
            "APP_DIR": str(self.directory), "WORKSPACE_ROOT": str(self.directory / "workspace"),
            "OPENCODE_PASSWORD": "test-password",
            "MODEL_API_KEY": "test-model-key",
            **overrides,
        }
        environment = {key: value for key, value in environment.items() if value is not None}
        # setup-python's Linux interpreter needs its library path in child processes.
        if "LD_LIBRARY_PATH" in os.environ:
            environment.setdefault("LD_LIBRARY_PATH", os.environ["LD_LIBRARY_PATH"])
        process = subprocess.Popen(
            [BASH, str(IMAGE / "entrypoint.sh"),
             *(args or ["serve", "--hostname", "0.0.0.0"])],
            cwd=self.directory, env=environment, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True,
        )
        self.addCleanup(self.cleanup_entrypoint, process)
        return process

    def cleanup_entrypoint(self, process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=3)
        finally:
            # The shell may already have exited while a descendant still runs.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            for stream in (process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()

    def wait_for_event(self, process, event, role, timeout=4, count=1):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if sum(item.get("event") == event and item.get("role") == role
                   for item in self.read_events()) >= count:
                return
            if process.poll() is not None:
                stdout, stderr = process.communicate()
                self.fail(f"entrypoint exited early ({process.returncode}): {stdout} {stderr}")
            time.sleep(0.02)
        self.fail(f"timed out waiting for {role} {event}")

    def stop_entrypoint(self, process, signum=signal.SIGTERM):
        if process.poll() is None:
            # Emulate tini -g forwarding once to the shared process group.
            os.killpg(process.pid, signum)
        stdout, stderr = process.communicate(timeout=15)
        return process.returncode, stdout, stderr

    def test_entrypoint_generates_shared_random_password(self):
        process = self.start_entrypoint(OPENCODE_PASSWORD=None)
        self.wait_for_event(process, "start", "node")
        self.wait_for_event(process, "start", "opencode")
        _, stdout, stderr = self.stop_entrypoint(process)
        starts = [item for item in self.read_events()
                  if item.get("event") == "start" and item.get("role") in {"opencode", "node"}]
        password = starts[0]["password"]
        self.assertRegex(password, r"^[A-Za-z0-9_-]{16}$")
        self.assertEqual(starts[1]["password"], password)
        self.assertNotIn(password, stdout + stderr)

    def test_entrypoint_shares_supplied_password_with_both_services(self):
        password = "native:with spaces"
        process = self.start_entrypoint(OPENCODE_PASSWORD=password)
        self.wait_for_event(process, "start", "node")
        self.wait_for_event(process, "start", "opencode")
        _, stdout, stderr = self.stop_entrypoint(process)
        starts = [item for item in self.read_events()
                  if item.get("event") == "start" and item.get("role") in {"opencode", "node"}]
        self.assertEqual([item["password"] for item in starts], [password, password])
        self.assertNotIn(password, stdout + stderr)

    def test_entrypoint_rejects_control_characters_in_password(self):
        for password in ("line\nbreak", "control\x7f"):
            with self.subTest(password=password):
                result, events = self.run_script(
                    "entrypoint.sh", "entrypoint", "serve", OPENCODE_PASSWORD=password,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("OPENCODE_PASSWORD", result.stderr)
                self.assertEqual(events, [])

    def test_entrypoint_requires_model_key_for_serve(self):
        result, events = self.run_script(
            "entrypoint.sh", "entrypoint", "serve", MODEL_API_KEY=None,
            OPENCODE_PASSWORD="test-password",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MODEL_API_KEY", result.stderr)
        self.assertEqual(events, [])

    def test_entrypoint_bridges_application_configuration(self):
        process = self.start_entrypoint(PORT="4785", MCP_PORT="4786", API_TOKEN="test-api-token")
        self.wait_for_event(process, "start", "node")
        self.wait_for_event(process, "start", "opencode")
        self.stop_entrypoint(process)
        events = self.read_events()
        app = next(item for item in events if item.get("role") == "node" and item["event"] == "start")
        self.assertEqual(app["env"], {
            "SAWD_PORT": "4785", "SAWD_MCP_PORT": "4786", "SAWD_API_TOKEN": "test-api-token",
            "SAWD_WORKSPACE_ROOT": str(self.directory / "workspace"), "SAWD_START_DOCKER": "false",
        })
        opencode = next(item for item in events if item.get("role") == "opencode" and item["event"] == "start")
        self.assertEqual(opencode["env"], {})

    def test_entrypoint_stops_both_services_and_descendants_on_signal(self):
        process = self.start_entrypoint(
            args=["serve", "two words", "$(touch should-not-exist)", "`false`"],
            TEST_SPAWN_DESCENDANT="opencode,node",
        )
        self.wait_for_event(process, "start", "opencode")
        self.wait_for_event(process, "start", "node")
        self.wait_for_event(process, "start", "descendant", count=2)
        code, stdout, stderr = self.stop_entrypoint(process)
        self.assertEqual(code, 143, stderr)
        events = self.read_events()
        roles = [item["role"] for item in events if item["event"] == "start"]
        self.assertEqual(roles.count("descendant"), 2)
        self.assertTrue(any(item.get("event") == "stop" and item.get("role") == "opencode" for item in events))
        self.assertTrue(any(item.get("event") == "stop" and item.get("role") == "node" for item in events))
        self.assertEqual({item["role"] for item in events if item["event"] == "stopped"},
                         {"node", "opencode"})
        app_args = next(item["args"] for item in events
                        if item.get("role") == "node" and item["event"] == "start")
        self.assertEqual(app_args, ["src/index.ts"])
        opencode_args = next(item["args"] for item in events
                       if item.get("role") == "opencode" and item["event"] == "start")
        self.assertEqual(opencode_args, ["serve", "two words", "$(touch should-not-exist)", "`false`"])
        self.assertEqual(sum(item.get("event") == "stop" and item.get("role") == "descendant"
                             for item in events), 2)
        self.assertFalse((self.directory / "should-not-exist").exists())
        self.assertNotIn("test-password", stdout + stderr)
        self.assertEqual(next(item["password"] for item in events
                              if item.get("role") == "opencode" and item["event"] == "start"),
                         "test-password")

    def test_entrypoint_stops_both_services_and_descendants_on_interrupt(self):
        process = self.start_entrypoint(TEST_SPAWN_DESCENDANT="opencode,node")
        self.wait_for_event(process, "start", "node")
        self.wait_for_event(process, "start", "opencode")
        self.wait_for_event(process, "start", "descendant", count=2)
        code, stdout, stderr = self.stop_entrypoint(process, signal.SIGINT)
        self.assertEqual(code, 130, stderr)
        events = self.read_events()
        self.assertEqual(sum(item.get("event") == "stop" and item.get("role") == "descendant"
                             for item in events), 2)
        self.assertTrue(any(item.get("event") == "stop" and item.get("role") == "opencode" for item in events))
        self.assertTrue(any(item.get("event") == "stop" and item.get("role") == "node" for item in events))

    def test_services_share_entrypoint_process_group_for_tini_signals(self):
        process = self.start_entrypoint()
        self.wait_for_event(process, "start", "node")
        self.wait_for_event(process, "start", "opencode")
        self.stop_entrypoint(process)
        starts = [item for item in self.read_events()
                  if item.get("event") == "start" and item.get("role") in {"node", "opencode"}]
        self.assertEqual([item["group"] for item in starts], [process.pid, process.pid])

    def test_entrypoint_waits_for_authenticated_opencode_http_200(self):
        password = "native:with spaces"
        process = self.start_entrypoint(
            OPENCODE_PASSWORD=password, OPENCODE_URL="http://127.0.0.1:4773/",
            TEST_CURL_STATUSES="error,503,302,200",
        )
        self.wait_for_event(process, "start", "node")
        _, stdout, stderr = self.stop_entrypoint(process)
        events = self.read_events()
        app_start = next(index for index, item in enumerate(events)
                         if item.get("role") == "node" and item["event"] == "start")
        probes = [item for item in events[:app_start] if item.get("role") == "curl"]
        self.assertGreaterEqual(len(probes), 4)
        self.assertEqual([item["status"] for item in probes[1:]], ["503", "302", "200"])
        for probe in probes:
            self.assertEqual(probe["args"][-1], "http://127.0.0.1:4773/api/info")
            self.assertIn(f"opencode:{password}", probe["args"])
            self.assertIn("--user", probe["args"])
            self.assertEqual(probe["args"][probe["args"].index("--max-time") + 1], "1")
        self.assertNotIn(password, stdout + stderr)

    def test_entrypoint_does_not_start_api_if_opencode_exits_before_ready(self):
        process = self.start_entrypoint(
            TEST_CURL_STATUSES="503", TEST_EXIT_ROLE="opencode", TEST_EXIT_STATUS="23",
        )
        _, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 23, stderr)
        self.assertFalse(any(item.get("role") == "node" for item in self.read_events()))

    def test_entrypoint_cleans_up_when_readiness_is_interrupted(self):
        process = self.start_entrypoint(
            TEST_CURL_STATUSES="503", TEST_CURL_DELAY="1", TEST_SPAWN_DESCENDANT="opencode",
        )
        self.wait_for_event(process, "check", "curl")
        self.wait_for_event(process, "start", "descendant")
        code, _, stderr = self.stop_entrypoint(process)
        self.assertEqual(code, 143, stderr)
        events = self.read_events()
        self.assertFalse(any(item.get("role") == "node" for item in events))
        self.assertEqual({item["role"] for item in events if item["event"] == "stop"},
                         {"opencode", "descendant"})
        self.assertTrue(any(item.get("role") == "opencode" and item["event"] == "stopped"
                            for item in events))

    def test_entrypoint_times_out_before_starting_api(self):
        shell_environment = self.directory / "bash-env"
        # Advance Bash's own clock in the polling shell without a 90 second test delay.
        shell_environment.write_text('sleep() { SECONDS=$((SECONDS + 90)); }\n')
        process = self.start_entrypoint(BASH_ENV=str(shell_environment), TEST_CURL_STATUSES="503")
        _, stderr = process.communicate(timeout=5)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("90", stderr)
        events = self.read_events()
        self.assertFalse(any(item.get("role") == "node" for item in events))
        self.assertTrue(any(item.get("role") == "opencode" and item["event"] == "stop"
                            for item in events))

    def test_entrypoint_shuts_down_sawd_when_opencode_exits(self):
        process = self.start_entrypoint(
            TEST_EXIT_ROLE="opencode", TEST_EXIT_STATUS="23", TEST_EXIT_DELAY="0.5",
        )
        stdout, stderr = process.communicate(timeout=6)
        self.assertEqual(process.returncode, 23, stderr)
        self.assertTrue(any(item.get("event") == "stop" and item.get("role") == "node"
                            for item in self.read_events()), stderr)

    def test_entrypoint_shuts_down_opencode_when_sawd_exits(self):
        process = self.start_entrypoint(TEST_EXIT_ROLE="node", TEST_EXIT_STATUS="24")
        stdout, stderr = process.communicate(timeout=6)
        self.assertEqual(process.returncode, 24, stderr)
        self.assertTrue(any(item.get("event") == "stop" and item.get("role") == "opencode"
                            for item in self.read_events()), stderr)

    def test_entrypoint_does_not_start_app_when_directory_is_invalid(self):
        process = self.start_entrypoint(APP_DIR=str(self.directory / "missing-sawd-exec-server"))
        stdout, stderr = process.communicate(timeout=5)
        self.assertNotEqual(process.returncode, 0)
        events = self.read_events()
        self.assertFalse(any(item.get("role") == "node" and item.get("event") == "start"
                             for item in events))
        starts = [item for item in events
                  if item.get("role") == "opencode" and item.get("event") == "start"]
        if starts:
            self.assertTrue(any(item.get("role") == "opencode" and item.get("event") == "stop"
                                for item in events))

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
