import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createExpandedDataset, assertDatasetScenario, validateExpandedDataset, evidenceFingerprint } from '../dist/evaluation/expanded-dataset.js';
import { FAMILIES, CONDITIONS } from '../dist/evaluation/expanded-contracts.js';
import { datasetCoverage, runExpandedEvaluation } from '../dist/evaluation/expanded.js';
import { connectScenarioExecutor } from '../dist/evaluation/fixture-mcp.js';
import { createScriptedBaselineModel, runScriptedBaseline, runEvaluationCase } from '../dist/evaluation/baseline.js';
import { createEvaluationCases, toAgentIncident } from '../dist/evaluation/cases.js';
import { evaluateInvestigation, summarizeEvaluation } from '../dist/evaluation/evaluator.js';
import { AgentOrchestrator } from '../dist/agent/agent-orchestrator.js';
import { OperationTimeoutError } from '../dist/agent/with-timeout.js';
import { ToolError } from '../dist/tools/tool-error.js';
import * as fixtures from '../dist/fixtures/index.js';
import { groundTruth } from '../dist/fixtures/ground-truth.js';

const find = (family, condition) => createExpandedDataset().find(scenario => scenario.family === family && scenario.evidenceCondition === condition);
async function connect(t, scenario) {
  const connection = await connectScenarioExecutor(scenario.evidence, scenario.source);
  t.after(connection.close);
  return connection.executor;
}
const toolCall = (name, args) => ({ callId: 'direct-read', name, arguments: args });
function noAnswers(requests, dataset) {
  const serialized = JSON.stringify(requests);
  for (const key of ['expectedCause', 'groundTruth', 'relevantLogIds', 'relevantMetricNames', 'relevantRunbookIds',
    'expectations', 'requiredTools', 'requiredToolReasons', 'faultCondition', 'evidenceCondition']) {
    assert.ok(!serialized.includes(key), `${key} must not enter Agent/model/tool data`);
  }
  for (const scenario of dataset) assert.ok(!serialized.includes(scenario.evaluationCase.expectations.groundTruth.expectedCause),
    'An evaluator answer must not enter model requests');
}
beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Expanded evaluation must not call OpenAI or external networks'));
});

test('expanded dataset has stable unique IDs, six cases per family and six justified relevant tool sets', () => {
  const dataset = createExpandedDataset();
  assert.deepEqual(dataset, createExpandedDataset());
  assert.equal(dataset.length, 30);
  assert.deepEqual(dataset.slice(0, 5).map(scenario => scenario.evaluationCase), createEvaluationCases());
  assert.deepEqual(dataset.slice(5).map(scenario => scenario.evaluationCase.caseId),
    ['REDIS', 'PROVIDER', 'QUEUE', 'POOL', 'DEPLOY'].flatMap(family => [2, 3, 4, 5, 6].map(index => `EVAL-${family}-0${index}`)));
  assert.equal(new Set(dataset.map(scenario => scenario.evaluationCase.caseId)).size, 30);
  const coverage = datasetCoverage(dataset);
  assert.deepEqual(coverage.families, Object.fromEntries(FAMILIES.map(family => [family, 6])));
  assert.deepEqual(coverage.evidenceConditions, Object.fromEntries(CONDITIONS.map(condition => [condition, 5])));
  assert.deepEqual(coverage.sources, { 'accepted-fixtures': 5, 'evaluation-only': 25 });
  assert.deepEqual(coverage.requiredToolSets, {
    'get_metrics + get_service_info + search_logs': 5,
    'get_metrics + get_service_info + search_logs + search_runbook': 5,
    'get_metrics + get_service_info + search_runbook': 5,
    'get_metrics + search_logs': 5,
    'get_metrics + search_logs + search_runbook': 5,
    'search_logs + search_runbook': 5,
  });
  for (const scenario of dataset) {
    assertDatasetScenario(scenario);
    assert.deepEqual(Object.keys(scenario.requiredToolReasons).sort(), [...scenario.evaluationCase.expectations.requiredTools].sort());
    for (const reason of Object.values(scenario.requiredToolReasons)) assert.ok(reason.trim().length > 30);
  }
});

