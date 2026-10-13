import { randomUUID } from 'node:crypto';
import type { InvestigationRecord } from '../domain/investigation.js';
import type { IncidentCase } from '../domain/incident.js';
import { assertModelResult, type AgentModel, type AgentModelRequest, type AgentToolOutput } from './agent-model.js';
import type { ToolExecutor } from './tool-executor.js';
import { withTimeout } from './with-timeout.js';
import { classifyToolFailure, MAX_TOOL_RETRIES, TOOL_RETRY_BACKOFF_MS } from './tool-retry-policy.js';

export class AgentOrchestrator {
  #currentRecord?: InvestigationRecord;

  /** Detached snapshot of the most recently started run, including its terminal state.
   * Overlapping runs retain independent local records; this getter follows the latest start.
   */
  get currentRecord(): InvestigationRecord | undefined {
    return this.#currentRecord && structuredClone(this.#currentRecord);
  }

  constructor(
    private readonly model: AgentModel,
    private readonly executor: ToolExecutor,
    private readonly maxTurns = 8,
    private readonly maxToolCalls = 8,
    private readonly modelTimeoutMs = 30_000,
    private readonly toolTimeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) throw new TypeError('maxTurns must be a positive safe integer');
    if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) throw new TypeError('maxToolCalls must be a positive safe integer');
    for (const [name, value] of [['modelTimeoutMs', modelTimeoutMs], ['toolTimeoutMs', toolTimeoutMs]] as const) {
      // Node clamps overflowing timer delays to 1ms; reject them rather than shorten the deadline.
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new TypeError(`${name} must be a positive safe integer no greater than 2147483647`);
      }
    }
  }

  async investigate(incident: IncidentCase): Promise<InvestigationRecord> {
    const record: InvestigationRecord = {
      investigationId: randomUUID(), incidentId: incident.id, status: 'STARTED', toolExecutions: [],
    };
    this.#currentRecord = record;
    try {
      let request: AgentModelRequest = { kind: 'initial', prompt: JSON.stringify({
        id: incident.id, title: incident.title, service: incident.service, description: incident.description,
        timeWindow: { start: incident.timeWindow.start, end: incident.timeWindow.end },
      }) };
      const usedCallIds = new Set<string>();
      let toolAttempts = 0; // Per investigation: one executor invocation consumes one of the default eight slots.
      for (let turn = 0; turn < this.maxTurns; turn++) {
        const response = await withTimeout(
          () => this.model.respond(request), this.modelTimeoutMs,
          `Agent model response timed out after ${this.modelTimeoutMs}ms`,
        );
        assertModelResult(response);
        if (response.kind === 'final') {
          // Copy model-owned arrays before retaining the validated result.
          record.diagnosis = structuredClone(response.diagnosis);
          const completed = structuredClone(record);
          completed.status = 'COMPLETED';
          record.status = 'COMPLETED';
          return completed;
        }
        if (turn + 1 === this.maxTurns) break; // Do not execute tools whose results cannot be consumed.
        for (const call of response.calls) {
          if (usedCallIds.has(call.callId)) throw new Error('Reused tool callId');
          usedCallIds.add(call.callId);
        }
        const outputs: AgentToolOutput[] = [];
        for (const call of response.calls) {
          const execution = { callId: call.callId, toolName: call.name };
          for (let attempt = 0; attempt <= MAX_TOOL_RETRIES; attempt++) {
            if (toolAttempts >= this.maxToolCalls) throw new Error(`Agent tool-call budget exhausted (${this.maxToolCalls})`);
            toolAttempts++; // Every actual attempt, including a retry, consumes one slot.
            record.status = 'INVESTIGATING';
            try {
              outputs.push(await withTimeout(
                () => this.executor.execute(call), this.toolTimeoutMs,
                `Agent tool execution timed out after ${this.toolTimeoutMs}ms`,
              ));
            } catch (error) {
              record.toolExecutions.push({ ...execution, status: 'FAILED' });
              if (attempt === MAX_TOOL_RETRIES || toolAttempts >= this.maxToolCalls
                || classifyToolFailure(call.name, error) !== 'RETRYABLE') throw error;
              // The timed-out read may still be running; only the explicit read set can retry.
              await new Promise<void>(resolve => setTimeout(resolve, TOOL_RETRY_BACKOFF_MS));
              continue;
            }
            record.toolExecutions.push({ ...execution, status: 'SUCCEEDED' });
            break;
          }
        }
        request = { kind: 'continuation', continuation: response.continuation, outputs };
      }
      throw new Error(`Agent model turn limit reached (${this.maxTurns})`);
    } catch (error) {
      record.status = 'FAILED';
      delete record.diagnosis;
      record.failure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}
