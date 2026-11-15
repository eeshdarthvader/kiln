# SAWD execution server

SAWD (Standard Agentic Workload Definition) describes agent work as tasks with
initial instructions, a changing plan, retained attachments, and reported status.
This server sets up SAWD tasks in OpenCode, provides an HTTP API and browser
overview, and gives agents task-scoped reporting MCP tools. After initial setup,
it stores reported progress without observing or controlling runtime execution.

Everything needed to build and run is in this directory. Tasks are independent of
A2A; there is no control-plane integration or persistence. The domain owns task
state and validation, one-time setup uses the runtime port, and
HTTP, MCP and OpenCode are adapters.

## Image dependency sources

The image uses Ubuntu 24.04 from Docker Hub and uv from GHCR. Mise is downloaded
with curl from its pinned official
GitHub release and verified against architecture-specific SHA-256 checksums in
[tool-versions.json](image/tool-versions.json); its installation does not
require an ECR mise repository.
Docker Engine/CLI `29.9.3`, containerd `2.4.2`, Buildx `0.39.0` and Compose
`5.7.1` are installed from Docker's signed Ubuntu APT repository, with exact
package revisions pinned in the Dockerfile. The containerd package supplies runc.
The low-level `ctr` CLI and its manual are excluded through dpkg; Docker builds,
runs and Compose do not require it. Local image builds need no ECR login.
uv `0.13.7` uses its digest-pinned upstream image because that release was not
available from the internal cache during verification. CI needs access to GHCR
and Docker Hub, plus `download.docker.com` for Docker packages and its signing key.
The base and uv image build arguments can select mirrors if needed.
Public upstreams supply GitHub CLI, application npm packages, the pinned native
OpenCode npm package, AWS CLI 2.39.3 archives for ARM64 and AMD64, and Python
packages for the AWS MCP proxy. Local npm uses the registry-only `.npmrc`; it is excluded from the image build context. The image sets matching
`NPM_CONFIG_REGISTRY` and `UV_DEFAULT_INDEX` defaults for package installs.

The optional AWS MCP proxy translates OpenCode's local MCP connection into
IAM/SigV4-authenticated HTTPS requests to AgentCore Gateway. Python and uv remain
because this proxy depends on Python. It is enabled only with `AWS_GATEWAY_URL`;
the Execution Server's reporting MCP is a separate connection.

During the image build, the tool bootstrap downloads only mise from GitHub,
Node.js from `nodejs.org` and npm from `registry.npmjs.org`. Every archive has a
pinned SHA-256 checksum for the supported architecture. These downloads bypass
the npm registry setting and mise's metadata services; CI needs HTTPS access to the artifact hosts
and their download redirects. Other OS packages, application dependencies and
the Python interpreter retain their existing sources. The build applies all
available Ubuntu package upgrades and skips the AWS proxy package-download cache.

## Build tools and version switching

The image includes mise and one Node 26/npm installation for building and running
the execution server. Java, Terraform, Yarn, pnpm and additional Node versions
are installed on demand with mise. Node is the only shared tool default, so
installing a project's tools does not fetch unrelated global toolchains.
Discover installed versions with
`mise ls --installed` and the current directory's selection with `mise current`.

Agents load the [factory-build-tools skill](skills/factory-build-tools/SKILL.md)
for repository-scoped selection and command execution. Both the build and
development agents reference this skill, which is included in the image.

Agents review repository mise configuration and explicitly install the required
versions with `mise install tool@version ...`, then run commands with `mise exec`.
Automatic installation remains disabled. Project dependencies use the
repository's package manager; repository build wrappers may fetch their declared
distributions. If a required JVM or Node.js installation fails, delivery stops.
Other tool installation failures skip only affected checks, with the failure and
skipped checks disclosed in the PR and user summary.

Runtime installations need access to mise/backend metadata services and artifact
hosts, including redirects. `GITHUB_EGRESS_PROXY` configures only the Git/gh
wrappers; deployments must separately provide working egress and any required
proxy/CA configuration for mise. The existing npm registry setting routes the
`npm:yarn` and `npm:pnpm` backends through that registry. No `mise.lock` is supplied, so
runtime installations may perform metadata lookups.

