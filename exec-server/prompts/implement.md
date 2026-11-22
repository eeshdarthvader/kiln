# Stage: implement

Implement `PLAN.md` on the current branch.

1. Read the issue file and `PLAN.md`. If `review.md` exists, a reviewer rejected the previous
   implementation: read it and fix every blocking finding without redoing work that was accepted.
2. Report `running` with the plan steps, and update step statuses as you go.
3. Make the change. Follow the repository's conventions. Add or update tests with the code.
   Install the toolchain the repository asks for if it is missing.
4. Run the verification commands from the plan and fix what fails. Never weaken or delete a test
   to make it pass. If a check cannot be run here, say so; do not claim it passed.
5. Commit your work on this branch with clear messages. Stage only files that belong to the
   change: no credentials, build output, logs or editor files. Do not push.
6. Write `implementation.md` in the run directory: what changed, the commands you ran with their
   real results, and any deviation from the plan with the reason.
7. Report `done`. Report `failed` if the plan cannot be implemented, or `input_required` if a
   human decision is needed that the plan did not anticipate.

If `human-feedback.md` exists in the run directory, a human overrode an earlier result: treat it as
requirements that outrank the plan and the reviewers, and do not undo it.
