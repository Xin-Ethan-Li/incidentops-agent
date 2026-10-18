import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { AgentOrchestrator } from '../dist/agent/index.js';
import { OperationTimeoutError } from '../dist/agent/with-timeout.js';
import { RunbookRetriever } from '../dist/rag/index.js';
import { restartService, ToolError } from '../dist/tools/index.js';
import * as fixtures from '../dist/fixtures/index.js';
import { createTestExecutor } from './fixtures/mcp-memory.js';

const incident = fixtures.incidents[0];
const read = (id, service = incident.service) => ({ callId: id, name: 'get_service_info', arguments: { service } });
const risky = (id = 'B', service = incident.service) => ({ callId: id, name: 'restart_service', arguments: { service } });
const batch = (...calls) => ({ kind: 'tool_calls', continuation: 'original-response', calls });
const final = { kind: 'final', diagnosis: { summary: 'Investigation complete.', probableCause: 'Further investigation needed.', confidence: 'medium', evidence: [], recommendedActions: [] } };
const output = call => ({ callId: call.callId, output: JSON.stringify(call.name === 'restart_service'
  ? restartService(call.arguments) : { service: call.arguments.service }) });
const entry = (id, name = 'get_service_info', status = 'SUCCEEDED') => ({ callId: id, toolName: name, status });
const decision = (waiting, choice = 'approve') => ({ investigationId: waiting.investigationId,
  approvalId: waiting.pendingApproval.approvalId, decision: choice });
function modelFor(...responses) {
  const seen = [];
  return { seen, async respond(request) {
    seen.push(structuredClone(request));
    const response = responses[seen.length - 1];
    assert.ok(response, 'Unexpected model call');
    return response;
  } };
}
function setup(responses = [batch(risky()), final], { budget = 8, turns = 8, execute } = {}) {
  const model = modelFor(...responses);
  const calls = [];
  const executor = { async execute(call) {
    calls.push(structuredClone(call));
    return execute ? execute(call, calls.length) : output(call);
  } };
  return { agent: new AgentOrchestrator(model, executor, turns, budget, 50, 5), model, calls };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function advance(t, ms) {
  t.mock.timers.tick(ms);
  await nextTurn();
}
beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Approval tests must not access the network'));
});

test('restart simulator returns repeatable explicit simulation data and never mutates fixtures', () => {
  const before = structuredClone({ ...fixtures });
  const expected = { service: incident.service, action: 'restart_service', simulated: true, status: 'SIMULATED' };
  assert.deepEqual(restartService({ service: incident.service }), expected);
  assert.deepEqual(restartService({ service: incident.service }), expected);
  assert.deepEqual({ ...fixtures }, before);
  for (const service of ['', ' ', 42, null]) assert.throws(() => restartService({ service }),
    error => error instanceof ToolError && error.code === 'INVALID_INPUT');
  assert.throws(() => restartService({ service: 'unknown-service' }),
    error => error instanceof ToolError && error.code === 'SERVICE_NOT_FOUND');
});

test('risk request pauses before executor or MCP; approval uses one slot and returns simulated evidence', async t => {
  const retriever = new RunbookRetriever({ embed() { assert.fail('No runbook requested'); } });
  const executor = await createTestExecutor(t, retriever);
  const execute = t.mock.method(executor, 'execute');
  const mcp = t.mock.method(executor.client, 'callTool');
  const model = modelFor(batch(risky()), final);
  const agent = new AgentOrchestrator(model, executor, 2, 1);
  const waiting = await agent.investigate(incident);
  assert.equal(waiting.status, 'AWAITING_APPROVAL');
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(mcp.mock.callCount(), 0);
  assert.equal(model.seen.length, 1);
  assert.deepEqual(waiting.toolExecutions, []);
  assert.deepEqual(waiting.pendingApproval, { investigationId: waiting.investigationId,
    approvalId: waiting.pendingApproval.approvalId, callId: 'B', toolName: 'restart_service', arguments: { service: incident.service } });
  assert.match(waiting.pendingApproval.approvalId, /^[0-9a-f-]{36}$/);
  const result = await agent.resolveApproval(decision(waiting));
  assert.equal(result.investigationId, waiting.investigationId);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(mcp.mock.callCount(), 1);
  assert.deepEqual(result.toolExecutions, [entry('B', 'restart_service')]);
  assert.deepEqual(model.seen[1].outputs, [output(risky())]);
  assert.ok(!Object.hasOwn(result, 'pendingApproval'));
});

