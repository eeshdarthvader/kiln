# SAWD data model and API reference

SAWD (Standard Agentic Workload Definition) describes agent work through initial
instructions, a plan, attachments, and the latest agent report. The server sets
up an OpenCode session, submits its initial prompt once, and registers the
reporting MCP. Its browser UI starts tasks, shows reported status, decisions and
artifacts, and links to the OpenCode session. After setup, SAWD stores reports
without observing or controlling execution. Questions, approvals, and follow-up
instructions use OpenCode's native UI. All state is in memory; there is no
persistence, pagination, streaming HTTP task feed, or recovery after restart.

## Task definitions and returned projections

Submit a task under a caller-chosen URL-safe ID:

```http
PUT /v1/tasks/change-123
Content-Type: application/json
Authorization: Bearer <SAWD_API_TOKEN>
```

```json
{
  "title": "Implement the requested change",
  "input": { "instructions": "Implement the change and verify it." },
  "acceptanceCriteria": ["The behavior is implemented", "Relevant checks pass"],
  "labels": ["implementation"],
  "executor": "<agent ID from GET /v1/agents>"
}
```

`title`, `input.instructions`, and `executor` are required. `acceptanceCriteria`
and `labels` default to empty arrays. The accepted definition is immutable. The
server compares normalized, validated content, ignoring object key order and
preserving array order. Repeating the same `PUT` returns the current task (`200`);
changing its accepted content returns `409`. Creation returns `201` with setup
status `pending` and no report. Acceptance does not start execution.

`executor` selects the initial provider-instance/model profile. Its ID is opaque;
discover it with `GET /v1/agents`. Unavailable profiles are not silently
substituted. Later native interaction may change the runtime model without
updating this immutable field.

Task detail responses have this shape:

```json
{
  "id": "change-123",
  "title": "Implement the requested change",
  "acceptanceCriteria": ["The behavior is implemented", "Relevant checks pass"],
  "labels": ["implementation"],
  "executor": "<agent ID>",
  "setup": { "status": "pending" },
  "report": null,
  "archivedAt": null,
  "runtimeUrl": null,
  "plan": { "steps": [] },
  "attachments": [],
  "input": { "instructions": "Implement the change and verify it." },
  "createdAt": "2026-11-10T10:00:00.000Z",
  "updatedAt": "2026-11-10T10:00:00.000Z"
}
```

`GET /v1/tasks` returns task summaries that omit `input`, `acceptanceCriteria`,
`plan`, and `attachments`. Detail responses retain all four. `runtimeUrl` becomes
the browser link to the OpenCode session when available; runtime authentication
is separate. Dates are ISO timestamps. The title also names the OpenCode session.
Internal commands and OpenCode IDs are not exposed.

`report` is either `null` or the latest received report:

```json
{
  "status": "running",
  "summary": "Implementing the requested change.",
  "receivedAt": "2026-11-10T10:01:00.000Z"
}
```

Setup state and reported work status are separate. There is no top-level task
`status` or `summary`, work version, plan revision, cancellation, or deadline.
The task is a snapshot of the latest report, not a durable output archive.

### Native interaction and follow-ups

Send questions, approval requests, and subsequent instructions through OpenCode.
Its configured permission policy applies. Before asking a question through the
native question tool or chat, or requesting approval, an agent must report
`input_required`. After receiving input, it must report `running` before resuming
work. The server does not observe native requests, answers, permission prompts,
idle state, new turns, or follow-ups; the stored report changes only when an
agent submits another report. Task instructions define any task-specific
question, review, or approval workflow.

A native follow-up can produce a new report in the same session after `done` or
`failed`, including after archival. Until that report arrives, the previous
report remains visible. Reports have no native turn attribution or stale-turn
protection: the last newly received report wins.

### Plan

