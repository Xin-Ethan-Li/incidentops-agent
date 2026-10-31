import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import { OpenAIAgentModel } from '../dist/agent/openai-agent-model.js';
import { OperationTimeoutError } from '../dist/agent/with-timeout.js';
import { IncidentOpsMcpClient } from '../dist/mcp/client.js';
import { usageForOutcome } from '../dist/measurement/provider-usage.js';
import { createInMemoryTracing } from '../dist/tracing/local.js';
import { ToolError } from '../dist/tools/tool-error.js';
import { LIVE_LIMITS, runLiveInvestigation } from '../dist/live-investigation.js';
import { incidents, logs } from '../dist/fixtures/index.js';

const incident = incidents[0];
const diagnosis = { summary: 'Offline SDK fixture diagnosis.', probableCause: 'Mock-only diagnostic result.', confidence: 'low',
  evidence: ['Review the delivered fixture logs.'], recommendedActions: [] };
const tokens = (input, output) => ({ input_tokens: input, output_tokens: output, total_tokens: input + output });
const tool = (name = 'search_logs', args = { service: incident.service, timeWindow: incident.timeWindow }, id = 'original-call') => ({
  type: 'function_call', id: 'function-item', call_id: id, name, arguments: JSON.stringify(args), status: 'completed',
});
const final = { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(diagnosis) }] };
const response = (output, id, usage) => ({ id, status: 'completed', error: null, output, ...(usage === undefined ? {} : { usage }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

beforeEach(t => {
  const prior = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_AGENT_MODEL };
  process.env.OPENAI_API_KEY = 'OFFLINE_SECRET_KEY'; process.env.OPENAI_AGENT_MODEL = 'offline-model';
  t.after(() => { for (const [key, value] of [['OPENAI_API_KEY', prior.key], ['OPENAI_AGENT_MODEL', prior.model]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('External requests are forbidden'));
});

function provider(t, responses, httpStatus = 200) {
  let next = 0;
  return t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.ok(next < responses.length, 'No unintended SDK retry or additional model turn');
    const value = responses[next++];
    if (typeof value === 'function') return value(init);
    return new Response(JSON.stringify(value), { status: httpStatus, headers: { 'content-type': 'application/json' } });
  });
}

function resources(t, overrides = {}) {
  const state = { connects: 0, closes: 0, calls: [], pid: null, modelSettings: undefined, model: undefined, report: undefined };
  const real = new IncidentOpsMcpClient({ command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/mcp-stdio-server.js', import.meta.url))], env: {} });
  t.after(() => real.close());
  const client = { get pid() { return real.pid; }, async connect(options) {
    state.connects++; state.connectOptions = options;
    const connecting = real.connect(options); state.pid = real.pid;
    await connecting; state.pid ??= real.pid;
    overrides.connected?.();
  }, async callTool(params) {
    state.calls.push(structuredClone(params));
    return overrides.callTool ? overrides.callTool(params, real, state.calls.length) : real.callTool(params);
  }, async close() {
    state.closes++; await real.close(); if (overrides.closeError) throw overrides.closeError;
  } };
  const dependencies = { createClient: () => client, createModel(settings) {
    state.modelSettings = settings;
    state.model = overrides.model ?? new OpenAIAgentModel(settings);
    state.respond = t.mock.method(state.model, 'respond');
    return state.model;
  }, ...(overrides.createTracing ? { createTracing: overrides.createTracing } : {}) };
  const options = { onReport(value) { state.report = value; }, ...overrides.options };
  return { state, dependencies, options };
}

function hierarchy(report) {
  const roots = report.spans.filter(span => span.name === 'incident.investigation');
  assert.equal(roots.length, 1); assert.equal(roots[0].parentSpanId, null);
  for (const span of report.spans.filter(span => span !== roots[0])) {
    assert.equal(span.parentSpanId, roots[0].spanId); assert.equal(span.traceId, roots[0].traceId);
  }
  return roots[0];
}

test('real SDK + real stdio uses four read schemas, selected arguments, original call ID and actual continuation evidence', async t => {
  const fetch = provider(t, [response([tool()], 'response-1', tokens(10, 2)), response([final], 'response-2', tokens(20, 3))]);
  const { state, dependencies, options } = resources(t, { options: { inspect: true } });
  const report = await runLiveInvestigation(incident.id, options, dependencies);
  const bodies = fetch.mock.calls.map(call => JSON.parse(call.arguments[1].body));
  assert.deepEqual(bodies[0].tools.map(item => item.name), ['search_logs', 'get_metrics', 'get_service_info', 'search_runbook']);
  assert.ok(bodies[0].tools.every(item => item.strict)); assert.equal(bodies[0].parallel_tool_calls, false);
  assert.equal(bodies[0].max_output_tokens, 2048); assert.equal(bodies[0].text.format.strict, true);
  assert.deepEqual(JSON.parse(bodies[0].input), incident);
  assert.equal(bodies[1].previous_response_id, 'response-1'); assert.equal(bodies[1].instructions, bodies[0].instructions);
  assert.equal(bodies[1].input[0].type, 'function_call_output'); assert.equal(bodies[1].input[0].call_id, 'original-call');
  assert.deepEqual(JSON.parse(bodies[1].input[0].output), logs.filter(item => item.service === incident.service));
  assert.deepEqual(state.calls, [{ name: 'search_logs', arguments: { service: incident.service, timeWindow: incident.timeWindow } }]);
  assert.deepEqual(report.outcome.diagnosis, diagnosis); assert.equal(report.outcome.status, 'COMPLETED');
  assert.deepEqual(report.outcome.toolExecutions, [{ callId: 'original-call', toolName: 'search_logs', status: 'SUCCEEDED' }]);
  assert.deepEqual(report.observed.deliveredCallIds, ['original-call']);
  assert.deepEqual(JSON.parse(report.inspection.deliveredOutputs[0].output), JSON.parse(bodies[1].input[0].output));
  assert.deepEqual(report.inspection.requests[0].arguments, state.calls[0].arguments);
  assert.equal(report.verificationReady, true); assert.equal(report.humanDiagnosisReview, 'PENDING');
  assert.equal(state.connects, 1); assert.equal(state.closes, 1); assert.equal(state.connectOptions.timeout, 10000);
  assert.equal(state.modelSettings.requestTimeoutMs, 31000); assert.ok(state.modelSettings.signal.aborted);
  assert.equal(report.cleanup.childExit, 'OBSERVED'); assert.throws(() => process.kill(state.pid, 0), { code: 'ESRCH' });
  assert.equal(report.spans.length, 4); hierarchy(report);
  assert.equal(report.measurements[0].duration.status, 'MEASURED');
  assert.deepEqual(report.measurementSummary.usage.completeTotal, { inputTokens: 30, outputTokens: 5, totalTokens: 35 });
  const originalResult = await state.respond.mock.calls[0].result;
  assert.deepEqual(usageForOutcome(originalResult).counts, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.deepEqual(report.measurements[0].modelCalls[0].usage, usageForOutcome(originalResult));
});

test('multiple model continuations reuse a single owned MCP process without duplicate execution', async t => {
  const fetch = provider(t, [response([tool('get_service_info', { service: incident.service }, 'A')], 'R1'),
    response([tool('get_metrics', { service: incident.service, timeWindow: incident.timeWindow }, 'B')], 'R2'), response([final], 'R3')]);
  const { state, dependencies, options } = resources(t);
  const report = await runLiveInvestigation(incident.id, options, dependencies);
  assert.equal(state.connects, 1); assert.equal(state.closes, 1); assert.equal(state.calls.length, 2);
  assert.deepEqual(report.observed.deliveredCallIds, ['A', 'B']); assert.equal(report.measurementSummary.toolAttempts.count, 2);
  assert.equal(report.measurementSummary.modelCalls.count, 3); assert.equal(fetch.mock.calls.length, 3);
  assert.equal(report.verificationReady, true); hierarchy(report);
});

for (const variant of ['zero', 'missing', 'partial']) test('provider usage remains honest: ' + variant, async t => {
  const initialUsage = variant === 'missing' ? undefined : variant === 'zero' ? tokens(0, 0) : tokens(10, 1);
  const finalUsage = variant === 'zero' ? tokens(0, 0) : undefined;
  provider(t, [response([tool()], 'R1', initialUsage), response([final], 'R2', finalUsage)]);
  const { dependencies, options } = resources(t);
  const report = await runLiveInvestigation(incident.id, options, dependencies), usage = report.measurementSummary.usage;
  assert.equal(usage.availability, { zero: 'AVAILABLE', missing: 'NOT_AVAILABLE', partial: 'PARTIAL' }[variant]);
  assert.deepEqual(usage.completeTotal, variant === 'zero' ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : null);
  assert.deepEqual(usage.knownSubtotal, variant === 'missing' ? null : variant === 'zero'
    ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : { inputTokens: 10, outputTokens: 1, totalTokens: 11 });
  const modelSpans = report.spans.filter(span => span.name === 'agent.model.respond');
  assert.equal(modelSpans[0].attributes['model.usage_available'], variant !== 'missing');
  if (variant === 'missing') assert.ok(!Object.hasOwn(modelSpans[0].attributes, 'model.total_tokens'));
});

test('HTTP provider failure is terminal, uses no SDK retry and emits no raw error details', async t => {
  const fetch = provider(t, [{ error: { message: 'SECRET_PROVIDER_BODY', type: 'server_error' } }], 500);
  const { state, dependencies, options } = resources(t);
  await assert.rejects(runLiveInvestigation(incident.id, options, dependencies), error => error.status === 500);
  assert.equal(fetch.mock.calls.length, 1); assert.equal(state.calls.length, 0); assert.equal(state.closes, 1);
  assert.equal(state.report.outcome.status, 'FAILED'); assert.equal(state.report.failure, 'INVESTIGATION_FAILED');
  assert.ok(!JSON.stringify(state.report).includes('SECRET_PROVIDER_BODY')); hierarchy(state.report);
});

test('provider parsing failure preserves usage on the original error object', async t => {
  provider(t, [response([{ ...final, content: [{ type: 'output_text', text: 'not valid JSON' }] }], 'R1', tokens(7, 3))]);
  const { state, dependencies, options } = resources(t);
  let failure;
  await assert.rejects(runLiveInvestigation(incident.id, options, dependencies), error => { failure = error; return /Malformed diagnosis JSON/.test(error.message); });
  assert.equal(state.report.measurements[0].modelCalls[0].status, 'FAILED');
  assert.deepEqual(state.report.measurements[0].modelCalls[0].usage, usageForOutcome(failure));
  assert.equal(usageForOutcome(failure).counts.totalTokens, 10);
});

test('tool failure preserves original identity, stops continuation and is not converted to successful evidence', async t => {
  const fetch = provider(t, [response([tool()], 'R1')]), original = new ToolError('SERVICE_NOT_FOUND', 'SECRET_TOOL_ERROR');
  const { state, dependencies, options } = resources(t, { callTool() { throw original; } });
  await assert.rejects(runLiveInvestigation(incident.id, options, dependencies), error => error === original);
  assert.equal(fetch.mock.calls.length, 1); assert.equal(state.calls.length, 1); assert.equal(state.closes, 1);
  assert.equal(state.report.outcome.toolExecutions[0].status, 'FAILED');
  assert.deepEqual(state.report.observed.deliveredCallIds, []); assert.ok(!JSON.stringify(state.report).includes('SECRET_TOOL_ERROR'));
});

test('model failure survives MCP and tracing cleanup failures without replacement or leakage', async t => {
  const original = new Error('SECRET_PRIMARY'), closeError = new Error('SECRET_CLEANUP');
  const local = createInMemoryTracing(), shutdown = local.provider.shutdown.bind(local.provider);
  t.after(shutdown); t.mock.method(local.provider, 'shutdown', async () => { throw new Error('SECRET_TRACE'); });
  const { state, dependencies, options } = resources(t, { model: { async respond() { throw original; } }, closeError, createTracing: () => local });
  await assert.rejects(runLiveInvestigation(incident.id, options, dependencies), error => error === original);
  assert.deepEqual(state.report.cleanup.errors, ['MCP_CLOSE_FAILED', 'TRACE_SHUTDOWN_FAILED']);
  assert.equal(state.report.cleanup.childExit, 'OBSERVED');
  assert.doesNotMatch(JSON.stringify(state.report), /SECRET_PRIMARY|SECRET_CLEANUP|SECRET_TRACE/);
});

test('cleanup failure after a completed workflow prevents a successful verification claim', async t => {
  provider(t, [response([tool()], 'R1'), response([final], 'R2')]);
  const { dependencies, options } = resources(t, { closeError: new Error('cleanup failure') });
  const report = await runLiveInvestigation(incident.id, options, dependencies);
  assert.equal(report.outcome.status, 'COMPLETED'); assert.equal(report.verificationReady, false);
  assert.equal(report.cleanup.mcpClose, 'FAILED');
});

test('unexpected risky proposal stays AWAITING_APPROVAL, executes nothing, abandons one-shot resources without a completed root', async t => {
  provider(t, [response([tool('restart_service', { service: incident.service }, 'risk')], 'R1')]);
  const { state, dependencies, options } = resources(t);
  const report = await runLiveInvestigation(incident.id, options, dependencies);
  assert.equal(report.outcome.status, 'AWAITING_APPROVAL'); assert.equal(report.verificationReady, false);
  assert.equal(report.traceComplete, false); assert.equal(report.spans.filter(span => span.name === 'incident.investigation').length, 0);
  assert.deepEqual(report.outcome.toolExecutions, []); assert.deepEqual(state.calls, []); assert.equal(state.closes, 1);
  assert.equal(report.measurements[0].duration.status, 'PENDING'); assert.equal(report.cleanup.childExit, 'OBSERVED');
});

test('immediate valid diagnosis preserves COMPLETED but does not claim the required tool round trip', async t => {
  provider(t, [response([final], 'R1')]); const { dependencies, options } = resources(t);
  const report = await runLiveInvestigation(incident.id, options, dependencies);
  assert.equal(report.outcome.status, 'COMPLETED'); assert.equal(report.traceComplete, true); assert.equal(report.verificationReady, false);
  assert.deepEqual(report.observed.deliveredCallIds, []);
});

test('default safe output and spans omit raw tool arguments, outputs, prompts and credentials', async t => {
  provider(t, [response([tool('search_logs', { service: incident.service, timeWindow: incident.timeWindow, contains: 'SECRET_ARGUMENT' })], 'R1'), response([final], 'R2')]);
  const { dependencies, options } = resources(t, { callTool() { return { content: [{ type: 'text', text: '{"value":"SECRET_TOOL_OUTPUT"}' }] }; } });
  const report = await runLiveInvestigation(incident.id, options, dependencies);
  assert.ok(!Object.hasOwn(report, 'inspection'));
  assert.doesNotMatch(JSON.stringify(report), /SECRET_ARGUMENT|SECRET_TOOL_OUTPUT|OFFLINE_SECRET_KEY/);
  assert.ok(!JSON.stringify(report.spans).includes(incident.description));
});

test('outer model timeout cancels the actual pending SDK fetch rather than waiting for the SDK default deadline', async t => {
  const started = deferred(); let signal;
  provider(t, [init => { signal = init.signal; started.resolve(); return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Offline abort', 'AbortError')), { once: true });
  }); }]);
  const { state, dependencies, options } = resources(t);
  const pending = runLiveInvestigation(incident.id, options, dependencies);
  const rejected = assert.rejects(pending, OperationTimeoutError);
  await started.promise;
  await rejected;
  assert.ok(signal.aborted); assert.equal(state.report.failure, 'TIMEOUT'); assert.equal(state.closes, 1);
  assert.equal(state.report.measurements[0].modelCalls[0].status, 'TIMEOUT');
  assert.equal(state.report.measurements[0].modelCalls[0].usage.reason, 'CALLER_TIMEOUT');
  assert.equal(state.report.outcome.status, 'FAILED'); assert.equal(state.calls.length, 0);
});

test('external cancellation aborts the SDK request, closes the child once and retains the actual failed outcome', async t => {
  const started = deferred(), controller = new AbortController(); let fetchSignal;
  const fetch = provider(t, [init => { fetchSignal = init.signal; started.resolve(); return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  }); }]);
  const { state, dependencies, options } = resources(t, { options: { signal: controller.signal } });
  const pending = runLiveInvestigation(incident.id, options, dependencies), rejected = assert.rejects(pending);
  await started.promise; controller.abort(); await rejected;
  assert.equal(fetch.mock.calls.length, 1); assert.ok(fetchSignal.aborted); assert.equal(state.closes, 1);
  assert.equal(state.report.failure, 'INTERRUPTED'); assert.equal(state.report.outcome.status, 'FAILED');
  assert.equal(state.report.cleanup.childExit, 'OBSERVED');
});

test('existing read timeout retry remains two budgeted attempts and delivers only the successful output', async t => {
  const first = deferred(), started = deferred();
  provider(t, [response([tool()], 'R1'), response([final], 'R2')]);
  const { state, dependencies, options } = resources(t, {
    callTool(params, real, attempt) { if (attempt === 1) { started.resolve(); return first.promise; } return real.callTool(params); } });
  const pending = runLiveInvestigation(incident.id, options, dependencies);
  await started.promise;
  const report = await pending;
  assert.equal(state.calls.length, 2); assert.equal(report.measurementSummary.toolAttempts.retries, 1);
  assert.deepEqual(report.measurements[0].toolAttempts.map(attempt => attempt.status), ['TIMEOUT', 'SUCCEEDED']);
  assert.deepEqual(report.observed.deliveredCallIds, ['original-call']); assert.equal(report.verificationReady, true);
  const snapshot = JSON.stringify(report);
  first.resolve({ content: [{ type: 'text', text: '"LATE_OUTPUT"' }] }); await nextTurn();
  assert.equal(JSON.stringify(report), snapshot);
});

test('initialization failure is bounded by SDK options, closes once and preserves its original error', async () => {
  const original = new Error('SECRET_INITIALIZATION'); let closes = 0, captured, report;
  await assert.rejects(runLiveInvestigation(incident.id, { onReport(value) { report = value; } }, {
    createModel: () => ({ respond() { assert.fail('No model before MCP initialization'); } }),
    createClient: () => ({ pid: null, async connect(options) { captured = options; throw original; },
      callTool() { assert.fail('No tools'); }, async close() { closes++; } }),
  }), error => error === original);
  assert.equal(captured.timeout, 10000); assert.ok(captured.signal.aborted); assert.equal(closes, 1);
  assert.equal(report.outcome.status, 'NOT_STARTED'); assert.equal(report.traceComplete, false);
  assert.equal(report.cleanup.childExit, 'NOT_OBSERVED'); assert.ok(!JSON.stringify(report).includes('SECRET_INITIALIZATION'));
});

test('real stdio handshake timeout uses installed SDK options and the recorded child exits', async t => {
  const client = new IncidentOpsMcpClient({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], env: {} });
  t.after(() => client.close());
  const connecting = client.connect({ timeout: 30 }); const pid = client.pid;
  await assert.rejects(connecting, error => /timed out/i.test(error.message));
  await client.close();
  if (pid !== null) {
    let exited = false;
    for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch (error) { exited = error.code === 'ESRCH'; break; } await delay(20); }
    assert.ok(exited, 'Observe actual OS child exit, not merely client.pid=null');
  } else assert.fail('The test must capture a real child PID');
});