test('read A / risky B / read C suspends the batch and resumes its original outputs and response ID', async () => {
  const proposal = batch(read('A'), risky(), read('C'));
  const { agent, model, calls } = setup([proposal, final], { budget: 3, turns: 2 });
  const waiting = await agent.investigate(incident);
  assert.deepEqual(calls, [read('A')]);
  assert.deepEqual(waiting.toolExecutions, [entry('A')]);
  assert.equal(model.seen.length, 1);
  const result = await agent.resolveApproval(decision(waiting));
  assert.equal(result.investigationId, waiting.investigationId);
  assert.deepEqual(calls, [read('A'), risky(), read('C')]);
  assert.deepEqual(result.toolExecutions, [entry('A'), entry('B', 'restart_service'), entry('C')]);
  assert.equal(model.seen.length, 2);
  assert.deepEqual(model.seen[1], { kind: 'continuation', continuation: 'original-response',
    outputs: [output(read('A')), output(risky()), output(read('C'))] });
  assert.equal(result.status, 'COMPLETED');
});

test('rejection retains prior history, executes neither B nor C and returns terminal REJECTED', async () => {
  const { agent, model, calls } = setup([batch(read('A'), risky(), read('C')), final]);
  const waiting = await agent.investigate(incident);
  const result = await agent.resolveApproval(decision(waiting, 'reject'));
  assert.equal(result.investigationId, waiting.investigationId);
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.rejection, 'Human rejected restart_service');
  assert.deepEqual(result.toolExecutions, [entry('A')]);
  assert.deepEqual(calls, [read('A')]);
  assert.equal(model.seen.length, 1);
  assert.ok(!Object.hasOwn(result, 'diagnosis'));
  assert.ok(!Object.hasOwn(result, 'failure'));
  assert.ok(!Object.hasOwn(result, 'pendingApproval'));
  await assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
});

test('rejection after the read budget is used neither executes nor substitutes a budget failure', async () => {
  const { agent, model, calls } = setup([batch(read('A'), risky())], { budget: 1 });
  const waiting = await agent.investigate(incident);
  assert.equal(waiting.status, 'AWAITING_APPROVAL');
  const rejected = await agent.resolveApproval(decision(waiting, 'reject'));
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(model.seen.length, 1);
  assert.deepEqual(calls, [read('A')]);
  assert.deepEqual(rejected.toolExecutions, [entry('A')]);
});

for (const field of ['investigationId', 'approvalId']) {
  test(`unknown ${field} is rejected without consuming the genuine approval`, async () => {
    const { agent, calls } = setup();
    const waiting = await agent.investigate(incident);
    await assert.rejects(agent.resolveApproval({ ...decision(waiting), [field]: 'unknown' }), /consumed approval/);
    assert.equal(agent.currentRecord.status, 'AWAITING_APPROVAL');
    assert.deepEqual(calls, []);
    assert.equal((await agent.resolveApproval(decision(waiting))).status, 'COMPLETED');
    assert.equal(calls.length, 1);
  });
}

test('approval API rejects argument substitution, extra authorization fields and invalid decisions', async () => {
  const { agent, calls } = setup();
  const waiting = await agent.investigate(incident);
  for (const input of [null, 'approve', {}, { ...decision(waiting), decision: true },
    { ...decision(waiting), decision: 'auto' }, { ...decision(waiting), service: 'payment-api' },
    { ...decision(waiting), arguments: { service: 'payment-api' } },
    { ...decision(waiting), callId: 'another' }, { ...decision(waiting), approved: true }]) {
    await assert.rejects(agent.resolveApproval(input), TypeError);
  }
  assert.deepEqual(calls, []);
  await agent.resolveApproval(decision(waiting));
  assert.deepEqual(calls, [risky()]);
});

