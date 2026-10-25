import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AgentOrchestrator } from '../dist/agent/agent-orchestrator.js';
import { OperationTimeoutError, withTimeout } from '../dist/agent/with-timeout.js';
import { InvestigationMeasurements } from '../dist/measurement/collector.js';
import { durationStatistics, summarizeMeasurements, usageSummary } from '../dist/measurement/report.js';
import { providerUsage, associateProviderUsage } from '../dist/measurement/provider-usage.js';
import { runMeasuredEvaluation } from '../dist/evaluation/measured.js';
import { runScriptedBaseline } from '../dist/evaluation/baseline.js';
import { runExpandedEvaluation } from '../dist/evaluation/expanded.js';
import { RunbookRetriever } from '../dist/rag/runbook-retriever.js';
import { SemanticRetrievalUnavailableError } from '../dist/rag/semantic-retrieval-unavailable-error.js';
import { incidents } from '../dist/fixtures/index.js';
import { createTestExecutor } from './fixtures/mcp-memory.js';

const incident = incidents[0];
const final = { kind: 'final', diagnosis: { summary: 'Controlled measurement.', probableCause: 'Further investigation needed.',
  confidence: 'low', evidence: [], recommendedActions: [] } };
const read = { callId: 'A', name: 'get_service_info', arguments: { service: incident.service } };
const risk = { callId: 'B', name: 'restart_service', arguments: { service: incident.service } };
const batch = calls => ({ kind: 'tool_calls', continuation: 'original-response', calls });
const output = call => ({ callId: call.callId, output: JSON.stringify({ service: incident.service }) });
const decision = (record, choice = 'approve') => ({ investigationId: record.investigationId,
  approvalId: record.pendingApproval.approvalId, decision: choice });
function setup(calls = [read], budget = 8) {
  const clock = { value: 0 };
  const collector = new InvestigationMeasurements(() => clock.value);
  const requests = [], executions = [];
  const model = { async respond(request) {
    requests.push(structuredClone(request)); clock.value += request.kind === 'initial' ? 2 : 4;
    return request.kind === 'initial' ? batch(calls) : final;
  } };
  const executor = { async execute(call) { executions.push(call); clock.value += 3; return output(call); } };
  const agent = new AgentOrchestrator(model, executor, 2, budget, 50, 5, collector);
  return { clock, collector, requests, executions, model, executor, agent };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function advance(t, clock, ms) { clock.value += ms; t.mock.timers.tick(ms); await nextTurn(); }
const ms = value => ({ status: 'MEASURED', milliseconds: value });
beforeEach(t => { t.mock.method(globalThis, 'fetch', () => assert.fail('Measurement tests must not access external networks')); });

test('monotonic milliseconds retain exact caller boundaries without changing investigation/result JSON', async t => {
  const s = setup([read], 1);
  t.mock.method(Date, 'now', () => -1); // Wall-clock values cannot influence the injected monotonic clock.
  const result = await s.agent.investigate(incident);
  const measured = s.collector.get(result.investigationId);
  assert.equal(measured.unit, 'milliseconds');
  assert.equal(measured.status, 'COMPLETED');
  assert.deepEqual(measured.duration, ms(9));
  assert.deepEqual(measured.modelCalls.map(call => call.duration), [ms(2), ms(4)]);
  assert.deepEqual(measured.modelCalls.map(call => [call.sequence, call.requestKind, call.status]), [[1, 'initial', 'SUCCEEDED'], [2, 'continuation', 'SUCCEEDED']]);
  assert.deepEqual(measured.toolAttempts, [{ sequence: 1, callId: 'A', toolName: 'get_service_info', attempt: 1, status: 'SUCCEEDED', duration: ms(3) }]);
  assert.deepEqual(result.diagnosis, final.diagnosis);
  assert.deepEqual(result.toolExecutions, [{ callId: 'A', toolName: 'get_service_info', status: 'SUCCEEDED' }]);
  assert.ok(!Object.hasOwn(result, 'measurements'));
  assert.deepEqual(s.requests[1].outputs, [output(read)]);
  assert.equal(usageSummary([measured]).completeTotal, null);
  measured.toolAttempts.length = 0;
  assert.equal(s.collector.get(result.investigationId).toolAttempts.length, 1, 'Returned measurements are detached');
});

test('model failure retains its identity, observed latency and FAILED investigation outcome', async () => {
  let clock = 0;
  const collector = new InvestigationMeasurements(() => clock);
  const original = new Error('model unavailable');
  const agent = new AgentOrchestrator({ async respond() { clock += 7; throw original; } },
    { execute() { assert.fail('No tool'); } }, 8, 8, 50, 5, collector);
  await assert.rejects(agent.investigate(incident), error => error === original);
  const measured = collector.getAll()[0];
  assert.equal(measured.status, 'FAILED');
  assert.deepEqual(measured.duration, ms(7));
  assert.deepEqual(measured.modelCalls[0].duration, ms(7));
  assert.equal(measured.modelCalls[0].status, 'FAILED');
  assert.deepEqual(measured.toolAttempts, []);
});

test('model timeout measures bounded wait and ignores late output and controlled late usage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { value: 0 }, pending = deferred();
  const collector = new InvestigationMeasurements(() => clock.value);
  const agent = new AgentOrchestrator({ respond() { return pending.promise; } }, { execute() { assert.fail('No tool'); } }, 8, 8, 5, 50, collector);
  const rejected = assert.rejects(agent.investigate(incident), OperationTimeoutError);
  await advance(t, clock, 5); await rejected;
  const measured = collector.getAll()[0];
  assert.deepEqual(measured.duration, ms(5));
  assert.equal(measured.modelCalls[0].status, 'TIMEOUT');
  assert.deepEqual(measured.modelCalls[0].usage, { status: 'NOT_AVAILABLE', reason: 'CALLER_TIMEOUT' });
  const late = structuredClone(final);
  associateProviderUsage(late, providerUsage({ input_tokens: 2, output_tokens: 3, total_tokens: 5 })); // Controlled metadata, not a real provider call.
  clock.value += 100;
  pending.resolve(late); await nextTurn();
  assert.deepEqual(collector.getAll()[0], measured);
  assert.equal(usageSummary(collector.getAll()).completeTotal, null);
});

