import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AgentOrchestrator } from '../dist/agent/agent-orchestrator.js';
import { OperationTimeoutError } from '../dist/agent/with-timeout.js';
import { RunbookRetriever } from '../dist/rag/runbook-retriever.js';
import { createEvaluationCases, toAgentIncident } from '../dist/evaluation/cases.js';
import { evaluateInvestigation, summarizeEvaluation } from '../dist/evaluation/evaluator.js';
import { createScriptedBaselineModel, runEvaluationCase, runScriptedBaseline } from '../dist/evaluation/baseline.js';
import * as fixtures from '../dist/fixtures/index.js';
import { groundTruth } from '../dist/fixtures/ground-truth.js';
import { createTestExecutor } from './fixtures/mcp-memory.js';

beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Evaluation must not access external networks or OpenAI'));
});
const createExecutor = t => createTestExecutor(t, new RunbookRetriever({ async embed(texts) { return texts.map(() => [1, 0]); } }));
function missingRunbookModel() {
  const model = createScriptedBaselineModel();
  return { async respond(request) {
    const response = await model.respond(request);
    if (response.kind === 'tool_calls') response.calls = response.calls.filter(call => call.name !== 'search_runbook');
    return response;
  } };
}
function failingModel(item, seen = []) {
  return { async respond(request) {
    seen.push(structuredClone(request));
    assert.equal(seen.length, 1, 'No continuation after terminal failure');
    return { kind: 'tool_calls', continuation: 'failure-response', calls: [
      { callId: 'logs', name: 'search_logs', arguments: { service: item.incident.service, timeWindow: item.incident.timeWindow } },
      { callId: 'missing', name: 'get_service_info', arguments: { service: 'missing-service' } },
      { callId: 'never', name: 'get_metrics', arguments: { service: item.incident.service, timeWindow: item.incident.timeWindow } },
    ] };
  } };
}
function assertNoGroundTruth(requests) {
  const serialized = JSON.stringify(requests);
  for (const field of ['expectations', 'groundTruth', 'expectedCause', 'relevantLogIds', 'relevantMetricNames', 'relevantRunbookIds']) {
    assert.ok(!serialized.includes(field), `${field} must not enter model input`);
  }
  for (const truth of groundTruth) assert.ok(!serialized.includes(truth.expectedCause), 'Expected answer must not enter model input');
}

test('evaluation cases address exactly the five stable unique accepted incidents with detached evaluator-only expectations', () => {
  const before = structuredClone({ ...fixtures, groundTruth });
  const cases = createEvaluationCases();
  assert.deepEqual(cases.map(item => item.caseId), ['INC-001', 'INC-002', 'INC-003', 'INC-004', 'INC-005']);
  assert.equal(new Set(cases.map(item => item.caseId)).size, 5);
  assert.equal(fixtures.groundTruth, undefined);
  for (const item of cases) {
    assert.deepEqual(item.incident, fixtures.incidents.find(incident => incident.id === item.caseId));
    assert.deepEqual(item.expectations.groundTruth, groundTruth.find(truth => truth.incidentId === item.incident.id));
    assert.deepEqual([...item.expectations.requiredTools].sort(), ['get_metrics', 'get_service_info', 'search_logs', 'search_runbook']);
    assert.deepEqual(toAgentIncident(item), item.incident);
  }
  cases[0].incident.timeWindow.start = 'mutated';
  cases[0].expectations.groundTruth.expectedCause = 'mutated';
  assert.deepEqual({ ...fixtures, groundTruth }, before);
  assert.notEqual(createEvaluationCases()[0].expectations.groundTruth.expectedCause, 'mutated');
});

test('five actual scripted MCP investigations reproduce equal scores and reports without leaking answers to prompts or continuation', async () => {
  const requests = [];
  const first = await runScriptedBaseline(request => requests.push(request));
  const second = await runScriptedBaseline();
  assert.deepEqual(first, second, 'UUIDs and elapsed time must not destabilize the report');
  assert.equal(first.model, 'scripted deterministic model; no real LLM');
  assert.equal(first.results.length, 5);
  assert.equal(requests.filter(request => request.kind === 'initial').length, 5);
  assert.equal(requests.filter(request => request.kind === 'continuation').length, 5);
  assertNoGroundTruth(requests);
  for (const item of createEvaluationCases()) {
    const prompt = requests.find(request => request.kind === 'initial' && JSON.parse(request.prompt).id === item.incident.id);
    assert.deepEqual(JSON.parse(prompt.prompt), item.incident);
  }
  for (const result of first.results) {
    assert.equal(result.outcome.status, 'COMPLETED');
    assert.equal(result.criteria.completion.status, 'PASS');
    assert.equal(result.criteria.toolSelection.status, 'PASS');
    assert.equal(result.criteria.toolSelection.attempts, 4);
    assert.equal(result.criteria.toolSelection.logicalCalls.length, 4);
    assert.equal(result.criteria.diagnosisCorrectness.status, 'NOT_EVALUATED');
    assert.notEqual(result.criteria.diagnosisCorrectness.actual, result.criteria.diagnosisCorrectness.expected,
      'Completion/coverage can pass even when the script does not infer the expected cause');
  }
  assert.deepEqual(first.summary, { caseCount: 5, criteria: {
    completion: { passed: 5, failed: 0, notEvaluated: 0, evaluated: 5 },
    toolSelection: { passed: 5, failed: 0, notEvaluated: 0, evaluated: 5 },
    diagnosisCorrectness: { passed: 0, failed: 0, notEvaluated: 5, evaluated: 0 },
  }, requiredToolCoverage: { covered: 20, required: 20 } });
  assert.ok(!Object.hasOwn(first.summary, 'accuracy'));
});