Every task starts with `plan: { "steps": [] }`. A plan is an ordered list of steps
with stable unique IDs, text, and status `pending`, `running`, or `completed`.
Publishing `plan: { steps }` through `report_status` replaces the full list; an
empty list clears it, and omitting `plan` preserves it. Summary, plan, and report
status save atomically. A rejected report saves none of its changes. Completed
steps do not imply completion; publish a `done` report when appropriate.

Plans survive reports and archival. Task instructions may define how to review
workspace files; useful artifacts can be retained as immutable attachments.

## Attachments

Attachments are immutable records with server-generated `id` and `createdAt`.
Create a new attachment for each revision. The server retains inline content and
references; it never reads arbitrary paths or fetches attachment URLs.

| `kind`              | Required content                                                         | Optional content      |
| ------------------- | ------------------------------------------------------------------------ | --------------------- |
| `decision`          | `title`, `summary`, `rationale`                                          | —                     |
| `artifact`          | `title`, inline `content`, `mediaType` (`text/plain` or `text/markdown`) | —                     |
| `evidence`          | `title`, at least one of `text` or `url`                                 | Other of `text`/`url` |
| `context_reference` | `title`, `url`                                                           | `description`         |

Decision attachments retain consequential choices and rationale outside the
session transcript. They never record runtime tool permissions. URLs must be
HTTP(S) without embedded credentials. Questions and approval requests are not
attachment kinds or reporting operations.

## Setup and reporting

`POST /v1/tasks/:id/start` performs one-time setup: create the task workspace and
session, select its model, configure reporting MCP, and submit the initial prompt.

| `setup.status` | Meaning                                                                                 |
| -------------- | --------------------------------------------------------------------------------------- |
| `pending`      | Accepted and awaiting explicit start                                                    |
| `starting`     | Initial setup is in progress                                                            |
| `submitted`    | Initial prompt submission is confirmed                                                  |
| `failed`       | Setup failed; `error.code` is `SETUP_FAILED`                                            |
| `unknown`      | Session preparation or prompt delivery is uncertain; `error.code` is `DELIVERY_UNKNOWN` |

Setup errors include a human-readable `message`. Retrying start for a submitted
or failed setup never relaunches it. Unknown setup can mean uncertain session
preparation before a prompt attempt or uncertain prompt delivery. Repeated start
only reconciles runtime state read-only when a prompt was prepared; otherwise it
preserves the unknown state for inspection. OpenCode v2's prompt response
confirms durable admission. After an uncertain response, setup checks the inbox
and stored message by stable message ID; it never blindly repeats uncertain
preparation or resends an uncertain prompt. An absent runtime message does not
prove that execution did not begin. Unknown setup can remain unresolved.

Reporting is accepted once setup has started (`starting`, `submitted`, or
`unknown`), including after earlier `done` or `failed` reports and after archival.
Pending and failed setup reject new reports and attachments. A saved successful
operation retry remains available. Reporting does not synchronize runtime state.

| `report.status`  | Agent-reported meaning       |
| ---------------- | ---------------------------- |
| `running`        | Work is in progress          |
| `input_required` | Work needs human input       |
| `done`           | The agent reports completion |
| `failed`         | The agent reports failure    |

The server stores these claims. It does not verify runtime settlement, observe
children, stop execution after failure, or infer completion from idle execution.
The root agent owns task-facing reports and attachments; children return findings
and blockers to the root. Reports have no automatic native call or turn
attribution. Task directories and sessions are organizational boundaries; all
agents share a runtime user and filesystem.

Archive is display metadata available at any time. It sets `archivedAt` once;
retries preserve the timestamp. Archival does not stop work or block start,
reports, attachments, or native follow-ups. There is no cancellation, deadline,
execution polling, or stop endpoint.

## HTTP API

The external API listens on `0.0.0.0:SAWD_PORT` (default `3775`); the Makefile
publishes it only on host loopback. Submission uses JSON with a 1 MB body limit.
Validated submissions and MCP inputs reject unknown fields, including nested
objects. Start/archive ignore body values; JSON parsing and size checks still
apply before routing.

