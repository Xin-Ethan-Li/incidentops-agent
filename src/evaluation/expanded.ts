import type { AgentModelRequest } from '../agent/agent-model.js';
import { createScriptedBaselineModel, runEvaluationCase } from './baseline.js';
import { summarizeEvaluation } from './evaluator.js';
import { createExpandedDataset, validateExpandedDataset } from './expanded-dataset.js';
import { connectScenarioExecutor } from './fixture-mcp.js';
import type { DatasetScenario, ExpandedReport } from './expanded-contracts.js';

export function datasetCoverage(dataset: DatasetScenario[]): ExpandedReport['coverage'] {
  validateExpandedDataset(dataset);
  const count = (keys: string[]) => Object.fromEntries([...new Set(keys)].sort().map(key => [key, keys.filter(value => value === key).length]));
  return { families: count(dataset.map(scenario => scenario.family)),
    evidenceConditions: count(dataset.map(scenario => scenario.evidenceCondition)),
    requiredToolSets: count(dataset.map(scenario => [...scenario.evaluationCase.expectations.requiredTools].sort().join(' + '))),
    sources: count(dataset.map(scenario => scenario.source)) };
}

export async function runExpandedEvaluation(observe?: (request: AgentModelRequest) => void): Promise<ExpandedReport> {
  const dataset = createExpandedDataset();
  const results: ExpandedReport['results'] = [];
  for (const scenario of dataset) {
    // Two distinct inputs: visible snapshot for tools, visible incident for Agent.
    const connection = await connectScenarioExecutor(scenario.evidence, scenario.source);
    try {
      results.push(await runEvaluationCase(scenario.evaluationCase, createScriptedBaselineModel(observe), connection.executor));
    } finally { await connection.close(); }
  }
  return { model: 'scripted deterministic model; no real LLM',
    execution: 'Unchanged AgentOrchestrator/ToolExecutor/scorer; in-memory MCP SDK. Five accepted cases use production fixture handlers; 25 new cases use evaluation-only read fixtures.',
    caseCount: dataset.length, coverage: datasetCoverage(dataset),
    cases: dataset.map(scenario => ({ caseId: scenario.evaluationCase.caseId, family: scenario.family,
      evidenceCondition: scenario.evidenceCondition, faultCondition: scenario.faultCondition,
      source: scenario.source, requiredToolReasons: scenario.requiredToolReasons })),
    results, summary: summarizeEvaluation(results),
    additionalSelectedTools: results.map(result => ({ caseId: result.caseId,
      tools: result.criteria.toolSelection.actual.filter(tool => !result.criteria.toolSelection.expected.some(expected => expected === tool)) })),
    limitations: [
      'Thirty authored synthetic scenarios measure dataset coverage and scripted harness behavior, not real LLM quality or diagnosis accuracy.',
      'The same accepted script always requests all four read tools using only visible incident input. Passing required-tool coverage does not establish autonomous tool choice.',
      'Required sets are explicit minimum collection rubrics with per-case justifications, not universal optimal tool combinations. Other tools are allowed; additionalSelectedTools is descriptive, not an accuracy metric.',
      'Retries retain the accepted logical-selection semantics; argument quality, evidence interpretation and unnecessary-call penalties are not scored.',
      'Cause correctness, evidence support, recommendation quality and confidence calibration remain NOT_EVALUATED; completion is not task success.',
      'Only the original five cases use accepted production business handlers. New data runs through separate evaluation-only read fixtures with the same MCP input shapes; it does not validate production handlers on new fixtures.',
      'Runbooks and deterministic embedding vectors supply guidance, not a diagnosis oracle. Uncertain cases deliberately lack a unique proven cause.',
      'Each new snapshot has its own MCP server; equal service names/time windows do not merge evidence across scenarios. No shared accepted fixture mutation occurs.',
      'No external APIs, network, persistence, new dependencies, Agent policy changes, tracing or latency/token instrumentation. Approval remains application-enforced for the local simulator only.',
    ] };
}
