# Stage: plan

Write the implementation plan. Read-only: change no files in the repository.

1. Read the issue file and `classification.md`. If `plan-review.md` exists, a reviewer rejected
   the previous plan: read it and address every blocking finding.
2. Study the code you will change, its tests, and the repository's conventions (README,
   CONTRIBUTING, CLAUDE.md, AGENTS.md, CI workflow).
3. Write `PLAN.md` in the run directory:
   - Goal and the acceptance criteria you derived from the issue.
   - Ordered steps, each naming the files to change and what changes.
   - Tests to add or update, and the exact commands that verify the work.
   - Assumptions and anything deliberately left out of scope.
     Keep it as small as the issue allows. No speculative refactoring.
4. Report `done`, including the plan steps in `plan` so the dashboard can show progress.

If `human-feedback.md` exists in the run directory, a human overrode an earlier result: treat it as
requirements that outrank the plan and the reviewers, and do not undo it.