Business routes use `/v1`. Old unversioned business paths return `404` with
`ROUTE_NOT_FOUND`. Health and UI paths remain unversioned. If `SAWD_API_TOKEN` is
configured, API routes except health require exact `Authorization: Bearer
<token>`. UI assets are public; their API calls require the token. Missing or
invalid authentication returns `401`. Configure network controls for non-loopback
exposure.

Writes return `503` while unready. Startup connects to OpenCode, discovers
connected provider models, and registers and probes reporting MCP before opening
the external listener. Readiness is a bootstrap/shutdown gate, not a continuous
OpenCode connectivity check.

| Method/path                  | Success response                                    | Behavior/errors                                             |
| ---------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `GET /`                      | HTML overview                                       | `503 UI_NOT_BUILT` if not built                             |
| `GET /assets/*`              | Static UI assets                                    | Missing assets fall through API authentication and routing  |
| `GET /healthz`               | `200 { "alive": true }`                             | Public liveness                                             |
| `GET /readyz`                | `200 { "ready": true }` or `503 { "ready": false }` | Public readiness                                            |
| `GET /v1/openapi.json`       | `200 <OpenAPI 3.1 document>`                        | API authentication applies                                  |
| `GET /v1/agents`             | `200 { "schemaVersion": 1, "agents": [...] }`       | Profiles expose `id`, `name`, `description`, `capabilities` |
| `PUT /v1/tasks/:id`          | `201` new / `200` identical retry; full task        | `404` unknown executor; `409` conflicting ID                |
| `GET /v1/tasks`              | `200 { "tasks": [<task summary>, ...] }`            | Includes archived tasks, in acceptance order                |
| `GET /v1/tasks/:id`          | `200 <full task>`                                   | `404` missing task; includes `runtimeUrl`                   |
| `POST /v1/tasks/:id/start`   | `200 <full task>`                                   | One-time setup; retries do not relaunch                     |
| `POST /v1/tasks/:id/archive` | `200 <full task>`                                   | Sets display metadata at any time                           |

There is no separate runtime-link route. An agent profile advertises capabilities
from `git`, `node`, `python`, and opt-in `docker`.

`GET /v1/opencode/connection` returns `{ url, password }` for the OpenCode login
dialog. Sign in at `url` as `opencode`, then open the task's `runtimeUrl`.
The existing API authorization applies; without `SAWD_API_TOKEN`, this endpoint
is accessible through the trusted local API. The password grants server-wide
OpenCode access and is never included in task responses or URLs. Responses use
`Cache-Control: no-store`; unavailable login details return `503 NOT_READY`.

API errors use `{ "error": { "code": "VALIDATION_FAILED", "message": "…",
"details": {} } }`. `details` is optional; branch on stable `code`, not `message`.

| Status | Codes                                                     |
| ------ | --------------------------------------------------------- |
| `400`  | `VALIDATION_FAILED` — invalid schema, ID, or JSON         |
| `401`  | `UNAUTHORIZED` — invalid configured API bearer token      |
| `404`  | `TASK_NOT_FOUND`, `EXECUTOR_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| `409`  | `IDEMPOTENCY_CONFLICT`, `TASK_STATE_CONFLICT`             |
| `413`  | `PAYLOAD_TOO_LARGE` — body exceeds 1 MB                   |
| `500`  | `INTERNAL_ERROR` — sanitized unexpected failure           |
| `503`  | `NOT_READY`, `UI_NOT_BUILT`                               |

Readiness retains `{ "ready": false }` on `503`. Setup error codes appear in task
setup metadata rather than as reported work failures.

## Reporting MCP

The server name remains `sawd-execution`, version `0.1.0`, using stateless
Streamable HTTP on `SAWD_MCP_PORT` (default `3776`), bound only to loopback. For
each task directory, OpenCode registers the task-scoped URL
`POST http://127.0.0.1:3776/mcp/tasks/<taskId>`. The URL path selects and validates
an existing task; an unknown task returns `404 TASK_NOT_FOUND`. All sessions using
the same task directory, including root, child, and follow-up sessions, share
that binding. OpenCode's per-directory MCP configuration retains the URL across
context compaction. The URL and task ID are non-secret correlation values: any trusted
caller that can reach the loopback listener can address a task. The route does
not use `SAWD_API_TOKEN` or another credential.