The shared installs and cache under `/opt/mise` are writable by `agent` and are
reused while the container exists. Replacing the container discards downloaded
tools unless its storage is persisted. Do not mount an empty directory over
`/opt/mise`: it also contains the Node installation required for service startup.
First use incurs download time; tools downloaded at runtime are outside the
build-time image scan.

Linting is supported through repository-declared dependencies or build plugins.
Standalone global linter CLIs, including ktlint, are unsupported. Repositories
that rely on them need a declared local lint integration to run lint here.

The [bootstrap installer](image/install-tools.sh) installs mise, Node and npm from
the exact HTTPS URLs and SHA-256 checksums in [tool-versions.json](image/tool-versions.json).
Downloads use retries and timeouts; checksums are verified before extraction.
Node is registered with `mise link` while mise is offline. Plain `mise install`
can request metadata even for exact versions, so it is reserved for runtime.
The npm archive includes its dependencies and needs no lifecycle scripts.
Build scripts and downloaded archives are removed after installation.

To update a bootstrap tool, change its manifest version, official archive URL and
checksum for each supported architecture (ARM64 and AMD64). Use publisher release
checksums or verify npm tarballs against the registry's `dist.integrity` before
recording their SHA-256. Keep Node's manifest version, `.nvmrc` and `package.json`
engine pin aligned; tests check this contract.

## CI image validation

The [Build workflow](../.github/workflows/pr-build.yml) runs on pull
requests and supports manual runs after the workflow reaches the default branch.
It runs `make test` with the pinned Node and Python versions on an ARM64 runner.

Base images use public registries and Docker packages
come from its public APT repository. Personal AWS credentials and model keys
are not needed. The shared
workflow uploads a temporary image to `ecr-scan-github-action` for scanning.
Publishing a release image and validating it in a MicroVM are separate steps.

## Run the published image without a checkout

Install Bash, Docker, AWS CLI and GitHub CLI. Start Docker, authenticate with
`gh auth login`, and select an AWS identity with pull access to ECR account
`123456789012` in `eu-central-1` (for example, using AWS SSO). Export `AWS_PROFILE`
with the configured profile name before running setup; an image pull fails if it
is unset or empty. Reusing a local image or existing container does not require it.
Only [setup.sh](setup.sh) is needed; no source checkout or build tools are required.

Download it into an empty directory and run it there:

```sh
mkdir -p software-factory && cd software-factory
gh api repos/eeshdarthvader/af/contents/exec-server/setup.sh \
  -H 'Accept: application/vnd.github.raw+json' > setup.sh
bash setup.sh
```