test('accidental Ground Truth in evaluation incident input is rejected before model or executor execution', async () => {
  for (const contaminate of [
    item => { item.incident.expectedCause = item.expectations.groundTruth.expectedCause; },
    item => { item.incident.expectations = item.expectations; },
    item => { item.incident.timeWindow.relevantLogIds = item.expectations.groundTruth.relevantLogIds; },
  ]) {
    const item = createEvaluationCases()[0];
    contaminate(item);
    await assert.rejects(runEvaluationCase(item, { respond() { assert.fail('No model call for contaminated input'); } },
      { execute() { assert.fail('No executor call for contaminated input'); } }), /Malformed evaluation case/);
  }
  assert.throws(() => assertNoGroundTruth([{ kind: 'initial', prompt: JSON.stringify({ ...fixtures.incidents[0],
    expectedCause: groundTruth[0].expectedCause }) }]), assert.AssertionError, 'The leak assertion itself detects contaminated model input');
});

test('required-tool coverage fails a missing runbook even when the actual investigation completes', async t => {
  const result = await runEvaluationCase(createEvaluationCases()[0], missingRunbookModel(), await createExecutor(t));
  assert.equal(result.criteria.completion.status, 'PASS');
  assert.equal(result.criteria.toolSelection.status, 'FAIL');
  assert.deepEqual(result.criteria.toolSelection.missing, ['search_runbook']);
  assert.equal(result.criteria.toolSelection.covered, 3);
  assert.equal(result.criteria.toolSelection.required, 4);
  assert.match(result.criteria.toolSelection.reason, /Missing required tools: search_runbook/);
});

test('actual failed investigation retains attempted tool selection, failure reason and prior history without continuation', async t => {
  const item = createEvaluationCases()[1];
  const seen = [];
  const result = await runEvaluationCase(item, failingModel(item, seen), await createExecutor(t));
  assert.equal(result.outcome.status, 'FAILED');
  assert.match(result.outcome.failure, /missing-service/);
  assert.equal(result.criteria.completion.status, 'FAIL');
  assert.match(result.criteria.completion.reason, /FAILED/);
  assert.deepEqual(result.criteria.toolSelection.logicalCalls, [
    { callId: 'logs', toolName: 'search_logs' }, { callId: 'missing', toolName: 'get_service_info' },
  ]);
  assert.deepEqual(result.criteria.toolSelection.missing, ['get_metrics', 'search_runbook']);
  assert.equal(result.criteria.toolSelection.covered, 2, 'Selection includes the actual failed metadata attempt, not only successes');
  assert.equal(result.criteria.toolSelection.attempts, 2);
  assert.equal(result.criteria.diagnosisCorrectness.actual, null);
  assert.equal(seen.length, 1);
});

