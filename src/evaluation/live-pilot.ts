import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LIVE_LIMITS, runLiveInvestigation, type LiveInvestigationReport, type LiveObservation } from '../live-investigation.js';
import { EMBEDDING_MODEL, estimateCaseMicrousd, freezePilotEvidence, PILOT_CASES, PILOT_DIRECTORY, PILOT_SOURCE, PILOT_VERSION,
  pilotFingerprint, pilotLogicalCalls, pilotManifestSchema, pilotPricingSchema, type PilotEvidence, type PilotManifest, type PilotStart,
} from './live-pilot-contracts.js';

export const DEFAULT_PILOT_DEADLINE_MS = 300_000;
export const PILOT_LIMITATION = 'Case reservations use operator-supplied token ceilings and USD rates. Observed Responses usage excludes embeddings, unreported calls and late work. This is a local stop policy, not a provider billing cap.';
export interface PilotInput {
  live: boolean;
  authorizePaid: boolean;
  runId?: string;
  budgetMicrousd?: number;
  deadlineMs?: number;
  pricing?: unknown;
}

export interface PilotDependencies {
  investigate?: typeof runLiveInvestigation;
  repositoryRoot?: string;
}

export function planLivePilot() {
  return {
    mode: 'PLAN_ONLY' as const, schemaVersion: PILOT_VERSION, cases: PILOT_CASES, serial: true,
    liveLimits: LIVE_LIMITS, defaultDeadlineMs: DEFAULT_PILOT_DEADLINE_MS, embeddingModel: EMBEDDING_MODEL,
    prerequisites: {
      configuredModel: process.env.OPENAI_AGENT_MODEL?.trim() ? 'PRESENT' : 'MISSING',
      providerKey: process.env.OPENAI_API_KEY?.trim() ? 'PRESENT' : 'MISSING',
      explicitRunOptions: ['--live', '--authorize-paid', '--run-id', '--budget-microusd', '--pricing'],
      pricingFields: Object.keys(pilotPricingSchema.shape),
      pricingAssumptions: 'Use approved uncached rates in USD microdollars per million tokens and full input ceilings including continuation context.',
      checkout: 'Run from a clean repository root with a build from the recorded commit.',
    },
    limitation: PILOT_LIMITATION,
  };
}

function buildManifest(input: PilotInput, commit: string) {
  const pricing = pilotPricingSchema.safeParse(input.pricing);
  if (!pricing.success) throw new TypeError('Valid dated pricing and conservative input token ceilings are required');
  const configuredModel = process.env.OPENAI_AGENT_MODEL?.trim();
  if (!configuredModel || !process.env.OPENAI_API_KEY?.trim()) throw new TypeError('OPENAI_AGENT_MODEL and OPENAI_API_KEY are required');
  if (configuredModel !== process.env.OPENAI_AGENT_MODEL || configuredModel !== pricing.data.model) {
    throw new TypeError('Configured model must exactly match the priced model');
  }
  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL !== 'https://api.openai.com/v1') {
    throw new TypeError('The live pilot requires the default OpenAI endpoint');
  }
  const reservedMicrousdPerCase = estimateCaseMicrousd(pricing.data);
  const result = pilotManifestSchema.safeParse({
    schemaVersion: PILOT_VERSION, runSource: PILOT_SOURCE, runId: input.runId, commit, createdAt: new Date().toISOString(),
    configuredModel, providerModelVersion: null, budgetMicrousd: input.budgetMicrousd,
    deadlineMs: input.deadlineMs ?? DEFAULT_PILOT_DEADLINE_MS, reservedMicrousdPerCase, pricing: pricing.data,
    liveLimits: LIVE_LIMITS, cases: PILOT_CASES,
  });
  if (!result.success) throw new TypeError('Invalid run ID, deadline or budget. Budget must cover one reserved case.');
  return result.data;
}

