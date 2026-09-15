import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { AgentOrchestrator, ToolExecutor } from '../dist/agent/index.js';
import { RunbookRetriever } from '../dist/rag/index.js';
import { incidents, runbooks } from '../dist/fixtures/index.js';
import { ToolError } from '../dist/tools/index.js';

const incident = incidents[0];
const call = (callId, name, args) => ({ callId, name, arguments: args });
const requests = (continuation, ...calls) => ({ kind: 'tool_calls', continuation, calls });
const final = text => ({ kind: 'final', text });
class ScriptedModel {
  seen = [];
  constructor(script) { this.script = script; }
  async respond(request) {
    this.seen.push(structuredClone(request));
    const next = this.script[this.seen.length - 1];
    assert.ok(next, 'Unexpected model turn');
    return typeof next === 'function' ? next(request) : next;
  }
}
function semanticExecutor() {
  const calls = [];
  const embeddings = {
    async embed(texts) {
      calls.push([...texts]);
      return texts.map(text => text.startsWith('Title:')
        ? (text.includes(runbooks[0].title) ? [1, 0] : [0, 1]) : [1, 0]);
    },
  };
  return { executor: new ToolExecutor(new RunbookRetriever(embeddings)), calls };
}

test('agent investigates through logs, metrics and semantic context then returns model final text', async () => {
  const { executor, calls } = semanticExecutor();
  const model = new ScriptedModel([
    requests('turn-1', call('log-id', 'search_logs', { service: incident.service, timeWindow: incident.timeWindow, levels: null, contains: null })),
    input => {
      assert.equal(input.continuation, 'turn-1');
      assert.equal(input.outputs[0].callId, 'log-id');
      assert.deepEqual(JSON.parse(input.outputs[0].output).map(log => log.id), ['LOG-001-01', 'LOG-001-02', 'LOG-001-03']);
      return requests('turn-2', call('metric-id', 'get_metrics', { service: incident.service, timeWindow: incident.timeWindow, metricNames: ['redis_connection_timeouts'] }));
    },
    input => {
      assert.equal(input.continuation, 'turn-2');
      assert.equal(input.outputs[0].callId, 'metric-id');
      assert.equal(JSON.parse(input.outputs[0].output)[0].points[1].value, 45);
      return requests('turn-3', call('book-id', 'search_runbook', { query: 'a failing dependency interrupts checkout', limit: 1 }));
    },
    input => {
      assert.equal(input.continuation, 'turn-3');
      assert.equal(input.outputs[0].callId, 'book-id');
      const evidence = JSON.parse(input.outputs[0].output)[0];
      assert.equal(evidence.runbook.id, 'RB-001');
      assert.equal(evidence.score, 1);
      return final('Retrieved guidance: ' + evidence.runbook.title);
    },
  ]);
  assert.equal(await new AgentOrchestrator(model, executor).investigate(incident), 'Retrieved guidance: ' + runbooks[0].title);
  assert.deepEqual(JSON.parse(model.seen[0].prompt), incident);
  assert.equal(calls[0].length, 5);
  assert.deepEqual(calls[1], ['a failing dependency interrupts checkout']);
});

test('executor routes all four allowed tools and normalizes nullable optional fields', async () => {
  const { executor } = semanticExecutor();
  const execute = async (name, args) => JSON.parse((await executor.execute(call('id', name, args))).output);
  assert.equal((await execute('get_service_info', { service: 'checkout-api' })).version, '1.4.2');
  assert.equal((await execute('search_logs', { service: 'checkout-api', timeWindow: incident.timeWindow, levels: ['error'], contains: 'REDIS' })).length, 1);
  assert.equal((await execute('get_metrics', { service: 'checkout-api', timeWindow: incident.timeWindow, metricNames: null })).length, 2);
  assert.equal((await execute('search_runbook', { query: 'dependency issue', limit: null })).length, 5);
});

test('multiple calls execute sequentially and preserve model call IDs in order', async () => {
  const { executor } = semanticExecutor();
  const order = [];
  const wrapped = { async execute(request) { order.push(request.callId); return executor.execute(request); } };
  const model = new ScriptedModel([
    requests('batch', call('second', 'get_service_info', { service: 'payment-api' }), call('first', 'get_service_info', { service: 'checkout-api' })),
    input => {
      assert.deepEqual(input.outputs.map(output => output.callId), ['second', 'first']);
      assert.deepEqual(input.outputs.map(output => JSON.parse(output.output).name), ['payment-api', 'checkout-api']);
      return final('done');
    },
  ]);
  assert.equal(await new AgentOrchestrator(model, wrapped).investigate(incident), 'done');
  assert.deepEqual(order, ['second', 'first']);
});

