import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOrchestrator } from '../dist/agent/index.js';
import { incidents } from '../dist/fixtures/index.js';

const incident = incidents[0];
const batch = (...ids) => ({ kind: 'tool_calls', continuation: 'response', calls: ids.map(callId => ({ callId, name: 'get_service_info', arguments: { service: incident.service } })) });
const final = { kind: 'final', diagnosis: { summary: 'Evidence collected.', probableCause: 'Further investigation needed.', confidence: 'medium', evidence: [], recommendedActions: [] } };
const output = call => ({ callId: call.callId, output: '{}' });
const entries = ids => ids.map(callId => ({ callId, toolName: 'get_service_info', status: 'SUCCEEDED' }));

test('budget 3 executes A/B/C and rejects D before the model-turn ceiling', async () => {
  let turns = 0;
  const attempts = [];
  const agent = new AgentOrchestrator({ async respond() { turns++; return batch('A', 'B', 'C', 'D'); } }, {
    async execute(call) { attempts.push(call.callId); return output(call); },
  }, 8, 3);
  await assert.rejects(agent.investigate(incident), { message: 'Agent tool-call budget exhausted (3)' });
  assert.equal(turns, 1); // No continuation to negotiate after overflow.
  assert.deepEqual(attempts, ['A', 'B', 'C']);
  assert.deepEqual(agent.currentRecord.toolExecutions, entries(attempts));
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.equal(agent.currentRecord.failure, 'Agent tool-call budget exhausted (3)');
  assert.ok(!Object.hasOwn(agent.currentRecord, 'diagnosis'));
});

test('remaining budget spans turns and executes only the permitted batch prefix', async () => {
  let turns = 0;
  const attempts = [];
  const agent = new AgentOrchestrator({ async respond(request) {
    if (turns++ === 0) return batch('prior-1', 'prior-2');
    assert.deepEqual(request.outputs.map(item => item.callId), ['prior-1', 'prior-2']);
    return batch('A', 'B', 'C');
  } }, { async execute(call) { attempts.push(call.callId); return output(call); } }, 8, 3);
  await assert.rejects(agent.investigate(incident), /tool-call budget exhausted \(3\)/);
  assert.equal(turns, 2);
  assert.deepEqual(attempts, ['prior-1', 'prior-2', 'A']);
  assert.deepEqual(agent.currentRecord.toolExecutions, entries(attempts));
});

test('exact budget permits a final diagnosis and resets for each investigation', async () => {
  const agent = new AgentOrchestrator({ async respond(request) {
    return request.kind === 'initial' ? batch('A', 'B') : final;
  } }, { async execute(call) { return output(call); } }, 2, 2);
  for (let run = 0; run < 2; run++) {
    const result = await agent.investigate(incident);
    assert.equal(result.status, 'COMPLETED');
    assert.deepEqual(result.toolExecutions, entries(['A', 'B']));
    assert.deepEqual(result.diagnosis, final.diagnosis);
  }
});

test('failed attempt uses the last permitted slot and preserves immediate original failure', async () => {
  const failure = new Error('tool failed');
  const attempts = [];
  const agent = new AgentOrchestrator({ async respond() { return batch('A', 'B', 'C'); } }, {
    async execute(call) { attempts.push(call.callId); if (call.callId === 'B') throw failure; return output(call); },
  }, 8, 2);
  await assert.rejects(agent.investigate(incident), error => error === failure);
  assert.deepEqual(attempts, ['A', 'B']);
  assert.deepEqual(agent.currentRecord.toolExecutions, [...entries(['A']), { callId: 'B', toolName: 'get_service_info', status: 'FAILED' }]);
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.equal(agent.currentRecord.failure, failure.message);
});

test('final model turn requests are not attempted or recorded even at budget boundary', async () => {
  let turns = 0;
  const attempts = [];
  const agent = new AgentOrchestrator({ async respond() { return batch(String(++turns)); } }, {
    async execute(call) { attempts.push(call.callId); return output(call); },
  }, 2, 1);
  await assert.rejects(agent.investigate(incident), { message: 'Agent model turn limit reached (2)' });
  assert.deepEqual(attempts, ['1']);
  assert.deepEqual(agent.currentRecord.toolExecutions, entries(['1']));
  const immediateLimit = new AgentOrchestrator({ async respond() { return batch('unused'); } }, {
    async execute() { assert.fail('No consumable turn'); },
  }, 1, 1);
  await assert.rejects(immediateLimit.investigate(incident), /model turn limit reached \(1\)/);
  assert.deepEqual(immediateLimit.currentRecord.toolExecutions, []);
});

test('default tool budget is eight independent attempts, including batched requests', async () => {
  const ids = Array.from({ length: 9 }, (_, i) => String(i + 1));
  const attempts = [];
  const agent = new AgentOrchestrator({ async respond() { return batch(...ids); } }, {
    async execute(call) { attempts.push(call.callId); return output(call); },
  });
  await assert.rejects(agent.investigate(incident), /tool-call budget exhausted \(8\)/);
  assert.deepEqual(attempts, ids.slice(0, 8));
  assert.deepEqual(agent.currentRecord.toolExecutions, entries(attempts));
});

test('invalid maxToolCalls is rejected without reinterpreting the third argument', () => {
  for (const limit of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '3', null]) {
    assert.throws(() => new AgentOrchestrator({}, {}, 8, limit), {
      name: 'TypeError', message: 'maxToolCalls must be a positive safe integer',
    });
  }
  assert.throws(() => new AgentOrchestrator({}, {}, 0, 3), /maxTurns must be a positive safe integer/);
});
