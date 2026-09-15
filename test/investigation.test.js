import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentOrchestrator, ToolExecutor } from '../dist/agent/index.js';
import { incidents } from '../dist/fixtures/index.js';

const incident = incidents[0];
const diagnosis = () => ({ summary: 'Investigation complete.', probableCause: 'Dependency failure suspected.', confidence: 'medium', evidence: ['Observed errors.'], recommendedActions: ['Inspect dependency.'] });
const final = () => ({ kind: 'final', diagnosis: diagnosis() });
const call = (callId, name = 'get_service_info') => ({ callId, name, arguments: { service: incident.service } });
const batch = (...calls) => ({ kind: 'tool_calls', continuation: 'response-id', calls });
const output = call => ({ callId: call.callId, output: '{}' });
const execution = (callId, status = 'SUCCEEDED', toolName = 'get_service_info') => ({ callId, toolName, status });
function failed(agent, message, executions = []) {
  const record = agent.currentRecord;
  assert.equal(record.status, 'FAILED');
  assert.equal(record.failure, message);
  assert.ok(!Object.hasOwn(record, 'diagnosis'));
  assert.deepEqual(record.toolExecutions, executions);
}

test('immediate completion exposes STARTED then COMPLETED without tool investigation', async () => {
  let agent;
  agent = new AgentOrchestrator({ async respond(request) {
    assert.equal(agent.currentRecord.status, 'STARTED');
    assert.deepEqual(JSON.parse(request.prompt), incident);
    return final();
  } }, { async execute() { assert.fail('No tool requested'); } });
  assert.equal(agent.currentRecord, undefined);
  const record = await agent.investigate(incident);
  assert.equal(record.status, 'COMPLETED');
  assert.equal(record.incidentId, incident.id);
  assert.match(record.investigationId, /^[0-9a-f-]{36}$/);
  assert.notEqual(record.investigationId, incident.id);
  assert.deepEqual(record.toolExecutions, []);
  assert.deepEqual(record.diagnosis, diagnosis());
  assert.ok(!Object.hasOwn(record, 'failure'));
  assert.deepEqual(agent.currentRecord, record);
  const next = await agent.investigate(incident);
  assert.notEqual(next.investigationId, record.investigationId);
  assert.equal(record.status, 'COMPLETED');
});

test('successful attempts preserve order, continuation and a stable investigation ID', async () => {
  let agent, id, turns = 0;
  const observed = [];
  agent = new AgentOrchestrator({ async respond(request) {
    observed.push(agent.currentRecord.status);
    if (turns++ === 0) {
      id = agent.currentRecord.investigationId;
      return batch(call('A'), call('B'));
    }
    assert.equal(request.continuation, 'response-id');
    assert.deepEqual(request.outputs, [output(call('A')), output(call('B'))]);
    assert.deepEqual(agent.currentRecord.toolExecutions, [execution('A'), execution('B')]);
    return final();
  } }, { async execute(request) {
    observed.push(agent.currentRecord.status);
    assert.equal(agent.currentRecord.investigationId, id);
    return output(request);
  } });
  const record = await agent.investigate(incident);
  observed.push(record.status);
  assert.deepEqual(observed, ['STARTED', 'INVESTIGATING', 'INVESTIGATING', 'INVESTIGATING', 'COMPLETED']);
  assert.deepEqual(record.toolExecutions, [execution('A'), execution('B')]);
  assert.equal(record.investigationId, id);
});

for (const partial of [false, true]) {
  test('tool failure retains original error and attempted order, partial=' + partial, async () => {
    const error = new Error('tool unavailable');
    const attempts = [];
    let agent;
    agent = new AgentOrchestrator({ async respond() { return partial ? batch(call('A'), call('B'), call('C')) : batch(call('B')); } }, {
      async execute(request) {
        assert.equal(agent.currentRecord.status, 'INVESTIGATING');
        attempts.push(request.callId);
        if (request.callId === 'B') throw error;
        return output(request);
      },
    });
    await assert.rejects(agent.investigate(incident), caught => caught === error);
    assert.deepEqual(attempts, partial ? ['A', 'B'] : ['B']);
    failed(agent, error.message, [...(partial ? [execution('A')] : []), execution('B', 'FAILED')]);
  });
}

