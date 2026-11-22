# Stage: classify

Decide whether this issue is ready for the factory to implement. Read-only: change no files in
the repository.

1. Read the issue file, then explore the repository enough to understand what the change touches.
2. Write `classification.md` in the run directory with: a one-paragraph restatement of the
   request, the type of work (bug, feature, refactor, docs, chore), the files or areas likely
   affected, rough complexity (small, medium, large), how it can be verified, and any risks.
3. Report:
   - `done` if a competent engineer could start now. Reasonable assumptions are fine; list them
     in `classification.md`.
   - `input_required` if a missing decision would change what gets built. Ask only the questions
     that block the work, numbered, in the summary.
   - `failed` if the request is out of scope for this repository or is not a code change.
