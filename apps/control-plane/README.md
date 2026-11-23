# Kiln control plane

Takes a GitHub issue, runs it through a pipeline of Claude Code agents, and ends with a draft
pull request. A small server drives the pipeline; [Herdr](https://herdr.dev) supplies the
terminals the agents run in, so you can attach and watch or step in at any time.

```
GitHub issues ──poll (gh)──▶ intake ─▶ run store (JSON on disk)
                                         │
dashboard (React, SSE) ◀── HTTP API ◀── pipeline ──▶ Herdr socket API
                                         ▲                │ worktree, one tab per stage
                               reporting MCP (:3776)      ▼
                                         ▲        Herdr session "factory"
                                         └──────── docker run … claude   (one container per stage)
```

## How a run works

One run per issue. The server starts each stage as a fresh agent in its own Herdr tab, inside
a container, working in a git worktree for the run's branch (`factory/<issue>-<slug>`).

| Stage         | What the agent does                                                  | Hand-off file       |
| ------------- | -------------------------------------------------------------------- | ------------------- |
| `classify`    | Decides whether the issue is ready; asks questions if it is not      | `classification.md` |
| `plan`        | Writes the implementation plan                                       | `PLAN.md`           |
| `plan-review` | Reviews the plan; can send the run back to `plan`                    | `plan-review.md`    |
| `implement`   | Makes the change, runs the tests, commits                            | `implementation.md` |
| `review`      | Reviews the diff and reruns the checks; can send back to `implement` | `review.md`         |
| `pr`          | Pushes the branch and opens a draft PR that closes the issue         |                     |

### Parallel runs and merge conflicts

Runs work on separate branches, so one run can merge while another is still going. Before the
`pr` stage the server fetches the base branch and rebases the run's branch onto it. A clean rebase
is silent; a conflict starts a `resolve` agent that merges both sets of changes, reruns the checks
and records a decision for each non-trivial conflict. The pull request watcher also checks open pull
requests of finished runs: if one starts conflicting because another merged first, the run reopens
the pushed branch, runs `resolve`, force-pushes with lease, and merges again per the autonomy
policy. Each run gets at most `FACTORY_MAX_STAGE_ATTEMPTS` resolve attempts.

## Autonomy: who decides what

The agents never judge what is critical; the server does, with rules a person wrote. A repository
sets its level and rules in `.factory/policy.json`, read from the **base branch** (an agent
cannot loosen the policy on its own branch). Without the file, `FACTORY_AUTONOMY` applies
(default `L1`).

```json
{
  "autonomy": "L2",
  "critical": {
    "paths": ["src/auth/**", "migrations/**", ".github/**"],
    "dependencies": true,
    "maxChangedLines": 400,
    "maxFiles": 25
  }
}
```

| Level | What the factory does                                                                    |
| ----- | ---------------------------------------------------------------------------------------- |
| `L0`  | Stops for approval after `plan-review` and after `review`; never merges                  |
| `L1`  | Opens a draft PR; a human merges                                                         |
| `L2`  | Merges its PR unless a rule matches; a critical change waits for approval after `review` |
| `L3`  | Merges everything; critical matches are listed in the issue comment, not blocked         |

A change is **critical** when it touches a protected path (anything under `.factory/` always
counts), changes a dependency manifest or lockfile (`dependencies: true`), exceeds the line or
file limit, an agent recorded a `one_way` decision, or the `review` agent reported `risk: high`
(it judges whether the change alters existing logic beyond what the issue asks; it can raise the
stakes but never lower what the rules found). Agents can raise a decision's
reversibility but a rule match always wins. If the policy file is invalid or the diff cannot be
read, the run fails safe: an invalid policy drops to `L1`, an unreadable diff counts as critical.

When a run waits for approval it gets the `factory:needs-input` label and an approval card in the
dashboard. **Approve** continues with the next stage. **Send back** writes your feedback to
`human-feedback.md` and re-runs `plan` or `implement`, which must honour it; the override is
kept as a decision on the run. Merging uses `gh pr merge --squash --auto`, so branch protection
and required checks still apply; where auto-merge is off, it merges directly only if every check
has already passed, and otherwise leaves the PR for you and says so in the comment.

The role prompts are in [`prompts/`](prompts). Agents share nothing but the files in the run
directory (`~/.factory/runs-data/<run>/`).

A stage ends when its agent calls `report_status` on the factory's MCP server. The server then
closes the tab and starts the next stage. If an agent exits or times out without reporting, the
stage is started again, up to `FACTORY_MAX_STAGE_ATTEMPTS` times per stage.

The issue shows where the run stands:

| Label                 | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `factory`             | Pick this issue up (you add this)                                     |
| `factory:in-progress` | A run is queued or working                                            |
| `factory:needs-input` | An agent asked a question in a comment; answer, then re-add `factory` |
| `factory:failed`      | The run failed; the comment says why. Re-add `factory` to try again   |
| `factory:done`        | A pull request is open and linked in a comment (merged at L2/L3)      |

## Requirements

- macOS or Linux with Node 26, Docker, the [`gh`](https://cli.github.com) CLI logged in with
  push access to the repositories, and [Herdr](https://herdr.dev) 0.9.5 or later.
- A Claude Code credential for the agents: run `claude setup-token` and put the result in
  `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, or set `ANTHROPIC_API_KEY`.

## Run it

```bash
npm ci
make agent-image          # build the agent container (once, and after Dockerfile changes)
cp .env.example .env      # set FACTORY_REPOS and the Claude credential
make herdr                # terminal 1: the Herdr session the factory drives
make start                # terminal 2: build the dashboard and start the server
```

Open <http://127.0.0.1:3775>. Label an issue `factory` in a watched repository, or choose
**Add issue** and paste an issue URL. To watch the agents, run `herdr --session factory`: each
run is a workspace and each stage a tab.

The factory uses its own Herdr session and never touches your default one.

The dashboard follows each pull request after the run ends: **PR draft**, **PR open**, **PR merged**
or **PR closed**, refreshed every `FACTORY_POLL_SECONDS` (and on "Check now"). It shows a merge
whoever made it: the factory, auto-merge once checks passed, or you on GitHub.

## Configuration

Everything is set through environment variables; [`.env.example`](.env.example) lists them all.

| Variable                 | Default                            | Purpose                                        |
| ------------------------ | ---------------------------------- | ---------------------------------------------- |
| `FACTORY_REPOS`          | empty                              | `owner/name` repositories to watch             |
| `FACTORY_LABEL`          | `factory`                          | Trigger label, and prefix of the state labels  |
| `FACTORY_POLL_SECONDS`   | `60`                               | Seconds between issue checks; `0` disables     |
| `FACTORY_AUTONOMY`       | `L1`                               | Level for repos without `.factory/policy.json` |
| `FACTORY_MAX_RUNS`       | `2`                                | Runs working at the same time                  |
| `FACTORY_HOME`           | `~/.factory`                       | Runs, repository clones, worktrees             |
| `HERDR_SESSION`          | `factory`                          | Herdr session to drive                         |
| `FACTORY_AGENT_IMAGE`    | `localhost/factory-agent:latest`   | Agent container image                          |
| `FACTORY_MCP_PUBLIC_URL` | `http://host.docker.internal:3776` | How containers reach the reporting endpoint    |
| `FACTORY_API_TOKEN`      | unset                              | Require a bearer token on the API              |

On Linux, containers do not resolve `host.docker.internal` by default: set
`FACTORY_AGENT_DOCKER_ARGS=--add-host=host.docker.internal:host-gateway` and
`FACTORY_MCP_HOST=0.0.0.0` (or the Docker bridge address).

## Security

- Agents run with Claude Code's permission prompts turned off, which is why each one runs in a
  container. A container sees only the run's worktree, the repository clone it belongs to, and
  the run directory.
- Agents receive a GitHub token and a Claude credential through `~/.factory/agent.env`
  (owner-readable only). The GitHub token has whatever access your `gh` login has; use a
  fine-grained token in `GH_TOKEN` to narrow it.
- Issue text is untrusted input that agents read. Only label issues you would hand to a
  contractor, and review every pull request. At the default `L1` the factory only opens drafts and never merges;
  `L2` and `L3` merge on their own, so set them only where branch protection and required checks
  stand behind them.
- The dashboard and API listen on `127.0.0.1`. The reporting endpoint has no authentication
  beyond unguessable run IDs; keep `FACTORY_MCP_HOST` on loopback unless you have to change it.

## API

All routes are under `/v1` and return JSON; errors are `{ "error": { "code", "message" } }`.

| Route                       | Purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `GET /v1/factory`           | Watched repositories, label, limits, last issue check   |
| `POST /v1/poll`             | Check the watched repositories now                      |
| `GET /v1/runs`              | Run summaries, newest first                             |
| `POST /v1/runs`             | `{ "issueUrl" }`: start a run, or restart a stopped one |
| `GET /v1/runs/:id`          | One run with its plan and attachments                   |
| `GET /v1/runs/:id/tail`     | Recent terminal output of the current stage             |
| `POST /v1/runs/:id/retry`   | Run a stopped run again from the first stage            |
| `POST /v1/runs/:id/cancel`  | Stop a run and remove its worktree                      |
| `POST /v1/runs/:id/approve` | Approve what the policy held back                       |
| `POST /v1/runs/:id/reject`  | `{ "feedback" }`: send the run back with your override  |
| `GET /v1/events`            | Server-sent `run` events, one per change                |

Agents report on a separate listener, `POST /mcp/runs/:runId/stages/:stage` (MCP over HTTP),
with the tools `get_reporting_instructions`, `report_status` and `create_attachment`.

## Development

```bash
make test        # typecheck, unit tests, formatting, image script tests
make smoke       # one issue through every stage on the live Herdr session, with a stub agent
npm run dev      # server with reload;  npm run dev:ui  for the dashboard on :5174
```

`make smoke` needs `make herdr` running. It uses a local git repository and
[`scripts/stub-agent.mjs`](scripts/stub-agent.mjs) in place of Docker, Claude and GitHub, so it
checks the orchestration only. `scripts/herdr-spike.mjs` prints the raw Herdr responses the
factory depends on; run it after a Herdr upgrade.

Code map: [`src/pipeline.ts`](src/pipeline.ts) is the stage state machine,
[`src/herdr/`](src/herdr) talks to Herdr, [`src/github/`](src/github) wraps `gh`,
[`src/core.ts`](src/core.ts) owns run records, [`src/mcp.ts`](src/mcp.ts) is the reporting
server, and [`ui/`](ui) is the dashboard.

## Not built yet

- Nothing restarts the Herdr session or the server after a reboot.
- A retry starts again from `classify` on a fresh worktree; it does not resume mid-pipeline.
- Agents cannot ask a question and continue in the same stage: `input_required` stops the run.
