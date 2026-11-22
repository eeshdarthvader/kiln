export const reportingServerName = 'factory';

export const reportingInstructions = `Report this stage's progress and result to the factory.

report_status({ operationId, report: { status, summary, verdict?, prUrl?, plan? } })
- status "running": when you start and at real milestones.
- status "done": the stage's work is complete. Review stages set verdict to "pass" or
  "changes_requested". The pr stage sets prUrl to the pull request URL.
- status "input_required": a human must decide something first. The summary is posted on the
  GitHub issue, so phrase it as a clear question. The stage ends when you send this.
- status "failed": the stage cannot be completed. Say what blocked you. The stage ends.
- plan: { steps: [{ id, text, status }] } with status pending, running or completed. Send the
  whole plan whenever it changes.

create_attachment({ operationId, attachment }) keeps a decision, artifact, evidence or context
reference with the run. Attachments cannot be edited afterwards. A decision may also carry
options (alternatives considered), reversibility ("cheap", "costly" or "one_way") and
blastRadius (what it touches). One-way decisions are shown to a human before the change merges.

Use a new operationId for each call. Reuse an operationId only to retry a call whose outcome you
did not see, with the same payload. After a final status (done, input_required, failed) stop
working: the factory closes this terminal.`;
