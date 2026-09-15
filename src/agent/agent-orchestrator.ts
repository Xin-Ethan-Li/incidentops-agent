import { randomUUID } from 'node:crypto';
import type { InvestigationRecord } from '../domain/investigation.js';
import type { IncidentCase } from '../domain/incident.js';
import { assertModelResult, type AgentModel, type AgentModelRequest, type AgentToolOutput } from './agent-model.js';
import type { ToolExecutor } from './tool-executor.js';

export class AgentOrchestrator {
  #currentRecord?: InvestigationRecord;

  /** Detached snapshot of the most recently started run, including its terminal state.
   * Overlapping runs retain independent local records; this getter follows the latest start.
   */
  get currentRecord(): InvestigationRecord | undefined {
    return this.#currentRecord && structuredClone(this.#currentRecord);
  }

  constructor(private readonly model: AgentModel, private readonly executor: ToolExecutor, private readonly maxTurns = 8) {
    if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) throw new TypeError('maxTurns must be a positive safe integer');
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
      for (let turn = 0; turn < this.maxTurns; turn++) {
        const response = await this.model.respond(request);
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
          record.status = 'INVESTIGATING';
          const execution = { callId: call.callId, toolName: call.name };
          try {
            outputs.push(await this.executor.execute(call));
          } catch (error) {
            record.toolExecutions.push({ ...execution, status: 'FAILED' });
            throw error;
          }
          record.toolExecutions.push({ ...execution, status: 'SUCCEEDED' });
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
