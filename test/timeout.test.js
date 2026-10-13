import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AgentOrchestrator } from '../dist/agent/index.js';
import { withTimeout } from '../dist/agent/with-timeout.js';
import { incidents } from '../dist/fixtures/index.js';

const incident = incidents[0];
const final = { kind: 'final', diagnosis: { summary: 'Evidence collected.', probableCause: 'Further investigation needed.', confidence: 'medium', evidence: [], recommendedActions: [] } };
const batch = (...ids) => ({ kind: 'tool_calls', continuation: 'response', calls: ids.map(callId => ({ callId, name: 'get_service_info', arguments: { service: incident.service } })) });
const output = callId => ({ callId, output: '{"evidence":"service info"}' });
const execution = (callId, status) => ({ callId, toolName: 'get_service_info', status });
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function assertFailed(agent, message, executions = []) {
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.equal(agent.currentRecord.failure, message);
  assert.deepEqual(agent.currentRecord.toolExecutions, executions);
  assert.ok(!Object.hasOwn(agent.currentRecord, 'diagnosis'));
}

test('model timeout fails the investigation without tools; a late response cannot resume it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  let turns = 0;
  const agent = new AgentOrchestrator({ respond() { turns++; return pending.promise; } }, {
    execute() { assert.fail('No tools after model timeout'); },
  }, 8, 8, 5, 50);
  const run = agent.investigate(incident);
  const rejected = assert.rejects(run, { message: 'Agent model response timed out after 5ms' });
  t.mock.timers.tick(4);
  assert.equal(agent.currentRecord.status, 'STARTED');
  t.mock.timers.tick(1);
  await rejected;
  assertFailed(agent, 'Agent model response timed out after 5ms');
  pending.resolve(batch('late-tool'));
  await nextTurn();
  assert.equal(turns, 1);
  assertFailed(agent, 'Agent model response timed out after 5ms');
});

test('model response before the deadline preserves the validated final diagnosis', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const agent = new AgentOrchestrator({ respond() { return pending.promise; } }, {
    execute() { assert.fail('Final response needs no tool'); },
  }, 8, 8, 5, 5);
  const run = agent.investigate(incident);
  t.mock.timers.tick(4);
  pending.resolve(final);
  const result = await run;
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.diagnosis, final.diagnosis);
  assert.deepEqual(result.toolExecutions, []);
  t.mock.timers.tick(100);
  assert.equal(agent.currentRecord.status, 'COMPLETED');
});

test('each continuation model response gets its own timeout boundary', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initial = deferred();
  const continuationStarted = deferred();
  let turns = 0;
  const agent = new AgentOrchestrator({ respond(request) {
    if (++turns === 1) return initial.promise;
    assert.deepEqual(request.outputs, [output('A')]);
    continuationStarted.resolve();
    return new Promise(() => {});
  } }, { async execute(call) { return output(call.callId); } }, 8, 8, 5, 50);
  const run = agent.investigate(incident);
  const rejected = assert.rejects(run, { message: 'Agent model response timed out after 5ms' });
  t.mock.timers.tick(4);
  initial.resolve(batch('A'));
  await continuationStarted.promise;
  t.mock.timers.tick(4);
  assert.equal(agent.currentRecord.status, 'INVESTIGATING');
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(turns, 2);
  assertFailed(agent, 'Agent model response timed out after 5ms', [execution('A', 'SUCCEEDED')]);
});

test('tool timeout uses one attempt, records failure and stops the batch without continuation or late evidence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const started = deferred();
  let turns = 0;
  const attempts = [];
  const agent = new AgentOrchestrator({ async respond() { turns++; return batch('A', 'B'); } }, {
    execute(call) { attempts.push(call.callId); started.resolve(); return pending.promise; },
  }, 8, 1, 50, 5);
  const run = agent.investigate(incident);
  const rejected = assert.rejects(run, { message: 'Agent tool execution timed out after 5ms' });
  await started.promise;
  t.mock.timers.tick(4);
  assert.equal(agent.currentRecord.status, 'INVESTIGATING');
  assert.deepEqual(agent.currentRecord.toolExecutions, []);
  t.mock.timers.tick(1);
  await rejected;
  assert.deepEqual(attempts, ['A']); // The one available slot was used by the timed-out attempt.
  assert.equal(turns, 1);
  assertFailed(agent, 'Agent tool execution timed out after 5ms', [execution('A', 'FAILED')]);
  pending.resolve(output('A'));
  await nextTurn();
  assert.deepEqual(attempts, ['A']);
  assert.equal(turns, 1);
  assertFailed(agent, 'Agent tool execution timed out after 5ms', [execution('A', 'FAILED')]);
});

