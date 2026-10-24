import type { LogEntry } from '../domain/log-entry.js';
import type { MetricSeries } from '../domain/metric-series.js';
import type { ServiceInfo } from '../domain/service-info.js';
import type { RunbookDocument } from '../domain/runbook.js';
import type { EvaluationCase, EvaluationResult, EvaluationSummary, ReadTool } from './contracts.js';

export const FAMILIES = ['redis-dependency-timeout', 'downstream-provider-degradation', 'queue-consumer-backlog',
  'database-pool-exhaustion', 'deployment-configuration-regression'] as const;
export type IncidentFamily = typeof FAMILIES[number];
export const CONDITIONS = ['accepted-baseline', 'strong-signal', 'distractor', 'ambiguous', 'missing-logs', 'missing-metrics'] as const;
export type EvidenceCondition = typeof CONDITIONS[number];

/** Visible data only. This is the sole input to the evaluation-only MCP fixture server. */
export interface ScenarioEvidence {
  service: ServiceInfo;
  logs: LogEntry[];
  metrics: MetricSeries[];
  runbooks: RunbookDocument[];
}

/** Evaluator-only annotations remain outside the unchanged strict EvaluationCase contract. */
export interface DatasetScenario {
  evaluationCase: EvaluationCase;
  source: 'accepted-fixtures' | 'evaluation-only';
  family: IncidentFamily;
  evidenceCondition: EvidenceCondition;
  faultCondition: string;
  requiredToolReasons: Partial<Record<ReadTool, string>>;
  evidence: ScenarioEvidence;
}

export interface ExpandedReport {
  model: 'scripted deterministic model; no real LLM';
  execution: string;
  caseCount: number;
  coverage: {
    families: Record<string, number>;
    evidenceConditions: Record<string, number>;
    requiredToolSets: Record<string, number>;
    sources: Record<string, number>;
  };
  cases: { caseId: string; family: IncidentFamily; evidenceCondition: EvidenceCondition; faultCondition: string;
    source: DatasetScenario['source']; requiredToolReasons: DatasetScenario['requiredToolReasons'] }[];
  results: EvaluationResult[];
  summary: EvaluationSummary;
  additionalSelectedTools: { caseId: string; tools: string[] }[];
  limitations: string[];
}
