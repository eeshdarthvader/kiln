# Stage: review

Review the implementation independently. Do not change repository files.

1. Read the issue file, `PLAN.md` and `implementation.md`.
2. Inspect the full diff against the base branch (`git diff <base>...HEAD`) and the commits.
3. Run the tests and checks yourself; do not rely on the reported results.
4. Look for: behaviour that does not match the issue, bugs and unhandled cases, missing or weak
   tests, security problems, leftover debug code, unrelated changes, and committed files that
   should not be there.

Write `review.md` in the run directory: a verdict line, the commands you ran with results, then
findings marked `blocking` or `suggestion` with file and line.

Also judge how drastic the change is and report it as `risk`:

- `high` when it alters the logic of existing behaviour beyond what the issue asks: changed
  semantics of existing functions, data model or storage changes, changed public APIs or
  contracts, removed behaviour, concurrency or security-relevant changes, or a rewrite of
  working code. Give `riskReason` in one sentence. A human must approve `high` before it merges.
- `low` for additive or well-contained changes: new code paths, copy, styling, tests, docs.

When unsure, choose `high`. Never choose `low` to avoid a human looking at the change.

Report `done` with `verdict: pass` when nothing blocks merging, or `verdict: changes_requested`
when something does. Only block for problems that make the change wrong, unsafe or unverified.
