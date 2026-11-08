import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { ChildProcess, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { LIVE_LIMITS, runLiveInvestigation } from '../../dist/live-investigation.js';
import { OperationTimeoutError } from '../../dist/agent/with-timeout.js';
import { IncidentOpsMcpClient } from '../../dist/mcp/client.js';
import { incidents } from '../../dist/fixtures/index.js';
import { groundTruth } from '../../dist/fixtures/ground-truth.js';
import { estimateCaseMicrousd, parsePilotEvidence, PILOT_CASES, PILOT_VERSION } from '../../dist/evaluation/live-pilot-contracts.js';
import { pilotRunPath, runLivePilot } from '../../dist/evaluation/live-pilot.js';
import { assessPilot, pilotReviewReferences, readPilotJournal, resolvePilotReviewReference } from '../../dist/evaluation/live-pilot-review.js';
import { parsePilotCommand } from '../../dist/evaluation/run-live-pilot.js';
import { assertQualityMaterial } from '../../dist/evaluation/quality.js';

const source = resolve(fileURLToPath(new URL('../../', import.meta.url))).replaceAll('\\', '/');
const cli = fileURLToPath(new URL('../../dist/evaluation/run-live-pilot.js', import.meta.url));
const stdioFixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.js', import.meta.url));
const fakeKey = 'offline-pilot-test-credential';
const pricing = {
  model: 'offline-fixture-model', embeddingModel: 'text-embedding-3-small', asOf: '2026-11-08',
  source: 'https://example.invalid/test-pricing', inputMicrousdPerMillion: 1_000_000,
  outputMicrousdPerMillion: 2_000_000, embeddingMicrousdPerMillion: 100_000,
  responseInputTokensPerCall: 128_000, embeddingTokensPerInput: 8192,
};
const reserve = estimateCaseMicrousd(pricing);
const diagnosis = { summary: 'Fixture diagnosis', probableCause: 'Fixture cause', confidence: 'low', evidence: [], recommendedActions: [] };
const cleanup = { mcpClose: 'SUCCEEDED', childExit: 'OBSERVED', tracingShutdown: 'SUCCEEDED', errors: [] };
const knownUsage = { status: 'AVAILABLE', source: 'OPENAI_RESPONSE', counts: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
let repositoryRoot;

before(t => {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'incidentops-pilot-test-'));
  const owned = realpathSync(directory);
  assert.equal(dirname(owned), parent);
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  // A local clone supplies real Git ignore/index behavior without writing to the source repo.
  repositoryRoot = join(owned, 'repo');
  execFileSync('git', ['-c', 'safe.directory=' + source + '/.git', 'clone', '--quiet', '--no-hardlinks',
    '--single-branch', '--', source, repositoryRoot], { cwd: owned });
});

beforeEach(t => {
  for (const [name, value] of Object.entries({
    OPENAI_API_KEY: fakeKey, OPENAI_AGENT_MODEL: pricing.model, OPENAI_BASE_URL: undefined,
  })) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  t.mock.method(globalThis, 'fetch', () => assert.fail('A pilot test must never call an external provider'));
});

const liveInput = (runId, budgetMicrousd = reserve * 5) => ({
  live: true, authorizePaid: true, runId, budgetMicrousd, pricing,
});

const resultFor = (incidentId, overrides = {}) => ({
  incidentId, outcome: { status: 'COMPLETED', diagnosis, toolExecutions: [] },
  measurements: [{ modelCalls: [{ sequence: 1, status: 'SUCCEEDED', usage: knownUsage }], toolAttempts: [] }],
  cleanup, traceComplete: true, ...overrides,
});

function mockCompleted(id, options, overrides) {
  options.onObservation({ kind: 'model-return', sequence: 1, requests: [], continuationOutputs: [] });
  return resultFor(id, overrides);
}

const saved = (runId, name) => JSON.parse(readFileSync(join(pilotRunPath(repositoryRoot, runId), name), 'utf8'));
const noRun = () => assert.fail('Investigation entry must not run');
const dependencies = investigate => ({ repositoryRoot, investigate });

