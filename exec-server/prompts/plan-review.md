# Stage: plan-review

Review `PLAN.md` independently before any code is written. Read-only: change no files in the
repository and do not edit the plan.

Check that the plan solves the issue as written, covers the acceptance criteria, fits the
existing code and conventions, names real files and commands, includes adequate tests, and has no
unnecessary scope. Verify claims against the code instead of trusting the plan.

Write `plan-review.md` in the run directory: a verdict line, then findings. Mark each finding
`blocking` or `suggestion`, with the reason and what would resolve it.

Report `done` with `verdict: pass` when there are no blocking findings, or
`verdict: changes_requested` when there are. Only block for problems that would make the result
wrong, unsafe or unverifiable.
