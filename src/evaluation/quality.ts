import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { assertDiagnosis } from '../domain/diagnosis.js';
import { READ_TOOLS } from './contracts.js';
import { assertDatasetScenario } from './expanded-dataset.js';
import { QUALITY_DIMENSIONS, QUALITY_VERSION, type Judgment, type JudgmentStatus, type QualityDecision,
  type QualityMaterial, type QualityObservation, type QualityReview } from './quality-contracts.js';
import type { DatasetScenario } from './expanded-contracts.js';

const text = z.string().trim().min(1);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const callSchema = z.strictObject({ callId: text, name: text, arguments: z.record(z.string(), z.json()) });
const outputSchema = z.strictObject({ callId: text, output: z.string() });
const observationSchema = z.strictObject({ status: z.enum(['STARTED', 'INVESTIGATING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'REJECTED']),
  diagnosis: z.union([z.null(), z.record(z.string(), z.json())]), requests: z.array(callSchema),
  attempts: z.array(z.strictObject({ call: callSchema, status: z.enum(['SUCCEEDED', 'FAILED']), output: z.string().nullable() })),
  deliveredOutputs: z.array(outputSchema) });
const materialSchema = z.strictObject({ schemaVersion: z.literal(QUALITY_VERSION), runSource: z.enum(['SCRIPTED_BASELINE', 'SYNTHETIC_TEST']),
  caseId: text, scenario: z.unknown(), observed: observationSchema, fingerprint });
const judgmentSchema = z.strictObject({ status: z.enum(['PASS', 'FAIL', 'NOT_EVALUATED']), rationale: text.max(1000),
  references: z.array(text).refine(refs => new Set(refs).size === refs.length) });
const reviewSchema = z.strictObject({ schemaVersion: z.literal(QUALITY_VERSION), caseId: text, outcomeFingerprint: fingerprint,
  provenance: z.enum(['INDEPENDENT_HUMAN', 'SYNTHETIC_TEST']), judgments: z.strictObject({
    cause: judgmentSchema, evidence: judgmentSchema, actions: judgmentSchema, toolSelection: judgmentSchema,
  }) });

/** Canonical JSON ignores object-key order, not diagnosis/request/output/annotation differences. */
function canonical(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value));
  const sort = (node: any): any => Array.isArray(node) ? node.map(sort)
    : node !== null && typeof node === 'object' ? Object.fromEntries(Object.keys(node).sort().map(key => [key, sort(node[key])])) : node;
  return JSON.stringify(sort(normalized));
}
export function materialFingerprint(material: Omit<QualityMaterial, 'fingerprint'> | QualityMaterial): string {
  const { schemaVersion, runSource, caseId, scenario, observed } = material;
  return createHash('sha256').update(canonical({ schemaVersion, runSource, caseId, scenario, observed })).digest('hex');
}
export function createQualityMaterial(scenario: DatasetScenario, observed: QualityObservation, runSource: QualityMaterial['runSource']): QualityMaterial {
  const packet = structuredClone({ schemaVersion: QUALITY_VERSION, caseId: scenario.evaluationCase.caseId, scenario, observed, runSource });
  const material = { ...packet, fingerprint: materialFingerprint(packet) };
  assertQualityMaterial(material);
  return material;
}
export function assertQualityMaterial(value: unknown): asserts value is QualityMaterial {
  if (!materialSchema.safeParse(value).success) throw new TypeError('Malformed quality material');
  const material = value as QualityMaterial;
  assertDatasetScenario(material.scenario);
  if (material.caseId !== material.scenario.evaluationCase.caseId) throw new TypeError('Quality case identity mismatch');
  const observed = material.observed;
  if (observed.status === 'COMPLETED') assertDiagnosis(observed.diagnosis);
  else if (observed.diagnosis !== null) throw new TypeError('Non-completed material cannot contain a diagnosis');
  const requests = new Map(observed.requests.map(call => [call.callId, call]));
  if (requests.size !== observed.requests.length) throw new TypeError('Duplicate logical request identity');
  const attempts = new Map<string, { count: number; status: string; output: string | null }>();
  let previousId: string | undefined;
  for (const attempt of observed.attempts) {
    if (canonical(requests.get(attempt.call.callId) ?? null) !== canonical(attempt.call)) throw new TypeError('Attempt does not match an actual request');
    const prior = attempts.get(attempt.call.callId);
    if (prior && (prior.status !== 'FAILED' || prior.count !== 1 || previousId !== attempt.call.callId
      || !READ_TOOLS.includes(attempt.call.name as typeof READ_TOOLS[number]))) throw new TypeError('Invalid retry history');
    if ((attempt.status === 'FAILED' && attempt.output !== null) || (attempt.status === 'SUCCEEDED' && attempt.output === null)) {
      throw new TypeError('Attempt output contradicts caller outcome');
    }
    attempts.set(attempt.call.callId, { count: (prior?.count ?? 0) + 1, status: attempt.status, output: attempt.output });
    previousId = attempt.call.callId;
  }
  const delivered = new Set<string>();
  for (const output of observed.deliveredOutputs) {
    const attempt = attempts.get(output.callId);
    if (delivered.has(output.callId) || attempt?.status !== 'SUCCEEDED' || attempt.output !== output.output) {
      throw new TypeError('Delivered evidence is not a unique successful actual output');
    }
    delivered.add(output.callId);
  }
  if (observed.status === 'COMPLETED' && [...requests.keys()].some(id => attempts.get(id)?.status !== 'SUCCEEDED' || !delivered.has(id))) {
    throw new TypeError('Completed material has undelivered or failed logical executions');
  }
  if (material.fingerprint !== materialFingerprint(material)) throw new TypeError('Stale or modified quality material fingerprint');
}