The unbound `POST http://127.0.0.1:3776/mcp` endpoint is for bootstrap and
discovery and exposes only `get_reporting_instructions`; it cannot write task
data. Other methods return HTTP `405`, `Allow: POST`, and a JSON-RPC error. Use an
MCP client for initialization, discovery, and tool calls. No OpenCode reporting
plugin or native call metadata is required. Task state is in memory, so after a
server restart a retained task URL refers to an unknown task until task state is
created again.

| Tool                         | Strict input object           | Successful text content                            |
| ---------------------------- | ----------------------------- | -------------------------------------------------- |
| `get_reporting_instructions` | `{}`                          | Human-readable reporting protocol                  |
| `create_attachment`          | `{ operationId, attachment }` | JSON saved attachment with ID/timestamp            |
| `report_status`              | `{ operationId, report }`     | JSON `{ taskId, operationId, receivedAt }` receipt |

Successful calls use `content: [{ "type": "text", "text": "…" }]`; write results
are JSON serialized in text. Domain failures return `isError: true` with the API
error envelope serialized in text. The MCP SDK may reject invalid arguments
before a tool runs. Unknown internal failures use a generic message. Writes fail
while unready; reporting instructions remain available.

Each write requires a task-scoped unique URL-safe `operationId`, shared across
both write tools. After an uncertain response, retry the identical operation with
the same ID and payload. The original result is returned without applying the
write again. A `report_status` retry returns its original receipt and does not
replace a newer report or advance `receivedAt`. Reusing an ID for another tool or
payload fails. Failed calls do not save an operation.

```json
{
  "operationId": "progress-1",
  "report": {
    "status": "running",
    "summary": "Implementing the requested change.",
    "plan": {
      "steps": [
        { "id": "implement", "text": "Implement the change", "status": "running" },
        { "id": "verify", "text": "Verify the behavior", "status": "pending" }
      ]
    }
  }
}
```

`summary` is required. Include a plan when useful and update it at meaningful
milestones. Report completion after satisfying acceptance criteria and
collecting child results. The root agent owns task-facing reporting. Read the
current OpenCode conversation every turn. There is no reporting context-fetch
tool. A failed MCP call is not a saved report.

## Validation limits

Limits count string characters unless stated otherwise. Unknown fields are
rejected. Human-readable strings are trimmed except artifact content, which is
preserved verbatim.

| Value                                                                                        | Limit/rule                                   |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Task, executor, plan-step, operation IDs                                                     | 1–128; `^[A-Za-z0-9][A-Za-z0-9_-]*$`         |
| Title                                                                                        | Trimmed, 1–200                               |
| Instructions, decision summary/rationale, evidence text, context description, report summary | Trimmed, 1–20,000                            |
| Acceptance criteria                                                                          | At most 50; each trimmed 1–2,000             |
| Labels                                                                                       | At most 50; each trimmed 1–100               |
| Artifact content                                                                             | 0–200,000; preserved verbatim                |
| Attachment URL                                                                               | At most 2,000; valid HTTP(S), no credentials |
| Plan steps                                                                                   | At most 50, unique IDs; trimmed text 1–1,000 |
| HTTP JSON body                                                                               | 1 MB                                         |

Discovery retains `schemaVersion: 1`; task bodies have no schema version. This
pre-release contract changes in place at `/v1` without backward compatibility.
Deploy the server, bundled UI, and consumers together. Clients should ignore
optional additive response fields. Export records that must survive restarting
the server; task snapshots and attachments exist only in process memory.