test('default CLI works without a key or model and plan mode starts no process or provider', async t => {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_AGENT_MODEL;
  const output = execFileSync(process.execPath, [cli], { cwd: repositoryRoot, env, encoding: 'utf8' });
  const plan = JSON.parse(output);
  assert.equal(plan.mode, 'PLAN_ONLY');
  assert.deepEqual(plan.cases, PILOT_CASES);
  assert.equal(plan.prerequisites.providerKey, 'MISSING');
  assert.equal(plan.prerequisites.configuredModel, 'MISSING');
  assert.equal(plan.liveLimits.maxTurns, 5);
  assert.equal(plan.liveLimits.maxToolCalls, 4);
  const spawn = t.mock.method(ChildProcess.prototype, 'spawn', () => assert.fail('Plan spawned a process'));
  assert.equal((await runLivePilot({ live: false, authorizePaid: false }, undefined, dependencies(noRun))).mode, 'PLAN_ONLY');
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.ok(!existsSync(join(repositoryRoot, '.project-control')));
});

test('live authorization, price, model and positive budget are validated before execution or evidence writes', async () => {
  assert.throws(() => parsePilotCommand(['--live', '--run-id', 'bad']), /authorization|authorize-paid/i);
  assert.throws(() => parsePilotCommand(['--live', '--authorize-paid', '--run-id', 'bad', '--case', 'INC-006']), /Unknown/);
  assert.throws(() => parsePilotCommand(['--live', '--authorize-paid', '--run-id', 'bad', '--budget-microusd', '0', '--pricing', 'price.json']), /positive integer/);
  for (const override of [
    { live: false }, { authorizePaid: false }, { pricing: undefined }, { pricing: { ...pricing, asOf: 'unknown' } },
    { pricing: { ...pricing, model: 'different-model' } }, { budgetMicrousd: 0 }, { budgetMicrousd: reserve - 1 },
    { deadlineMs: 2_147_483_648 }, { runId: '../outside' },
  ]) {
    await assert.rejects(runLivePilot({ ...liveInput('bad'), ...override }, undefined, dependencies(noRun)));
  }
  delete process.env.OPENAI_AGENT_MODEL;
  await assert.rejects(runLivePilot(liveInput('bad'), undefined, dependencies(noRun)), /OPENAI_AGENT_MODEL/);
  assert.ok(!existsSync(pilotRunPath(repositoryRoot, 'bad')));
});

test('case reservation includes all five Responses turns and the corpus plus four embedding queries', () => {
  const expected = Math.ceil((5 * (128_000 * 1_000_000 + 2048 * 2_000_000) + (5 + 4) * 8192 * 100_000) / 1_000_000);
  assert.equal(reserve, expected);
  assert.throws(() => estimateCaseMicrousd({ ...pricing, responseInputTokensPerCall: Number.MAX_SAFE_INTEGER }), /supported range/);
});

test('serial pilot starts the five allowed cases once each and records reservations before each session', async () => {
  const seen = [];
  let active = 0;
  const runId = 'serial';
  const result = await runLivePilot(liveInput(runId), undefined, dependencies(async (id, options) => {
    assert.equal(++active, 1);
    assert.equal(saved(runId, id + '.started.json').reservedMicrousd, reserve);
    seen.push(id);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return mockCompleted(id, options);
  }));
  assert.deepEqual(seen, PILOT_CASES);
  assert.equal(result.stop, 'COMPLETED');
  assert.equal(result.reservedMicrousd, reserve * 5);
  assert.deepEqual(result.notRun, []);
  await assert.rejects(runLivePilot(liveInput(runId), undefined, dependencies(noRun)), /EEXIST/);
});

