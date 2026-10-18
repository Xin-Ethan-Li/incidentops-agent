import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { AgentOrchestrator } from '../dist/agent/index.js';
import { ToolExecutor, MalformedMcpResultError } from '../dist/agent/tool-executor.js';
import { classifyToolFailure } from '../dist/agent/tool-retry-policy.js';
import { OperationTimeoutError } from '../dist/agent/with-timeout.js';
import { ToolError } from '../dist/tools/tool-error.js';
import { incidents } from '../dist/fixtures/index.js';

const incident = incidents[0];
const final = { kind: 'final', diagnosis: { summary: 'Evidence collected.', probableCause: 'Further investigation needed.', confidence: 'medium', evidence: [], recommendedActions: [] } };
const call = (callId, name = 'get_service_info') => ({ callId, name, arguments: { service: incident.service } });
const batch = calls => ({ kind: 'tool_calls', continuation: 'response', calls });
const output = (callId, source = 'retry') => ({ callId, output: JSON.stringify({ source }) });
const entry = (callId, status, toolName = 'get_service_info') => ({ callId, toolName, status });
const timeoutMessage = 'Agent tool execution timed out after 5ms';
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function advance(t, ms) {
  t.mock.timers.tick(ms);
  await nextTurn(); // Drain promise continuations before advancing the next deadline.
}
function start(t, execute, { calls = [call('A')], budget = 8, model } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts = [];
  const requests = [];
  const agent = new AgentOrchestrator(model ?? { async respond(request) {
    requests.push(request);
    return request.kind === 'initial' ? batch(calls) : final;
  } }, { execute(request) {
    attempts.push(request);
    return execute(request, attempts.length);
  } }, 8, budget, 50, 5);
  return { agent, attempts, requests, run: agent.investigate(incident) };
}
function assertFailed(agent, message, entries) {
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.equal(agent.currentRecord.failure, message);
  assert.deepEqual(agent.currentRecord.toolExecutions, entries);
  assert.ok(!Object.hasOwn(agent.currentRecord, 'diagnosis'));
}

for (const name of ['search_logs', 'get_metrics', 'get_service_info', 'search_runbook']) {
  test(`${name}: timeout then success waits 100ms and uses two slots for one logical output`, async t => {
    const request = call('A', name);
    const { agent, run, attempts, requests } = start(t, (request, attempt) =>
      attempt === 1 ? new Promise(() => {}) : Promise.resolve(output(request.callId)), { calls: [request], budget: 2 });
    await nextTurn();
    await advance(t, 5);
    assert.deepEqual(agent.currentRecord.toolExecutions, [entry('A', 'FAILED', name)]);
    assert.equal(agent.currentRecord.status, 'INVESTIGATING');
    await advance(t, 99);
    assert.equal(attempts.length, 1, 'Retry must not start before backoff finishes');
    assert.equal(requests.length, 1);
    await advance(t, 1);
    const result = await run;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], request);
    assert.equal(attempts[1], request, 'Internal retry retains the same callId and arguments');
    assert.deepEqual(result.toolExecutions, [entry('A', 'FAILED', name), entry('A', 'SUCCEEDED', name)]);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].outputs, [output('A')]);
    assert.equal(result.status, 'COMPLETED', 'Exact tool budget still permits the final diagnosis');
    assert.deepEqual(result.diagnosis, final.diagnosis);
  });
}

test('two application timeouts produce two failures and stop the batch without a third attempt', async t => {
  const { agent, run, attempts, requests } = start(t, () => new Promise(() => {}), { calls: [call('A'), call('B')] });
  const rejected = assert.rejects(run, error => error instanceof OperationTimeoutError && error.message === timeoutMessage);
  await nextTurn();
  await advance(t, 5);
  await advance(t, 100);
  assert.equal(attempts.length, 2);
  await advance(t, 5);
  await rejected;
  await advance(t, 1000);
  assert.deepEqual(attempts.map(item => item.callId), ['A', 'A']);
  assert.equal(requests.length, 1);
  assertFailed(agent, timeoutMessage, [entry('A', 'FAILED'), entry('A', 'FAILED')]);
});