/** Logical review identifiers, explicitly mapped to paths relative to a QualityMaterial packet. */
export const REVIEW_REFERENCE_PATHS = {
  'scenario.expectedCause': 'scenario.evaluationCase.expectations.groundTruth.expectedCause',
  'scenario.evidenceCondition': 'scenario.evidenceCondition',
  'scenario.requiredToolReasons': 'scenario.requiredToolReasons',
  'scenario.evidence': 'scenario.evidence',
  'diagnosis.probableCause': 'observed.diagnosis.probableCause',
  'diagnosis.confidence': 'observed.diagnosis.confidence',
  'diagnosis.evidence': 'observed.diagnosis.evidence',
  'diagnosis.recommendedActions': 'observed.diagnosis.recommendedActions',
} as const;

/** Dynamic identifiers resolve by exact callId to the entire request or delivered-output entry. */
export function resolveReviewReference(material: QualityMaterial, reference: string): unknown {
  let value: unknown;
  if (Object.hasOwn(REVIEW_REFERENCE_PATHS, reference)) {
    value = material;
    for (const key of REVIEW_REFERENCE_PATHS[reference as keyof typeof REVIEW_REFERENCE_PATHS].split('.')) {
      value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    }
  } else if (reference.startsWith('request:')) {
    value = material.observed.requests.find(call => call.callId === reference.slice('request:'.length));
  } else if (reference.startsWith('observed-output:')) {
    value = material.observed.deliveredOutputs.find(output => output.callId === reference.slice('observed-output:'.length));
  }
  if (value === undefined) throw new TypeError('Unknown or unavailable quality review reference: ' + reference);
  return structuredClone(value);
}

export function reviewReferences(material: QualityMaterial): string[] {
  return [...Object.keys(REVIEW_REFERENCE_PATHS).filter(reference => !reference.startsWith('diagnosis.') || material.observed.diagnosis !== null),
    ...material.observed.requests.map(call => 'request:' + call.callId),
    ...material.observed.deliveredOutputs.map(output => 'observed-output:' + output.callId)];
}

