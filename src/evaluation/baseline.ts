import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { AgentOrchestrator } from '../agent/agent-orchestrator.js';
import { ToolExecutor } from '../agent/tool-executor.js';
import type { AgentModel, AgentModelRequest } from '../agent/agent-model.js';
import type { IncidentCase } from '../domain/incident.js';
import { runbooks } from '../fixtures/index.js';
import { createIncidentOpsServer } from '../mcp/server.js';
import { RunbookRetriever } from '../rag/runbook-retriever.js';
import { createEvaluationCases, toAgentIncident } from './cases.js';
import { evaluateInvestigation, summarizeEvaluation } from './evaluator.js';
import type { BaselineReport, EvaluationCase, EvaluationResult } from './contracts.js';

/** Expectations are not arguments to the model or executor; observe only their actual record. */
export async function runEvaluationCase(item: EvaluationCase, model: AgentModel, executor: ToolExecutor): Promise<EvaluationResult> {
  const incident = toAgentIncident(item);
  const agent = new AgentOrchestrator(model, executor);
  let record;
  try { record = await agent.investigate(incident); }
  catch (error) {
    record = agent.currentRecord;
    if (!record || record.status !== 'FAILED') throw error;
  }
  return evaluateInvestigation(item, record);
}

/** Harness control, not a reasoning model. Reads only the actual AgentModelRequest. */
export function createScriptedBaselineModel(observe?: (request: AgentModelRequest) => void): AgentModel {
  return { async respond(request) {
    observe?.(structuredClone(request));
    if (request.kind === 'initial') {
      const incident: IncidentCase = JSON.parse(request.prompt);
      return { kind: 'tool_calls', continuation: 'baseline-response', calls: [
        { callId: 'metadata', name: 'get_service_info', arguments: { service: incident.service } },
        { callId: 'logs', name: 'search_logs', arguments: { service: incident.service, timeWindow: incident.timeWindow } },
        { callId: 'metrics', name: 'get_metrics', arguments: { service: incident.service, timeWindow: incident.timeWindow } },
        { callId: 'runbook', name: 'search_runbook', arguments: { query: `Investigate ${incident.service}`, limit: 1 } },
      ] };
    }
    return { kind: 'final', diagnosis: {
      summary: 'Scripted evidence collection completed.',
      probableCause: 'The scripted baseline does not infer an incident cause.',
      confidence: 'low', evidence: request.outputs.map(output => `Received tool output ${output.callId}.`),
      recommendedActions: [],
    } };
  } };
}

/** JSON-compatible report, with no timestamps/UUIDs in scores and no external services. */
export async function runScriptedBaseline(observe?: (request: AgentModelRequest) => void): Promise<BaselineReport> {
  const cases = createEvaluationCases();
  const retriever = new RunbookRetriever({ async embed(texts) {
    // Deterministic vectors use visible runbook titles/tags only, never Ground Truth.
    return texts.map(text => {
      const selected = runbooks.findIndex(book => text.startsWith(`Title: ${book.title}\n`)
        || book.tags.some(tag => text === `Investigate ${tag}`));
      if (selected < 0) throw new Error('Unsupported deterministic embedding input');
      return runbooks.map((_, index) => index === selected ? 1 : 0);
    });
  } });
  const server = createIncidentOpsServer(retriever);
  const client = new Client({ name: 'deterministic-evaluation', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const results: EvaluationResult[] = [];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const executor = new ToolExecutor(client);
    for (const item of cases) results.push(await runEvaluationCase(item, createScriptedBaselineModel(observe), executor));
  } finally {
    try { await client.close(); } finally { await server.close(); }
  }
  return {
    model: 'scripted deterministic model; no real LLM',
    execution: 'AgentOrchestrator -> ToolExecutor -> in-memory MCP SDK -> fixture handlers',
    scoring: {
      completion: 'PASS iff the actual investigation status is COMPLETED, not proof of diagnosis correctness.',
      toolSelection: 'Required-tool coverage from actual records. Retries share a logical callId; distinct tool names count once. Failed attempts still show selection. Extra tools are not penalized.',
      diagnosisCorrectness: 'NOT_EVALUATED. Unrestricted expectedCause prose does not support reliable automatic semantic grading.',
    },
    results, summary: summarizeEvaluation(results),
    limitations: [
      'Five synthetic fixtures and scripted decisions validate this harness, not real LLM quality or real-world accuracy.',
      'Tool coverage does not assess arguments, returned evidence relevance, unnecessary calls, diagnosis quality or task success.',
      'Cause correctness, evidence support, recommendation quality and confidence calibration are NOT_EVALUATED; no overall accuracy is reported.',
      'Ground Truth/report expectations are evaluator-only; model requests and tools retain the existing fixture boundary. This is a data boundary, not process isolation against malicious imports.',
      'No latency/token/cost instrumentation, expanded corpus, persistence or observability. Approval remains enforced by AgentOrchestrator for the local simulated action only.',
    ],
  };
}