Before prompting for the Bifrost key, setup links to the
[virtual keys page](https://ai-gateway.example.com/workspace/governance/virtual-keys).

The script asks for the Bifrost key without echoing it and saves it as
`MODEL_API_KEY`. For repository access, it reuses a nonempty `GH_TOKEN` in `.env`
or saves `gh auth token`. For `GPR_TOKEN`, it uses a nonempty
exported value first, then a nonempty value in the local `.env`, then
`gh auth token --hostname github.com`. It validates the selected `GPR_TOKEN`
with `gh api /user` and the `X-OAuth-Scopes` response header;
`read:packages` or `write:packages` is required. A failed
request, absent scope header, or header lacking both scopes stops setup with
remediation instructions. GitHub CLI is required on every setup run for this
validation, even when `GPR_TOKEN` is already exported or saved. Setup never runs
`gh auth refresh`. The accepted package scope does not prove access to a
particular package or organization; package access and organization policy can
still prevent installation.

Setup saves `MODEL_API_KEY`, `GH_TOKEN`, the selected `GPR_TOKEN`, and
`OPENCODE_PASSWORD=tester` in `.env` with mode `600`, readable only by your user.
Both GitHub credentials are passed through the container environment to OpenCode
and local tools; setup does not create a separate token file. It creates
`workspace/`, checks for the desired image locally, and logs Docker into ECR to
pull it if missing before replacing any existing container. It starts
`software-factory-exec-server` from
`123456789012.dkr.ecr.eu-central-1.amazonaws.com/software-factory-execution-server:v0.3`
and waits up to four minutes for readiness.
Setup passes an empty `AWS_GATEWAY_URL` to Docker, so the AWS gateway stays
disabled even if `.env` contains a gateway URL.
Open <http://127.0.0.1:3775> when it reports ready. Like `make run`, it enables
nested Docker using privileged mode and exposes both ports only on loopback.

Setup also copies `~/.m2/settings.xml` and `~/.gradle/gradle.properties`, when
present, into `/home/agent`, preserving the `.m2/` and `.gradle/` paths.
Each copy is owned by `agent:agent` with file permissions `600`.
Services and their build commands run as `agent`, so Maven and Gradle use the
copies under `/home/agent` by default. Each file is checked independently;
missing files are skipped.
Reruns refresh these copies from the host.

For an interactive shell as the build user, run:

```sh
docker exec -it --user agent -e HOME=/home/agent software-factory-exec-server bash
```

Seven numbered stages show progress with `INFO`, `OK`, `SKIP`, `WAIT`, and `FAIL`
labels, including reasons for skipped work. Setup probes `/readyz` directly inside
the running container every two seconds, without waiting for Docker's cached
health status, and reports elapsed time every ten seconds while starting.
Colors appear only in supported terminals;
set `NO_COLOR=1` to disable them. Captured logs stay plain text.

Rerun `bash setup.sh` from the same directory to resume: existing nonempty
`MODEL_API_KEY`, `GH_TOKEN`, and `GPR_TOKEN` values are reused. A matching running
container is left running; a matching stopped container is started. Setup compares
the desired image, workspace label, explicit `.env` assignments, and setup-forced
environment values. If any differ, setup stops,
removes, and recreates only the selected container named by `CONTAINER` while
preserving `.env` and the bind-mounted `workspace/`; OpenCode sessions inside
the container are lost. The desired image is checked and pulled if missing before
the existing container is removed. To refresh a GitHub CLI-managed credential,
unset `GH_TOKEN` and `GITHUB_TOKEN` if they override the CLI login, run
`gh auth refresh --hostname github.com --scopes read:packages`, remove a stale
saved `GPR_TOKEN` from `.env` (or export a replacement), then rerun setup.
Replace or update a custom token yourself. AWS CLI and `AWS_PROFILE` are only
needed for an image pull. GitHub CLI is required on every setup run. `IMAGE` can
select another published tag in the same registry, and `CONTAINER` can change the
name; the host ports remain fixed.

The `.env` file stores `MODEL_API_KEY`, `GH_TOKEN`, `GPR_TOKEN`, and
`OPENCODE_PASSWORD`; remove it after testing. The container configuration also
retains these environment credentials, visible through `docker inspect`, so
remove the container after testing. Every exit prints a final warning in red
(when terminal colors are enabled): do not commit or share `.env`, the container,
or `docker inspect` output.

`workspace/` is mounted at `/workspace/software-factory`, so task files survive container
replacement. On Linux, setup gives UID/GID `1000` ownership of the workspace
directory only if the runtime user cannot write to it; existing contents are not
changed. Task state remains in memory and OpenCode sessions remain inside the
container. Restarting loses task state; removing the container also loses sessions.

Use `docker logs -f software-factory-exec-server` for diagnostics and
`docker stop software-factory-exec-server` to shut down. Setup prints shutdown and
reset commands using the selected container and workspace. To reset the default
container, run this from the setup directory:

```sh
docker stop software-factory-exec-server && \
  docker rm software-factory-exec-server && \
  rm -rf -- workspace
```

This removes container state, OpenCode sessions, and `workspace/`, keeping `.env`.
Run `bash setup.sh` separately to recreate the setup. To update the image, set
`IMAGE` to the desired tag and rerun; setup checks and pulls it before replacing
the existing container.

For installations created with the previous `sawd-exec-server` name, stop and
remove that container before running the renamed setup; both use the same ports.

## Build and run with Docker

Start Docker Desktop or a Docker Engine daemon before running these commands.

```sh
cd exec-server
cp .env.example .env
# Set MODEL_API_KEY, GH_TOKEN, and GPR_TOKEN in .env; optionally set API_TOKEN.
make build
make run
make open
curl --fail http://127.0.0.1:3775/readyz
```

Open <http://127.0.0.1:3775> to create and start tasks, inspect reported status,
decisions and artifacts, and open the OpenCode session. The overview refreshes
tasks every five seconds. If configured, enter
`API_TOKEN` in the page; it stays in browser memory. After a task starts and
its OpenCode session is available, use **Open in OpenCode** in the workspace.
The dialog shows two steps: sign in using the displayed password and username
`opencode`, then return to the dialog and open the task-session link. Both links
open in a new tab. If already signed in, go straight to the second step.

In **Create task**, the Jira link tab accepts an HTTPS issue URL containing an
issue key and optional additional instructions, and starts the selected executor.
Additional instructions are appended to the ticket-fetch prompt. The agent fetches the ticket using
the Rovo/Atlassian tools exposed through MCP Catalog, then follows its normal
workflow. Catalog authorization and Jira access are required; if the ticket
cannot be read, the agent reports the blocker. The task details tab retains the
manual form, including the option to save without starting.

`make build` builds the image and loads it into Docker's local image store;
`make run` (also the default for bare `make`)
recreates `sawd-exec-server` using the existing image without rebuilding.
Run `make build` once before first use and again after image changes.
`make run` publishes the task UI/API at host loopback port `3775` and OpenCode at `3773`.
`make stop` stops it, `make test` runs checks, and `make open` opens the task UI
in your browser. Use `docker logs -f sawd-exec-server` for logs. The reporting
MCP bootstrap and discovery endpoint is `http://127.0.0.1:3776/mcp`.

Only `IMAGE`, `CONTAINER`, and `RUN_ARGS` are Make overrides. Put credentials and
runtime settings in `.env`; use `RUN_ARGS` for optional Docker flags, such as
mounting local checkouts:

```sh
make run RUN_ARGS='-v "$$HOME/Documents/repos:/workspace/repos:rw"'
```

The doubled dollar sign passes `$HOME` through Make to the shell. Select
`/workspace/repos` or a repository beneath it in OpenCode. Agents can modify
those host checkouts. No host directories are mounted by default. `make run`
removes any existing Docker container with the configured name before starting
its replacement. Recreating the container clears its sessions and task state.

`make run` enables Docker commands inside the container, as described in
[Nested Docker](#nested-docker).

Task acceptance does not start execution. Choose an executor from `GET /v1/agents`,
submit `PUT /v1/tasks/:id`, then call `POST /v1/tasks/:id/start`. See the
[SAWD data model and API reference](docs/sawd-api.md) for payloads, lifecycle,
idempotency, HTTP endpoints and reporting MCP tools.

The machine-readable OpenAPI 3.1 contract is `GET /v1/openapi.json`, protected by
the same API authentication. Clients must use `/v1` for task and agent routes;
old unversioned business paths return `404`. The former follow-up and pairing
routes are removed. Health probes and UI paths
remain unversioned. Errors include stable `error.code` and `error.message` fields.

Task detail separates initial `setup` state from the latest agent `report` and
includes `runtimeUrl` when the native session is available. The task list omits
instructions, acceptance criteria, plan, and attachments. Archive at any time with
`POST /v1/tasks/:id/archive`; this sets display metadata and does not stop work or
block start and reporting. There is no cancellation or deadline API. `executor`
retains the initial model choice; native interaction may change the runtime model
without updating this field.

## Runtime and credentials

The image pins OpenCode `2.2.7`, Node `26.13.1`, npm `11.21.2`, Python `3.14.8`
and uv `0.13.7`. OpenCode uses the OpenAI-compatible gateway provider configured with
`MODEL_API_KEY`. Its server URL defaults to `http://127.0.0.1:3773`.
The entrypoint generates a cryptographically random 16-character `OPENCODE_PASSWORD`
when it is unset or empty and shares it with OpenCode and the execution server.
It changes on every container start. Set `OPENCODE_PASSWORD` in `.env` to keep a
fixed password. Use the task UI's **Open in OpenCode** dialog to retrieve the
password and sign in as `opencode`; the entrypoint never prints it or writes it
to configuration. Only OpenCode v2 is supported; use `serve` for its API and UI.

Both services run as `agent` (UID/GID `1000`), with home `/home/agent`.
Image settings use `START_DOCKER`, `PORT` (default `3775`), `MCP_PORT` (`3776`),
`WORKSPACE_ROOT` (`/workspace/sawd`), and optional `API_TOKEN`.
The entrypoint translates these settings into the application's existing `SAWD_*`
variables. It validates credentials, generates the shared password, starts OpenCode,
and waits up to 90 seconds for its API before launching the task API.
The task API process serves both the UI and reporting MCP.
The HTTP API contract stays unchanged. Custom listener ports require matching
Docker port mappings; the Makefile publishes the defaults.

The default model is `gpt-6-luna`; by default, profiles expose `gpt-6-luna`,
`gpt-6-sol`, and `gpt-6-astra`. Set `OPENCODE_MODEL` to choose the default model and
`OPENCODE_MODELS` to configure exposed models; the selected default is always
included. All exposed models use local context and output caps of `128000` and
`16384` tokens, configurable with `OPENCODE_CONTEXT_LIMIT` and
`OPENCODE_OUTPUT_LIMIT`. These are conservative local caps, not claims about the
gateway's maximum limits. The model key stays in the runtime environment and is
not written to OpenCode configuration. Credentials are excluded from the build
context. Optional `GITHUB_EGRESS_PROXY`
and the bundled CA configure the Git/gh wrappers; `GITHUB_EGRESS_CA` overrides
the CA path inside the container.

The `mcp_catalog` remote MCP connects to `https://ai-gateway.example.com/mcp`
using the same `MODEL_API_KEY` as an `x-bf-vk` header. OpenCode reads the key
from the environment, with browser OAuth disabled. Complete any required
downstream MCP authorization outside the container for the same Bifrost identity.
Bifrost stores and refreshes those downstream credentials; revoked grants require
external reauthorization. The key must have access to the required MCP tools.

Set `AWS_GATEWAY_URL` to an Amazon Bedrock AgentCore gateway MCP URL to add the
`aws-gateway` MCP server to the OpenCode runtime. The image includes
`mcp-proxy-for-aws-cli==1.8.0`, which signs requests with IAM SigV4 for
`bedrock-agentcore` and derives the signing region from the gateway URL. No
gateway is added when the variable is unset or empty.

Set the gateway URL and credentials in `.env`, or pass selected host variables
by name with `RUN_ARGS`. The AWS MCP launcher inherits the environment and lets
the AWS SDK resolve credentials through its standard chain. For a local profile,
authenticate on the host and run:

```sh
export AWS_PROFILE=my-profile
make run RUN_ARGS='-e AWS_PROFILE -v "$$HOME/.aws:/home/agent/.aws:ro"'
```

Referenced credential files or external credential helpers must also be available
inside the container. The IAM identity needs permission to invoke the gateway.
Recreate the container after replacing environment credentials.

Set `API_TOKEN` to require `Authorization: Bearer <token>` on task, agent,
and OpenCode connection routes, including the OpenAPI document. The connection
endpoint returns the server-wide runtime password for the login dialog with
`Cache-Control: no-store`. Health endpoints and UI assets remain public. Without a
token, use the trusted host loopback mapping supplied by the Makefile. Configure
authentication and network controls before exposing the API elsewhere.

Task instructions govern agent interactions. OpenCode's configured permission
policy controls runtime tool access; the server does not override it or answer
permission prompts. All agents share a runtime user. Dedicated
task directories and threads are organizational boundaries, not
security sandboxes.

The root agent owns task-facing SAWD reports and attachments. Children return
findings and blockers to the root. This is an agent protocol; the reporting MCP
URL binds calls to a task, and reports carry no automatic native call or turn
attribution.

SAWD creates the OpenCode session, sends the initial instructions once, and
registers the `sawd-execution` MCP separately for the task directory at
`http://127.0.0.1:3776/mcp/tasks/<taskId>`. The configured URL supplies task
context to status, plan, and attachment writes, so agents do not pass task IDs or
credentials in tool arguments. The task ID in the URL is a non-secret correlation
value; a caller trusted to reach the loopback listener can address tasks. All root,
child, and follow-up sessions using the same task directory share its binding.
OpenCode's per-directory MCP configuration retains this URL across context
compaction.
The unbound `http://127.0.0.1:3776/mcp` endpoint exposes only
`get_reporting_instructions` for bootstrap and discovery. Task context otherwise
comes from the OpenCode conversation; there is no reporting context-fetch tool.
There is no question, approval, answer, or follow-up API. Before asking a
question through OpenCode's native question tool or chat, or requesting approval,
an agent must report `input_required`. After
receiving input, it must report `running` before resuming work. Native
interactions and new turns do not automatically change the stored report or add
native call or turn attribution. Task instructions define any task-specific
question, review, or approval workflow.

For human implementation plan approval, agents write `IMPLEMENTATION_PLAN.md`
in the task workspace (or the task's specified path), report `input_required`,
link the file in OpenCode, and end the turn. Reviewers submit approval, rejection,
or requested changes through chat or inline file comments. Revision requests
lead to another saved revision and review turn. After explicit approval of the
current revision, the agent records the full plan as an artifact, the approval
as a decision linked to that artifact, and the implementation steps in the task
plan before implementing. These are agent reporting instructions; the server
does not enforce approval or observe comments. Attachments remain in memory.

Use [sample-prompt.txt](sample-prompt.txt) as task instructions to exercise free-text,
single-choice and multiple-choice questions, decision recording, and this approval
flow. To test revisions, reject the first draft with an inline comment, then
approve the revised plan in a later turn. The demo finishes with three delegated
translations and a retained result artifact.

Native follow-ups continue in the same session and workspace. New reports can
replace earlier `done` or `failed` reports, including after archival. The last
newly received report wins; SAWD does not track work versions, plan revisions,
or superseded turns, and does not verify runtime settlement. A `failed` report
stores the failure claim without stopping execution.

Model discovery makes up to three attempts when reads fail transiently, before
task setup. If discovery still fails, no task session or prompt has been created;
submit a new task after checking OpenCode availability and configured models.

Setup submits the initial prompt once. OpenCode v2's prompt response confirms
durable admission; uncertain responses are reconciled by reading the inbox and
stored message using the same message ID. Retrying start never relaunches submitted
or failed setup. Unknown setup can mean uncertain session preparation or prompt
delivery. Repeated start only reconciles read-only using stable runtime IDs when
a prompt was prepared; otherwise it preserves the unknown state for inspection.
The server never blindly repeats uncertain preparation or resends an uncertain
prompt. Reporting does not contact the runtime. Each reporting write requires an
operation ID; identical retries return their original result. Status reporting
returns only a `{ taskId, operationId, receivedAt }` receipt.

The task interface retains initial instructions, plan, attachments and the latest
report. Save useful results as explicit attachments and use **Open in
OpenCode** for all conversation. This breaking contract replaces the prior shape
in place at `/v1`; deploy the bundled UI and consumers together. Drain active work
and export any required records before restarting the in-memory server.

### Nested Docker

Git, Node, Python and Docker are available to advertised agents when started
with `make run`. It enables the nested Docker daemon automatically:

```sh
make run
# Once startup completes, verify daemon access:
docker exec sawd-exec-server docker info
```

`make run` reuses the existing image. It appends
`--privileged --user root -e START_DOCKER=true` to any supplied `RUN_ARGS`.
When starting the image directly, pass the same flags to enable the daemon.
The entrypoint starts the daemon as root, then drops to `agent` before launching
services. Only then is `docker` advertised as an agent capability. The daemon
uses the classic image store with `vfs` to avoid nested overlayfs mounts.
The launcher starts `dockerd` directly, which manages its own containerd process;
systemd is not used. APT service autostart is disabled by `policy-rc.d`.

SAWD task state lives only in process memory: restarting SAWD loses it. Replacing
the container also loses credentials, workspaces and OpenCode sessions. There is
no recovery or cross-task context sharing. Tini forwards signals to the shared
process group and reaps orphaned processes. The entrypoint stops the sibling
service if either exits; the container runtime enforces the shutdown timeout.
Submit replacement work explicitly after a restart. Docker's inline healthcheck
probes the application's `/readyz` endpoint; it does not continuously probe
OpenCode responsiveness.

## Development

```sh
cd exec-server
. "$HOME/.nvm/nvm.sh"
nvm use
npm ci
npm run build
make test
```

`npm run build` typechecks server and UI, then writes the production UI to
`dist/`. The image runs this build. `make test` runs typechecking, Node tests,
format checks, Python image/startup tests and shell syntax checks. Tests use fake
OpenCode responses and local listeners without model credentials. `npm run format`
formats the project.

For UI development with a running container:

```sh
npm run dev:ui
```

Vite serves <http://127.0.0.1:5174> and proxies API requests to `127.0.0.1:3775`.
Set `SAWD_PORT` if the container uses a different API port.

`npm start` (or `npm run dev` for watch mode) connects SAWD to `OPENCODE_URL`,
default `http://127.0.0.1:3773`. Set `OPENCODE_PUBLIC_URL` when browsers need a
different OpenCode base URL; it defaults to `OPENCODE_URL`. Set
`OPENCODE_PASSWORD` to the running OpenCode server's password. The username is always `opencode`.
Local listener defaults are `SAWD_PORT=3775` and `SAWD_MCP_PORT=3776`;
`SAWD_WORKSPACE_ROOT` sets the OpenCode workspace root when running the app directly.
The image translates the unprefixed settings described above. Ports must differ. For
normal operation, use the complete container.

Reporting MCP requires no OpenCode reporting plugin. OpenCode registers its
task-scoped URL separately for each task directory; agents use operation IDs for
idempotent reporting writes. Task state remains in memory, so a URL retained in
OpenCode configuration refers to an unknown task after the server restarts and
its state is lost.

With the container running, `npm run smoke` runs a real `gpt-6-luna`
task and checks retained attachments, a completed plan, an explicit completion
report, the task list projection, and archival. This opt-in check uses model credentials and
leaves its task available for inspection. `SAWD_URL`, `SAWD_API_TOKEN` and
`SAWD_SMOKE_AGENT` override endpoint, authentication and executor.

`npm run smoke:native` also checks inline plan review and a fresh follow-up report
in the same session. It prints the OpenCode session link and guides these manual steps:

1. Open `IMPLEMENTATION_PLAN.md`, add the inline comment printed by the script,
   and submit it through normal chat. The comment asks for a checklist item
   containing `SAWD_INLINE_REVIEW_CONFIRMED`.
2. Wait for the revised plan and another `input_required` notice, inspect the
   revision, and send `Approve` through normal chat.
3. After completion, send the follow-up printed by the script in the same session.

This smoke scenario requires separate feedback and approval turns; the check
verifies the feedback in a retained revised plan artifact and waits for fresh
report timestamps. SAWD does not verify turn ownership. The check never answers
or delivers a follow-up.
Native mode permits only the plan file to be created or revised, requires a
person, and allows up to 14 minutes to complete the interaction.

### Agent-managed repository checkouts

The execution server creates a task directory and starts OpenCode there. The
`build` agent identifies and clones the target repository inside that workspace;
the server does not infer repositories, preflight GitHub access, or clone code.

Include the canonical repository and optional base revision in the task instructions:

```text
Upgrade example-org/price-alerts-service to Java 25. Base branch: master.
```

Build prepares `<task-workspace>/repository`, uses the default branch unless a
branch, tag or commit is requested, and verifies the origin and resolved commit.
It passes the absolute checkout path and revision to the classifier and any
other delegated agents. Commands must target that checkout explicitly; OpenCode's
session directory stays at the task workspace root. Existing task checkouts are
inspected and reused without resetting edits. Build makes evidence-backed decisions
by default and asks a human when it cannot decide safely or the task explicitly
requires human input. Explicit instructions to avoid assumptions or seek human
decisions are honored, including when stated in the ticket. Missing or conflicting
repository context is resolved under those constraints before cloning. Children
return questions to build rather than asking the human or reporting status directly.

The container needs GitHub authentication for repository cloning and package
access. Set `GH_TOKEN` in the ignored `.env` or configure `GITHUB_EGRESS_PROXY`
for cloning. `GPR_TOKEN` is additional and is used by repository package
configuration that references it. For local `make run`, pass host credentials by
name with `make run RUN_ARGS='-e GH_TOKEN -e GPR_TOKEN'`. A host keychain login is
not automatically shared. Build reports actionable access or clone failures;
write access and permission to publish remain separate concerns.

Repository preparation and safe reuse are agent instructions, not server-enforced
validation. Separate task folders are organizational boundaries, not OS security
sandboxes. This change does not add a repository field to the API or automatic
server-side repository inference.
