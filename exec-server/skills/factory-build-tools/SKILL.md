---
name: factory-build-tools
description: Install and select repository-specific build tools with mise before running software factory build commands.
---

# Factory Build Tools

Use mise as the runtime user for runtimes, package managers and build tools.
The image supplies Node 26/npm; install other required tools on demand.

1. Inspect the checkout's version files, package-manager declarations and build
   configuration. Resolve requirements to exact versions. Review mise hooks and
   backends before trusting repository configuration.
2. Check `mise ls --installed` and `mise current`. Install missing tools with
   `mise install tool@version ...`; automatic installation is disabled.
3. Run commands from the checkout with `mise exec -- <command>` for project pins,
   or `mise exec tool@version ... -- <command>` for explicit selections. Installing
   a tool alone does not select it. Mise also sets `JAVA_HOME`.

For repeated commands without existing project pins, use
`mise use --path mise.local.toml --pin tool@version ...`. Keep local overrides out
of commits unless requested, and record selected versions in the task handoff.
Never use `mise use --global` or replace the server's bundled Node/npm. Preserve
the configured `npm:yarn` and `npm:pnpm` aliases.

Install project dependencies with the repository's package manager. Build wrappers
may fetch their declared distributions. Do not use global package installs or
download-and-run installers to bypass mise.

If installation fails, report the tool, version, cause and affected commands.
A required JVM/Node.js failure blocks delivery. For other tools, skip only affected
checks and disclose them in the PR and user summary; never report them as passed.
Check service and credential prerequisites separately.

Run lint through repository-declared dependencies or build plugins. Standalone
global linters are unsupported; report missing lint integration as unavailable.

## GitHub Packages credentials

`GPR_TOKEN` is inherited by agents and local tools. Check only that it is present
with `test -n "${GPR_TOKEN:-}"`, then use the repository's package configuration
that references it. If it is missing, report a blocker. Never print token values,
read secret files, dump the environment, or enable shell tracing. Setup validates
scopes only when credentials are provisioned through that setup path; presence
checks are sufficient for agents.

## Local test images

Resolve fixtures at runtime, not in setup. On ECR mirror access errors, verify
that the fixture is an unmodified public Docker Hub mirror, then immediately
continue with the fallback in the same session without routine approval:

1. Pull the same upstream repository/version into the tests' Docker daemon and
   tag it locally with the expected ECR reference. Never push the alias.
2. If the build is stuck retrying, capture the error, stop only your blocked
   processes, and record the attempt as interrupted. Rerun without duplicate
   builds; use bounded waits and inspect logs until results are available.
3. Check pull policy. If needed, use a temporary local fixture override, restore
   only your edits afterward, and exclude the override from delivery.

Never substitute custom internal images, change versions, weaken tests, or bypass
mandated image/digest or pull-policy requirements. Matching tags do not prove
identical bytes. Report both image references, resolved digest, fallback method
and test results; distinguish public-image coverage from ECR/deployment validation.
Report a blocker only if the permitted fallback is unavailable or fails.