test('missing/invalid configuration creates no model, child or API request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('No network on invalid configuration'));
  const never = { createModel() { assert.fail('No model'); }, createClient() { assert.fail('No child'); } };
  await assert.rejects(runLiveInvestigation('missing', {}, never), /supported Incident/);
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(runLiveInvestigation(incident.id, {}, never), /OPENAI_API_KEY/);
  process.env.OPENAI_API_KEY = 'offline'; delete process.env.OPENAI_AGENT_MODEL;
  await assert.rejects(runLiveInvestigation(incident.id, {}, never), /OPENAI_AGENT_MODEL/);
  assert.equal(fetch.mock.calls.length, 0);
});

test('already-cancelled invocation creates no resources and preserves the cancellation reason', async () => {
  const controller = new AbortController(), original = new Error('cancelled before setup');
  controller.abort(original); let report;
  await assert.rejects(runLiveInvestigation(incident.id, { signal: controller.signal, onReport(value) { report = value; } }, {
    createModel() { assert.fail('No adapter after cancellation'); },
    createClient() { assert.fail('No child after cancellation'); },
    createTracing() { assert.fail('No tracing after cancellation'); },
  }), error => error === original);
  assert.equal(report.failure, 'INTERRUPTED'); assert.equal(report.outcome.status, 'NOT_STARTED');
  assert.equal(report.cleanup.mcpClose, 'NOT_CREATED');
});

