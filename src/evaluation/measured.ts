import { AgentOrchestrator } from '../agent/agent-orchestrator.js';
import { InvestigationMeasurements } from '../measurement/collector.js';
import { summarizeMeasurements } from '../measurement/report.js';
import { createScriptedBaselineModel } from './baseline.js';
import { toAgentIncident } from './cases.js';
import { evaluateInvestigation, summarizeEvaluation } from './evaluator.js';
import { createExpandedDataset } from './expanded-dataset.js';
import { connectScenarioExecutor } from './fixture-mcp.js';
import type { EvaluationResult } from './contracts.js';

/** Separate optional path: accepted evaluation runners and scoring stay unchanged. */
export async function runMeasuredEvaluation() {
  const collector = new InvestigationMeasurements();
  const results: EvaluationResult[] = [];
  for (const scenario of createExpandedDataset()) {
    const connection = await connectScenarioExecutor(scenario.evidence, scenario.source);
    const agent = new AgentOrchestrator(createScriptedBaselineModel(), connection.executor, 8, 8, 30_000, 30_000, collector);
    try {
      let record;
      try { record = await agent.investigate(toAgentIncident(scenario.evaluationCase)); }
      catch (error) { record = agent.currentRecord; if (!record || record.status !== 'FAILED') throw error; }
      results.push(evaluateInvestigation(scenario.evaluationCase, record));
    } finally { await connection.close(); }
  }
  const measurements = collector.getAll();
  return { model: 'scripted deterministic model; no real LLM', caseCount: results.length,
    scoring: summarizeEvaluation(results), results, measurements, measurementSummary: summarizeMeasurements(measurements),
    limitations: [
      'Durations are local scripted harness caller waits, not production performance, real LLM latency or reproducible timing constants.',
      'Investigation elapsed includes retry backoff and approval suspension until terminal return/rethrow. It is not active execution time. Pending approval is nonterminal.',
      'MCP connection setup/cleanup and report construction occur outside investigation timing. Model/tool observations measure the bounded caller wait, including local scheduling and adaptation overhead.',
      'A TIMEOUT records the bounded caller wait; underlying work may continue and late usage/results do not revise the record.',
      'Provider usage refers only to observed OpenAI Responses metadata. Scripted usage is NOT_AVAILABLE, not zero. Partial subtotals are never complete totals; embedding tokens, pricing and billing reconciliation are not measured.',
      'The five accepted cases retain production fixture handlers; the other 25 use evaluation-only handlers. Completion/coverage still do not establish diagnosis correctness or autonomous tool choice.',
      'No external requests, new dependencies, persistence, tracing or execution-policy changes.',
    ] };
}