test('tool timeout plus retry retains two spans, excludes 100ms backoff and respects exact attempt budget', async t => {
  const s = setup([read], 2), pending = deferred();
  const normal = s.executor.execute.bind(s.executor);
  let first = true;
  t.mock.method(s.executor, 'execute', call => {
    if (first) { first = false; s.executions.push(call); return pending.promise; }
    return normal(call);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = s.agent.investigate(incident);
  await nextTurn();
  await advance(t, s.clock, 5);
  await advance(t, s.clock, 99);
  assert.equal(s.executions.length, 1);
  await advance(t, s.clock, 1);
  const result = await run, measured = s.collector.get(result.investigationId);
  assert.deepEqual(measured.duration, ms(114)); // 2 model + 5 timeout + 100 backoff + 3 retry + 4 model.
  assert.deepEqual(measured.toolAttempts.map(call => [call.callId, call.attempt, call.status, call.duration]),
    [['A', 1, 'TIMEOUT', ms(5)], ['A', 2, 'SUCCEEDED', ms(3)]]);
  assert.deepEqual(result.toolExecutions.map(call => call.status), ['FAILED', 'SUCCEEDED']);
  assert.equal(s.executions[0], s.executions[1]);
  assert.deepEqual(s.requests[1].outputs, [output(read)]);
  const summary = summarizeMeasurements([measured]);
  assert.equal(summary.toolAttempts.logicalCalls, 1); assert.equal(summary.toolAttempts.retries, 1);
  assert.equal(summary.toolAttempts.durations.mean, 4);
  pending.resolve(output(read)); await nextTurn();
  assert.deepEqual(s.collector.get(result.investigationId), measured);
});

test('a timed-out attempt with no retry budget remains one failed wait and preserves the original timeout', async t => {
  const s = setup([read], 1);
  t.mock.method(s.executor, 'execute', () => new Promise(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(s.agent.investigate(incident), error => error instanceof OperationTimeoutError
    && error.message === 'Agent tool execution timed out after 5ms');
  await nextTurn(); await advance(t, s.clock, 5); await rejected;
  const measured = s.collector.getAll()[0];
  assert.equal(measured.status, 'FAILED'); assert.deepEqual(measured.duration, ms(7));
  assert.equal(measured.toolAttempts.length, 1); assert.equal(measured.modelCalls.length, 1);
  assert.equal(measured.toolAttempts[0].status, 'TIMEOUT');
});

for (const choice of ['approve', 'reject']) {
  test(`approval ${choice} retains nonterminal suspension and explicitly includes human waiting in end-to-end elapsed`, async () => {
    const after = { ...read, callId: 'C' }, s = setup([read, risk, after], 3);
    const waiting = await s.agent.investigate(incident);
    assert.equal(waiting.status, 'AWAITING_APPROVAL');
    const before = s.collector.get(waiting.investigationId);
    assert.equal(before.status, 'AWAITING_APPROVAL'); assert.deepEqual(before.duration, { status: 'PENDING' });
    assert.equal(before.toolAttempts.length, 1); assert.deepEqual(before.approvalWaits, [{ duration: { status: 'PENDING' } }]);
    assert.equal(summarizeMeasurements([before]).investigationElapsed.observations, 0);
    s.clock.value += 1000;
    await assert.rejects(s.agent.resolveApproval({ ...decision(waiting), approvalId: 'wrong' }), /approval/);
    assert.deepEqual(s.collector.get(waiting.investigationId), before, 'Invalid decisions cannot close the suspension');
    const result = await s.agent.resolveApproval(decision(waiting, choice));
    const measured = s.collector.get(waiting.investigationId);
    assert.deepEqual(measured.approvalWaits, [{ duration: ms(1000) }]);
    assert.equal(result.investigationId, waiting.investigationId);
    assert.equal(measured.status, choice === 'approve' ? 'COMPLETED' : 'REJECTED');
    assert.deepEqual(measured.duration, ms(choice === 'approve' ? 1015 : 1005));
    assert.equal(measured.toolAttempts.length, choice === 'approve' ? 3 : 1);
    assert.equal(s.requests.length, choice === 'approve' ? 2 : 1);
    assert.ok(measured.boundary.includes('including-backoff-and-approval-wait'));
    await assert.rejects(s.agent.resolveApproval(decision(waiting)), /consumed/);
    assert.deepEqual(s.collector.get(waiting.investigationId), measured);
  });
}

test('approved risky timeout has one measured attempt, no automatic retry and no approval replay', async t => {
  const s = setup([risk], 8);
  t.mock.method(s.executor, 'execute', () => new Promise(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = await s.agent.investigate(incident);
  const rejected = assert.rejects(s.agent.resolveApproval(decision(waiting)), OperationTimeoutError);
  await advance(t, s.clock, 5); await rejected;
  const measured = s.collector.get(waiting.investigationId);
  assert.equal(measured.status, 'FAILED'); assert.equal(measured.toolAttempts.length, 1);
  assert.equal(measured.toolAttempts[0].toolName, 'restart_service');
  assert.equal(measured.toolAttempts[0].status, 'TIMEOUT');
  await assert.rejects(s.agent.resolveApproval(decision(waiting)), /consumed/);
  assert.equal(s.requests.length, 1);
});

test('overlapping investigations retain independent measurement and approval contexts', async () => {
  let clock = 0;
  const collector = new InvestigationMeasurements(() => clock);
  const agent = new AgentOrchestrator({ async respond(request) {
    clock += 2;
    return request.kind === 'initial' ? batch([{ ...risk, callId: JSON.parse(request.prompt).id }]) : final;
  } }, { async execute(call) { clock += 3; return output(call); } }, 2, 1, 50, 5, collector);
  const a = await agent.investigate(incidents[0]), b = await agent.investigate(incidents[1]);
  clock += 20;
  await agent.resolveApproval(decision(a));
  assert.equal(collector.get(a.investigationId).status, 'COMPLETED');
  assert.equal(collector.get(b.investigationId).status, 'AWAITING_APPROVAL');
  clock += 10;
  await agent.resolveApproval(decision(b, 'reject'));
  assert.equal(collector.get(b.investigationId).status, 'REJECTED');
  assert.deepEqual(collector.get(a.investigationId).toolAttempts.map(call => call.callId), [incidents[0].id]);
  assert.deepEqual(collector.get(b.investigationId).toolAttempts, []);
});

test('semantic fallback through actual MCP remains one measured tool attempt and one budget slot', async t => {
  let clock = 0;
  const collector = new InvestigationMeasurements(() => clock);
  const executor = await createTestExecutor(t, new RunbookRetriever({ async embed() { clock += 5; throw new SemanticRetrievalUnavailableError('controlled outage'); } }));
  const call = { callId: 'R', name: 'search_runbook', arguments: { query: 'cache', limit: 1 } };
  const agent = new AgentOrchestrator({ async respond(request) { clock += 2; return request.kind === 'initial' ? batch([call]) : final; } }, executor, 2, 1, 50, 50, collector);
  const result = await agent.investigate(incident), measured = collector.get(result.investigationId);
  assert.deepEqual(measured.toolAttempts, [{ sequence: 1, callId: 'R', toolName: 'search_runbook', attempt: 1, status: 'SUCCEEDED', duration: ms(5) }]);
  assert.deepEqual(measured.duration, ms(9)); assert.equal(result.status, 'COMPLETED');
});

test('invalid or failing clocks yield unavailable durations and observation failures do not replace Agent errors/results', async () => {
  let decreasing = 10;
  for (const clock of [() => NaN, () => { throw Error('clock unavailable'); }, () => decreasing--]) {
    const collector = new InvestigationMeasurements(clock);
    const agent = new AgentOrchestrator({ async respond() { return final; } }, {}, 2, 1, 50, 5, collector);
    assert.equal((await agent.investigate(incident)).status, 'COMPLETED');
    assert.equal(collector.getAll()[0].duration.status, 'NOT_AVAILABLE');
    assert.equal(summarizeMeasurements(collector.getAll()).investigationElapsed.mean, null);
  }
  const failure = new Error('original');
  const observer = { succeeded() { throw Error('measurement'); }, failed() { throw Error('measurement'); } };
  assert.equal(await withTimeout(async () => 42, 50, 'timeout', observer), 42);
  await assert.rejects(withTimeout(async () => { throw failure; }, 50, 'timeout', observer), error => error === failure);
});

test('report denominators include all terminal outcomes and empty/unavailable samples never become zero or NaN', async () => {
  let clock = 0;
  const collector = new InvestigationMeasurements(() => clock);
  await new AgentOrchestrator({ async respond() { clock += 2; return final; } }, {}, 2, 1, 50, 5, collector).investigate(incident);
  await assert.rejects(new AgentOrchestrator({ async respond() { clock += 3; throw Error('failure'); } }, {}, 2, 1, 50, 5, collector).investigate(incident));
  const agent = new AgentOrchestrator({ async respond() { clock += 1; return batch([risk]); } }, {}, 2, 1, 50, 5, collector);
  const waiting = await agent.investigate(incident); clock += 10; await agent.resolveApproval(decision(waiting, 'reject'));
  const summary = summarizeMeasurements(collector.getAll());
  assert.equal(summary.investigations.terminal, 3);
  assert.deepEqual(summary.investigations.outcomes, { RUNNING: 0, AWAITING_APPROVAL: 0, COMPLETED: 1, FAILED: 1, REJECTED: 1 });
  assert.equal(summary.investigationElapsed.mean, 16 / 3); assert.equal(summary.investigationElapsed.measured, 3);
  assert.equal(summary.modelCalls.count, 3); assert.equal(summary.toolAttempts.count, 0);
  assert.equal(summary.toolAttempts.durations.mean, null); assert.equal(summary.usage.completeTotal, null);
  assert.deepEqual(durationStatistics([]), { unit: 'milliseconds', observations: 0, measured: 0, pending: 0, notAvailable: 0, minimum: null, maximum: null, mean: null });
  assert.doesNotMatch(JSON.stringify(summarizeMeasurements([])), /NaN|Infinity/);
});

test('optional measured evaluation preserves both accepted scores and scripted usage is unavailable for all 60 model calls', async () => {
  const original = await runScriptedBaseline(), expanded = await runExpandedEvaluation(), measured = await runMeasuredEvaluation();
  assert.deepEqual(measured.results, expanded.results);
  assert.deepEqual(measured.results.slice(0, 5), original.results);
  assert.deepEqual(measured.scoring, expanded.summary);
  assert.deepEqual(await runScriptedBaseline(), original);
  assert.deepEqual(await runExpandedEvaluation(), expanded);
  const summary = measured.measurementSummary;
  assert.equal(summary.investigations.observed, 30); assert.equal(summary.investigations.outcomes.COMPLETED, 30);
  assert.equal(summary.modelCalls.count, 60); assert.equal(summary.toolAttempts.count, 120); assert.equal(summary.toolAttempts.retries, 0);
  assert.equal(summary.modelCalls.durations.measured, 60); assert.equal(summary.toolAttempts.durations.measured, 120);
  assert.deepEqual(summary.usage, { availability: 'NOT_AVAILABLE', modelCalls: 60, reportedCalls: 0, unavailableCalls: 60,
    knownSubtotal: null, completeTotal: null, reason: 'No observed provider-reported model usage; unavailable is not zero' });
  for (const record of measured.measurements) {
    assert.ok(record.duration.milliseconds >= 0 && Number.isFinite(record.duration.milliseconds));
    assert.ok(record.modelCalls.every(call => call.duration.milliseconds >= 0 && Number.isFinite(call.duration.milliseconds)));
    assert.ok(record.toolAttempts.every(call => call.duration.milliseconds >= 0 && Number.isFinite(call.duration.milliseconds)));
  }
});