test('budget reserves the full estimate even for cheap observed calls and skips the next uncovered case', async () => {
  const calls = [];
  const result = await runLivePilot(liveInput('budget', reserve * 2 - 1), undefined, dependencies((id, options) => {
    calls.push(id);
    return mockCompleted(id, options);
  }));
  assert.equal(result.stop, 'BUDGET_LIMIT');
  assert.deepEqual(calls, ['INC-001']);
  assert.deepEqual(result.notRun, PILOT_CASES.slice(1));
  assert.equal(result.reservedMicrousd, reserve);
});

test('pilot stops on missing or over-ceiling usage, unexpected approval or uncertain cleanup', async () => {
  const modes = [
    ['unknown-usage', 'BUDGET_UNCERTAIN', { measurements: [{ modelCalls: [{ sequence: 1, status: 'SUCCEEDED',
      usage: { status: 'NOT_AVAILABLE', reason: 'NOT_REPORTED' } }], toolAttempts: [] }] }],
    ['over-usage', 'BUDGET_UNCERTAIN', { measurements: [{ modelCalls: [{ sequence: 1, status: 'SUCCEEDED',
      usage: { ...knownUsage, counts: { inputTokens: 128001, outputTokens: 1, totalTokens: 128002 } } }], toolAttempts: [] }] }],
    ['approval', 'UNEXPECTED_APPROVAL', { outcome: { status: 'AWAITING_APPROVAL', toolExecutions: [] } }],
    ['cleanup', 'CLEANUP_UNCERTAIN', { cleanup: { ...cleanup, childExit: 'NOT_OBSERVED' } }],
  ];
  for (const [runId, stop, override] of modes) {
    const result = await runLivePilot(liveInput(runId), undefined, dependencies((id, options) => mockCompleted(id, options, override)));
    assert.equal(result.stop, stop);
    assert.equal(result.outcomes.length, 1);
    assert.deepEqual(result.notRun, PILOT_CASES.slice(1));
  }
});

test('deadline requests cancellation, preserves the reported failure and leaves later cases unrun', async () => {
  const input = { ...liveInput('deadline'), deadlineMs: 5 };
  const result = await runLivePilot(input, undefined, dependencies(async (id, options) => {
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    options.onReport(resultFor(id, { outcome: { status: 'FAILED', toolExecutions: [] }, failure: 'INTERRUPTED', measurements: [] }));
    throw new Error('A raw provider error must not be stored');
  }));
  const evidence = saved('deadline', 'INC-001.json');
  assert.equal(result.stop, 'CANCELLED');
  assert.equal(evidence.status, 'FAILED');
  assert.equal(evidence.failure, 'INTERRUPTED');
  assert.equal(evidence.cancellation, 'DEADLINE_REQUESTED');
  assert.deepEqual(result.notRun, PILOT_CASES.slice(1));
  assert.doesNotMatch(JSON.stringify(evidence), /raw provider error/);
});

test('unsafe evidence is rejected and its durable start marker prevents a blind rerun', async () => {
  const input = liveInput('interrupted-write');
  await assert.rejects(runLivePilot(input, undefined, dependencies((id, options) => mockCompleted(id, options, {
    outcome: { status: 'COMPLETED', toolExecutions: [], diagnosis: { ...diagnosis, summary: fakeKey } },
  }))), /Sensitive material/);
  const journal = readPilotJournal(repositoryRoot, input.runId);
  assert.equal(journal.cases[0].state, 'STARTED_WITHOUT_EVIDENCE');
  assert.equal(journal.cases[1].state, 'NOT_RUN');
  assert.equal(assessPilot(journal.manifest, journal.cases).results[0].taskSuccess, 'NOT_EVALUATED');
  assert.ok(!existsSync(join(pilotRunPath(repositoryRoot, input.runId), 'INC-001.json')));
  await assert.rejects(runLivePilot(input, undefined, dependencies(noRun)), /EEXIST/);
});

const functionCall = (name, args, id) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id, status: 'completed' });
const final = { type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: JSON.stringify(diagnosis) }] };
const incident = incidents[0];
const read = (id, service = incident.service) => functionCall('get_service_info', { service }, id);

