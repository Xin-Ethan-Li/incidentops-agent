import { z } from 'zod/v4';
import { logs, metrics, services, runbooks } from '../fixtures/index.js';
import { assertEvaluationCase, createEvaluationCases } from './cases.js';
import { READ_TOOLS, type EvaluationCase, type ReadTool } from './contracts.js';
import { CONDITIONS, FAMILIES, type DatasetScenario, type ScenarioEvidence, type EvidenceCondition } from './expanded-contracts.js';
import { expansionSeeds } from './expansion-seeds.js';
import { evidenceSchema } from './visible-evidence.js';

const nonblank = z.string().refine(value => value.trim().length > 0);
const scenarioSchema = z.strictObject({
  evaluationCase: z.unknown(), source: z.enum(['accepted-fixtures', 'evaluation-only']),
  family: z.enum(FAMILIES), evidenceCondition: z.enum(CONDITIONS), faultCondition: nonblank,
  requiredToolReasons: z.partialRecord(z.enum(READ_TOOLS), nonblank), evidence: evidenceSchema,
});
const sets: Record<EvidenceCondition, ReadTool[]> = {
  'accepted-baseline': [...READ_TOOLS],
  'strong-signal': ['search_logs', 'get_metrics'],
  distractor: ['search_logs', 'get_metrics', 'get_service_info'],
  ambiguous: ['search_logs', 'get_metrics', 'search_runbook'],
  'missing-logs': ['get_metrics', 'get_service_info', 'search_runbook'],
  'missing-metrics': ['search_logs', 'search_runbook'],
};
const reasons: Record<ReadTool, string> = {
  search_logs: 'Read event-level failure details and distinguish relevant messages from incidental observations.',
  get_metrics: 'Inspect quantitative impact and correlated signals, without inferring cause from correlation alone.',
  get_service_info: 'Locate dependency/deployment context needed by this scenario rubric.',
  search_runbook: 'Inspect available guidance and the evidence still needed before proposing an operational change.',
};

function acceptedEvidence(item: EvaluationCase): ScenarioEvidence {
  const inWindow = (time: string) => Date.parse(time) >= Date.parse(item.incident.timeWindow.start)
    && Date.parse(time) <= Date.parse(item.incident.timeWindow.end);
  return structuredClone({ service: services.find(service => service.name === item.incident.service)!,
    logs: logs.filter(log => log.service === item.incident.service && inWindow(log.timestamp)),
    metrics: metrics.filter(series => series.service === item.incident.service).map(series => ({ ...series,
      points: series.points.filter(point => inWindow(point.timestamp)) })).filter(series => series.points.length), runbooks });
}

export function assertDatasetScenario(value: unknown): asserts value is DatasetScenario {
  const parsed = scenarioSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('Malformed dataset scenario: ' + parsed.error.message);
  const scenario = value as DatasetScenario;
  const { evaluationCase: item, evidence } = scenario;
  assertEvaluationCase(item);
  const familyIndex = FAMILIES.indexOf(scenario.family);
  const original = createEvaluationCases()[familyIndex];
  if (item.incident.service !== original.incident.service || evidence.service.name !== item.incident.service) {
    throw new TypeError('Scenario family/service mismatch');
  }
  if (scenario.source === 'accepted-fixtures' && (scenario.evidenceCondition !== 'accepted-baseline'
    || JSON.stringify(item) !== JSON.stringify(original) || JSON.stringify(evidence) !== JSON.stringify(acceptedEvidence(original)))) {
    throw new TypeError('Accepted baseline scenario must remain unchanged');
  }
  if (scenario.source === 'evaluation-only' && (scenario.evidenceCondition === 'accepted-baseline'
    || !item.caseId.startsWith('EVAL-') || item.incident.id !== item.caseId)) throw new TypeError('Invalid expanded scenario identity');
  const inWindow = (time: string) => Date.parse(time) >= Date.parse(item.incident.timeWindow.start)
    && Date.parse(time) <= Date.parse(item.incident.timeWindow.end);
  const unique = (items: string[], label: string) => {
    if (new Set(items).size !== items.length) throw new TypeError('Duplicate scenario ' + label);
  };
  if (Date.parse(evidence.service.lastDeploymentAt) > Date.parse(item.incident.timeWindow.end)) {
    throw new TypeError('Service deployment context is later than the scenario window');
  }
  unique(evidence.logs.map(log => log.id), 'log ID');
  unique(evidence.metrics.map(series => series.name), 'metric name');
  unique(evidence.runbooks.map(book => book.id), 'runbook ID');
  for (const log of evidence.logs) {
    if (log.service !== item.incident.service || !inWindow(log.timestamp)
      || (scenario.source === 'evaluation-only' && !log.id.startsWith(item.caseId + '-LOG-'))) {
      throw new TypeError('Log evidence does not belong to this scenario/window');
    }
  }
  for (const series of evidence.metrics) {
    if (series.service !== item.incident.service || series.points.some(point => !inWindow(point.timestamp))) {
      throw new TypeError('Metric evidence does not belong to this scenario/window');
    }
    unique(series.points.map(point => point.timestamp), 'metric timestamp');
  }
  const truth = item.expectations.groundTruth;
  if (truth.relevantLogIds.some(id => !evidence.logs.some(log => log.id === id))
    || truth.relevantMetricNames.some(name => !evidence.metrics.some(series => series.name === name))
    || truth.relevantRunbookIds.some(id => !evidence.runbooks.some(book => book.id === id && book.tags.includes(item.incident.service)))) {
    throw new TypeError('Ground Truth reference is missing or belongs to another scenario/family');
  }
  if ((scenario.evidenceCondition === 'missing-logs' && evidence.logs.length !== 0)
    || (scenario.evidenceCondition === 'missing-metrics' && evidence.metrics.length !== 0)
    || (scenario.evidenceCondition !== 'missing-logs' && evidence.logs.length === 0)
    || (scenario.evidenceCondition !== 'missing-metrics' && evidence.metrics.length === 0)) {
    throw new TypeError('Evidence condition contradicts available observations');
  }
  if (JSON.stringify(Object.keys(scenario.requiredToolReasons).sort()) !== JSON.stringify([...item.expectations.requiredTools].sort())) {
    throw new TypeError('Each required tool must have exactly one justification');
  }
  if ((item.expectations.requiredTools.includes('search_logs') && evidence.logs.length === 0)
    || (item.expectations.requiredTools.includes('get_metrics') && evidence.metrics.length === 0)) {
    throw new TypeError('Required evidence tool has no observations under this rubric');
  }
}