test('last available slot propagates the first timeout without retry, backoff or budget-error replacement', async t => {
  const { agent, run, attempts, requests } = start(t, () => new Promise(() => {}), { budget: 1 });
  const timers = t.mock.method(globalThis, 'setTimeout');
  const rejected = assert.rejects(run, error => error instanceof OperationTimeoutError && error.message === timeoutMessage);
  await nextTurn();
  await advance(t, 5);
  await rejected;
  await advance(t, 1000);
  assert.equal(attempts.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(timers.mock.calls.filter(item => item.arguments[1] === 100).length, 0);
  assertFailed(agent, timeoutMessage, [entry('A', 'FAILED')]);
});

test('retry failure propagates the final original error and does not continue to later tools', async t => {
  const failure = new Error('retry read failed');
  const { agent, run, attempts, requests } = start(t, (_, attempt) => {
    if (attempt === 1) return new Promise(() => {});
    throw failure;
  }, { calls: [call('A'), call('B')] });
  const rejected = assert.rejects(run, error => error === failure);
  await nextTurn();
  await advance(t, 5);
  await advance(t, 100);
  await rejected;
  assert.deepEqual(attempts.map(item => item.callId), ['A', 'A']);
  assert.equal(requests.length, 1);
  assertFailed(agent, failure.message, [entry('A', 'FAILED'), entry('A', 'FAILED')]);
});

for (const [failure, classification] of [
  [new ToolError('INVALID_INPUT', 'invalid input'), 'NON_RETRYABLE'],
  [new ToolError('SERVICE_NOT_FOUND', 'missing service'), 'NON_RETRYABLE'],
  [new TypeError('query must be nonempty'), 'NON_RETRYABLE'],
  [new Error('unknown read failure'), 'UNKNOWN'],
  [new Error(timeoutMessage), 'UNKNOWN'],
]) {
  test(`${failure.name} ${failure.message} is ${classification} and preserves the original failure without retry`, async t => {
    assert.equal(classifyToolFailure('get_service_info', failure), classification);
    const { agent, run, attempts, requests } = start(t, () => Promise.reject(failure), { calls: [call('A'), call('B')] });
    await assert.rejects(run, error => error === failure);
    await advance(t, 1000);
    assert.equal(attempts.length, 1);
    assert.equal(requests.length, 1);
    assertFailed(agent, failure.message, [entry('A', 'FAILED')]);
  });
}

test('malformed MCP results are explicitly NON_RETRYABLE at the real executor boundary', async t => {
  for (const result of [null, {}, { content: [] }, { content: [{ type: 'image', data: 'x' }] },
    { content: [{ type: 'text', text: 'not json' }] }, { isError: 'false', content: [{ type: 'text', text: '{}' }] }]) {
    let mcpCalls = 0;
    const executor = new ToolExecutor({ async callTool() { mcpCalls++; return result; } });
    const { agent, run, attempts, requests } = start(t, request => executor.execute(request));
    await assert.rejects(run, error => {
      assert.ok(error instanceof MalformedMcpResultError);
      assert.match(error.message, /^Malformed MCP result/);
      assert.equal(classifyToolFailure('get_service_info', error), 'NON_RETRYABLE');
      return true;
    });
    assert.equal(attempts.length, 1);
    assert.equal(mcpCalls, 1);
    assert.equal(requests.length, 1);
    assert.equal(agent.currentRecord.status, 'FAILED');
    t.mock.timers.reset();
  }
});

test('unknown MCP isError and a serialized timeout-looking error stay generic and never retry', async t => {
  const executor = new ToolExecutor({ async callTool() {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { name: 'OperationTimeoutError', message: timeoutMessage } }) }] };
  } });
  const { agent, run, attempts, requests } = start(t, request => executor.execute(request));
  await assert.rejects(run, error => {
    assert.equal(error.constructor, Error);
    assert.equal(classifyToolFailure('get_service_info', error), 'UNKNOWN');
    return true;
  });
  await advance(t, 1000);
  assert.equal(attempts.length, 1);
  assert.equal(requests.length, 1);
  assertFailed(agent, timeoutMessage, [entry('A', 'FAILED')]);
});

test('typed SDK RequestTimeout propagates through ToolExecutor and may retry a read without reconnect', async t => {
  const failure = new SdkError(SdkErrorCode.RequestTimeout, 'SDK request timeout');
  assert.equal(classifyToolFailure('get_service_info', failure), 'RETRYABLE');
  let mcpCalls = 0;
  const executor = new ToolExecutor({ async callTool() {
    if (++mcpCalls === 1) throw failure;
    return { content: [{ type: 'text', text: output('A').output }] };
  } });
  const { run, attempts, requests } = start(t, request => executor.execute(request), { budget: 2 });
  await nextTurn();
  await advance(t, 99);
  assert.equal(mcpCalls, 1);
  await advance(t, 1);
  const result = await run;
  assert.equal(mcpCalls, 2);
  assert.equal(attempts.length, 2);
  assert.deepEqual(result.toolExecutions, [entry('A', 'FAILED'), entry('A', 'SUCCEEDED')]);
  assert.deepEqual(requests[1].outputs, [output('A')]);
  assert.equal(result.status, 'COMPLETED');
});

for (const code of [SdkErrorCode.ConnectionClosed, SdkErrorCode.SendFailed, SdkErrorCode.InvalidResult]) {
  test(`SDK ${code} is NON_RETRYABLE and never blindly reuses a failed transport`, async t => {
    const failure = new SdkError(code, 'SDK boundary failure');
    assert.equal(classifyToolFailure('get_service_info', failure), 'NON_RETRYABLE');
    const executor = new ToolExecutor({ async callTool() { throw failure; } });
    const { agent, run, attempts, requests } = start(t, request => executor.execute(request));
    await assert.rejects(run, error => error === failure);
    await advance(t, 1000);
    assert.equal(attempts.length, 1);
    assert.equal(requests.length, 1);
    assertFailed(agent, failure.message, [entry('A', 'FAILED')]);
  });
}