function fakeResponses(t, steps) {
  const bodies = [];
  const fetch = t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    const index = bodies.length;
    assert.ok(index < steps.length, 'Unexpected model call or SDK retry');
    bodies.push(JSON.parse(options.body));
    return Promise.resolve(new Response(JSON.stringify(steps[index] === null ? { error: { message: 'synthetic failure' } } : {
      id: 'response-' + index, model: pricing.model, status: 'completed', output: steps[index],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }), { status: steps[index] === null ? 500 : 200, headers: { 'content-type': 'application/json' } }));
  });
  return { fetch, bodies };
}

async function fixtureSession(id, options, decorate = client => client) {
  // Real local stdio and the existing fixture tools. The child uses deterministic embeddings and forbids fetch.
  const client = new IncidentOpsMcpClient({ command: process.execPath, args: [stdioFixture], env: {} });
  return runLiveInvestigation(id, options, { createClient: () => decorate(client) });
}

const fourReads = () => [read('service'), functionCall('search_logs', { service: incident.service, timeWindow: incident.timeWindow }, 'logs'),
  functionCall('get_metrics', { service: incident.service, timeWindow: incident.timeWindow }, 'metrics'),
  functionCall('search_runbook', { query: 'checkout errors', limit: 1 }, 'runbook')];

test('mocked live session uses four read schemas, preserves evidence delivery and isolates evaluator data', async t => {
  const steps = [fourReads(), [final]];
  const { bodies } = fakeResponses(t, steps);
  const result = await runLivePilot(liveInput('scoring', reserve), undefined, dependencies(fixtureSession));
  assert.equal(result.stop, 'BUDGET_LIMIT');
  assert.equal(bodies.length, 2);
  assert.deepEqual(JSON.parse(bodies[0].input), incident);
  assert.deepEqual(bodies[0].tools.map(tool => tool.name), ['search_logs', 'get_metrics', 'get_service_info', 'search_runbook']);
  assert.equal(bodies[0].max_output_tokens, 2048);
  assert.equal(bodies[1].previous_response_id, 'response-0');
  const wire = JSON.stringify(bodies);
  assert.doesNotMatch(wire, /groundTruth|expectedCause|requiredToolReasons|judgments|LIVE_OPENAI_PILOT|toolCorrectness/);
  for (const item of groundTruth) assert.ok(!wire.includes(item.expectedCause));
  const evidence = parsePilotEvidence(saved('scoring', 'INC-001.json'));
  assert.equal(evidence.manifest.configuredModel, pricing.model);
  assert.equal(evidence.manifest.providerModelVersion, null);
  assert.equal(evidence.attempts.length, 4);
  assert.deepEqual(evidence.deliveredOutputs.map(item => item.callId), bodies[1].input.map(item => item.call_id));
  assert.deepEqual(evidence.deliveredOutputs.map(item => item.output), bodies[1].input.map(item => item.output));
  assert.ok(evidence.observationComplete);
  assert.ok(evidence.traceComplete);
  assert.throws(() => assertQualityMaterial(evidence), /Malformed quality material/);
});

