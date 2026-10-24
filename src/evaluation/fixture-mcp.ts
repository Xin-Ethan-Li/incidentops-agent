import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { ToolExecutor } from '../agent/tool-executor.js';
import { RunbookRetriever } from '../rag/runbook-retriever.js';
import { createIncidentOpsServer } from '../mcp/server.js';
import { ToolError } from '../tools/tool-error.js';
import { validateService, validateWindow } from '../tools/validate-input.js';
import { evidenceSchema } from './visible-evidence.js';
import type { ScenarioEvidence } from './expanded-contracts.js';

function visibleRetriever(data: ScenarioEvidence): RunbookRetriever {
  return new RunbookRetriever({ async embed(texts) {
    return texts.map(text => {
      const selected = data.runbooks.findIndex(book => text.startsWith(`Title: ${book.title}\n`)
        || book.tags.some(tag => text === `Investigate ${tag}`));
      if (selected < 0) throw new TypeError('Unsupported deterministic fixture embedding input');
      return data.runbooks.map((_, index) => index === selected ? 1 : 0);
    });
  } }, data.runbooks);
}

/** Evaluation-only evidence adapter, NOT the production business handlers for new data.
 * No scenario, expected answer, required tool set or family annotations enter this boundary.
 */
function createFixtureServer(data: ScenarioEvidence, retriever: RunbookRetriever): McpServer {
  const server = new McpServer({ name: 'evaluation-only-read-fixtures', version: '1.0.0' });
  const windowSchema = z.strictObject({ start: z.string(), end: z.string() });
  const result = async (read: () => unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await read()) }] }; }
    catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: {
        name: error instanceof ToolError ? 'ToolError' : error instanceof TypeError ? 'TypeError' : 'Error',
        ...(error instanceof ToolError ? { code: error.code } : {}),
        message: error instanceof Error ? error.message : String(error),
      } }) }] };
    }
  };
  const service = (name: string) => {
    validateService(name);
    if (name !== data.service.name) throw new ToolError('SERVICE_NOT_FOUND', 'Unknown service: ' + name);
    return structuredClone(data.service);
  };
  server.registerTool('get_service_info', {
    description: 'Read an isolated evaluation service snapshot.', inputSchema: z.strictObject({ service: z.string() }),
  }, args => result(() => service(args.service)));
  server.registerTool('search_logs', {
    description: 'Search isolated evaluation log fixtures.',
    inputSchema: z.strictObject({ service: z.string(), timeWindow: windowSchema,
      levels: z.array(z.enum(['info', 'warn', 'error'])).nullish(), contains: z.string().nullish() }),
  }, args => result(() => {
    const { start, end } = validateWindow(args.timeWindow);
    service(args.service);
    return structuredClone(data.logs.filter(log => log.service === args.service && Date.parse(log.timestamp) >= start && Date.parse(log.timestamp) <= end
      && (args.levels == null || args.levels.includes(log.level))
      && (args.contains == null || log.message.toLowerCase().includes(args.contains.toLowerCase())))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  }));
  server.registerTool('get_metrics', {
    description: 'Read isolated evaluation metric fixtures.',
    inputSchema: z.strictObject({ service: z.string(), timeWindow: windowSchema, metricNames: z.array(z.string()).nullish() }),
  }, args => result(() => {
    const { start, end } = validateWindow(args.timeWindow);
    service(args.service);
    if (args.metricNames?.some(name => !name.trim())) throw new ToolError('INVALID_INPUT', 'metricNames must be an array of nonempty strings');
    return structuredClone(data.metrics.filter(series => series.service === args.service
      && (args.metricNames == null || args.metricNames.includes(series.name)))
      .map(series => ({ ...series, points: series.points.filter(point => Date.parse(point.timestamp) >= start && Date.parse(point.timestamp) <= end)
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)) }))
      .filter(series => series.points.length).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }));
  server.registerTool('search_runbook', {
    description: 'Retrieve visible fixture guidance, without evaluator expectations.',
    inputSchema: z.strictObject({ query: z.string(), limit: z.number().nullish() }),
  }, args => result(() => retriever.retrieveWithFallback({ query: args.query, limit: args.limit ?? undefined })));
  return server;
}

export async function connectScenarioExecutor(input: ScenarioEvidence, source: 'accepted-fixtures' | 'evaluation-only') {
  const checked = evidenceSchema.safeParse(input);
  if (!checked.success) throw new TypeError('Malformed visible scenario evidence: ' + checked.error.message);
  const data = structuredClone(checked.data);
  const retriever = visibleRetriever(data);
  const server = source === 'accepted-fixtures' ? createIncidentOpsServer(retriever) : createFixtureServer(data, retriever);
  const client = new Client({ name: 'expanded-evaluation', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const close = async () => { try { await client.close(); } finally { await server.close(); } };
  try { await server.connect(serverTransport); await client.connect(clientTransport); }
  catch (error) { await close(); throw error; }
  return { executor: new ToolExecutor(client), close };
}
