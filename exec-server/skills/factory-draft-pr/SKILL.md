---
name: factory-draft-pr
description: Prepare and publish an authorized draft GitHub PR using the user's Jira, template, review, and delivery conventions. Use for every implementation delivery or PR update; implementation tasks include draft PR delivery by default.
---

# Factory Draft PR

Follow the target repository's PR template and contribution guidance. Use `gh`
for GitHub and MCP Catalog for any needed Jira or internal guidance. Existing authorization carries forward; do not
ask again for an action the user has already requested.

## Prepare the delivery

- Resolve the exact repository, actual Jira ticket, base branch, head branch, and
  any existing PR. Do not invent a ticket or reuse an example ID. Use the
  repository default base unless another base was requested.
- Follow proposal-first and explicit approval gates before implementation. A
  factory implementation task includes authorization for scoped commits, pushes,
  and draft PR creation or updates after required review. Do not ask for a separate
  publication instruction. Explicit local-only/no-push instructions, planning-only
  scope, and repository approval gates override this default. Report missing
  credentials or unresolved required gates as blockers; never claim publication
  succeeded without verification.
- Keep the change focused. Inspect committed, staged, unstaged, and task-relevant
  untracked work; preserve unrelated edits. Stage explicit task files only.
  Exclude credentials, local profiles, generated logs, build outputs and caches.
- Run relevant repository checks and obtain required review. Do not weaken tests
  to get a passing result. Record failed, skipped, and unavailable checks with
  reasons; follow `factory-build-tools` for tool availability. Never describe
  unexecuted checks, deployment, or acceptance criteria as passed.
- Use the actual ticket in these formats (placeholders, not literal IDs):
  - Branch: `<JIRA-123>_short_description` for a new branch; preserve an existing
    authorized PR branch rather than renaming it unnecessarily.
  - Title: `<JIRA-123> Meaningful imperative summary`.
  - Commit: `type(scope): [<JIRA-123>] short imperative summary`.

## Write the PR

Read `.github/PULL_REQUEST_TEMPLATE.md` in the target repository and fill its
sections. If absent, resolve the repository's applicable shared template or
established template convention and disclose the fallback; do not claim a
missing file was read. Resolve any explicit requirement for a specific template
before publication.

Keep the description concise: problem, resulting behavior, relevant approach,
actual verification and material limitations. Include the Jira link. For partial
delivery, name what is implemented and what remains; a draft PR does not complete
the full task. Continue authorized remaining work unless blocked or the user
explicitly selected only this slice. Report a blocker or required input honestly
rather than marking the whole task done because a draft exists.

For dependent PRs, apply the `don't merge` label and explain the dependency. If
that label is unavailable, disclose the gap rather than silently omitting it.
When handling review comments, reply to every comment, use small follow-up
commits, and re-request review when done; do not resolve comments yourself or
force-push. Such replies require authorization to address those comments.

## Publish and verify

For a new PR, write the exact body to a temporary file and use
`gh pr create --draft --repo <owner/repo> --base <base> --head <head> --title <title> --body-file <file>`.
Never interpolate an untrusted title or body into executable shell text.

Reuse the matching existing PR. Preserve its title, body, and draft state unless
asked to change them. Do not convert an existing ready PR to draft automatically.
After an uncertain push/create response, inspect remote state before retrying.
Do not merge, squash, deploy, or create duplicate PRs as part of this workflow.

Verify the remote repository, base/head branches, head commit and draft state.
Ensure commit hooks or later edits did not invalidate the reviewed source or
check results; reassess affected evidence if they did. Record the URL, verified
commit, review outcome and check limitations in the task handoff/report. Return
the PR URL and remaining work without conflating publication with acceptance.