test('caller snapshots and model-owned proposal mutations cannot change the approved operation or remaining batch', async () => {
  const proposal = batch(risky(), read('C'));
  const { agent, model, calls } = setup([proposal, final]);
  const waiting = await agent.investigate(incident);
  const approve = decision(waiting);
  waiting.pendingApproval.arguments.service = 'payment-api';
  waiting.pendingApproval.callId = 'substituted';
  waiting.toolExecutions.push(entry('fake'));
  const snapshot = agent.currentRecord;
  snapshot.pendingApproval.arguments.service = 'inventory-api';
  proposal.calls[0].arguments.service = 'notification-api';
  proposal.calls[0].callId = 'changed-model-id';
  proposal.calls[1].name = 'delete_database';
  proposal.continuation = 'changed-model-response';
  const result = await agent.resolveApproval(approve);
  assert.deepEqual(calls, [risky(), read('C')]);
  assert.equal(model.seen[1].continuation, 'original-response');
  assert.deepEqual(result.toolExecutions, [entry('B', 'restart_service'), entry('C')]);
  result.toolExecutions.length = 0;
  result.diagnosis.summary = 'caller changed';
  assert.deepEqual(agent.currentRecord.toolExecutions, [entry('B', 'restart_service'), entry('C')]);
  assert.equal(agent.currentRecord.diagnosis.summary, final.diagnosis.summary);
});

test('model-supplied approval-looking fields cannot auto-approve a risky request', async () => {
  const { agent, calls, model } = setup([{ ...batch(risky()), decision: 'approve', approved: true }, final]);
  const waiting = await agent.investigate(incident);
  assert.equal(waiting.status, 'AWAITING_APPROVAL');
  assert.equal(calls.length, 0);
  assert.equal(model.seen.length, 1);
  await agent.resolveApproval(decision(waiting, 'reject'));
});

test('repeated approval after completion cannot replay the simulated action', async () => {
  const { agent, calls, model } = setup();
  const waiting = await agent.investigate(incident);
  await agent.resolveApproval(decision(waiting));
  await assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
  await assert.rejects(agent.resolveApproval(decision(waiting, 'reject')), /consumed approval/);
  assert.equal(calls.length, 1);
  assert.equal(model.seen.length, 2);
  assert.equal(agent.currentRecord.status, 'COMPLETED');
});

test('concurrent approve/approve/reject claims execute at most once before the first await', async () => {
  const pending = deferred();
  const { agent, calls } = setup(undefined, { execute: () => pending.promise });
  const waiting = await agent.investigate(incident);
  const first = agent.resolveApproval(decision(waiting));
  const second = assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
  const reject = assert.rejects(agent.resolveApproval(decision(waiting, 'reject')), /consumed approval/);
  await nextTurn();
  assert.equal(calls.length, 1);
  pending.resolve(output(risky()));
  assert.equal((await first).status, 'COMPLETED');
  await second;
  await reject;
});

test('a concurrent rejection claims the approval and prevents a competing approval from executing', async () => {
  const { agent, calls, model } = setup();
  const waiting = await agent.investigate(incident);
  const rejected = agent.resolveApproval(decision(waiting, 'reject'));
  await assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
  assert.equal((await rejected).status, 'REJECTED');
  assert.equal(calls.length, 0);
  assert.equal(model.seen.length, 1);
});

test('each risky call in a batch needs a fresh approval and previous tokens cannot approve the next call', async () => {
  const { agent, calls, model } = setup([batch(risky('B'), risky('D', 'payment-api')), final], { budget: 2, turns: 2 });
  const first = await agent.investigate(incident);
  const second = await agent.resolveApproval(decision(first));
  assert.equal(second.status, 'AWAITING_APPROVAL');
  assert.equal(second.investigationId, first.investigationId);
  assert.equal(second.pendingApproval.callId, 'D');
  assert.notEqual(second.pendingApproval.approvalId, first.pendingApproval.approvalId);
  assert.deepEqual(second.toolExecutions, [entry('B', 'restart_service')]);
  await assert.rejects(agent.resolveApproval(decision(first)), /consumed approval/);
  assert.equal(calls.length, 1);
  const completed = await agent.resolveApproval(decision(second));
  assert.equal(completed.status, 'COMPLETED');
  assert.deepEqual(calls, [risky('B'), risky('D', 'payment-api')]);
  assert.equal(model.seen[1].outputs.length, 2);
});

