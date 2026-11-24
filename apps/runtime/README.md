# Kiln runtime

Where the agents run. The [control plane](../control-plane/README.md) decides what happens next;
this package does it: it creates a run's git worktree, opens a [Herdr](https://herdr.dev) tab for
each stage, starts Claude Code in a container inside that tab, and reports when the pane ends.
It also serves the dashboard's web terminal and owns the agent container image.

The package is `@factory/runtime`. It imports nothing from the control plane.

```
control plane ──AgentRuntime──▶ HerdrRuntime ──socket API──▶ Herdr session "factory"
                                                                 │ one workspace per run, one tab per stage
                                                                 ▼
                                                  docker run … factory-agent   (Claude Code)
control plane HTTP server ◀── WebSocket ──▶ TerminalService ──▶ pty bridge ──▶ shell in the run's worktree
```

## What it provides

| Piece                                         | What it does                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`contract.ts`](src/contract.ts)              | `AgentRuntime`, `RunRef` and `RuntimeConfig`: the whole surface the control plane uses                      |
| [`herdr/`](src/herdr)                         | `HerdrClient` (Herdr's Unix-socket API), `HerdrRuntime` (the contract on Herdr) and the stage launch script |
| [`terminal.ts`](src/terminal.ts)              | `TerminalService`: one-time tickets and a WebSocket shell, via a Python pty bridge                          |
| [`Dockerfile`](Dockerfile), [`image/`](image) | The agent container: Claude Code, `gh`, git, mise, Python and Node                                          |

### The contract

The control plane calls these methods and nothing else:

| Method                            | Purpose                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `runDirectory(runId)`             | Where a run's hand-off files live (`<home>/runs-data/<run>`)          |
| `createWorkspace(run, repoPath)`  | Create (or reopen) the run's worktree and its Herdr workspace         |
| `startStage(run, stage, n, text)` | Write the stage prompt and launch script, open a tab, return its pane |
| `onExit(listener)`                | Be told once when a stage's pane exits or is closed                   |
| `isAlive(pane)`, `tail(pane, n)`  | Check a pane and read its recent output                               |
| `sendInput(pane, text)`           | Type a line into the pane and press Enter                             |
| `stopStage(pane)`                 | Close the pane                                                        |
| `removeWorkspace(id)`             | Remove the worktree and close the workspace                           |

`RunRef` is the slice of a run these methods read (id, repo, issue number, title, branch, base
branch, worktree, workspace and pull request URL). The control plane's `Run` satisfies it as is,
and tests swap in an in-memory fake.

## How a stage launches

1. `startStage` writes `<run dir>/stages/<stage>-<attempt>.prompt.md` and a `.sh` launch script.
2. It opens a Herdr tab in the run's workspace and sends `exec bash <script>` to it.
3. The script ends in `docker run --rm -it …` with the worktree, its parent repository clone and the
   run directory mounted at their host paths (a git worktree refers to its repository by absolute
   path), plus the `FACTORY_*` variables the container's entrypoint reads.
4. Because the script `exec`s, the pane exits when the agent does, and `onExit` fires.

Agent credentials (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, and a GitHub token) reach the
container through `<home>/agent.env`, which the control plane writes owner-readable only.

## Agent container

Build it once, and again after changing anything under `image/` or the `Dockerfile`:

```bash
make agent-image                        # tags localhost/factory-agent:latest
make agent-image IMAGE=example/agent:1  # or any tag; set FACTORY_AGENT_IMAGE to match
```

- Ubuntu 24.04 with `gh`, git, ripgrep, jq, Python (uv) and Node (mise), running as a non-root
  `agent` user (UID 1000) so files written to the mounted worktree stay owned by a normal user.
- Claude Code is pinned in the `Dockerfile` (`CLAUDE_CODE_VERSION`) with auto-update off.
- [`image/entrypoint.sh`](image/entrypoint.sh) starts Claude Code with the stage prompt and the
  control plane's reporting MCP server. `FACTORY_AGENT_MODE=print` runs it headless; the default is
  interactive so you can attach in Herdr and step in.
- Permission prompts are off inside the container, which is why each stage runs in one: it sees only
  the run's worktree, its repository clone and the run directory.

## Web terminal

Each run's page in the dashboard has a **Shell** panel: a shell on the host, opened in the run's
worktree. It needs `python3` on the host (the pty bridge uses the standard library only).

It is a remote shell, so it is guarded:

- The dashboard first asks the control plane's API (which enforces `FACTORY_API_TOKEN`) for a
  one-time ticket valid for 30 seconds.
- The WebSocket at `/v1/terminal` refuses any `Host` or `Origin` that is not loopback.
- At most four shells are open at once, and `FACTORY_API_TOKEN` is stripped from the shell's
  environment.

Set `FACTORY_TERMINAL=off` to remove it.

## Configuration

The control plane reads these and hands the runtime a `RuntimeConfig`. Set them in the control
plane's `.env`.

| Variable                    | Default                            | Purpose                                             |
| --------------------------- | ---------------------------------- | --------------------------------------------------- |
| `HERDR_SESSION`             | `factory`                          | Herdr session to drive (never your default session) |
| `FACTORY_HOME`              | `~/.factory`                       | Worktrees, repository clones, run directories       |
| `FACTORY_AGENT_IMAGE`       | `localhost/factory-agent:latest`   | Agent container image                               |
| `FACTORY_MCP_PUBLIC_URL`    | `http://host.docker.internal:3776` | How containers reach the reporting endpoint         |
| `FACTORY_AGENT_DOCKER_ARGS` | unset                              | Extra `docker run` arguments for every agent        |
| `FACTORY_AGENT_MODEL`       | unset                              | Model passed to Claude Code                         |
| `FACTORY_TERMINAL`          | `on`                               | Web terminal; `off` disables it                     |
| `FACTORY_TERMINAL_SHELL`    | `$SHELL`                           | Shell the web terminal starts                       |

On Linux, containers do not resolve `host.docker.internal` by default: set
`FACTORY_AGENT_DOCKER_ARGS=--add-host=host.docker.internal:host-gateway` and
`FACTORY_MCP_HOST=0.0.0.0` (or the Docker bridge address).

`FACTORY_AGENT_COMMAND` replaces the container with a host command. It exists for the control
plane's `make smoke`, which runs a stub agent.

## Requirements

macOS or Linux with Node 26, Docker, Python 3 and [Herdr](https://herdr.dev) 0.9.5 or later.

## Development

```bash
make test        # typecheck, unit tests, formatting, and image script tests
make herdr       # start the Herdr session the factory drives, in the foreground
make agent-image # build the agent container
```

`HerdrClient` is tested against a fake Unix-socket server, and `TerminalService` against a real
shell. [`scripts/herdr-spike.mjs`](scripts/herdr-spike.mjs) prints the raw Herdr responses the
runtime depends on; run it after a Herdr upgrade:

```bash
herdr --session factory server &
node scripts/herdr-spike.mjs factory
```

The image tests (`tests/`) need Python 3.11 or newer.
