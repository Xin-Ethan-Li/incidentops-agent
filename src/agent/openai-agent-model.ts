import OpenAI from 'openai';
import { assertDiagnosis, DIAGNOSIS_SCHEMA } from '../domain/diagnosis.js';
import { assertModelResult, INVESTIGATION_INSTRUCTIONS, type AgentModel, type AgentModelRequest, type AgentModelResult, type AgentToolCall } from './agent-model.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';
import { associateProviderUsage, providerUsage } from '../measurement/provider-usage.js';

export class OpenAIAgentModel implements AgentModel {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_AGENT_MODEL;
    if (!apiKey?.trim()) throw new Error('OPENAI_API_KEY is required');
    if (!model?.trim()) throw new Error('OPENAI_AGENT_MODEL is required');
    this.model = model;
    this.client = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async respond(request: AgentModelRequest): Promise<AgentModelResult> {
    if (!request || (request.kind !== 'initial' && request.kind !== 'continuation')) throw new Error('Malformed model request');
    if (request.kind === 'initial' && (typeof request.prompt !== 'string' || !request.prompt.trim())) throw new Error('Missing incident prompt');
    if (request.kind === 'continuation' && (typeof request.continuation !== 'string' || !request.continuation.trim()
      || !Array.isArray(request.outputs) || request.outputs.length === 0
      || request.outputs.some(output => !output || typeof output.callId !== 'string' || !output.callId.trim() || typeof output.output !== 'string')
      || new Set(request.outputs.map(output => output.callId)).size !== request.outputs.length)) throw new Error('Malformed continuation');
    const response = await this.client.responses.create({
      model: this.model,
      instructions: INVESTIGATION_INSTRUCTIONS, // previous_response_id does not carry instructions forward.
      tools: TOOL_DEFINITIONS.map(definition => ({ type: 'function' as const, ...definition, strict: true })),
      parallel_tool_calls: false,
      text: { format: { type: 'json_schema', name: 'incident_diagnosis', schema: DIAGNOSIS_SCHEMA, strict: true } },
      ...(request.kind === 'initial'
        ? { input: request.prompt }
        : { previous_response_id: request.continuation, input: request.outputs.map(output => ({
          type: 'function_call_output' as const, call_id: output.callId, output: output.output,
        })) }),
    });
    const usage = providerUsage(response?.usage);
    try {
      if (response.status !== 'completed' || response.error) throw new Error(`OpenAI response did not complete: ${response.status}`);
      if (typeof response.id !== 'string' || !response.id.trim() || !Array.isArray(response.output)) throw new Error('Malformed OpenAI response');
      const calls: AgentToolCall[] = [];
      const texts: string[] = [];
      for (const item of response.output) {
        if (item.type === 'function_call') {
          if (item.status && item.status !== 'completed') throw new Error('Incomplete function call');
          if (typeof item.arguments !== 'string') throw new Error('Malformed function arguments');
          let args: unknown;
          try { args = JSON.parse(item.arguments); } catch { throw new Error('Malformed function arguments JSON'); }
          calls.push({ callId: item.call_id, name: item.name, arguments: args });
        } else if (item.type === 'message') {
          if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) throw new Error('Malformed assistant message');
          for (const content of item.content) {
            if (content.type !== 'output_text' || typeof content.text !== 'string') throw new Error('Unsupported or refused model response');
            texts.push(content.text);
          }
        } else if (item.type !== 'reasoning') {
          throw new Error(`Unsupported model output: ${item.type}`);
        }
      }
      let result: AgentModelResult;
      if (calls.length) {
        result = { kind: 'tool_calls', continuation: response.id, calls };
      } else {
        let diagnosis: unknown;
        try { diagnosis = JSON.parse(texts.join('\n')); } catch { throw new Error('Malformed diagnosis JSON'); }
        assertDiagnosis(diagnosis);
        result = { kind: 'final', diagnosis };
      }
      assertModelResult(result);
      associateProviderUsage(result, usage);
      return result;
    } catch (error) {
      associateProviderUsage(error, usage);
      throw error;
    }
  }
}