export function checkToolRequests(material: QualityMaterial) {
  const { requests, attempts } = material.observed, incident = material.scenario.evaluationCase.incident;
  const issues: { code: string; callId?: string; reason: string }[] = [];
  const issue = (code: string, reason: string, callId?: string) => issues.push({ code, ...(callId ? { callId } : {}), reason });
  // A failed/pending model may never have finished choosing tools. Do not relabel that as an omission.
  if (material.observed.status === 'COMPLETED') for (const name of material.scenario.evaluationCase.expectations.requiredTools) {
    if (!requests.some(call => call.name === name)) issue('MISSING_NECESSARY_TOOL', `${name}: ${material.scenario.requiredToolReasons[name]}`);
  }
  for (const call of requests) {
    const args = call.arguments as Record<string, unknown>;
    if (![...READ_TOOLS, 'restart_service'].includes(call.name)) {
      issue('UNRECOGNIZED_TOOL', 'Request is outside the accepted tool allowlist', call.callId); continue;
    }
    if (call.name !== 'search_runbook' && args.service !== incident.service) issue('WRONG_SERVICE', 'Request target differs from the scenario service', call.callId);
    if (call.name === 'search_logs' || call.name === 'get_metrics') {
      const window = args.timeWindow as { start?: unknown; end?: unknown } | null;
      const start = typeof window?.start === 'string' ? Date.parse(window.start) : NaN;
      const end = typeof window?.end === 'string' ? Date.parse(window.end) : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end
        || start < Date.parse(incident.timeWindow.start) || end > Date.parse(incident.timeWindow.end)) {
        issue('WRONG_TIME_WINDOW', 'Window must be valid and contained in the incident window; narrower windows still need review', call.callId);
      }
    }
    if (call.name === 'search_runbook') {
      if (typeof args.query !== 'string' || !args.query.trim()) issue('INVALID_QUERY', 'Query must be a nonblank string; relevance is human-reviewed', call.callId);
      if (args.limit != null && (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit <= 0)) {
        issue('INVALID_LIMIT', 'Supplied limit must be a positive safe integer; suitable size is human-reviewed', call.callId);
      }
    }
  }
  const nonterminal = ['STARTED', 'INVESTIGATING', 'AWAITING_APPROVAL'].includes(material.observed.status);
  return { status: issues.length ? 'FAIL' as const : nonterminal || (!requests.length && material.observed.status !== 'COMPLETED')
      ? 'NOT_EVALUATED' as const : 'PASS' as const, issues, omissionsAssessed: material.observed.status === 'COMPLETED',
    logicalSelections: requests.map(call => ({ callId: call.callId, toolName: call.name,
      attempts: attempts.filter(attempt => attempt.call.callId === call.callId).length })),
    actualAttempts: attempts.length,
    limitation: 'Structural/target checks only; necessary omissions are conclusive only after COMPLETED. Interrupted selection is not automatically an omission. No automatic query relevance, semantic appropriateness or exact-set penalty; PASS here is not tool correctness PASS.' };
}