test('application rejects unknown tool requests without executing arbitrary code', async () => {
  const { executor, calls } = semanticExecutor();
  for (const name of ['delete_database', 'constructor', 'toString', '__proto__']) {
    const model = new ScriptedModel([requests('bad', call('id', name, {}))]);
    await assert.rejects(new AgentOrchestrator(model, executor).investigate(incident), /Tool not allowed/);
    assert.equal(model.seen.length, 1);
  }
  assert.deepEqual(calls, []);
});

test('immediate final response executes no tools', async () => {
  const model = new ScriptedModel([final('Insufficient evidence supplied.')]);
  const executor = { async execute() { assert.fail('Must not execute'); } };
  assert.equal(await new AgentOrchestrator(model, executor).investigate(incident), 'Insufficient evidence supplied.');
});

test('default ceiling is eight model turns and no tools run after final available turn', async () => {
  let turns = 0;
  let executions = 0;
  const model = { async respond() { turns++; return requests('r' + turns, call('c' + turns, 'get_service_info', { service: 'checkout-api' })); } };
  const executor = { async execute(request) { executions++; return { callId: request.callId, output: '{}' }; } };
  await assert.rejects(new AgentOrchestrator(model, executor).investigate(incident), /turn limit reached \(8\)/);
  assert.equal(turns, 8);
  assert.equal(executions, 7);
});

test('configured ceiling permits final text on last turn and rejects invalid ceilings', async () => {
  const { executor } = semanticExecutor();
  const model = new ScriptedModel([requests('r', call('c', 'get_service_info', { service: 'checkout-api' })), final('done')]);
  assert.equal(await new AgentOrchestrator(model, executor, 2).investigate(incident), 'done');
  for (const value of [0, -1, 1.5, Infinity]) assert.throws(() => new AgentOrchestrator(model, executor, value), TypeError);
});

test('malformed model protocol is rejected before tool execution', async () => {
  const executor = { async execute() { assert.fail('Must not execute'); } };
  const valid = call('id', 'get_service_info', { service: 'checkout-api' });
  for (const response of [null, {}, final(' '), { ...final('done'), calls: [valid] },
    requests('', valid), requests('r'), requests('r', valid, valid), requests('r', { ...valid, arguments: [] }),
    requests('r', { ...valid, callId: '' }), requests('r', { ...valid, arguments: '{}' })]) {
    await assert.rejects(new AgentOrchestrator(new ScriptedModel([() => response]), executor).investigate(incident), /Malformed/);
  }
});

test('call IDs cannot be reused across turns', async () => {
  const { executor } = semanticExecutor();
  const response = requests('r', call('id', 'get_service_info', { service: 'checkout-api' }));
  await assert.rejects(new AgentOrchestrator(new ScriptedModel([response, response]), executor).investigate(incident), /Reused/);
});

test('executor validates argument shapes and propagates existing tool validation errors', async () => {
  const { executor } = semanticExecutor();
  for (const args of [null, [], '{}', {}, { service: 'checkout-api', extra: true }]) {
    await assert.rejects(executor.execute(call('id', 'get_service_info', args)), error => error instanceof ToolError && error.code === 'INVALID_INPUT');
  }
  await assert.rejects(executor.execute(call('id', 'get_service_info', { service: 'unknown' })), error => error.code === 'SERVICE_NOT_FOUND');
  await assert.rejects(executor.execute(call('id', 'search_logs', { service: 'checkout-api', timeWindow: { start: 'bad', end: 'bad' } })), error => error.code === 'INVALID_INPUT');
  await assert.rejects(executor.execute(call('id', 'get_metrics', { service: 'checkout-api', timeWindow: incident.timeWindow, metricNames: 7 })), error => error.code === 'INVALID_INPUT');
  await assert.rejects(executor.execute(call('id', 'search_runbook', { query: ' ', limit: null })), TypeError);
});

test('embedding and model failures propagate without recovery', async () => {
  const failure = new Error('provider unavailable');
  const retriever = new RunbookRetriever({ async embed() { throw failure; } });
  const model = new ScriptedModel([requests('r', call('id', 'search_runbook', { query: 'query' }))]);
  await assert.rejects(new AgentOrchestrator(model, new ToolExecutor(retriever)).investigate(incident), error => error === failure);
  await assert.rejects(new AgentOrchestrator({ async respond() { throw failure; } }, {}).investigate(incident), error => error === failure);
});

test('incident prompt explicitly selects visible fields, including nested time window', async () => {
  const model = new ScriptedModel([final('done')]);
  const extra = { ...incident, expectedCause: 'hidden', relevantLogIds: ['hidden'], timeWindow: { ...incident.timeWindow, answer: 'hidden' } };
  await new AgentOrchestrator(model, {}).investigate(extra);
  assert.deepEqual(JSON.parse(model.seen[0].prompt), incident);
  const directory = new URL('../src/agent/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    assert.doesNotMatch(readFileSync(new URL(name, directory), 'utf8'), /ground-truth|expectedCause|@nestjs/);
  }
});
