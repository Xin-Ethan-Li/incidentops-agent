import { searchLogs, getMetrics, getServiceInfo, ToolError, type SearchLogsInput, type GetMetricsInput } from '../tools/index.js';
import type { RunbookRetriever } from '../rag/runbook-retriever.js';
import type { AgentToolCall, AgentToolOutput } from './agent-model.js';

function argumentsObject(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) {
    throw new ToolError('INVALID_INPUT', 'Tool arguments must be an object with the allowed fields');
  }
  return value as Record<string, unknown>;
}

export class ToolExecutor {
  constructor(private readonly retriever: RunbookRetriever) {}

  async execute(call: AgentToolCall): Promise<AgentToolOutput> {
    if (!call || typeof call.callId !== 'string' || !call.callId.trim()) throw new Error('Missing tool callId');
    let result: unknown;
    switch (call.name) {
      case 'search_logs': {
        const args = argumentsObject(call.arguments, ['service', 'timeWindow', 'levels', 'contains'], ['service', 'timeWindow']);
        argumentsObject(args.timeWindow, ['start', 'end'], ['start', 'end']);
        // The accepted tools perform value validation; these casts do not bypass it.
        result = searchLogs({ service: args.service, timeWindow: args.timeWindow,
          levels: args.levels ?? undefined, contains: args.contains ?? undefined } as SearchLogsInput);
        break;
      }
      case 'get_metrics': {
        const args = argumentsObject(call.arguments, ['service', 'timeWindow', 'metricNames'], ['service', 'timeWindow']);
        argumentsObject(args.timeWindow, ['start', 'end'], ['start', 'end']);
        result = getMetrics({ service: args.service, timeWindow: args.timeWindow, metricNames: args.metricNames ?? undefined } as GetMetricsInput);
        break;
      }
      case 'get_service_info': {
        const args = argumentsObject(call.arguments, ['service'], ['service']);
        result = getServiceInfo({ service: args.service as string });
        break;
      }
      case 'search_runbook': {
        const args = argumentsObject(call.arguments, ['query', 'limit'], ['query']);
        const matches = await this.retriever.retrieve({ query: args.query as string, limit: (args.limit ?? undefined) as number | undefined });
        result = matches.map(({ runbook, score }) => ({
          runbook: { id: runbook.id, title: runbook.title, tags: [...runbook.tags], content: runbook.content }, score,
        }));
        break;
      }
      default: throw new Error(`Tool not allowed: ${call.name}`);
    }
    return { callId: call.callId, output: JSON.stringify(result) };
  }
}