for (const error of [new Error('model unavailable'), 'non-Error failure']) {
  test('model failure before tools is retained and rethrown: ' + String(error), async () => {
    let agent;
    agent = new AgentOrchestrator({ async respond() {
      assert.equal(agent.currentRecord.status, 'STARTED');
      throw error;
    } }, { async execute() { assert.fail('No tool'); } });
    await assert.rejects(agent.investigate(incident), caught => caught === error);
    failed(agent, error instanceof Error ? error.message : error);
  });
}

for (const result of [null, { kind: 'final', diagnosis: { ...diagnosis(), confidence: 0.9 } }]) {
  test('invalid model/diagnosis records validation failure: ' + JSON.stringify(result), async () => {
    const agent = new AgentOrchestrator({ async respond() { return result; } }, {});
    await assert.rejects(agent.investigate(incident), error => {
      assert.match(error.message, /Malformed/);
      failed(agent, error.message);
      return true;
    });
  });
}

test('turn limit records only seven actual attempts and never the eighth request', async () => {
  let turns = 0;
  const agent = new AgentOrchestrator({ async respond() { return batch(call(String(++turns))); } }, { async execute(request) { return output(request); } });
  await assert.rejects(agent.investigate(incident), /turn limit reached \(8\)/);
  assert.equal(turns, 8);
  failed(agent, 'Agent model turn limit reached (8)', Array.from({ length: 7 }, (_, i) => execution(String(i + 1))));
  const noAttempt = new AgentOrchestrator({ async respond() { return batch(call('unused')); } }, { async execute() { assert.fail('Last turn'); } }, 1);
  await assert.rejects(noAttempt.investigate(incident), /turn limit/);
  failed(noAttempt, 'Agent model turn limit reached (1)');
});

test('unknown tool records rejected executor attempt without arbitrary execution', async () => {
  const executor = new ToolExecutor({ async callTool() { assert.fail('Unapproved tool must not reach MCP'); } });
  const agent = new AgentOrchestrator({ async respond() { return batch(call('bad', 'delete_database')); } }, executor);
  await assert.rejects(agent.investigate(incident), error => {
    assert.match(error.message, /Tool not allowed/);
    failed(agent, error.message, [execution('bad', 'FAILED', 'delete_database')]);
    return true;
  });
});

test('snapshot and result mutations cannot alter retained state or model diagnosis', async () => {
  const modelDiagnosis = diagnosis();
  let agent, turn = 0;
  agent = new AgentOrchestrator({ async respond() {
    if (turn++ === 0) {
      const snapshot = agent.currentRecord;
      snapshot.status = 'FAILED';
      snapshot.toolExecutions.push(execution('invented'));
      return batch(call('real'));
    }
    return { kind: 'final', diagnosis: modelDiagnosis };
  } }, { async execute(request) { return output(request); } });
  const result = await agent.investigate(incident);
  const expected = structuredClone(result);
  result.status = 'FAILED';
  result.toolExecutions[0].status = 'FAILED';
  result.toolExecutions.push(execution('fake'));
  result.diagnosis.evidence.push('fake');
  result.diagnosis.recommendedActions.length = 0;
  modelDiagnosis.evidence.length = 0;
  modelDiagnosis.recommendedActions.push('mutated');
  const snapshot = agent.currentRecord;
  snapshot.diagnosis.evidence.length = 0;
  snapshot.diagnosis.recommendedActions.push('fake');
  snapshot.toolExecutions.length = 0;
  assert.deepEqual(agent.currentRecord, expected);
});

test('overlapping runs keep separate records and getter follows latest start', async () => {
  let resolveFirst, rejectSecond;
  let calls = 0;
  const error = new Error('second failed');
  const agent = new AgentOrchestrator({ respond() {
    return ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : new Promise((_, reject) => { rejectSecond = reject; });
  } }, {});
  const first = agent.investigate(incident);
  const firstId = agent.currentRecord.investigationId;
  const second = agent.investigate(incident);
  const secondId = agent.currentRecord.investigationId;
  rejectSecond(error);
  await assert.rejects(second, caught => caught === error);
  resolveFirst(final());
  assert.equal((await first).investigationId, firstId);
  assert.notEqual(firstId, secondId);
  assert.equal(agent.currentRecord.investigationId, secondId);
  failed(agent, error.message);
});
