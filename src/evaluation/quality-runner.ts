import { AgentOrchestrator } from '../agent/agent-orchestrator.js';
import type { AgentModel, AgentToolCall, AgentToolOutput } from '../agent/agent-model.js';
import type { ToolExecutor } from '../agent/tool-executor.js';
import { createScriptedBaselineModel } from './baseline.js';
import { toAgentIncident } from './cases.js';
import { assertDatasetScenario, createExpandedDataset } from './expanded-dataset.js';
import { connectScenarioExecutor } from './fixture-mcp.js';
import type { DatasetScenario } from './expanded-contracts.js';
import { assertQualityMaterial, createQualityMaterial, materialFingerprint } from './quality.js';
import type { QualityMaterial, QualityObservation } from './quality-contracts.js';

/** Evaluation-only observation of a caller-owned executor instance; never a production record field. */
export async function observeQualityCase(scenario: DatasetScenario, model: AgentModel, executor: ToolExecutor, runSource: QualityMaterial['runSource']) {
  assertDatasetScenario(scenario);
  const requests: AgentToolCall[] = [], deliveredOutputs: AgentToolOutput[] = [];
  const captured: { call: AgentToolCall; output: string | null }[] = [];
  const execute = executor.execute;
  executor.execute = async call => {
    const attempt = { call: structuredClone(call), output: null as string | null };
    captured.push(attempt);
    const result = await execute.call(executor, call);
    attempt.output = result.output;
    return result;
  };
  const observedModel: AgentModel = { async respond(request) {
    if (request.kind === 'continuation') deliveredOutputs.push(...structuredClone(request.outputs));
    const result = await model.respond(request);
    if (result.kind === 'tool_calls') requests.push(...structuredClone(result.calls));
    return result;
  } };
  const agent = new AgentOrchestrator(observedModel, executor);
  try {
    let record;
    try { record = await agent.investigate(toAgentIncident(scenario.evaluationCase)); }
    catch (error) { record = agent.currentRecord; if (!record || record.status !== 'FAILED') throw error; }
    const observed: QualityObservation = { status: record.status, diagnosis: record.diagnosis ?? null, requests,
      attempts: captured.map((attempt, index) => {
        const execution = record.toolExecutions[index];
        if (!execution || execution.callId !== attempt.call.callId || execution.toolName !== attempt.call.name) throw new TypeError('Quality observation/history mismatch');
        return { call: attempt.call, status: execution.status, output: execution.status === 'SUCCEEDED' ? attempt.output : null };
      }), deliveredOutputs };
    // Snapshot terminal caller history: later underlying work cannot add evidence to this packet.
    return createQualityMaterial(scenario, observed, runSource);
  } finally { executor.execute = execute; }
}

export async function generateQualityMaterials(): Promise<QualityMaterial[]> {
  const materials: QualityMaterial[] = [];
  for (const scenario of createExpandedDataset()) {
    // Only detached visible evidence enters MCP; only visible incident fields enter the Agent.
    const connection = await connectScenarioExecutor(scenario.evidence, scenario.source);
    try { materials.push(await observeQualityCase(scenario, createScriptedBaselineModel(), connection.executor, 'SCRIPTED_BASELINE')); }
    finally { await connection.close(); }
  }
  return materials;
}

/** Replay only the existing 30 current scenarios, with intact fingerprints and no invented data. */
export function validateQualityDataset(value: unknown): asserts value is QualityMaterial[] {
  if (!Array.isArray(value) || value.length !== 30) throw new TypeError('Quality review requires the existing 30 cases');
  const current = new Map(createExpandedDataset().map(scenario => [scenario.evaluationCase.caseId, scenario]));
  const seen = new Set<string>();
  for (const material of value) {
    assertQualityMaterial(material);
    const expected = current.get(material.caseId);
    if (seen.has(material.caseId) || !expected || materialFingerprint({ ...material, scenario: expected }) !== material.fingerprint) {
      throw new TypeError('Quality case is duplicate, stale or outside the current dataset');
    }
    seen.add(material.caseId);
  }
}
