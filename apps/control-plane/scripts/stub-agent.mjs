#!/usr/bin/env node
// Stand-in for the agent container, used by scripts/smoke.ts and FACTORY_AGENT_COMMAND.
// It does the minimum each stage must do and reports through the factory MCP server.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const {
  FACTORY_STAGE: stage,
  FACTORY_ATTEMPT: attempt,
  FACTORY_MCP_URL: url,
  FACTORY_RUN_DIR: runDirectory,
} = process.env;
console.log(`stub agent: stage ${stage}, attempt ${attempt}, cwd ${process.cwd()}`);

const client = new Client({ name: 'stub-agent', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
let operation = 0;
const report = async (value) => {
  const result = await client.callTool({
    name: 'report_status',
    arguments: { operationId: `${stage}-${attempt}-${++operation}`, report: value },
  });
  console.log(`reported ${value.status}: ${result.content[0].text}`);
};

await report({ status: 'running', summary: `Stub ${stage} started.` });
const final = { status: 'done', summary: `Stub ${stage} finished.` };
if (stage === 'plan') {
  writeFileSync(join(runDirectory, 'PLAN.md'), '# Plan\n\n1. Add the file.\n');
  final.plan = { steps: [{ id: 'add-file', text: 'Add the file', status: 'pending' }] };
}
if (stage === 'plan-review' || stage === 'review') {
  // Reject the first plan once, to exercise the loop back to the plan stage.
  final.verdict = stage === 'plan-review' && attempt === '1' ? 'changes_requested' : 'pass';
}
if (stage === 'implement') {
  writeFileSync('factory-smoke.txt', `written by the stub agent at ${new Date().toISOString()}\n`);
  execFileSync('git', ['add', 'factory-smoke.txt']);
  execFileSync('git', [
    '-c',
    'user.name=stub',
    '-c',
    'user.email=stub@example.invalid',
    'commit',
    '-q',
    '-m',
    'Add smoke file',
  ]);
}
if (stage === 'pr')
  final.prUrl = process.env.STUB_PR_URL ?? 'https://github.com/example/smoke/pull/1';
await new Promise((resolve) => setTimeout(resolve, Number(process.env.STUB_DELAY_MS ?? 400)));
await report(final);
await client.close();
// Stay open like an interactive agent would; the factory closes the pane.
setInterval(() => {}, 1000);