test('ordinary synchronous tool failure preserves the original error and terminates immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = new Error('tool failed');
  let turns = 0;
  const attempts = [];
  const agent = new AgentOrchestrator({ async respond() { turns++; return batch('A', 'B'); } }, {
    execute(call) { attempts.push(call.callId); throw failure; },
  }, 8, 1, 5, 5);
  await assert.rejects(agent.investigate(incident), error => error === failure);
  assert.equal(turns, 1);
  assert.deepEqual(attempts, ['A']);
  assertFailed(agent, 'tool failed', [execution('A', 'FAILED')]);
  t.mock.timers.tick(100);
  assertFailed(agent, 'tool failed', [execution('A', 'FAILED')]);
});

test('ordinary model rejection preserves its original error rather than becoming a timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = new TypeError('model failed');
  const agent = new AgentOrchestrator({ async respond() { throw failure; } }, {
    execute() { assert.fail('No response to execute'); },
  }, 8, 8, 5, 5);
  await assert.rejects(agent.investigate(incident), error => error === failure);
  assertFailed(agent, 'model failed');
  t.mock.timers.tick(100);
  assertFailed(agent, 'model failed');
});

test('tool success before the deadline returns unchanged evidence and allows an exact-budget final diagnosis', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const started = deferred();
  let turns = 0;
  const agent = new AgentOrchestrator({ async respond(request) {
    if (++turns === 1) return batch('A');
    assert.equal(request.kind, 'continuation');
    assert.equal(request.continuation, 'response');
    assert.deepEqual(request.outputs, [output('A')]);
    return final;
  } }, { execute() { started.resolve(); return pending.promise; } }, 2, 1, 5, 5);
  const run = agent.investigate(incident);
  await started.promise;
  t.mock.timers.tick(4);
  pending.resolve(output('A'));
  const result = await run;
  assert.equal(turns, 2);
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.toolExecutions, [execution('A', 'SUCCEEDED')]);
  assert.deepEqual(result.diagnosis, final.diagnosis);
});

for (const [name, index] of [['modelTimeoutMs', 0], ['toolTimeoutMs', 1]]) {
  test(`${name} rejects invalid values and accepts the supported timer boundaries`, () => {
    for (const invalid of [0, -1, 1.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 2_147_483_648, '5', null, true, 5n]) {
      const timeouts = [5, 5];
      timeouts[index] = invalid;
      assert.throws(() => new AgentOrchestrator({}, {}, 8, 8, ...timeouts), {
        name: 'TypeError', message: `${name} must be a positive safe integer no greater than 2147483647`,
      });
    }
    for (const valid of [1, 2_147_483_647]) {
      const timeouts = [5, 5];
      timeouts[index] = valid;
      assert.doesNotThrow(() => new AgentOrchestrator({}, {}, 8, 8, ...timeouts));
    }
  });
}

test('default model timeout is 30000ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const agent = new AgentOrchestrator({ respond() { return new Promise(() => {}); } }, {});
  const rejected = assert.rejects(agent.investigate(incident), { message: 'Agent model response timed out after 30000ms' });
  t.mock.timers.tick(29_999);
  assert.equal(agent.currentRecord.status, 'STARTED');
  t.mock.timers.tick(1);
  await rejected;
  assertFailed(agent, 'Agent model response timed out after 30000ms');
});

test('default tool timeout is 30000ms with no remaining retry budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred();
  const agent = new AgentOrchestrator({ async respond() { return batch('A'); } }, {
    execute() { started.resolve(); return new Promise(() => {}); },
  }, 8, 1);
  const rejected = assert.rejects(agent.investigate(incident), { message: 'Agent tool execution timed out after 30000ms' });
  await started.promise;
  t.mock.timers.tick(29_999);
  assert.equal(agent.currentRecord.status, 'INVESTIGATING');
  t.mock.timers.tick(1);
  await rejected;
  assertFailed(agent, 'Agent tool execution timed out after 30000ms', [execution('A', 'FAILED')]);
});

test('timeout helper clears its timer after success and preserves the original result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const result = { evidence: 'unchanged' };
  assert.equal(await withTimeout(() => Promise.resolve(result), 5, 'expired'), result);
  assert.equal(clear.mock.callCount(), 1);
  t.mock.timers.tick(100);
});

test('timeout helper clears its timer and preserves both async and synchronous errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const failure = new Error('original');
  await assert.rejects(withTimeout(() => Promise.reject(failure), 5, 'expired'), error => error === failure);
  assert.equal(clear.mock.callCount(), 1);
  await assert.rejects(withTimeout(() => { throw failure; }, 5, 'expired'), error => error === failure);
  assert.equal(clear.mock.callCount(), 2);
  t.mock.timers.tick(100);
});

test('timeout helper clears its timer on expiry and observes late operation rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const pending = deferred();
  const rejected = assert.rejects(withTimeout(() => pending.promise, 5, 'expired'), { message: 'expired' });
  t.mock.timers.tick(5);
  await rejected;
  assert.equal(clear.mock.callCount(), 1);
  pending.reject(new Error('late rejection')); // node:test fails on an unhandled rejection.
  await nextTurn();
});