test('approved risky timeout consumes one slot, is never retried or replayed, and ignores late completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const { agent, calls, model } = setup([batch(risky(), read('C')), final], { execute: () => pending.promise });
  const waiting = await agent.investigate(incident);
  const rejected = assert.rejects(agent.resolveApproval(decision(waiting)), error =>
    error instanceof OperationTimeoutError && error.message === 'Agent tool execution timed out after 5ms');
  await nextTurn();
  await advance(t, 5);
  await rejected;
  await advance(t, 1000);
  assert.equal(calls.length, 1);
  assert.equal(model.seen.length, 1);
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.deepEqual(agent.currentRecord.toolExecutions, [entry('B', 'restart_service', 'FAILED')]);
  await assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
  const failed = agent.currentRecord;
  pending.resolve(output(risky()));
  await nextTurn();
  assert.deepEqual(agent.currentRecord, failed);
});

for (const failure of [new Error('simulator failed'), new SdkError(SdkErrorCode.RequestTimeout, 'SDK timeout')]) {
  test(`${failure.message}: approved risky failure propagates unchanged without retry or later tools`, async () => {
    const { agent, model, calls } = setup([batch(risky(), read('C')), final], { execute: () => { throw failure; } });
    const waiting = await agent.investigate(incident);
    await assert.rejects(agent.resolveApproval(decision(waiting)), error => error === failure);
    assert.equal(agent.currentRecord.status, 'FAILED');
    assert.equal(agent.currentRecord.failure, failure.message);
    assert.deepEqual(agent.currentRecord.toolExecutions, [entry('B', 'restart_service', 'FAILED')]);
    assert.deepEqual(calls, [risky()]);
    assert.equal(model.seen.length, 1);
    await assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
  });
}

test('approval with an exhausted budget fails before risky execution and creates no fake record', async () => {
  const { agent, model, calls } = setup([batch(read('A'), risky(), read('C')), final], { budget: 1 });
  const waiting = await agent.investigate(incident);
  assert.equal(waiting.status, 'AWAITING_APPROVAL');
  await assert.rejects(agent.resolveApproval(decision(waiting)), { message: 'Agent tool-call budget exhausted (1)' });
  assert.deepEqual(calls, [read('A')]);
  assert.deepEqual(agent.currentRecord.toolExecutions, [entry('A')]);
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.equal(model.seen.length, 1);
  await assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
});

test('approval consumes the remaining slot, preventing later batch tools after budget exhaustion', async () => {
  const { agent, calls, model } = setup([batch(read('A'), risky(), read('C')), final], { budget: 2 });
  const waiting = await agent.investigate(incident);
  await assert.rejects(agent.resolveApproval(decision(waiting)), { message: 'Agent tool-call budget exhausted (2)' });
  assert.deepEqual(calls, [read('A'), risky()]);
  assert.deepEqual(agent.currentRecord.toolExecutions, [entry('A'), entry('B', 'restart_service')]);
  assert.equal(model.seen.length, 1);
});

test('tool attempts spent on read retries before suspension remain spent on approval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { agent, calls, model } = setup([batch(read('A'), risky()), final], { budget: 2,
    execute: (call, attempt) => attempt === 1 ? new Promise(() => {}) : output(call) });
  const run = agent.investigate(incident);
  await nextTurn();
  await advance(t, 5);
  await advance(t, 100);
  const waiting = await run;
  assert.deepEqual(waiting.toolExecutions, [entry('A', 'get_service_info', 'FAILED'), entry('A')]);
  await assert.rejects(agent.resolveApproval(decision(waiting)), /budget exhausted \(2\)/);
  assert.deepEqual(calls, [read('A'), read('A')]);
  assert.equal(model.seen.length, 1);
});

test('read retries after approved execution still use the same remaining budget and preserve one output per call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { agent, model, calls } = setup([batch(risky(), read('C')), final], { budget: 3,
    execute: (call, attempt) => attempt === 2 ? new Promise(() => {}) : output(call) });
  const waiting = await agent.investigate(incident);
  const resumed = agent.resolveApproval(decision(waiting));
  await nextTurn();
  await advance(t, 5);
  await advance(t, 100);
  const result = await resumed;
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(calls, [risky(), read('C'), read('C')]);
  assert.deepEqual(result.toolExecutions, [entry('B', 'restart_service'), entry('C', 'get_service_info', 'FAILED'), entry('C')]);
  assert.deepEqual(model.seen[1].outputs, [output(risky()), output(read('C'))]);
});