test('offline scoring separates completion, structural checks and human quality and rejects invalid review bindings', async t => {
  fakeResponses(t, [fourReads(), [final]]);
  await runLivePilot(liveInput('review', reserve), undefined, dependencies(fixtureSession));
  const { manifest, cases } = readPilotJournal(repositoryRoot, 'review');
  const evidence = cases[0].evidence;
  const resolve = reference => resolvePilotReviewReference(evidence, reference);
  assert.deepEqual(resolve('incident'), incident);
  assert.deepEqual(resolve('outcome'), { caseId: 'INC-001', status: 'COMPLETED', failure: null, cancellation: 'NONE' });
  assert.deepEqual(resolve('diagnosis'), diagnosis);
  assert.deepEqual(resolve('request:logs'), evidence.requests.find(item => item.callId === 'logs'));
  assert.deepEqual(resolve('observed-output:logs'), evidence.deliveredOutputs.find(item => item.callId === 'logs'));
  resolve('incident').timeWindow.start = 'modified';
  resolve('diagnosis').summary = 'modified';
  resolve('request:logs').arguments.service = 'modified';
  assert.deepEqual(resolve('incident'), incident);
  assert.equal(resolve('diagnosis').summary, diagnosis.summary);
  assert.equal(resolve('request:logs').arguments.service, incident.service);
  assert.doesNotMatch(JSON.stringify(pilotReviewReferences(evidence).map(resolve)), /groundTruth|expectedCause|judgments/);
  for (const reference of ['groundTruth', 'scenario.expectedCause', 'request:INC-002', 'request:', 'observed-output:absent']) {
    assert.throws(() => resolve(reference), /Unknown, unavailable or ambiguous/);
  }
  assert.throws(() => assessPilot(manifest, [{ ...cases[0], caseId: 'INC-002' }]), /Mismatched pilot review evidence/);
  const noReviews = assessPilot(manifest, cases);
  assert.equal(noReviews.results[0].completion, 'PASS');
  assert.equal(noReviews.results[0].structural, 'PASS');
  assert.equal(noReviews.results[0].taskSuccess, 'NOT_EVALUATED');
  assert.equal(noReviews.results[0].toolCorrectness, 'NOT_EVALUATED');
  // In-memory test inputs exercise the scoring contract. These are not actual reviews and are never saved.
  const judgment = { status: 'PASS', rationale: 'Synthetic assertion for the scoring test.', references: ['observed-output:logs'] };
  const sample = { schemaVersion: PILOT_VERSION, runId: manifest.runId, caseId: 'INC-001', provenance: 'INDEPENDENT_HUMAN',
    evidenceFingerprint: evidence.evidenceFingerprint, judgments: { cause: judgment, evidence: judgment, actions: judgment, toolSelection: judgment } };
  const result = assessPilot(manifest, cases, [sample]).results[0];
  assert.equal(result.taskSuccess, 'PASS');
  assert.equal(result.toolCorrectness, 'PASS');
  const fail = { ...sample, judgments: { ...sample.judgments, actions: { ...judgment, status: 'FAIL' } } };
  assert.equal(assessPilot(manifest, cases, [fail]).results[0].taskSuccess, 'FAIL');
  for (const invalid of [
    [sample, sample], [{ ...sample, runId: 'another' }], [{ ...sample, caseId: 'INC-002' }],
    [{ ...sample, evidenceFingerprint: '0'.repeat(64) }], [{ ...sample, provenance: 'SYNTHETIC_TEST' }],
    [{ ...sample, judgments: { ...sample.judgments, cause: { ...judgment, references: ['observed-output:absent'] } } }],
  ]) assert.throws(() => assessPilot(manifest, cases, invalid));
  assert.throws(() => parsePilotEvidence({ ...evidence, diagnosis: { ...evidence.diagnosis, summary: 'tampered' } }), /binding mismatch/);
});

test('partial batch success is recorded without marking outputs as delivered when a later tool fails', async t => {
  const { fetch } = fakeResponses(t, [[read('first'), read('wrong', 'absent-service')]]);
  const result = await runLivePilot(liveInput('partial'), undefined, dependencies(fixtureSession));
  const evidence = saved('partial', 'INC-001.json');
  assert.equal(result.stop, 'EXECUTION_ERROR');
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(evidence.attempts.map(item => item.status), ['SUCCEEDED', 'FAILED']);
  assert.ok(evidence.attempts[0].output);
  assert.equal(evidence.attempts[1].output, null);
  assert.deepEqual(evidence.deliveredOutputs, []);
});

