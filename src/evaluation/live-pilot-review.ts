import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod/v4';
import { incidents } from '../fixtures/incidents.js';
import { READ_TOOLS } from './contracts.js';
import { createExpandedDataset } from './expanded-dataset.js';
import { parsePilotEvidence, PILOT_CASES, PILOT_SOURCE, PILOT_VERSION, pilotFingerprint,
  pilotManifestSchema, pilotStartSchema, type PilotEvidence, type PilotManifest } from './live-pilot-contracts.js';
import { pilotRepositoryCommit, pilotRunPath, readPilotJson } from './live-pilot.js';
import { QUALITY_DIMENSIONS, QUALITY_RUBRIC, type JudgmentStatus } from './quality-contracts.js';
import { checkToolRequests } from './quality.js';

const text = z.string().trim().min(1);
const judgment = z.strictObject({
  status: z.enum(['PASS', 'FAIL', 'NOT_EVALUATED']),
  rationale: text.max(1000),
  references: z.array(text).refine(refs => refs.length === new Set(refs).size),
});
const reviewsSchema = z.array(z.strictObject({
  schemaVersion: z.literal(PILOT_VERSION),
  runId: text, caseId: z.enum(PILOT_CASES), evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.literal('INDEPENDENT_HUMAN'),
  judgments: z.strictObject({ cause: judgment, evidence: judgment, actions: judgment, toolSelection: judgment }),
})).max(PILOT_CASES.length);

type JournalCase = { caseId: typeof PILOT_CASES[number]; state: 'FROZEN' | 'STARTED_WITHOUT_EVIDENCE' | 'NOT_RUN'; evidence?: PilotEvidence };

