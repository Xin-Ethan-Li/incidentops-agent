import type { Diagnosis } from '../domain/diagnosis.js';
import type { IncidentCase } from '../domain/incident.js';
import { assertModelResult, type AgentModel, type AgentModelRequest, type AgentToolOutput } from './agent-model.js';
import type { ToolExecutor } from './tool-executor.js';

export class AgentOrchestrator {
  constructor(private readonly model: AgentModel, private readonly executor: ToolExecutor, private readonly maxTurns = 8) {
    if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) throw new TypeError('maxTurns must be a positive safe integer');
  }

  async investigate(incident: IncidentCase): Promise<Diagnosis> {
    let request: AgentModelRequest = { kind: 'initial', prompt: JSON.stringify({
      id: incident.id, title: incident.title, service: incident.service, description: incident.description,
      timeWindow: { start: incident.timeWindow.start, end: incident.timeWindow.end },
    }) };
    const usedCallIds = new Set<string>();
    for (let turn = 0; turn < this.maxTurns; turn++) {
      const response = await this.model.respond(request);
      assertModelResult(response);
      if (response.kind === 'final') return response.diagnosis;
      if (turn + 1 === this.maxTurns) break; // Do not execute tools whose results cannot be consumed.
      for (const call of response.calls) {
        if (usedCallIds.has(call.callId)) throw new Error('Reused tool callId');
        usedCallIds.add(call.callId);
      }
      const outputs: AgentToolOutput[] = [];
      for (const call of response.calls) outputs.push(await this.executor.execute(call));
      request = { kind: 'continuation', continuation: response.continuation, outputs };
    }
    throw new Error(`Agent model turn limit reached (${this.maxTurns})`);
  }
}
