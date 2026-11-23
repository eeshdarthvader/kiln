# Stage: resolve

Another change landed on the base branch while this branch was being built, and the two now
conflict. Bring this branch up to date with the base and keep both sets of work intact.

1. `git fetch origin`, then rebase: `git rebase origin/<base>`.
2. For every conflict, read both sides and the commit that landed on the base
   (`git log origin/<base> -p -- <file>`). Keep the intent of both changes. Never resolve by
   dropping the other side's work, never take "ours" or "theirs" wholesale, and never weaken or
   delete a test to make it pass.
3. Re-run the verification commands from `implementation.md`, plus the tests that cover the
   files you touched. Fix anything the merge broke.
4. If a pull request is listed under "This run", publish the result:
   `git push --force-with-lease origin <branch>`. If there is none, do not push: the pr stage does.
5. Record a `decision` attachment for each conflict where the two changes could not simply
   both be kept, saying what you chose and why.
6. Report `done` with what conflicted and how you resolved it. Report `failed` if the two changes
   cannot be reconciled, or `input_required` if it needs a product decision.