test('scenario differences include mechanisms, distractors, uncertainty and actually absent evidence, not relabeling', () => {
  const dataset = createExpandedDataset();
  assert.equal(new Set(dataset.map(evidenceFingerprint)).size, 30);
  const redis = find(FAMILIES[0], 'strong-signal');
  assert.match(redis.evidence.logs[1].message, /max number of clients/);
  assert.equal(redis.evidence.metrics.find(series => series.name === 'redis_connected_clients').points[1].value, 1000);
  const provider = find(FAMILIES[1], 'strong-signal');
  assert.match(provider.evidence.logs[1].message, /HTTP 429/);
  const queue = find(FAMILIES[2], 'strong-signal');
  assert.equal(queue.evidence.metrics.find(series => series.name === 'enqueue_rate').points[2].value, 480);
  assert.equal(queue.evidence.metrics.find(series => series.name === 'processing_rate').points[2].value, 120);
  assert.match(queue.evaluationCase.expectations.groundTruth.expectedCause, /functioning|active/);
  const pool = find(FAMILIES[3], 'strong-signal');
  assert.equal(pool.evidence.metrics.find(series => series.name === 'db_pool_capacity').points[1].value, 4);
  assert.match(pool.evidence.logs[2].message, /50 ms/);
  const deploy = find(FAMILIES[4], 'strong-signal');
  assert.ok(Date.parse(deploy.evidence.service.lastDeploymentAt) < Date.parse(deploy.evidence.logs[1].timestamp));
  assert.match(deploy.evidence.logs[1].message, /\/v3\/send/);
  for (const scenario of dataset.filter(scenario => scenario.source === 'evaluation-only')) {
    const truth = scenario.evaluationCase.expectations.groundTruth;
    if (scenario.evidenceCondition === 'missing-logs') {
      assert.deepEqual(scenario.evidence.logs, []); assert.deepEqual(truth.relevantLogIds, []);
    }
    if (scenario.evidenceCondition === 'missing-metrics') {
      assert.deepEqual(scenario.evidence.metrics, []); assert.deepEqual(truth.relevantMetricNames, []);
    }
    if (scenario.evidenceCondition === 'ambiguous') assert.match(truth.expectedCause, /cannot|not proven|does not establish/);
    if (scenario.evidenceCondition === 'distractor') assert.ok(scenario.evidence.logs.some(log =>
      log.level === 'warn' && !truth.relevantLogIds.includes(log.id)), 'Distractor must be visible, not an annotation only');
  }
});