test('resumption retains model-turn progress and final-turn requests remain unexecuted', async () => {
  const { agent, model, calls } = setup([batch(read('A')), batch(risky()), batch(read('C'))], { turns: 3 });
  const waiting = await agent.investigate(incident);
  assert.equal(model.seen.length, 2);
  await assert.rejects(agent.resolveApproval(decision(waiting)), { message: 'Agent model turn limit reached (3)' });
  assert.equal(model.seen.length, 3);
  assert.deepEqual(calls, [read('A'), risky()]);
  assert.deepEqual(agent.currentRecord.toolExecutions, [entry('A'), entry('B', 'restart_service')]);
});

test('risky requests on the final model turn never execute or create pending approval', async () => {
  const { agent, calls } = setup([batch(risky())], { turns: 1 });
  await assert.rejects(agent.investigate(incident), /turn limit reached \(1\)/);
  assert.equal(calls.length, 0);
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.deepEqual(agent.currentRecord.toolExecutions, []);
  assert.ok(!Object.hasOwn(agent.currentRecord, 'pendingApproval'));
});

test('used model call IDs survive approval and cannot be reused in continuation', async () => {
  const { agent, calls } = setup([batch(read('A'), risky()), batch(read('B'))]);
  const waiting = await agent.investigate(incident);
  await assert.rejects(agent.resolveApproval(decision(waiting)), /Reused tool callId/);
  assert.deepEqual(calls, [read('A'), risky()]);
  assert.deepEqual(agent.currentRecord.toolExecutions, [entry('A'), entry('B', 'restart_service')]);
});

test('two investigations keep approvals, services and execution histories independent', async () => {
  const { agent, calls } = setup([batch(risky('B', 'checkout-api')), batch(risky('B', 'payment-api')), final, final]);
  const first = await agent.investigate(incident);
  const second = await agent.investigate(fixtures.incidents[1]);
  await assert.rejects(agent.resolveApproval({ ...decision(first), investigationId: second.investigationId }), /consumed approval/);
  await assert.rejects(agent.resolveApproval({ ...decision(second), investigationId: first.investigationId }), /consumed approval/);
  const completedFirst = await agent.resolveApproval(decision(first));
  assert.equal(agent.currentRecord.investigationId, second.investigationId);
  assert.equal(agent.currentRecord.status, 'AWAITING_APPROVAL');
  assert.deepEqual(agent.currentRecord.toolExecutions, []);
  const completedSecond = await agent.resolveApproval(decision(second));
  assert.equal(completedFirst.investigationId, first.investigationId);
  assert.equal(completedSecond.investigationId, second.investigationId);
  assert.deepEqual(calls, [risky('B', 'checkout-api'), risky('B', 'payment-api')]);
  assert.deepEqual(completedFirst.toolExecutions, [entry('B', 'restart_service')]);
  assert.deepEqual(completedSecond.toolExecutions, [entry('B', 'restart_service')]);
});

test('resuming an older investigation never replaces currentRecord for a newer completed investigation', async () => {
  const { agent } = setup([batch(risky()), final, final]);
  const waiting = await agent.investigate(incident);
  const newer = await agent.investigate(fixtures.incidents[1]);
  const older = await agent.resolveApproval(decision(waiting));
  assert.equal(older.investigationId, waiting.investigationId);
  assert.equal(older.status, 'COMPLETED');
  assert.deepEqual(agent.currentRecord, newer);
});

test('invalid proposed service cannot become a successful simulated restart after approval', async t => {
  const executor = await createTestExecutor(t, new RunbookRetriever({ embed() { assert.fail('No retrieval'); } }));
  const model = modelFor(batch(risky('B', 'unknown-service')), final);
  const agent = new AgentOrchestrator(model, executor);
  const waiting = await agent.investigate(incident);
  await assert.rejects(agent.resolveApproval(decision(waiting)), error => error instanceof ToolError && error.code === 'SERVICE_NOT_FOUND');
  assert.equal(model.seen.length, 1);
  assert.deepEqual(agent.currentRecord.toolExecutions, [entry('B', 'restart_service', 'FAILED')]);
});