test('actual timeout-classified retry increases attempts but not logical selection or required-tool coverage', async t => {
  const item = createEvaluationCases()[0];
  const executor = await createExecutor(t);
  const original = executor.execute.bind(executor);
  let firstLog = true;
  const execute = t.mock.method(executor, 'execute', call => {
    if (call.name === 'search_logs' && firstLog) {
      firstLog = false;
      throw new OperationTimeoutError('Deterministic executor timeout');
    }
    return original(call);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const agent = new AgentOrchestrator(createScriptedBaselineModel(), executor);
  const run = agent.investigate(toAgentIncident(item));
  await nextTurn();
  assert.equal(execute.mock.callCount(), 2);
  t.mock.timers.tick(100);
  await nextTurn();
  const record = await run;
  assert.deepEqual(record.toolExecutions.map(attempt => [attempt.callId, attempt.status]), [
    ['metadata', 'SUCCEEDED'], ['logs', 'FAILED'], ['logs', 'SUCCEEDED'], ['metrics', 'SUCCEEDED'], ['runbook', 'SUCCEEDED'],
  ]);
  const result = evaluateInvestigation(item, record);
  assert.equal(result.criteria.toolSelection.attempts, 5);
  assert.equal(result.criteria.toolSelection.logicalCalls.length, 4);
  assert.equal(result.criteria.toolSelection.actual.length, 4);
  assert.equal(result.criteria.toolSelection.covered, 4);
  assert.equal(result.criteria.toolSelection.required, 4);
});

test('distinct logical calls and additional selected tools do not inflate required-tool coverage or imply exact matching', async t => {
  const item = createEvaluationCases()[2];
  item.expectations.requiredTools = ['search_logs']; // Explicit evaluator-only rubric variant.
  const script = createScriptedBaselineModel();
  const model = { async respond(request) {
    const response = await script.respond(request);
    if (response.kind === 'tool_calls') response.calls.push({ ...response.calls[1], callId: 'logs-again' });
    return response;
  } };
  const result = await runEvaluationCase(item, model, await createExecutor(t));
  assert.equal(result.criteria.toolSelection.status, 'PASS');
  assert.equal(result.criteria.toolSelection.attempts, 5);
  assert.equal(result.criteria.toolSelection.logicalCalls.length, 5);
  assert.equal(result.criteria.toolSelection.actual.length, 4);
  assert.equal(result.criteria.toolSelection.covered, 1);
  assert.equal(result.criteria.toolSelection.required, 1);
});

test('even literal expectedCause equality in an explicitly synthetic scoring record does not establish semantic correctness', async t => {
  const item = createEvaluationCases()[0];
  const record = await new AgentOrchestrator(createScriptedBaselineModel(), await createExecutor(t)).investigate(toAgentIncident(item));
  // Evaluator-only synthetic variant; never feed the answer to the Agent/model.
  record.diagnosis.probableCause = item.expectations.groundTruth.expectedCause;
  const result = evaluateInvestigation(item, record);
  assert.equal(result.criteria.diagnosisCorrectness.status, 'NOT_EVALUATED');
  assert.deepEqual(summarizeEvaluation([result]).criteria.diagnosisCorrectness,
    { passed: 0, failed: 0, notEvaluated: 1, evaluated: 0 });
});

test('mixed real investigation outcomes produce correct per-criterion numerators and denominators', async t => {
  const cases = createEvaluationCases();
  const executor = await createExecutor(t);
  const results = [
    await runEvaluationCase(cases[0], createScriptedBaselineModel(), executor),
    await runEvaluationCase(cases[1], missingRunbookModel(), executor),
    await runEvaluationCase(cases[2], failingModel(cases[2]), executor),
  ];
  assert.deepEqual(summarizeEvaluation(results), { caseCount: 3, criteria: {
    completion: { passed: 2, failed: 1, notEvaluated: 0, evaluated: 3 },
    toolSelection: { passed: 1, failed: 2, notEvaluated: 0, evaluated: 3 },
    diagnosisCorrectness: { passed: 0, failed: 0, notEvaluated: 3, evaluated: 0 },
  }, requiredToolCoverage: { covered: 9, required: 12 } });
});

test('malformed cases and records fail explicitly instead of being scored as passing', async t => {
  const item = createEvaluationCases()[0];
  const record = await new AgentOrchestrator(createScriptedBaselineModel(), await createExecutor(t)).investigate(toAgentIncident(item));
  for (const corrupt of [
    value => { value.expectations.requiredTools = ['not_a_tool']; },
    value => { value.expectations.requiredTools = ['search_logs', 'search_logs']; },
    value => { value.expectations.groundTruth.incidentId = 'INC-wrong'; },
    value => { value.incident.timeWindow.end = 'invalid'; },
  ]) {
    const invalid = structuredClone(item); corrupt(invalid);
    assert.throws(() => evaluateInvestigation(invalid, record), TypeError);
  }
  for (const invalid of [null, {}, { ...record, status: 'UNKNOWN' }, { ...record, incidentId: 'wrong' },
    { ...record, diagnosis: { summary: 'missing required fields' } }, { ...record, status: 'FAILED', diagnosis: undefined },
    { ...record, failure: 'Contradictory completed state' }, { ...record, toolExecutions: [{ ...record.toolExecutions[0], status: 'REQUESTED' }] },
    { ...record, toolExecutions: [...record.toolExecutions, record.toolExecutions[0]] },
    { ...record, toolExecutions: [{ ...record.toolExecutions[0], status: 'FAILED' }] }]) {
    assert.throws(() => evaluateInvestigation(item, invalid), TypeError);
  }
});

test('summary rejects duplicates, unsupported criterion semantics and impossible coverage rather than inventing denominators', async () => {
  const result = (await runScriptedBaseline()).results[0];
  assert.throws(() => summarizeEvaluation([result, result]), /duplicate/);
  for (const corrupt of [
    value => { value.criteria.completion.status = 'NOT_EVALUATED'; },
    value => { value.criteria.diagnosisCorrectness.status = 'PASS'; },
    value => { value.criteria.toolSelection.covered = 5; },
    value => { value.criteria.toolSelection.required = 0; },
    value => { value.criteria.toolSelection.covered = 0; },
    value => { value.criteria.toolSelection.required = 1; value.criteria.toolSelection.covered = 1; },
    value => { value.criteria.completion.actual = 'FAILED'; },
  ]) {
    const invalid = structuredClone(result); corrupt(invalid);
    assert.throws(() => summarizeEvaluation([invalid]), TypeError);
  }
  assert.deepEqual(summarizeEvaluation([]).criteria.completion, { passed: 0, failed: 0, notEvaluated: 0, evaluated: 0 });
});