const unreviewed = (): Judgment => ({ status: 'NOT_EVALUATED', rationale: 'No independent case adjudication supplied', references: [] });
const decide = (status: JudgmentStatus, origin: string, reason: string): QualityDecision => ({ status, origin, reason });
export function assessQuality(materials: QualityMaterial[], inputReviews: unknown = [], options: { allowSyntheticTests?: boolean } = {}) {
  const byCase = new Map<string, QualityMaterial>();
  for (const material of materials) {
    assertQualityMaterial(material);
    if (byCase.has(material.caseId)) throw new TypeError('Duplicate quality material case');
    byCase.set(material.caseId, material);
  }
  const parsed = z.array(reviewSchema).safeParse(inputReviews);
  if (!parsed.success) throw new TypeError('Malformed quality reviews; explicit judgments, provenance, rationale and references are required');
  const reviews = new Map<string, QualityReview>();
  for (const review of parsed.data) {
    const material = byCase.get(review.caseId);
    if (!material) throw new TypeError('Review references an unknown case');
    if (reviews.has(review.caseId)) throw new TypeError('Duplicate/conflicting review for case');
    if (review.outcomeFingerprint !== material.fingerprint) throw new TypeError('Stale review fingerprint for actual outcome/material');
    if (review.provenance === 'SYNTHETIC_TEST' && !options.allowSyntheticTests) throw new TypeError('Synthetic test assessments are not human reviews');
    if (review.provenance === 'INDEPENDENT_HUMAN' && material.runSource === 'SYNTHETIC_TEST') throw new TypeError('Test material cannot count as a human benchmark');
    const refs = new Set(reviewReferences(material));
    for (const dimension of QUALITY_DIMENSIONS) {
      const judgment = review.judgments[dimension];
      if (judgment.references.some(ref => !refs.has(ref)) || (judgment.status !== 'NOT_EVALUATED' && judgment.references.length === 0)) {
        throw new TypeError('Judgment must cite existing case-specific packet references');
      }
      if (dimension !== 'toolSelection' && !material.observed.diagnosis && judgment.status !== 'NOT_EVALUATED') throw new TypeError('No actual diagnosis to adjudicate');
      if (dimension === 'toolSelection' && !material.observed.requests.length && material.observed.status !== 'COMPLETED'
        && judgment.status !== 'NOT_EVALUATED') throw new TypeError('No observed tool selection to adjudicate');
    }
    reviews.set(review.caseId, review);
  }
  const results = materials.map(material => {
    const review = reviews.get(material.caseId);
    const judgments = review?.judgments ?? { cause: unreviewed(), evidence: unreviewed(), actions: unreviewed(), toolSelection: unreviewed() };
    const required = [judgments.cause, judgments.evidence, judgments.actions];
    const origin = review?.provenance ?? 'UNREVIEWED';
    let taskSuccess: QualityDecision;
    if (material.observed.status === 'FAILED') taskSuccess = decide('FAIL', 'EXECUTION_FAILURE', 'Workflow failed; this is not a reviewed incorrect diagnosis');
    else if (material.observed.status === 'REJECTED') taskSuccess = decide('FAIL', 'WORKFLOW_REJECTED', 'Workflow rejected without a completed investigation result');
    else if (material.observed.status !== 'COMPLETED') taskSuccess = decide('NOT_EVALUATED', 'NONTERMINAL', 'Investigation has no terminal completed diagnosis');
    else if (required.some(judgment => judgment.status === 'FAIL')) taskSuccess = decide('FAIL', origin, 'At least one adjudicated task quality dimension fails');
    else if (required.every(judgment => judgment.status === 'PASS')) taskSuccess = decide('PASS', origin, 'Completed and cause/evidence/actions all explicitly pass');
    else taskSuccess = decide('NOT_EVALUATED', origin, 'One or more required qualitative dimensions remain unreviewed');
    const checks = checkToolRequests(material);
    const toolCorrectness = checks.status === 'FAIL' ? decide('FAIL', 'AUTOMATED_REQUEST_CHECKS', 'Provable request/necessary-tool error; independent of execution success')
      : judgments.toolSelection.status === 'FAIL' ? decide('FAIL', origin, 'Explicit adjudication of an inappropriate actual selection')
      : checks.status === 'NOT_EVALUATED' ? decide('NOT_EVALUATED', 'INCOMPLETE_SELECTION_CONTEXT', 'Pending or unobserved selection cannot establish complete correctness')
      : judgments.toolSelection.status === 'NOT_EVALUATED' ? decide('NOT_EVALUATED', origin, 'Structural checks pass, but semantic/tool-need adjudication is missing')
        : decide(judgments.toolSelection.status, origin, 'Structural checks plus explicit per-case tool-selection adjudication');
    return { caseId: material.caseId, outcomeFingerprint: material.fingerprint, runSource: material.runSource,
      reviewProvenance: review?.provenance ?? 'NONE', judgments: structuredClone(judgments), taskSuccess, toolCorrectness, requestChecks: checks };
  });
  const counts = (decisions: { status: JudgmentStatus }[]) => {
    const passed = decisions.filter(item => item.status === 'PASS').length, failed = decisions.filter(item => item.status === 'FAIL').length;
    return { total: decisions.length, evaluated: passed + failed, passed, failed,
      notEvaluated: decisions.length - passed - failed, passRateAmongEvaluated: passed + failed ? passed / (passed + failed) : null };
  };
  return { schemaVersion: QUALITY_VERSION, scope: 'Separate offline synthetic-case assessment, not real LLM or autonomous-selection accuracy', results,
    summary: { caseCount: materials.length, humanReviewRecords: [...reviews.values()].filter(review => review.provenance === 'INDEPENDENT_HUMAN').length,
      syntheticTestReviewRecords: [...reviews.values()].filter(review => review.provenance === 'SYNTHETIC_TEST').length,
      submittedReviewRecords: reviews.size,
      casesWithAnyJudgment: results.filter(item => QUALITY_DIMENSIONS.some(dimension => item.judgments[dimension].status !== 'NOT_EVALUATED')).length,
      unreviewedCases: results.filter(item => QUALITY_DIMENSIONS.every(dimension => item.judgments[dimension].status === 'NOT_EVALUATED')).length,
      taskSuccess: counts(results.map(item => item.taskSuccess)),
      toolCorrectness: counts(results.map(item => item.toolCorrectness)), structuralRequestChecks: counts(results.map(item => item.requestChecks)),
      dimensions: Object.fromEntries(QUALITY_DIMENSIONS.map(dimension => [dimension, counts(results.map(item => item.judgments[dimension]))])) },
    limitations: ['Human provenance is a self-attestation, not identity verification; rationales require independent case-specific judgment.',
      'Fingerprint binds observed diagnosis, requests, outcomes, delivered evidence, run source and evaluator context. It detects staleness, not forged adjudication.',
      'Only evaluated cases form assessed pass-rate denominators; zero evaluated produces null. Tests and structural checks do not establish actual human-reviewed quality.'] };
}