function gitRead(root: string, args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function pilotRepositoryCommit(root: string): string {
  if (realpathSync(gitRead(root, ['rev-parse', '--show-toplevel'])) !== root) throw new Error('Run from the repository root');
  if (gitRead(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('A clean checkout is required for live evidence');
  return gitRead(root, ['rev-parse', 'HEAD']);
}

function ensureDirectory(path: string) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('Pilot evidence path must be a local directory');
}

export function pilotRunPath(root: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new TypeError('Invalid pilot run ID');
  return resolve(root, PILOT_DIRECTORY, 'run-' + id);
}

function createJournal(root: string, manifest: PilotManifest) {
  const directory = pilotRunPath(root, manifest.runId);
  const rel = PILOT_DIRECTORY + '/run-' + manifest.runId;
  const names = ['manifest.json', 'finished.json', ...PILOT_CASES.flatMap(id => [id + '.started.json', id + '.json'])];
  if (gitRead(root, ['ls-files', '--', '.project-control'])) throw new Error('Private project-control paths must be untracked');
  for (const name of names) gitRead(root, ['check-ignore', '-q', '--', rel + '/' + name]);
  ensureDirectory(join(root, '.project-control'));
  ensureDirectory(resolve(root, PILOT_DIRECTORY));
  // Exclusive run ID. An interrupted run remains on disk and is never resumed by this entry point.
  mkdirSync(directory, { mode: 0o700 });
  const write = (name: string, data: unknown) => {
    const json = JSON.stringify(data, null, 2) + '\n';
    const key = process.env.OPENAI_API_KEY;
    if ((key && json.includes(key)) || /\b(?:authorization|proxy-authorization)\s*\\?"?\s*[:=]\s*\\?"?\s*(?:bearer|basic)\s+\S+/i.test(json)) {
      throw new Error('Sensitive material cannot be stored in pilot evidence');
    }
    const fd = openSync(join(directory, name), 'wx', 0o600);
    try {
      writeFileSync(fd, json, 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  };
  write('manifest.json', manifest);
  return { directory, write };
}

/** Read a regular JSON file without emitting parser diagnostics or file contents. */
export function readPilotJson(path: string): unknown {
  if (!lstatSync(path).isFile()) throw new TypeError('Pilot JSON input must be a regular file');
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new TypeError('Invalid pilot JSON input'); }
}

function captureCase(manifest: PilotManifest, start: PilotStart, report: LiveInvestigationReport | undefined,
  events: LiveObservation[], cancellation: PilotEvidence['cancellation']): PilotEvidence {
  if (report && report.incidentId !== start.caseId) throw new Error('Pilot report case mismatch');
  const record = report?.measurements[0];
  const modelCalls = (record?.modelCalls ?? []).map(({ sequence, status, usage }) => ({ sequence, status, usage }));
  const modelEvents = events.filter(event => event.kind === 'model-return' && modelCalls[event.sequence - 1]?.status === 'SUCCEEDED');
  let observationComplete = report !== undefined && modelEvents.length === modelCalls.filter(item => item.status === 'SUCCEEDED').length
    && (report.outcome.toolExecutions.length === (record?.toolAttempts.length ?? 0));
  const requests = modelEvents.flatMap(event => event.kind === 'model-return' ? event.requests : []);
  const attempts = (report?.outcome.toolExecutions ?? []).map((execution, index) => {
    const started = events.find(event => event.kind === 'tool-start' && event.sequence === index + 1);
    const returned = events.find(event => event.kind === 'tool-return' && event.sequence === index + 1);
    const call = started?.kind === 'tool-start' && started.call.callId === execution.callId && started.call.name === execution.toolName
      && requests.some(proposal => pilotFingerprint(started.call) === pilotFingerprint(proposal)) ? started.call : null;
    const output = execution.status === 'SUCCEEDED' && returned?.kind === 'tool-return'
      && returned.output.callId === execution.callId ? returned.output.output : null;
    const wait = record?.toolAttempts[index];
    const waitStatus = wait?.callId === execution.callId && wait.toolName === execution.toolName ? wait.status : null;
    if (!call || !waitStatus || waitStatus === 'PENDING' || (waitStatus === 'SUCCEEDED') !== (execution.status === 'SUCCEEDED')
      || execution.status === 'SUCCEEDED' && output === null) observationComplete = false;
    return { ...execution, call, output, waitStatus };
  });
  const deliveredOutputs = modelEvents.flatMap(event => event.kind === 'model-return' ? event.continuationOutputs : []).filter(item => {
    const bound = attempts.some(attempt => attempt.callId === item.callId && attempt.status === 'SUCCEEDED' && attempt.output === item.output);
    if (!bound) observationComplete = false;
    return bound;
  });
  if (report?.outcome.status === 'COMPLETED' && requests.some(request => !deliveredOutputs.some(item => item.callId === request.callId))) {
    observationComplete = false;
  }
  return freezePilotEvidence({
    manifest, start, finishedAt: new Date().toISOString(), status: report?.outcome.status ?? 'NOT_STARTED',
    failure: report ? report.failure ?? null : 'NO_SESSION_REPORT', cancellation,
    diagnosis: report?.outcome.diagnosis ? { ...report.outcome.diagnosis } : null,
    observationComplete, requests, logicalCalls: pilotLogicalCalls(requests, attempts),
    attempts, deliveredOutputs, modelCalls, embeddingUsage: 'NOT_OBSERVED', cleanup: report?.cleanup ?? null,
    traceComplete: report?.traceComplete ?? false,
  });
}

export type PilotStop = 'COMPLETED' | 'BUDGET_LIMIT' | 'CANCELLED' | 'UNEXPECTED_APPROVAL' | 'EXECUTION_ERROR'
  | 'CLEANUP_UNCERTAIN' | 'OBSERVATION_INCOMPLETE' | 'BUDGET_UNCERTAIN';

function caseStop(evidence: PilotEvidence, failed: boolean): PilotStop | undefined {
  if (evidence.cancellation !== 'NONE') return 'CANCELLED';
  if (evidence.status === 'AWAITING_APPROVAL') return 'UNEXPECTED_APPROVAL';
  if (failed || evidence.status !== 'COMPLETED' || evidence.failure) return 'EXECUTION_ERROR';
  const cleanup = evidence.cleanup;
  if (!cleanup || cleanup.mcpClose !== 'SUCCEEDED' || cleanup.childExit !== 'OBSERVED'
    || cleanup.tracingShutdown !== 'SUCCEEDED' || cleanup.errors.length) return 'CLEANUP_UNCERTAIN';
  if (!evidence.observationComplete) return 'OBSERVATION_INCOMPLETE';
  if (!evidence.modelCalls.length || evidence.modelCalls.some(item => item.usage.status !== 'AVAILABLE'
    || item.usage.counts.inputTokens > evidence.manifest.pricing.responseInputTokensPerCall
    || item.usage.counts.outputTokens > LIVE_LIMITS.maxOutputTokens)) return 'BUDGET_UNCERTAIN';
  return undefined;
}

export async function runLivePilot(input: PilotInput, signal?: AbortSignal, dependencies: PilotDependencies = {}) {
  if (!input.live && !input.authorizePaid) return planLivePilot();
  if (input.live !== true || input.authorizePaid !== true) throw new TypeError('Both live and paid authorization flags are required');
  signal?.throwIfAborted();
  const root = realpathSync(dependencies.repositoryRoot ?? process.cwd());
  const manifest = buildManifest(input, pilotRepositoryCommit(root));
  const journal = createJournal(root, manifest);
  const investigate = dependencies.investigate ?? runLiveInvestigation;
  let reservedMicrousd = 0;
  let stop: PilotStop = 'COMPLETED';
  const outcomes: { caseId: typeof PILOT_CASES[number]; status: PilotEvidence['status'] }[] = [];
  for (const caseId of PILOT_CASES) {
    if (signal?.aborted) { stop = 'CANCELLED'; break; }
    if (manifest.budgetMicrousd - reservedMicrousd < manifest.reservedMicrousdPerCase) { stop = 'BUDGET_LIMIT'; break; }
    const start: PilotStart = { runId: manifest.runId, caseId, startedAt: new Date().toISOString(), reservedMicrousd: manifest.reservedMicrousdPerCase };
    journal.write(caseId + '.started.json', start);
    reservedMicrousd += start.reservedMicrousd;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), manifest.deadlineMs);
    const caseSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const events: LiveObservation[] = [];
    let report: LiveInvestigationReport | undefined;
    let failed = false;
    try {
      report = await investigate(caseId, { signal: caseSignal,
        onReport: result => { report = result; },
        onObservation: event => { events.push(event); return undefined; },
      });
    } catch { failed = true; } // Report callbacks preserve the original outcome. Never persist raw errors.
    finally { clearTimeout(timer); }
    const cancellation = signal?.aborted ? 'OPERATOR_REQUESTED' : deadline.signal.aborted ? 'DEADLINE_REQUESTED' : 'NONE';
    const evidence = captureCase(manifest, start, report, events, cancellation);
    journal.write(caseId + '.json', evidence);
    outcomes.push({ caseId, status: evidence.status });
    const reason = caseStop(evidence, failed);
    if (reason) { stop = reason; break; }
  }
  const summary = { mode: 'LIVE_PILOT' as const, runId: manifest.runId, stop, reservedMicrousd,
    outcomes, notRun: PILOT_CASES.filter(id => !outcomes.some(item => item.caseId === id)), limitation: PILOT_LIMITATION };
  journal.write('finished.json', { ...summary, finishedAt: new Date().toISOString() });
  return summary;
}
