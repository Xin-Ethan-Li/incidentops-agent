import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIAgentModel } from '../dist/agent/openai-agent-model.js';
import { AgentOrchestrator } from '../dist/agent/agent-orchestrator.js';
import { InvestigationMeasurements } from '../dist/measurement/collector.js';
import { usageSummary } from '../dist/measurement/report.js';
import { usageForOutcome } from '../dist/measurement/provider-usage.js';
import { incidents } from '../dist/fixtures/index.js';

const incident = incidents[0];
const diagnosis = { summary: 'Mock provider response.', probableCause: 'Further investigation needed.', confidence: 'low', evidence: [], recommendedActions: [] };
const message = { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [
  { type: 'output_text', text: JSON.stringify(diagnosis), annotations: [] },
] };
const fn = (name = 'get_service_info') => ({ type: 'function_call', id: 'fc', call_id: 'A', name,
  arguments: JSON.stringify({ service: incident.service }), status: 'completed' });
const response = (output = [message], usage) => ({ id: 'mock-response', object: 'response', status: 'completed', error: null, output,
  ...(usage === undefined ? {} : { usage }) });
const tokens = (input, output) => ({ input_tokens: input, output_tokens: output, total_tokens: input + output,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
function mockProvider(t, responses, status = 200) {
  const previous = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_AGENT_MODEL };
  process.env.OPENAI_API_KEY = 'local-test-placeholder'; process.env.OPENAI_AGENT_MODEL = 'mock-provider-model';
  t.after(() => {
    for (const [name, value] of [['OPENAI_API_KEY', previous.key], ['OPENAI_AGENT_MODEL', previous.model]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  let next = 0;
  // Real SDK, controlled local fetch responses only. These are NOT live provider measurements.
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    assert.ok(next < responses.length, 'No unexpected API request/retry');
    return new Response(JSON.stringify(responses[next++]), { status, headers: { 'content-type': 'application/json' } });
  });
  const collector = new InvestigationMeasurements();
  const model = new OpenAIAgentModel();
  const agent = new AgentOrchestrator(model, { async execute(call) { return { callId: call.callId, output: '{}' }; } }, 3, 2, 1000, 1000, collector);
  return { agent, collector, model, fetch };
}

test('mock OpenAI usage survives tool/final response mapping unchanged without extending result JSON', async t => {
  const s = mockProvider(t, [response([fn()], tokens(100, 20)), response([message], tokens(30, 4))]);
  const respond = t.mock.method(s.model, 'respond');
  const result = await s.agent.investigate(incident);
  assert.deepEqual(result.diagnosis, diagnosis);
  const mapped = await respond.mock.calls[0].result;
  assert.deepEqual(mapped, { kind: 'tool_calls', continuation: 'mock-response', calls: [
    { callId: 'A', name: 'get_service_info', arguments: { service: incident.service } },
  ] });
  const measured = s.collector.getAll()[0];
  assert.deepEqual(measured.modelCalls.map(call => call.usage.counts), [
    { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, { inputTokens: 30, outputTokens: 4, totalTokens: 34 },
  ]);
  const summary = usageSummary([measured]);
  assert.equal(summary.availability, 'AVAILABLE'); assert.equal(summary.reportedCalls, 2);
  assert.deepEqual(summary.completeTotal, { inputTokens: 130, outputTokens: 24, totalTokens: 154 });
  assert.deepEqual(summary.knownSubtotal, summary.completeTotal);
  assert.equal(s.fetch.mock.callCount(), 2);
});

test('missing mock provider usage is explicitly unavailable, never a fabricated zero total', async t => {
  const s = mockProvider(t, [response()]);
  await s.agent.investigate(incident);
  const measured = s.collector.getAll()[0];
  assert.deepEqual(measured.modelCalls[0].usage, { status: 'NOT_AVAILABLE', reason: 'NOT_REPORTED' });
  const summary = usageSummary([measured]);
  assert.equal(summary.availability, 'NOT_AVAILABLE'); assert.equal(summary.reportedCalls, 0);
  assert.equal(summary.knownSubtotal, null); assert.equal(summary.completeTotal, null);
});

test('genuine zero in a controlled provider response remains AVAILABLE and distinct from missing', async t => {
  const s = mockProvider(t, [response([message], tokens(0, 0))]);
  await s.agent.investigate(incident);
  const summary = usageSummary(s.collector.getAll());
  assert.equal(summary.availability, 'AVAILABLE'); assert.equal(summary.reportedCalls, 1);
  assert.deepEqual(summary.completeTotal, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

test('partial provider availability exposes only a labeled subtotal, not a complete investigation total', async t => {
  const s = mockProvider(t, [response([fn()], tokens(10, 2)), response()]);
  await s.agent.investigate(incident);
  const summary = usageSummary(s.collector.getAll());
  assert.equal(summary.availability, 'PARTIAL'); assert.equal(summary.modelCalls, 2);
  assert.equal(summary.reportedCalls, 1); assert.equal(summary.unavailableCalls, 1);
  assert.deepEqual(summary.knownSubtotal, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.equal(summary.completeTotal, null);
});

test('invalid or incomplete usage metadata does not change accepted model parsing or invent missing counts', async t => {
  const invalid = [{ input_tokens: 1, output_tokens: 2 }, tokens(-1, 2), { ...tokens(1, 2), total_tokens: 9 },
    { ...tokens(1, 2), input_tokens: '1' }, tokens(0.5, 1), { ...tokens(1, 2), output_tokens: null }];
  const s = mockProvider(t, invalid.map(usage => response([message], usage)));
  for (const _ of invalid) {
    const result = await s.model.respond({ kind: 'initial', prompt: 'visible incident' });
    assert.deepEqual(result, { kind: 'final', diagnosis });
    assert.deepEqual(usageForOutcome(result), { status: 'NOT_AVAILABLE', reason: 'INVALID_PROVIDER_USAGE' });
  }
});

test('observed incomplete provider response can report usage even though model/investigation fail', async t => {
  const s = mockProvider(t, [{ ...response([message], tokens(9, 3)), status: 'incomplete' }]);
  await assert.rejects(s.agent.investigate(incident), /OpenAI response did not complete: incomplete/);
  const measured = s.collector.getAll()[0];
  assert.equal(measured.status, 'FAILED'); assert.equal(measured.modelCalls[0].status, 'FAILED');
  assert.deepEqual(measured.modelCalls[0].usage.counts, { inputTokens: 9, outputTokens: 3, totalTokens: 12 });
  assert.deepEqual(usageSummary([measured]).completeTotal, { inputTokens: 9, outputTokens: 3, totalTokens: 12 });
});

test('SDK transport failure retains no-retry behavior and does not fabricate provider usage', async t => {
  const s = mockProvider(t, [{ error: { message: 'local mock failure', type: 'server_error' } }], 500);
  await assert.rejects(s.agent.investigate(incident));
  assert.equal(s.fetch.mock.callCount(), 1);
  assert.equal(s.collector.getAll()[0].modelCalls[0].status, 'FAILED');
  assert.equal(usageSummary(s.collector.getAll()).completeTotal, null);
});

test('all-reported calls in a suspended investigation still cannot claim a terminal complete total', async t => {
  const s = mockProvider(t, [response([fn('restart_service')], tokens(2, 3))]);
  const waiting = await s.agent.investigate(incident);
  assert.equal(waiting.status, 'AWAITING_APPROVAL');
  const pending = usageSummary(s.collector.getAll());
  assert.equal(pending.availability, 'PARTIAL'); assert.equal(pending.completeTotal, null);
  assert.deepEqual(pending.knownSubtotal, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  await s.agent.resolveApproval({ investigationId: waiting.investigationId, approvalId: waiting.pendingApproval.approvalId, decision: 'reject' });
  assert.equal(usageSummary(s.collector.getAll()).availability, 'AVAILABLE');
  assert.deepEqual(usageSummary(s.collector.getAll()).completeTotal, pending.knownSubtotal);
  assert.equal(s.fetch.mock.callCount(), 1);
});

test('large controlled usage counters never overflow into an invented or imprecise aggregate total', async t => {
  const maximum = tokens(Number.MAX_SAFE_INTEGER, 0);
  const s = mockProvider(t, [response([fn()], maximum), response([message], maximum)]);
  await s.agent.investigate(incident);
  const summary = usageSummary(s.collector.getAll());
  assert.equal(summary.reportedCalls, 2); assert.equal(summary.knownSubtotal, null); assert.equal(summary.completeTotal, null);
  assert.match(summary.reason, /safe integer/);
  assert.doesNotMatch(JSON.stringify(summary), /NaN|Infinity/);
});
