"""Exercise the image bootstrap with local archives and no network access."""

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import unittest


IMAGE = Path(__file__).resolve().parents[1] / "image"
FAKE_CLI = '''
import hashlib, json, os, shutil, sys
from pathlib import Path
tool = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["TEST_EVENTS"], "a") as output:
    output.write(json.dumps({"tool": tool, "args": args,
                            "offline": os.environ.get("MISE_OFFLINE"),
                            "auto_install": os.environ.get("MISE_AUTO_INSTALL")}) + "\\n")
if tool == "dpkg":
    print(os.environ["TEST_ARCH"])
elif tool == "curl":
    url = args[args.index("-o") - 1]
    if url == os.environ.get("TEST_FAIL_URL"):
        sys.exit(22)
    archives = json.loads(os.environ["TEST_ARCHIVES"])
    shutil.copyfile(archives[url], args[args.index("-o") + 1])
elif tool == "mise":
    assert os.environ["MISE_OFFLINE"] == "true"
    assert os.environ["MISE_AUTO_INSTALL"] == "false"
    assert args[0] in {"link", "reshim"}, args
elif tool == "install":
    assert args[:2] == ["-m", "0755"], args
    assert args[3] == "/usr/local/bin/mise", args
    target = Path(os.environ["TEST_BIN"]) / "mise"
    shutil.copyfile(args[2], target)
    target.chmod(0o755)
elif tool == "sha256sum":
    # macOS's sha256sum lacks the GNU flags used by the Ubuntu image.
    assert args == ["--check", "--status"], args
    expected, filename = sys.stdin.read().rstrip("\\n").split("  ", 1)
    actual = hashlib.sha256(Path(filename).read_bytes()).hexdigest()
    sys.exit(0 if expected == actual else 1)
'''


class ToolInstallationTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="tool bootstrap ")
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name).resolve()
        self.data = self.directory / "data"
        self.config = self.directory / "config"
        self.bin = self.directory / "bin"
        for directory in (self.data, self.config, self.bin):
            directory.mkdir()
        self.events = self.directory / "events.jsonl"
        self.manifest = json.loads((IMAGE / "tool-versions.json").read_text())
        self.archives = {}
        for arch, artifact in self.manifest["mise"]["downloads"].items():
            self.make_artifact(artifact, f"mise-{arch}", {
                "mise/bin/mise": f"#!{sys.executable}\n" + FAKE_CLI,
            }, prefix="")
        for arch, artifact in self.manifest["node"]["downloads"].items():
            self.make_artifact(artifact, f"node-{arch}", {
                "bin/node": arch,
                "lib/node_modules/npm/package.json": '{"version":"bundled"}',
                "lib/node_modules/npm/stale-dependency": "remove me",
            })
        self.make_artifact(self.manifest["npm"]["download"], "npm", {
            "package.json": json.dumps({"version": self.manifest["npm"]["version"]}),
            "bin/npm-cli.js": "patched npm",
        })
        for tool in ("dpkg", "curl", "install", "sha256sum"):
            executable = self.bin / tool
            executable.write_text(f"#!{sys.executable}\n" + FAKE_CLI)
            executable.chmod(0o755)

    def make_artifact(self, artifact, name, files, prefix="package"):
        archive = self.directory / f"{name}.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            for filename, content in files.items():
                payload = content.encode()
                entry = tarfile.TarInfo(f"{prefix}/{filename}" if prefix else filename)
                entry.size = len(payload)
                output.addfile(entry, io.BytesIO(payload))
        artifact["sha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.archives[artifact["url"]] = str(archive)

    def run_installer(self, arch="arm64", **overrides):
        self.events.unlink(missing_ok=True)
        shutil.rmtree(self.data / "toolsets", ignore_errors=True)
        (self.data / "tool-versions.json").write_text(json.dumps(self.manifest))
        shutil.copyfile(IMAGE / "mise.toml", self.config / "config.toml")
        environment = {
            "PATH": f"{self.bin}:{os.environ['PATH']}", "HOME": str(self.directory),
            "MISE_DATA_DIR": str(self.data), "MISE_CONFIG_DIR": str(self.config),
            "MISE_OFFLINE": "false", "MISE_AUTO_INSTALL": "true",
            "TEST_EVENTS": str(self.events), "TEST_ARCH": arch,
            "TEST_BIN": str(self.bin),
            "TEST_ARCHIVES": json.dumps(self.archives), **overrides,
        }
        if "LD_LIBRARY_PATH" in os.environ:
            environment["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
        return subprocess.run(
            ["/bin/sh", str(IMAGE / "install-tools.sh")], env=environment,
            cwd=self.directory, capture_output=True, text=True, timeout=10,
        )

    def calls(self, tool):
        events = self.events.read_text().splitlines() if self.events.exists() else []
        return [event["args"] for line in events
                if (event := json.loads(line))["tool"] == tool]

    def test_installs_only_node_for_each_architecture_and_registers_offline(self):
        for arch in ("arm64", "amd64"):
            with self.subTest(arch=arch):
                result = self.run_installer(arch)
                self.assertEqual(result.returncode, 0, result.stderr)
                destination = self.data / "toolsets/node/26.13.1"
                self.assertEqual((destination / "bin/node").read_text(), arch)
                npm = destination / "lib/node_modules/npm"
                self.assertEqual(json.loads((npm / "package.json").read_text()),
                                 {"version": "11.21.2"})
                self.assertFalse((npm / "stale-dependency").exists())
                self.assertEqual(self.calls("mise"), [
                    ["link", "node@26.13.1", str(destination)], ["reshim"],
                ])
                self.assertEqual(len(self.calls("curl")), 3)
                config = tomllib.loads((self.config / "config.toml").read_text())
                self.assertEqual(config["tools"], {"node": "26.13.1"})
                self.assertFalse(config["settings"].get("offline", False))
                self.assertEqual(config["tool_alias"], {"yarn": "npm:yarn", "pnpm": "npm:pnpm"})

    def test_checksum_mismatch_stops_before_registration(self):
        for artifact in (self.manifest["mise"]["downloads"]["arm64"],
                         self.manifest["node"]["downloads"]["arm64"],
                         self.manifest["npm"]["download"]):
            with self.subTest(url=artifact["url"]):
                checksum = artifact["sha256"]
                artifact["sha256"] = "0" * 64
                result = self.run_installer()
                artifact["sha256"] = checksum
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("SHA-256 verification failed", result.stderr)
                self.assertEqual(self.calls("mise"), [])
                self.assertFalse((self.data / "toolsets").exists())

    def test_download_failure_stops_before_registration(self):
        result = self.run_installer(TEST_FAIL_URL=self.manifest["npm"]["download"]["url"])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls("mise"), [])
        self.assertFalse((self.data / "toolsets").exists())

    def test_invalid_archive_stops_before_registration(self):
        artifact = self.manifest["node"]["downloads"]["arm64"]
        archive = Path(self.archives[artifact["url"]])
        archive.write_bytes(b"not an archive")
        artifact["sha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls("mise"), [])

    def test_unsupported_architecture_never_downloads(self):
        result = self.run_installer("riscv64")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls("curl"), [])
        self.assertEqual(self.calls("mise"), [])

    def test_node_pin_matches_application_and_developer_runtime(self):
        application = IMAGE.parent
        package = json.loads((application / "package.json").read_text())
        version = self.manifest["node"]["version"]
        self.assertEqual(version, package["engines"]["node"])
        self.assertEqual(version, (application / ".nvmrc").read_text().strip())


if __name__ == "__main__":
    unittest.main()