function optionalJson(path: string) {
  try { return readPilotJson(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export function readPilotJournal(root: string, runId: string) {
  root = realpathSync(root);
  const directory = pilotRunPath(root, runId);
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new TypeError('Invalid pilot directory');
  const manifest = pilotManifestSchema.parse(readPilotJson(join(directory, 'manifest.json')));
  if (manifest.runId !== runId || manifest.commit !== pilotRepositoryCommit(root)) {
    throw new TypeError('Review requires the original run ID and a clean checkout at its recorded commit');
  }
  const cases: JournalCase[] = [];
  let remaining = manifest.budgetMicrousd;
  let gap = false;
  for (const caseId of PILOT_CASES) {
    const startInput = optionalJson(join(directory, caseId + '.started.json'));
    const evidenceInput = optionalJson(join(directory, caseId + '.json'));
    if (startInput === undefined) {
      if (evidenceInput !== undefined) throw new TypeError('Pilot result lacks a start marker');
      cases.push({ caseId, state: 'NOT_RUN' });
      gap = true;
      continue;
    }
    const start = pilotStartSchema.parse(startInput);
    if (gap || start.runId !== runId || start.caseId !== caseId || start.reservedMicrousd !== manifest.reservedMicrousdPerCase
      || start.reservedMicrousd > remaining) throw new TypeError('Inconsistent pilot reservation history');
    remaining -= start.reservedMicrousd;
    if (evidenceInput === undefined) {
      cases.push({ caseId, state: 'STARTED_WITHOUT_EVIDENCE' });
      gap = true;
      continue;
    }
    const evidence = parsePilotEvidence(evidenceInput);
    if (pilotFingerprint(evidence.manifest) !== pilotFingerprint(manifest)
      || pilotFingerprint(evidence.start) !== pilotFingerprint(start)) throw new TypeError('Pilot result does not match the journal');
    cases.push({ caseId, state: 'FROZEN', evidence });
  }
  return { manifest, cases };
}

export function pilotReviewReferences(evidence: PilotEvidence) {
  return ['incident', 'outcome', ...(evidence.diagnosis ? ['diagnosis'] : []),
    ...evidence.requests.filter(item => evidence.requests.filter(other => other.callId === item.callId).length === 1)
      .map(item => 'request:' + item.callId),
    ...evidence.deliveredOutputs.map(item => 'observed-output:' + item.callId)];
}

/** Resolve only from validated frozen evidence and the model-visible fixture. */
export function resolvePilotReviewReference(evidence: PilotEvidence, reference: string) {
  const { caseId, runId } = evidence.start;
  const fixture = incidents.find(item => item.id === caseId);
  if (!fixture || !evidence.manifest.cases.includes(caseId) || evidence.manifest.runId !== runId) {
    throw new TypeError('Mismatched pilot reference context');
  }
  if (reference === 'incident') {
    const { id, title, service, description, timeWindow: { start, end } } = fixture;
    return { id, title, service, description, timeWindow: { start, end } };
  }
  if (reference === 'outcome') {
    return { caseId, status: evidence.status, failure: evidence.failure, cancellation: evidence.cancellation };
  }
  if (reference === 'diagnosis' && evidence.diagnosis) return structuredClone(evidence.diagnosis);
  for (const [prefix, items] of [['request:', evidence.requests], ['observed-output:', evidence.deliveredOutputs]] as const) {
    if (!reference.startsWith(prefix)) continue;
    const callId = reference.slice(prefix.length);
    const matches = items.filter(item => item.callId === callId);
    if (matches.length === 1) return structuredClone(matches[0]);
    break;
  }
  throw new TypeError('Unknown, unavailable or ambiguous pilot review reference');
}

function requestCheck(evidence: PilotEvidence): JudgmentStatus {
  if (!evidence.observationComplete || evidence.status === 'NOT_STARTED') return 'NOT_EVALUATED';
  if (evidence.requests.some(item => !READ_TOOLS.some(tool => tool === item.name))
    || new Set(evidence.requests.map(item => item.callId)).size !== evidence.requests.length) return 'FAIL';
  const scenario = createExpandedDataset().find(item => item.source === 'accepted-fixtures'
    && item.evaluationCase.caseId === evidence.start.caseId);
  if (!scenario) throw new TypeError('Missing accepted pilot scenario');
  return checkToolRequests({ scenario, observed: {
    status: evidence.status, diagnosis: null, requests: evidence.requests, deliveredOutputs: evidence.deliveredOutputs,
    attempts: evidence.attempts.flatMap(item => item.call ? [{ call: item.call, output: item.output, status: item.status }] : []),
  } }).status;
}

export function assessPilot(manifest: PilotManifest, cases: JournalCase[], reviewInput: unknown = []) {
  const parsed = reviewsSchema.safeParse(reviewInput);
  if (!parsed.success) throw new TypeError('Invalid independent pilot review records');
  const byCase = new Map<typeof PILOT_CASES[number], PilotEvidence>();
  const manifestFingerprint = pilotFingerprint(manifest);
  for (const { caseId, state, evidence } of cases) {
    if (!evidence) continue;
    const frozen = parsePilotEvidence(evidence);
    if (state !== 'FROZEN' || frozen.start.caseId !== caseId || pilotFingerprint(frozen.manifest) !== manifestFingerprint
      || byCase.has(caseId)) throw new TypeError('Mismatched pilot review evidence');
    byCase.set(caseId, frozen);
  }
  const reviews = new Map<typeof PILOT_CASES[number], typeof parsed.data[number]>();
  for (const review of parsed.data) {
    const evidence = byCase.get(review.caseId);
    if (!evidence || review.runId !== manifest.runId || review.evidenceFingerprint !== evidence.evidenceFingerprint
      || reviews.has(review.caseId)) throw new TypeError('Stale, duplicate or mismatched pilot review');
    for (const dimension of QUALITY_DIMENSIONS) {
      const item = review.judgments[dimension];
      for (const reference of item.references) resolvePilotReviewReference(evidence, reference);
      if (item.status !== 'NOT_EVALUATED' && (item.references.length === 0 || !evidence.observationComplete
          || (dimension === 'toolSelection' ? evidence.requests.length === 0 : evidence.diagnosis === null))) {
        throw new TypeError('Pilot judgment lacks an observed outcome or valid case-specific references');
      }
    }
    reviews.set(review.caseId, review);
  }
  const results = cases.map(({ caseId, state }) => {
    const evidence = byCase.get(caseId);
    const review = reviews.get(caseId);
    const completed = evidence?.status === 'COMPLETED';
    const failed = evidence?.status === 'FAILED' || evidence?.status === 'REJECTED'
      || evidence?.status === 'NOT_STARTED' && evidence.failure !== null;
    const completion: JudgmentStatus = completed ? 'PASS' : failed ? 'FAIL' : 'NOT_EVALUATED';
    const structural = evidence ? requestCheck(evidence) : 'NOT_EVALUATED';
    const selection = review?.judgments.toolSelection.status ?? 'NOT_EVALUATED';
    const toolCorrectness: JudgmentStatus = structural === 'FAIL' || selection === 'FAIL' ? 'FAIL'
      : structural === 'PASS' && selection === 'PASS' ? 'PASS' : 'NOT_EVALUATED';
    const dimensions = Object.fromEntries(QUALITY_DIMENSIONS.map(key => [key, review?.judgments[key].status ?? 'NOT_EVALUATED']));
    const taskDimensions = [dimensions.cause, dimensions.evidence, dimensions.actions];
    const taskSuccess: JudgmentStatus = failed || completed && taskDimensions.includes('FAIL') ? 'FAIL'
      : completed && taskDimensions.every(status => status === 'PASS') ? 'PASS' : 'NOT_EVALUATED';
    return { caseId, state, workflowStatus: evidence?.status ?? null, completion, structural, toolCorrectness, taskSuccess, dimensions,
      taskFailureOrigin: failed ? 'WORKFLOW' : taskSuccess === 'FAIL' ? 'HUMAN_REVIEW' : null,
      humanReview: review ? review.provenance : null, evidenceFingerprint: evidence?.evidenceFingerprint ?? null,
      reviewReferences: evidence ? pilotReviewReferences(evidence) : [],
    };
  });
  const counts = (values: JudgmentStatus[]) => {
    const passed = values.filter(value => value === 'PASS').length, failed = values.filter(value => value === 'FAIL').length;
    return { passed, failed, notEvaluated: values.length - passed - failed, evaluated: passed + failed };
  };
  return { mode: 'OFFLINE_PILOT_REVIEW', schemaVersion: PILOT_VERSION, runSource: PILOT_SOURCE, manifest, results,
    summary: {
      completion: counts(results.map(item => item.completion)),
      toolCorrectness: counts(results.map(item => item.toolCorrectness)),
      taskSuccess: counts(results.map(item => item.taskSuccess)),
      dimensions: Object.fromEntries(QUALITY_DIMENSIONS.map(key => [key, counts(results.map(item => item.dimensions[key]))])),
    },
    rubric: {
      cause: QUALITY_RUBRIC.cause, evidence: QUALITY_RUBRIC.evidence, actions: QUALITY_RUBRIC.actions,
      toolSelection: QUALITY_RUBRIC.toolSelection, taskSuccess: QUALITY_RUBRIC.taskSuccess,
      toolCorrectness: QUALITY_RUBRIC.toolCorrectness,
    },
  };
}

export function reviewLivePilot(runId: string, reviewsPath?: string, repositoryRoot = process.cwd()) {
  const { manifest, cases } = readPilotJournal(repositoryRoot, runId);
  return assessPilot(manifest, cases, reviewsPath ? readPilotJson(resolve(reviewsPath)) : []);
}