test('unrecognized SDK errors and timeout-shaped plain values remain UNKNOWN', () => {
  for (const failure of [new SdkError(SdkErrorCode.NotConnected, 'not connected'),
    Object.assign(new Error('timeout'), { code: SdkErrorCode.RequestTimeout }),
    { name: 'OperationTimeoutError', message: timeoutMessage }, 'timeout', null]) {
    assert.equal(classifyToolFailure('get_service_info', failure), 'UNKNOWN');
  }
});

test('future risky or unknown tool names do not inherit timeout retry', async t => {
  for (const name of ['restart_service', 'constructor', 'toString', '__proto__']) {
    assert.equal(classifyToolFailure(name, new OperationTimeoutError(timeoutMessage)), 'NON_RETRYABLE');
    assert.equal(classifyToolFailure(name, new SdkError(SdkErrorCode.RequestTimeout, 'SDK timeout')), 'NON_RETRYABLE');
  }
  const { agent, run, attempts, requests } = start(t, () => new Promise(() => {}), { calls: [call('A', 'restart_service')] });
  const waiting = await run;
  assert.equal(waiting.status, 'AWAITING_APPROVAL');
  assert.equal(attempts.length, 0);
  const rejected = assert.rejects(agent.resolveApproval({ investigationId: waiting.investigationId,
    approvalId: waiting.pendingApproval.approvalId, decision: 'approve' }),
  error => error instanceof OperationTimeoutError && error.message === timeoutMessage);
  await nextTurn();
  await advance(t, 5);
  await rejected;
  await advance(t, 1000);
  assert.equal(attempts.length, 1);
  assert.equal(requests.length, 1);
  assertFailed(agent, timeoutMessage, [entry('A', 'FAILED', 'restart_service')]);
});

test('typed model timeout still fails immediately without any model retry', async t => {
  let turns = 0;
  const { agent, run, attempts } = start(t, () => assert.fail('No tools'), { model: { respond() {
    turns++;
    return new Promise(() => {});
  } } });
  const rejected = assert.rejects(run, error => error instanceof OperationTimeoutError && error.message === 'Agent model response timed out after 50ms');
  await advance(t, 50);
  await rejected;
  await advance(t, 1000);
  assert.equal(turns, 1);
  assert.equal(attempts.length, 0);
  assertFailed(agent, 'Agent model response timed out after 50ms', []);
});

test('late first-attempt success cannot overwrite retry evidence or the completed record', async t => {
  const first = deferred();
  const { agent, run, attempts, requests } = start(t, (request, attempt) =>
    attempt === 1 ? first.promise : Promise.resolve(output(request.callId)), { budget: 2 });
  await nextTurn();
  await advance(t, 5);
  await advance(t, 100);
  const result = await run;
  first.resolve(output('A', 'late first attempt'));
  await nextTurn();
  assert.equal(attempts.length, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].outputs, [output('A')]);
  assert.deepEqual(agent.currentRecord, result);
  assert.equal(result.status, 'COMPLETED');
});

test('late first-attempt rejection is observed and cannot replace the final retry failure', async t => {
  const first = deferred();
  const failure = new TypeError('retry validation failed');
  const { agent, run, requests } = start(t, (_, attempt) => attempt === 1 ? first.promise : Promise.reject(failure));
  const rejected = assert.rejects(run, error => error === failure);
  await nextTurn();
  await advance(t, 5);
  await advance(t, 100);
  await rejected;
  first.reject(new Error('late first rejection'));
  await nextTurn();
  assert.equal(requests.length, 1);
  assertFailed(agent, failure.message, [entry('A', 'FAILED'), entry('A', 'FAILED')]);
});

for (const budget of [2, 3]) {
  test(`A retries successfully; B executes only with remaining budget (${budget} slots)`, async t => {
    const { agent, run, attempts, requests } = start(t, (request, attempt) =>
      attempt === 1 ? new Promise(() => {}) : Promise.resolve(output(request.callId)), { calls: [call('A'), call('B')], budget });
    const completion = budget === 2 ? assert.rejects(run, { message: 'Agent tool-call budget exhausted (2)' }) : run;
    await nextTurn();
    await advance(t, 5);
    await advance(t, 100);
    await completion;
    const history = [entry('A', 'FAILED'), entry('A', 'SUCCEEDED')];
    if (budget === 2) {
      assert.deepEqual(attempts.map(item => item.callId), ['A', 'A']);
      assert.equal(requests.length, 1);
      assertFailed(agent, 'Agent tool-call budget exhausted (2)', history);
    } else {
      assert.deepEqual(attempts.map(item => item.callId), ['A', 'A', 'B']);
      assert.equal(agent.currentRecord.status, 'COMPLETED');
      assert.deepEqual(agent.currentRecord.toolExecutions, [...history, entry('B', 'SUCCEEDED')]);
      assert.deepEqual(requests[1].outputs, [output('A'), output('B')]);
    }
  });
}
