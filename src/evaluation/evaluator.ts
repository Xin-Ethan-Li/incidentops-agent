import { z } from 'zod/v4';
import { assertDiagnosis } from '../domain/diagnosis.js';
import type { InvestigationRecord } from '../domain/investigation.js';
import { assertEvaluationCase } from './cases.js';
import { READ_TOOLS, type EvaluationCase, type EvaluationResult, type EvaluationSummary } from './contracts.js';

const nonblank = z.string().refine(value => value.trim().length > 0);
const recordSchema = z.strictObject({
  investigationId: nonblank, incidentId: nonblank,
  status: z.enum(['STARTED', 'INVESTIGATING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'REJECTED']),
  toolExecutions: z.array(z.strictObject({ callId: nonblank, toolName: nonblank, status: z.enum(['SUCCEEDED', 'FAILED']) })),
  diagnosis: z.unknown().optional(), failure: nonblank.optional(), rejection: nonblank.optional(),
  pendingApproval: z.strictObject({ investigationId: nonblank, approvalId: nonblank, callId: nonblank,
    toolName: z.literal('restart_service'), arguments: z.record(z.string(), z.unknown()) }).optional(),
});

/** Observes accepted records; does not influence Agent tool decisions or policy. */
export function evaluateInvestigation(item: EvaluationCase, record: InvestigationRecord): EvaluationResult {
  assertEvaluationCase(item);
  const parsed = recordSchema.safeParse(record);
  if (!parsed.success) throw new TypeError('Malformed evaluation record: ' + parsed.error.message);
  if (record.incidentId !== item.incident.id) throw new TypeError('Evaluation record incidentId does not match case');
  if (record.status === 'COMPLETED') {
    assertDiagnosis(record.diagnosis);
    if (record.failure || record.rejection || record.pendingApproval) throw new TypeError('Contradictory completed evaluation record');
  } else if (record.diagnosis !== undefined) throw new TypeError('Non-completed evaluation record cannot contain a diagnosis');
  if (record.status === 'FAILED' && !record.failure) throw new TypeError('Failed evaluation record requires a failure reason');
  if (record.status === 'REJECTED' && !record.rejection) throw new TypeError('Rejected evaluation record requires a rejection reason');
  if ((record.status === 'AWAITING_APPROVAL') !== (record.pendingApproval !== undefined)) {
    throw new TypeError('Evaluation record approval state mismatch');
  }

  const logicalCalls: { callId: string; toolName: string }[] = [];
  const seen = new Map<string, { toolName: string; attempts: number; status: string }>();
  for (const attempt of record.toolExecutions) {
    const previous = seen.get(attempt.callId);
    if (previous) {
      if (previous.toolName !== attempt.toolName || previous.status !== 'FAILED' || previous.attempts !== 1
        || !READ_TOOLS.includes(attempt.toolName as typeof READ_TOOLS[number])
        || logicalCalls.at(-1)?.callId !== attempt.callId) {
        throw new TypeError('Inconsistent logical tool history in evaluation record');
      }
      previous.attempts++;
      previous.status = attempt.status;
    } else {
      logicalCalls.push({ callId: attempt.callId, toolName: attempt.toolName });
      seen.set(attempt.callId, { toolName: attempt.toolName, attempts: 1, status: attempt.status });
    }
  }
  if (record.status === 'COMPLETED' && [...seen.values()].some(call => call.status !== 'SUCCEEDED')) {
    throw new TypeError('Completed evaluation record contains an unsuccessful logical call');
  }
  const actual = [...new Set(logicalCalls.map(call => call.toolName))].sort();
  const expected = [...item.expectations.requiredTools].sort();
  const missing = expected.filter(name => !actual.includes(name));
  const completed = record.status === 'COMPLETED';
  return {
    caseId: item.caseId,
    outcome: { status: record.status, ...(record.failure ? { failure: record.failure } : {}),
      ...(record.rejection ? { rejection: record.rejection } : {}) },
    criteria: {
      completion: { status: completed ? 'PASS' : 'FAIL', expected: 'COMPLETED', actual: record.status,
        reason: completed ? 'Workflow completed; this does not establish diagnosis correctness.'
          : `Workflow is ${record.status}: ${record.failure ?? record.rejection ?? 'not completed'}` },
      toolSelection: { status: missing.length ? 'FAIL' : 'PASS', expected, actual, missing, logicalCalls,
        attempts: record.toolExecutions.length, covered: expected.length - missing.length, required: expected.length,
        reason: missing.length ? 'Missing required tools: ' + missing.join(', ')
          : 'All required tools were selected. Extra tools are not penalized; tool success/arguments are not scored.' },
      diagnosisCorrectness: { status: 'NOT_EVALUATED', expected: item.expectations.groundTruth.expectedCause,
        actual: record.diagnosis?.probableCause ?? null,
        reason: 'Ground truth is unrestricted prose, not a semantic correctness oracle. Cause correctness, evidence support, action quality and confidence calibration are not assessed.' },
    },
  };
}

export function summarizeEvaluation(results: EvaluationResult[]): EvaluationSummary {
  if (!Array.isArray(results)) throw new TypeError('Evaluation results must be an array');
  const empty = () => ({ passed: 0, failed: 0, notEvaluated: 0, evaluated: 0 });
  const summary: EvaluationSummary = { caseCount: results.length,
    criteria: { completion: empty(), toolSelection: empty(), diagnosisCorrectness: empty() },
    requiredToolCoverage: { covered: 0, required: 0 } };
  const ids = new Set<string>();
  for (const result of results) {
    if (!result || typeof result.caseId !== 'string' || !result.caseId.trim() || ids.has(result.caseId)) {
      throw new TypeError('Malformed or duplicate evaluation result caseId');
    }
    ids.add(result.caseId);
    if (result.criteria?.completion?.actual !== result.outcome?.status
      || (result.criteria?.completion?.status === 'PASS') !== (result.outcome?.status === 'COMPLETED')) {
      throw new TypeError('Inconsistent evaluation completion result');
    }
    for (const key of ['completion', 'toolSelection', 'diagnosisCorrectness'] as const) {
      const status = result.criteria?.[key]?.status;
      if (key === 'diagnosisCorrectness' ? status !== 'NOT_EVALUATED' : status !== 'PASS' && status !== 'FAIL') {
        throw new TypeError('Unsupported evaluation criterion status: ' + key);
      }
      const counts = summary.criteria[key];
      if (status === 'NOT_EVALUATED') counts.notEvaluated++;
      else { counts.evaluated++; if (status === 'PASS') counts.passed++; else counts.failed++; }
    }
    const { covered, required, expected, actual, missing } = result.criteria.toolSelection;
    if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(required) || covered < 0 || required <= 0 || covered > required
      || (result.criteria.toolSelection.status === 'PASS') !== (covered === required)
      || !Array.isArray(expected) || !Array.isArray(actual) || !Array.isArray(missing)
      || expected.length !== required || new Set(expected).size !== required
      || expected.some(name => !READ_TOOLS.includes(name))
      || expected.filter(name => actual.includes(name)).length !== covered
      || missing.length !== required - covered || new Set(missing).size !== missing.length
      || missing.some(name => !expected.includes(name) || actual.includes(name))) {
      throw new TypeError('Invalid tool-selection coverage counts');
    }
    summary.requiredToolCoverage.covered += covered;
    summary.requiredToolCoverage.required += required;
  }
  return summary;
}
