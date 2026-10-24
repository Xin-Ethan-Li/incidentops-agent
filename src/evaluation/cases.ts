import { z } from 'zod/v4';
import { incidents } from '../fixtures/index.js';
import { groundTruth } from '../fixtures/ground-truth.js';
import { READ_TOOLS, type EvaluationCase, type ReadTool } from './contracts.js';

const nonblank = z.string().refine(value => value.trim().length > 0);
const uniqueStrings = z.array(nonblank).refine(values => new Set(values).size === values.length);
const caseSchema = z.strictObject({
  caseId: nonblank,
  // Strict at both levels: accidental evaluator-only fields are rejected, not serialized.
  incident: z.strictObject({ id: nonblank, title: nonblank, service: nonblank, description: nonblank,
    timeWindow: z.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() }) }),
  expectations: z.strictObject({
    groundTruth: z.strictObject({ incidentId: nonblank, expectedCause: nonblank,
      relevantLogIds: uniqueStrings, relevantMetricNames: uniqueStrings, relevantRunbookIds: uniqueStrings }),
    requiredTools: z.array(z.enum(READ_TOOLS)).min(1).refine(values => new Set(values).size === values.length),
  }),
});

export function assertEvaluationCase(value: unknown): asserts value is EvaluationCase {
  const checked = caseSchema.safeParse(value);
  if (!checked.success) throw new TypeError('Malformed evaluation case: ' + checked.error.message);
  const { incident, expectations } = checked.data;
  if (incident.id !== expectations.groundTruth.incidentId
    || Date.parse(incident.timeWindow.start) > Date.parse(incident.timeWindow.end)) {
    throw new TypeError('Malformed evaluation case: incident/ground-truth ID mismatch or reversed time window');
  }
}

/** Fresh evaluator-only snapshots; the accepted fixture index still excludes answers. */
export function createEvaluationCases(): EvaluationCase[] {
  const cases = incidents.map(incident => {
    const matches = groundTruth.filter(answer => answer.incidentId === incident.id);
    if (matches.length !== 1) throw new TypeError('Expected one ground-truth entry for ' + incident.id);
    const answer = matches[0];
    // Metadata is required context; other tools correspond to the existing relevant evidence lists.
    const requiredTools: ReadTool[] = ['get_service_info'];
    if (answer.relevantLogIds.length) requiredTools.push('search_logs');
    if (answer.relevantMetricNames.length) requiredTools.push('get_metrics');
    if (answer.relevantRunbookIds.length) requiredTools.push('search_runbook');
    const item: EvaluationCase = structuredClone({ caseId: incident.id, incident,
      expectations: { groundTruth: answer, requiredTools } });
    assertEvaluationCase(item);
    return item;
  });
  if (new Set(cases.map(item => item.caseId)).size !== cases.length) throw new TypeError('Duplicate evaluation caseId');
  return cases;
}

/** The only evaluation-to-Agent input boundary: a detached, visible-field-only incident. */
export function toAgentIncident(item: EvaluationCase) {
  assertEvaluationCase(item);
  const { id, title, service, description, timeWindow } = item.incident;
  return { id, title, service, description, timeWindow: { start: timeWindow.start, end: timeWindow.end } };
}
