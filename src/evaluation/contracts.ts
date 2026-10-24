import type { IncidentCase } from '../domain/incident.js';
import type { Diagnosis } from '../domain/diagnosis.js';
import type { InvestigationStatus } from '../domain/investigation.js';
import type { IncidentGroundTruth } from '../fixtures/ground-truth.js';

export const READ_TOOLS = ['search_logs', 'get_metrics', 'get_service_info', 'search_runbook'] as const;
export type ReadTool = typeof READ_TOOLS[number];

/** Evaluator-owned. Never pass this object or its expectations to the Agent/model. */
export interface EvaluationCase {
  caseId: string;
  incident: IncidentCase;
  expectations: { groundTruth: IncidentGroundTruth; requiredTools: ReadTool[] };
}

export interface EvaluationResult {
  caseId: string;
  outcome: { status: InvestigationStatus; failure?: string; rejection?: string };
  criteria: {
    completion: { status: 'PASS' | 'FAIL'; expected: 'COMPLETED'; actual: InvestigationStatus; reason: string };
    toolSelection: {
      status: 'PASS' | 'FAIL';
      /** Required-tool coverage, not exact-set matching or argument correctness. */
      expected: ReadTool[];
      actual: string[];
      missing: ReadTool[];
      logicalCalls: { callId: string; toolName: string }[];
      attempts: number;
      covered: number;
      required: number;
      reason: string;
    };
    diagnosisCorrectness: {
      status: 'NOT_EVALUATED';
      expected: string;
      actual: Diagnosis['probableCause'] | null;
      reason: string;
    };
  };
}

export interface CriterionSummary { passed: number; failed: number; notEvaluated: number; evaluated: number }
export interface EvaluationSummary {
  caseCount: number;
  criteria: Record<keyof EvaluationResult['criteria'], CriterionSummary>;
  requiredToolCoverage: { covered: number; required: number };
}

export interface BaselineReport {
  model: 'scripted deterministic model; no real LLM';
  execution: 'AgentOrchestrator -> ToolExecutor -> in-memory MCP SDK -> fixture handlers';
  scoring: { completion: string; toolSelection: string; diagnosisCorrectness: string };
  results: EvaluationResult[];
  summary: EvaluationSummary;
  limitations: string[];
}