test('failed continuation does not certify that an attempted payload reached the model', async t => {
  const { bodies } = fakeResponses(t, [[read('first')], null]);
  let liveReport;
  const result = await runLivePilot(liveInput('failed-continuation'), undefined, dependencies((id, options) => fixtureSession(id, {
    ...options, inspect: true,
    onReport(report) { liveReport = report; options.onReport(report); },
  })));
  const evidence = saved('failed-continuation', 'INC-001.json');
  assert.equal(result.stop, 'EXECUTION_ERROR');
  assert.equal(bodies[1].input[0].call_id, 'first');
  assert.equal(evidence.attempts[0].status, 'SUCCEEDED');
  assert.deepEqual(evidence.deliveredOutputs, []);
  assert.deepEqual(evidence.modelCalls.map(call => call.status), ['SUCCEEDED', 'FAILED']);
  assert.deepEqual(liveReport.observed.deliveredCallIds, []);
  assert.deepEqual(liveReport.inspection.deliveredOutputs, []);
  assert.ok(resolvePilotReviewReference(evidence, 'request:first'));
  for (const reference of ['diagnosis', 'observed-output:first']) {
    assert.throws(() => resolvePilotReviewReference(evidence, reference), /unavailable/);
  }
});

test('reused proposal IDs are ambiguous while the output from a completed continuation remains resolvable', async t => {
  fakeResponses(t, [[read('reused')], [read('reused')]]);
  const result = await runLivePilot(liveInput('duplicate-reference'), undefined, dependencies(fixtureSession));
  const evidence = parsePilotEvidence(saved('duplicate-reference', 'INC-001.json'));
  assert.equal(result.stop, 'EXECUTION_ERROR');
  assert.equal(evidence.requests.length, 2);
  assert.ok(!pilotReviewReferences(evidence).includes('request:reused'));
  assert.throws(() => resolvePilotReviewReference(evidence, 'request:reused'), /ambiguous/);
  assert.deepEqual(resolvePilotReviewReference(evidence, 'observed-output:reused'), evidence.deliveredOutputs[0]);
});

test('live pilot reuses the five-turn limit and does not execute an unconsumable fifth request', async t => {
  const { fetch } = fakeResponses(t, Array.from({ length: 5 }, (_, index) => [read('turn-' + index)]));
  const result = await runLivePilot(liveInput('turn-limit'), undefined, dependencies(fixtureSession));
  const evidence = saved('turn-limit', 'INC-001.json');
  assert.equal(result.stop, 'EXECUTION_ERROR');
  assert.equal(fetch.mock.callCount(), 5);
  assert.equal(evidence.requests.length, 5);
  assert.equal(evidence.attempts.length, 4);
  assert.equal(evidence.deliveredOutputs.length, 4);
});

test('live pilot keeps the four-attempt budget even if a model proposes a larger batch', async t => {
  const { fetch } = fakeResponses(t, [Array.from({ length: 5 }, (_, index) => read('batch-' + index))]);
  const result = await runLivePilot(liveInput('tool-limit'), undefined, dependencies(fixtureSession));
  const evidence = saved('tool-limit', 'INC-001.json');
  assert.equal(result.stop, 'EXECUTION_ERROR');
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(evidence.requests.length, 5);
  assert.equal(evidence.attempts.length, 4);
  assert.deepEqual(evidence.deliveredOutputs, []);
});

test('an SDK read timeout preserves one logical call, two attempts and only the successful output', async t => {
  fakeResponses(t, [[read('retry-info')], [final]]);
  const result = await runLivePilot(liveInput('retry', reserve), undefined, dependencies((id, options) => fixtureSession(id, options, client => {
    const original = client.callTool.bind(client);
    let first = true;
    client.callTool = async params => {
      if (first) { first = false; throw new SdkError(SdkErrorCode.RequestTimeout, 'offline timeout'); }
      return original(params);
    };
    return client;
  })));
  assert.equal(result.stop, 'BUDGET_LIMIT');
  const evidence = saved('retry', 'INC-001.json');
  assert.deepEqual(evidence.logicalCalls, [{ callId: 'retry-info', toolName: 'get_service_info', attemptCount: 2 }]);
  assert.deepEqual(evidence.attempts.map(item => item.waitStatus), ['TIMEOUT', 'SUCCEEDED']);
  assert.equal(evidence.attempts[0].output, null);
  assert.deepEqual(evidence.deliveredOutputs, [{ callId: 'retry-info', output: evidence.attempts[1].output }]);
});

