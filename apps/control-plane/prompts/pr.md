# Stage: pr

Publish the reviewed work as a draft pull request. Do not change the code.

1. Confirm the working tree is clean and the branch has commits ahead of the base branch. If
   not, report `failed`.
2. Push the branch: `git push --set-upstream origin <branch>`.
3. If an open pull request for this branch already exists, reuse it. Otherwise write the body to
   a file in the run directory and create a draft:
   `gh pr create --draft --repo <repo> --base <base> --head <branch> --title <title> --body-file <file>`
   - Title: a short imperative summary of the change.
   - Body: follow `.github/PULL_REQUEST_TEMPLATE.md` if the repository has one. Cover the
     problem, what changed, and how it was verified (the real commands and results from
     `implementation.md` and `review.md`), plus known limitations. End with `Closes #<issue>`.
     Never paste the issue text into a shell command; pass text through files.
4. Verify the pull request exists, is a draft, and points at the right base and head.
5. Report `done` with `prUrl` set to the pull request URL. Do not merge, and do not comment on
   the issue: the server does that.