test('optional SDK request deadline aborts its fetch and never retries', async t => {
  let signal;
  const fetch = provider(t, [init => {
    signal = init.signal;
    return new Promise((_, reject) => signal.addEventListener('abort',
      () => reject(new DOMException('Offline deadline', 'AbortError')), { once: true }));
  }]);
  await assert.rejects(new OpenAIAgentModel({ requestTimeoutMs: 25 }).respond({ kind: 'initial', prompt: 'offline' }),
    error => error instanceof OpenAI.APIConnectionTimeoutError);
  assert.ok(signal.aborted); assert.equal(fetch.mock.calls.length, 1);
});

test('optional OpenAI configuration validates locally and default constructor behavior remains backward compatible', async t => {
  for (const value of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => new OpenAIAgentModel({ maxOutputTokens: value }), TypeError);
    assert.throws(() => new OpenAIAgentModel({ requestTimeoutMs: value }), TypeError);
  }
  assert.throws(() => new OpenAIAgentModel({ requestTimeoutMs: 2147483648 }), TypeError);
  assert.throws(() => new OpenAIAgentModel({ readOnly: 'yes' }), TypeError);
  assert.throws(() => new OpenAIAgentModel({ signal: {} }), TypeError);
  const fetch = provider(t, [response([final], 'default')]);
  await new OpenAIAgentModel().respond({ kind: 'initial', prompt: 'offline input' });
  const body = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.equal(body.tools.length, 5); assert.ok(!Object.hasOwn(body, 'max_output_tokens'));
});