test('throwing optional observation callbacks do not replace a valid live result', async t => {
  fakeResponses(t, [[read('info')], [final]]);
  const report = await fixtureSession('INC-001', { onObservation() { throw new Error('Observer failed'); } });
  assert.equal(report.outcome.status, 'COMPLETED');
  assert.deepEqual(report.outcome.diagnosis, diagnosis);
  assert.equal(report.outcome.toolExecutions.length, 1);
});

test('cancellation during continuation retains the original error even if an observer mutates its event and throws', async () => {
  const controller = new AbortController();
  const original = new Error('offline cancellation');
  const client = new IncidentOpsMcpClient({ command: process.execPath, args: [stdioFixture], env: {} });
  let report;
  const events = [];
  await assert.rejects(runLiveInvestigation('INC-001', {
    inspect: true, signal: controller.signal,
    onReport(value) { report = value; },
    onObservation(event) {
      events.push(event.kind);
      if (event.kind === 'model-return') event.requests[0].name = 'restart_service';
      throw new Error('observer failure');
    },
  }, {
    createClient: () => client,
    createModel: ({ signal }) => ({ async respond(request) {
      if (request.kind === 'initial') return { kind: 'tool_calls', continuation: 'offline',
        calls: [{ callId: 'info', name: 'get_service_info', arguments: { service: incident.service } }] };
      assert.equal(request.outputs[0].callId, 'info');
      controller.abort();
      assert.ok(signal.aborted);
      throw original;
    } }),
  }), error => error === original);
  assert.deepEqual(events, ['model-return', 'tool-start', 'tool-return']);
  assert.deepEqual(report.outcome.toolExecutions, [{ callId: 'info', toolName: 'get_service_info', status: 'SUCCEEDED' }]);
  assert.equal(report.outcome.status, 'FAILED');
  assert.equal(report.failure, 'INTERRUPTED');
  assert.deepEqual(report.observed.deliveredCallIds, []);
  assert.deepEqual(report.inspection.deliveredOutputs, []);
  assert.equal(report.cleanup.childExit, 'OBSERVED');
});

test('a continuation that returns during cleanup after the caller timeout is not counted as delivered', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let enterContinuation, finishContinuation, report;
  const entered = new Promise(resolve => { enterContinuation = resolve; });
  const late = new Promise(resolve => { finishContinuation = resolve; });
  const returned = [];
  const pending = runLiveInvestigation('INC-001', {
    inspect: true, onReport(value) { report = value; },
    onObservation(event) { if (event.kind === 'model-return') returned.push(event.sequence); },
  }, {
    createClient: () => ({
      pid: null,
      async connect() {},
      async callTool() { return { content: [{ type: 'text', text: '{"offline":true}' }] }; },
      async close() { finishContinuation({ kind: 'final', diagnosis }); await late; },
    }),
    createModel: () => ({ async respond(request) {
      if (request.kind === 'initial') return { kind: 'tool_calls', continuation: 'offline',
        calls: [{ callId: 'info', name: 'get_service_info', arguments: { service: incident.service } }] };
      enterContinuation();
      return late;
    } }),
  });
  const rejected = assert.rejects(pending, OperationTimeoutError);
  await entered;
  t.mock.timers.tick(LIVE_LIMITS.modelTimeoutMs);
  t.mock.timers.reset(); // Let the real tracing SDK finish its asynchronous cleanup.
  await rejected;
  assert.deepEqual(returned, [1, 2]);
  assert.equal(report.measurements[0].modelCalls[1].status, 'TIMEOUT');
  assert.equal(report.failure, 'TIMEOUT');
  assert.deepEqual(report.observed.deliveredCallIds, []);
  assert.deepEqual(report.inspection.deliveredOutputs, []);
});