/** Ignore names, IDs, titles and timestamps when checking that evidence actually differs. */
export function evidenceFingerprint(scenario: DatasetScenario): string {
  return JSON.stringify({ service: scenario.evidence.service.name,
    logs: scenario.evidence.logs.map(log => ({ level: log.level, message: log.message })),
    metrics: scenario.evidence.metrics.map(series => ({ name: series.name, unit: series.unit, values: series.points.map(point => point.value) })) });
}

export function validateExpandedDataset(value: unknown): asserts value is DatasetScenario[] {
  if (!Array.isArray(value) || value.length !== 30) throw new TypeError('Expanded dataset requires the 30 authored scenarios');
  const ids = new Set<string>(), fingerprints = new Set<string>();
  const counts = new Map<string, number>();
  for (const scenario of value) {
    assertDatasetScenario(scenario);
    if (ids.has(scenario.evaluationCase.caseId)) throw new TypeError('Duplicate dataset caseId');
    ids.add(scenario.evaluationCase.caseId);
    const fingerprint = evidenceFingerprint(scenario);
    if (fingerprints.has(fingerprint)) throw new TypeError('Duplicate evidence; relabeling is not scenario diversity');
    fingerprints.add(fingerprint);
    counts.set(scenario.family, (counts.get(scenario.family) ?? 0) + 1);
  }
  if (FAMILIES.some(family => counts.get(family) !== 6)
    || createEvaluationCases().some(item => !value.some(scenario => scenario.source === 'accepted-fixtures' && scenario.evaluationCase.caseId === item.caseId))) {
    throw new TypeError('Dataset must preserve all five originals and six scenarios per family');
  }
}

export function createExpandedDataset(): DatasetScenario[] {
  const originals = createEvaluationCases();
  const dataset: DatasetScenario[] = originals.map((item, index) => ({ evaluationCase: item, source: 'accepted-fixtures',
    family: FAMILIES[index], evidenceCondition: 'accepted-baseline', faultCondition: item.expectations.groundTruth.expectedCause,
    requiredToolReasons: { ...reasons }, evidence: acceptedEvidence(item) }));
  const time = (minute: number) => `2026-09-02T10:${String(minute).padStart(2, '0')}:00.000Z`;
  for (const pack of expansionSeeds) {
    const index = originals.findIndex(item => item.incident.id === pack.incidentId);
    const original = originals[index];
    for (const [variantIndex, seed] of pack.variants.entries()) {
      const caseId = `EVAL-${pack.shortId}-${String(variantIndex + 2).padStart(2, '0')}`;
      const service = structuredClone(services.find(service => service.name === original.incident.service)!);
      if (pack.incidentId === 'INC-005') { service.version = `1.4.${variantIndex}`; service.lastDeploymentAt = time(4); }
      const observedLogs = seed.logs.length ? [
        { id: caseId + '-LOG-01', service: service.name, timestamp: time(0), level: 'info' as const,
          message: 'Requests are completing normally before the incident signals change.' },
        ...seed.logs.map((entry, position) => ({ id: `${caseId}-LOG-${String(position + 2).padStart(2, '0')}`,
          service: service.name, timestamp: time(position === 0 ? 5 : position === seed.logs.length - 1 ? 10 : 8),
          level: entry.relevant === false ? 'warn' as const : 'error' as const, message: entry.message })),
      ] : [];
      const observedMetrics = seed.metrics.map(series => ({ service: service.name, name: series.name, unit: series.unit,
        points: series.values.map((value, point) => ({ timestamp: time(point * 5), value })) }));
      const relevantLogIds = seed.logs.flatMap((entry, position) => entry.relevant === false ? [] : [observedLogs[position + 1].id]);
      const requiredTools = [...sets[seed.condition]];
      dataset.push({ source: 'evaluation-only', family: FAMILIES[index], evidenceCondition: seed.condition, faultCondition: seed.fault,
        requiredToolReasons: Object.fromEntries(requiredTools.map(tool => [tool, tool === 'get_service_info'
          ? `Inspect ${service.name}'s dependencies (${service.dependencies.join(', ')}) and deployment context to interpret ${seed.condition} evidence.`
          : `${reasons[tool]} Scenario collection goal: ${seed.fault}`])),
        evaluationCase: { caseId, incident: { id: caseId, title: seed.title, service: service.name,
          description: seed.symptoms, timeWindow: { start: time(0), end: time(10) } },
        expectations: { requiredTools, groundTruth: { incidentId: caseId, expectedCause: seed.expectedCause, relevantLogIds,
          relevantMetricNames: seed.metrics.filter(series => series.relevant !== false).map(series => series.name),
          relevantRunbookIds: [...original.expectations.groundTruth.relevantRunbookIds] } } },
        evidence: { service, logs: observedLogs, metrics: observedMetrics, runbooks: structuredClone(runbooks) } });
    }
  }
  validateExpandedDataset(dataset);
  return dataset;
}