test('thirty actual MCP investigations repeat equal results, preserve baseline and expose only scenario-owned visible evidence', async () => {
  const before = structuredClone({ ...fixtures, groundTruth });
  const baseline = await runScriptedBaseline();
  const dataset = createExpandedDataset();
  const requests = [];
  const report = await runExpandedEvaluation(request => requests.push(request));
  assert.deepEqual(report, await runExpandedEvaluation());
  assert.deepEqual(await runScriptedBaseline(), baseline);
  assert.deepEqual({ ...fixtures, groundTruth }, before, 'No accepted fixture is mutated even temporarily');
  assert.deepEqual(report.results.slice(0, 5), baseline.results);
  assert.equal(report.model, 'scripted deterministic model; no real LLM');
  assert.match(report.execution, /25 new cases use evaluation-only/);
  assert.equal(requests.length, 60);
  noAnswers(requests, dataset);
  dataset.forEach((scenario, index) => {
    const initial = requests[index * 2], continuation = requests[index * 2 + 1];
    assert.equal(initial.kind, 'initial');
    assert.deepEqual(JSON.parse(initial.prompt), toAgentIncident(scenario.evaluationCase));
    assert.equal(continuation.kind, 'continuation');
    assert.equal(continuation.continuation, 'baseline-response');
    const outputs = Object.fromEntries(continuation.outputs.map(output => [output.callId, JSON.parse(output.output)]));
    assert.deepEqual(outputs.metadata, scenario.evidence.service);
    assert.deepEqual(outputs.logs, scenario.evidence.logs);
    assert.deepEqual(outputs.metrics, [...scenario.evidence.metrics].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    assert.equal(outputs.runbook.length, 1);
    assert.ok(scenario.evaluationCase.expectations.groundTruth.relevantRunbookIds.includes(outputs.runbook[0].runbook.id));
    assert.equal(report.results[index].criteria.toolSelection.attempts, 4);
  });
  assert.deepEqual(report.summary, { caseCount: 30, criteria: {
    completion: { passed: 30, failed: 0, notEvaluated: 0, evaluated: 30 },
    toolSelection: { passed: 30, failed: 0, notEvaluated: 0, evaluated: 30 },
    diagnosisCorrectness: { passed: 0, failed: 0, notEvaluated: 30, evaluated: 0 },
  }, requiredToolCoverage: { covered: 85, required: 85 } });
  assert.deepEqual(report.coverage, datasetCoverage(dataset));
  assert.equal(report.additionalSelectedTools.reduce((total, item) => total + item.tools.length, 0), 35);
  assert.ok(report.limitations.some(item => item.includes('not universal optimal')));
  assert.ok(report.limitations.some(item => item.includes('does not establish autonomous tool choice')));
  assert.ok(!Object.hasOwn(report.summary, 'accuracy'));
});

test('invalid references, scenario ownership, timestamps, missing modalities and rubric inconsistencies are rejected', () => {
  const original = find(FAMILIES[0], 'strong-signal');
  for (const corrupt of [
    s => { s.evaluationCase.expectations.groundTruth.relevantLogIds = ['EVAL-PROVIDER-02-LOG-02']; },
    s => { s.evaluationCase.expectations.groundTruth.relevantMetricNames = ['not_a_metric']; },
    s => { s.evaluationCase.expectations.groundTruth.relevantRunbookIds = ['RB-004']; },
    s => { s.evidence.logs[1].service = 'payment-api'; },
    s => { s.evidence.logs[1].id = 'EVAL-REDIS-03-LOG-02'; },
    s => { s.evidence.logs[1].timestamp = '2026-09-03T10:05:00.000Z'; },
    s => { s.evidence.metrics[0].points[0].timestamp = 'not-a-date'; },
    s => { s.evidence.metrics[0].service = 'payment-api'; },
    s => { s.evidence.metrics[0].points[1].value = NaN; },
    s => { s.evidence.service.lastDeploymentAt = '2026-09-03T00:00:00.000Z'; },
    s => { s.evaluationCase.incident.timeWindow.end = '2026-09-01T00:00:00.000Z'; },
    s => { s.evidenceCondition = 'missing-logs'; },
    s => { delete s.requiredToolReasons.search_logs; },
  ]) {
    const invalid = structuredClone(original); corrupt(invalid);
    assert.throws(() => assertDatasetScenario(invalid), TypeError);
  }
  const baseline = createExpandedDataset()[0];
  baseline.evaluationCase.incident.title += ' changed';
  assert.throws(() => assertDatasetScenario(baseline), /baseline scenario must remain unchanged/);
  const duplicate = createExpandedDataset(); duplicate[6] = structuredClone(duplicate[5]);
  assert.throws(() => validateExpandedDataset(duplicate), /Duplicate dataset caseId/);
  assert.throws(() => validateExpandedDataset(createExpandedDataset().slice(0, 29)), /30 authored scenarios/);
});

test('changing IDs, titles and timestamps cannot disguise duplicate scenario evidence', () => {
  const dataset = createExpandedDataset();
  const clone = structuredClone(dataset[5]);
  const nextId = dataset[6].evaluationCase.caseId;
  clone.evaluationCase.caseId = nextId;
  clone.evaluationCase.incident.id = nextId;
  clone.evaluationCase.incident.title = 'A different title is not different evidence';
  clone.evaluationCase.expectations.groundTruth.incidentId = nextId;
  const rename = id => id.replace(dataset[5].evaluationCase.caseId, nextId);
  clone.evidence.logs.forEach(log => { log.id = rename(log.id); });
  clone.evaluationCase.expectations.groundTruth.relevantLogIds = clone.evaluationCase.expectations.groundTruth.relevantLogIds.map(rename);
  const shift = timestamp => new Date(Date.parse(timestamp) + 3600000).toISOString();
  clone.evaluationCase.incident.timeWindow.start = shift(clone.evaluationCase.incident.timeWindow.start);
  clone.evaluationCase.incident.timeWindow.end = shift(clone.evaluationCase.incident.timeWindow.end);
  clone.evidence.logs.forEach(log => { log.timestamp = shift(log.timestamp); });
  clone.evidence.metrics.forEach(series => series.points.forEach(point => { point.timestamp = shift(point.timestamp); }));
  dataset[6] = clone;
  assert.throws(() => validateExpandedDataset(dataset), /relabeling is not scenario diversity/);
});

test('answer contamination is rejected at incident and visible MCP snapshot boundaries', async () => {
  const original = find(FAMILIES[0], 'strong-signal');
  const invalid = structuredClone(original);
  invalid.evaluationCase.incident.expectedCause = invalid.evaluationCase.expectations.groundTruth.expectedCause;
  assert.throws(() => assertDatasetScenario(invalid), /Malformed evaluation case/);
  await assert.rejects(runEvaluationCase(invalid.evaluationCase, { respond() { assert.fail('No model call'); } },
    { execute() { assert.fail('No execution'); } }), /Malformed evaluation case/);
  for (const corrupt of [
    evidence => { evidence.groundTruth = original.evaluationCase.expectations.groundTruth; },
    evidence => { evidence.logs[0].expectedCause = 'injected answer'; },
    evidence => { evidence.service.requiredTools = ['search_logs']; },
    evidence => { evidence.runbooks[0].relevantLogIds = ['injected answer list']; },
  ]) {
    const evidence = structuredClone(original.evidence); corrupt(evidence);
    await assert.rejects(connectScenarioExecutor(evidence, 'evaluation-only'), /Malformed visible scenario evidence/);
  }
  assert.throws(() => noAnswers([{ kind: 'continuation', outputs: [{ output: JSON.stringify({ expectedCause: 'leak' }) }] }], [original]),
    assert.AssertionError, 'The leak guard detects contaminated successful tool evidence');
});

test('missing a required tool fails despite completion on a new scenario, while optional extras remain non-penalized', async t => {
  const scenario = find(FAMILIES[0], 'missing-logs');
  const script = createScriptedBaselineModel();
  const model = { async respond(request) {
    const result = await script.respond(request);
    if (result.kind === 'tool_calls') result.calls = result.calls.filter(call => call.name !== 'get_service_info');
    return result;
  } };
  const result = await runEvaluationCase(scenario.evaluationCase, model, await connect(t, scenario));
  assert.equal(result.criteria.completion.status, 'PASS');
  assert.equal(result.criteria.toolSelection.status, 'FAIL');
  assert.deepEqual(result.criteria.toolSelection.missing, ['get_service_info']);
  assert.equal(result.criteria.toolSelection.covered, 2);
  assert.equal(result.criteria.toolSelection.required, 3);
  const strong = find(FAMILIES[0], 'strong-signal');
  const withExtras = await runEvaluationCase(strong.evaluationCase, createScriptedBaselineModel(), await connect(t, strong));
  assert.equal(withExtras.criteria.toolSelection.actual.length, 4);
  assert.equal(withExtras.criteria.toolSelection.covered, 2);
  assert.equal(withExtras.criteria.toolSelection.required, 2);
  assert.equal(withExtras.criteria.toolSelection.status, 'PASS');
  assert.deepEqual(summarizeEvaluation([result, withExtras]).requiredToolCoverage, { covered: 4, required: 5 });
});

test('actual new-scenario retry records consume another attempt without inflating coverage or logical selections', async t => {
  const scenario = find(FAMILIES[2], 'strong-signal');
  const executor = await connect(t, scenario);
  const original = executor.execute.bind(executor);
  let first = true;
  t.mock.method(executor, 'execute', call => {
    if (call.name === 'search_logs' && first) { first = false; throw new OperationTimeoutError('Injected read timeout'); }
    return original(call);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const agent = new AgentOrchestrator(createScriptedBaselineModel(), executor);
  const run = agent.investigate(toAgentIncident(scenario.evaluationCase));
  await nextTurn();
  t.mock.timers.tick(100);
  await nextTurn();
  const record = await run;
  assert.deepEqual(record.toolExecutions.map(attempt => [attempt.callId, attempt.status]), [
    ['metadata', 'SUCCEEDED'], ['logs', 'FAILED'], ['logs', 'SUCCEEDED'], ['metrics', 'SUCCEEDED'], ['runbook', 'SUCCEEDED'],
  ]);
  const result = evaluateInvestigation(scenario.evaluationCase, record);
  assert.equal(result.criteria.toolSelection.attempts, 5);
  assert.equal(result.criteria.toolSelection.logicalCalls.length, 4);
  assert.equal(result.criteria.toolSelection.covered, 2);
  assert.equal(result.criteria.toolSelection.required, 2);
  assert.equal(result.criteria.diagnosisCorrectness.status, 'NOT_EVALUATED');
});

test('isolated MCP fixture snapshots filter evidence and never mix scenarios sharing a service/time window', async t => {
  const first = find(FAMILIES[0], 'strong-signal'), second = find(FAMILIES[0], 'distractor');
  const executorA = await connect(t, first), executorB = await connect(t, second);
  const args = { service: first.evaluationCase.incident.service, timeWindow: first.evaluationCase.incident.timeWindow };
  const a = JSON.parse((await executorA.execute(toolCall('search_logs', args))).output);
  const b = JSON.parse((await executorB.execute(toolCall('search_logs', args))).output);
  assert.deepEqual(a, first.evidence.logs); assert.deepEqual(b, second.evidence.logs);
  assert.ok(a.every(log => log.id.startsWith('EVAL-REDIS-02-')));
  assert.ok(b.every(log => log.id.startsWith('EVAL-REDIS-03-')));
  first.evidence.logs[1].message = 'Caller mutation after connection';
  assert.deepEqual(JSON.parse((await executorA.execute(toolCall('search_logs', args))).output), a);
  assert.deepEqual(JSON.parse((await executorA.execute(toolCall('search_logs', { ...args, levels: [] }))).output), []);
  assert.deepEqual(JSON.parse((await executorA.execute(toolCall('get_metrics', { ...args, metricNames: ['not_present'] }))).output), []);
  assert.deepEqual(JSON.parse((await executorA.execute(toolCall('search_logs', { ...args, timeWindow: {
    start: '2026-09-03T00:00:00.000Z', end: '2026-09-03T01:00:00.000Z' } }))).output), []);
  await assert.rejects(executorA.execute(toolCall('get_service_info', { service: 'different-service' })),
    error => error instanceof ToolError && error.code === 'SERVICE_NOT_FOUND');
});
