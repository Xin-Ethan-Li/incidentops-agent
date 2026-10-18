import { ToolError } from '../tools/tool-error.js';
import type { AgentToolCall, AgentToolOutput } from './agent-model.js';

export interface McpToolCaller {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

/** Local result-shape validation failure; retains the existing Error messages. */
export class MalformedMcpResultError extends Error {}

function argumentsObject(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) {
    throw new ToolError('INVALID_INPUT', 'Tool arguments must be an object with the allowed fields');
  }
  return value as Record<string, unknown>;
}


export class ToolExecutor {
  constructor(private readonly client: McpToolCaller) {}

  async execute(call: AgentToolCall): Promise<AgentToolOutput> {
    if (!call || typeof call.callId !== 'string' || !call.callId.trim()) throw new Error('Missing tool callId');
    let args: Record<string, unknown>;
    switch (call.name) {
      case 'search_logs':
        args = argumentsObject(call.arguments, ['service', 'timeWindow', 'levels', 'contains'], ['service', 'timeWindow']);
        argumentsObject(args.timeWindow, ['start', 'end'], ['start', 'end']);
        break;
      case 'get_metrics':
        args = argumentsObject(call.arguments, ['service', 'timeWindow', 'metricNames'], ['service', 'timeWindow']);
        if (args.metricNames != null && (!Array.isArray(args.metricNames)
          || !Array.from(args.metricNames).every(name => typeof name === 'string' && name.trim().length > 0))) {
          throw new ToolError('INVALID_INPUT', 'metricNames must be an array of nonempty strings');
        }
        argumentsObject(args.timeWindow, ['start', 'end'], ['start', 'end']);
        break;
      case 'get_service_info':
      case 'restart_service':
        args = argumentsObject(call.arguments, ['service'], ['service']); break;
      case 'search_runbook':
        args = argumentsObject(call.arguments, ['query', 'limit'], ['query']);
        // Preserve Week 1 semantic errors before MCP schema validation runs.
        if (typeof args.query !== 'string' || !args.query.trim()) throw new TypeError('query must be nonempty');
        if (args.limit != null && (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit <= 0)) {
          throw new TypeError('limit must be a positive safe integer');
        }
        break;
      default: throw new Error('Tool not allowed: ' + call.name);
    }
    const result = await this.client.callTool({ name: call.name, arguments: args });
    if (!result || typeof result !== 'object') throw new MalformedMcpResultError('Malformed MCP result');
    const value = result as { isError?: unknown; content?: unknown };
    if (value.isError !== undefined && typeof value.isError !== 'boolean') throw new MalformedMcpResultError('Malformed MCP result');
    if (!Array.isArray(value.content) || value.content.length !== 1
      || value.content[0]?.type !== 'text' || typeof value.content[0].text !== 'string') {
      throw new MalformedMcpResultError('Malformed MCP result: expected one JSON text block');
    }
    const output: string = value.content[0].text;
    if (value.isError) {
      let error;
      try { error = JSON.parse(output).error; } catch { /* SDK input validation may use plain text. */ }
      if (error && typeof error.message === 'string') {
        if (error.name === 'ToolError' && ['INVALID_INPUT', 'SERVICE_NOT_FOUND'].includes(error.code)) {
          throw new ToolError(error.code, error.message);
        }
        if (error.name === 'TypeError') throw new TypeError(error.message);
        throw new Error(error.message);
      }
      throw new Error('MCP tool execution failed: ' + output);
    }
    try { JSON.parse(output); } catch { throw new MalformedMcpResultError('Malformed MCP result: invalid JSON'); }
    return { callId: call.callId, output };
  }
}
