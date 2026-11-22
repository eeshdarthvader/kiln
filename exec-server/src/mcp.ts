import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import type { Core } from './core.ts';
import { FactoryError } from './domain.ts';
import { errorEnvelope } from './http.ts';
import { reportingInstructions, reportingServerName } from './reporting-instructions.ts';
import { attachmentSchema, idSchema, parse, reportSchema, stageSchema } from './validation.ts';

/** A stateless MCP server per request. The run and stage come from the URL, never from the agent. */
export async function handleMcp(
  core: Core,
  req: Request,
  res: Response,
  ready: () => boolean,
  scope?: { runId: string; stage: string },
) {
  if (scope) {
    core.get(scope.runId);
    parse(stageSchema, scope.stage);
  }
  const server = new McpServer(
    { name: reportingServerName, version: '0.2.0' },
    { instructions: 'Call get_reporting_instructions before starting work.' },
  );
  const invoke = (operation: () => unknown) => {
    try {
      if (!ready()) throw new FactoryError('The factory is not ready.', 503, 'NOT_READY');
      return { content: [{ type: 'text' as const, text: JSON.stringify(operation()) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              errorEnvelope(
                error instanceof ZodError ? new FactoryError('Invalid tool arguments.') : error,
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
  if (scope) {
    server.registerTool(
      'create_attachment',
      {
        description:
          'Keep a consequential decision and its rationale, a useful artifact, evidence, or a context reference with the run. Attachments are immutable. Retry uncertain calls with the same operation ID and payload.',
        inputSchema: z.object({ operationId: idSchema, attachment: attachmentSchema }).strict(),
      },
      async (args) =>
        invoke(() =>
          core.createAttachment(scope.runId, scope.stage, args.operationId, args.attachment),
        ),
    );
    server.registerTool(
      'report_status',
      {
        description:
          'Report this stage: running at start and milestones; done when the stage is complete (review stages add verdict pass or changes_requested, the pr stage adds prUrl); input_required when a human must decide something; failed when the stage cannot be completed. done, input_required and failed end the stage. Include plan: {steps} when the plan is set or changes. Retry uncertain calls with the same operation ID and report.',
        inputSchema: z.object({ operationId: idSchema, report: reportSchema }).strict(),
      },
      async (args) =>
        invoke(() => core.reportStatus(scope.runId, scope.stage, args.operationId, args.report)),
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
