import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Run, StageName } from './domain.ts';

const directory = new URL('../prompts/', import.meta.url);
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`${name}.md`, directory)), 'utf8');

export type PromptBuilder = (
  run: Run,
  stage: StageName,
  attempt: number,
  runDirectory: string,
) => string;

/** The full first message for a stage: shared rules, the stage's role, then this run's facts. */
export const stagePrompt: PromptBuilder = (run, stage, attempt, runDirectory) =>
  [
    read('common').trim(),
    read(stage).trim(),
    [
      '## This run',
      '',
      `- Repository: ${run.repo}`,
      run.ticket
        ? `- Ticket: ${run.ticket.key} in ${run.ticket.provider} (${run.issueUrl}). It is not a GitHub issue: do not write \`Closes #…\`; name the ticket key and link in the pull request description instead.`
        : `- Issue: #${run.issueNumber} (${run.issueUrl})`,
      `- Issue file: ${runDirectory}/issue.md`,
      `- Run directory: ${runDirectory}`,
      `- Repository checkout: ${run.worktreePath}`,
      `- Branch: ${run.branch}`,
      ...(run.prUrl ? [`- Pull request: ${run.prUrl}`] : []),
      `- Base branch: origin/${run.baseBranch}`,
      `- Stage attempt: ${attempt}`,
    ].join('\n'),
  ].join('\n\n') + '\n';

export const issueFile = (run: Run, body: string) =>
  `# ${run.title}\n\n${run.issueUrl}\n\n${body.trim() || '_The issue has no description._'}\n`;
