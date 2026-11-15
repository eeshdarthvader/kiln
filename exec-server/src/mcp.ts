import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import type { Core } from './core.ts';
import { SawdError } from './domain.ts';
import { errorEnvelope } from './http.ts';
import { attachmentSchema, idSchema, reportSchema } from './validation.ts';
import {
  reportingInstructions,
  reportingInstructionsReference,
  reportingServerName,
} from './reporting-instructions.ts';

export async function handleMcp(
  core: Core,
  req: Request,
  res: Response,
  ready: () => boolean,
  taskId?: string,
) {
  if (taskId !== undefined) core.record(taskId);
  const server = new McpServer(
    { name: reportingServerName, version: '0.1.0' },
    { instructions: reportingInstructionsReference },
  );
  const operationId = idSchema;
  const invoke = (operation: () => unknown) => {
    try {
      if (!ready()) throw new SawdError('SAWD is not ready.', 503, 'NOT_READY');
      return { content: [{ type: 'text' as const, text: JSON.stringify(operation()) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              errorEnvelope(
                error instanceof ZodError ? new SawdError('Invalid tool arguments.') : error,
                'Unable to process this tool call.',
              ),
            ),
          },
        ],
      };
    }
  };
  server.registerTool(
    'get_reporting_instructions',
    {
      description: 'Read before starting work to learn when and how to report status and results.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: 'text', text: reportingInstructions }] }),
  );
  if (taskId !== undefined) {
    server.registerTool(
      'create_attachment',
      {
        description:
          'Call when producing a consequential decision and rationale, useful artifact, evidence, or context reference. Attachments are immutable; save revisions separately. Retry uncertain calls with the same operation ID and payload.',
        inputSchema: z.object({ operationId, attachment: attachmentSchema }).strict(),
      },
      async (args) =>
        invoke(() => core.createAttachment(taskId, args.operationId, args.attachment)),
    );
    server.registerTool(
      'report_status',
      {
        description:
          'Report running when starting, resuming, or making meaningful progress; input_required before asking the user a question through the native question tool or chat, requesting approval, or waiting for input; done after completion; failed when unable to complete. Report running after receiving input and before continuing. Include the full current plan: {steps} when establishing the plan, after substantial changes, and at milestones, including completion; omit it only when unchanged. Retry uncertain calls with the same operation ID and report.',
        inputSchema: z.object({ operationId, report: reportSchema }).strict(),
      },
      async (args) => invoke(() => core.reportStatus(taskId, args.operationId, args.report)),
    );
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.once('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
