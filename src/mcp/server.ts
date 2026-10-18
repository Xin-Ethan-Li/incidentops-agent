import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { searchLogs, getMetrics, getServiceInfo, ToolError } from '../tools/index.js';
import type { RunbookRetriever } from '../rag/runbook-retriever.js';

const windowSchema = z.strictObject({ start: z.string(), end: z.string() });
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
async function result(run: () => unknown) {
  try { return text(await run()); }
  catch (error) {
    return { ...text({ error: {
      name: error instanceof ToolError ? 'ToolError' : error instanceof TypeError ? 'TypeError' : 'Error',
      ...(error instanceof ToolError ? { code: error.code } : {}),
      message: error instanceof Error ? error.message : String(error),
    } }), isError: true };
  }
}

/** Only adapts existing business tools; retrieval remains in RunbookRetriever. */
export function createIncidentOpsServer(retriever: RunbookRetriever): McpServer {
  const server = new McpServer({ name: 'incidentops-read-tools', version: '1.0.0' });
  server.registerTool('search_logs', {
    description: 'Search deterministic service logs in a time window.',
    inputSchema: z.strictObject({ service: z.string(), timeWindow: windowSchema,
      levels: z.array(z.enum(['info', 'warn', 'error'])).nullish(), contains: z.string().nullish() }),
  }, args => result(() => searchLogs({ ...args, levels: args.levels ?? undefined, contains: args.contains ?? undefined })));
  server.registerTool('get_metrics', {
    description: 'Read deterministic service metrics in a time window.',
    inputSchema: z.strictObject({ service: z.string(), timeWindow: windowSchema, metricNames: z.array(z.string()).nullish() }),
  }, args => result(() => getMetrics({ ...args, metricNames: args.metricNames ?? undefined })));
  server.registerTool('get_service_info', {
    description: 'Read service metadata and dependencies.',
    inputSchema: z.strictObject({ service: z.string() }),
  }, args => result(() => getServiceInfo(args)));
  server.registerTool('search_runbook', {
    description: 'Retrieve relevant runbook context. Scores indicate relevance, not diagnosis confidence.',
    inputSchema: z.strictObject({ query: z.string(), limit: z.number().nullish() }),
  }, args => result(() => retriever.retrieveWithFallback({ query: args.query, limit: args.limit ?? undefined })));
  return server;
}
