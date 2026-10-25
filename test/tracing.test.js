import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { context, trace, SpanStatusCode, ROOT_CONTEXT } from '@opentelemetry/api';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { AgentOrchestrator } from '../dist/agent/agent-orchestrator.js';
import { OpenAIAgentModel } from '../dist/agent/openai-agent-model.js';
import { ToolExecutor, MalformedMcpResultError } from '../dist/agent/tool-executor.js';
import { OperationTimeoutError } from '../dist/agent/with-timeout.js';
import { ToolError } from '../dist/tools/tool-error.js';
import { InvestigationMeasurements } from '../dist/measurement/collector.js';
import { summarizeMeasurements } from '../dist/measurement/report.js';
import { associateProviderUsage, providerUsage } from '../dist/measurement/provider-usage.js';
import { createInMemoryTracing } from '../dist/tracing/local.js';
import { createScriptedBaselineModel, runScriptedBaseline } from '../dist/evaluation/baseline.js';
import { runExpandedEvaluation } from '../dist/evaluation/expanded.js';
import { runMeasuredEvaluation } from '../dist/evaluation/measured.js';
import { createExpandedDataset } from '../dist/evaluation/expanded-dataset.js';
import { connectScenarioExecutor } from '../dist/evaluation/fixture-mcp.js';
import { toAgentIncident } from '../dist/evaluation/cases.js';
import { evaluateInvestigation } from '../dist/evaluation/evaluator.js';
import { RunbookRetriever } from '../dist/rag/runbook-retriever.js';
import { SemanticRetrievalUnavailableError } from '../dist/rag/semantic-retrieval-unavailable-error.js';
import { incidents } from '../dist/fixtures/index.js';
import { createTestExecutor } from './fixtures/mcp-memory.js';

const incident = incidents[0];
const final = { kind: 'final', diagnosis: { summary: 'Scripted trace test.', probableCause: 'Further investigation needed.',
  confidence: 'low', evidence: [], recommendedActions: [] } };
const read = { callId: 'A', name: 'get_service_info', arguments: { service: incident.service } };
const risk = { callId: 'B', name: 'restart_service', arguments: { service: incident.service } };
const batch = calls => ({ kind: 'tool_calls', continuation: 'original-response', calls });
const output = call => ({ callId: call.callId, output: '{}' });
const decision = (record, choice = 'approve') => ({ investigationId: record.investigationId,
  approvalId: record.pendingApproval.approvalId, decision: choice });
const project = span => ({ name: span.name, context: span.spanContext(), parent: span.parentSpanContext,
  attributes: span.attributes, events: span.events, status: span.status, startTime: span.startTime, endTime: span.endTime });
const models = spans => spans.filter(span => span.name === 'agent.model.respond');
const tools = spans => spans.filter(span => span.name === 'agent.tool.execute');
const roots = spans => spans.filter(span => span.name === 'incident.investigation');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function tick(t, clock, ms) { clock.value += ms; t.mock.timers.tick(ms); await nextTurn(); }
beforeEach(t => { t.mock.method(globalThis, 'fetch', () => assert.fail('Tracing tests must not call external services')); });

function localTracing(t, clock = { value: 0 }) {
  const local = createInMemoryTracing();
  t.after(() => local.provider.shutdown());
  const tracer = local.provider.getTracer('incidentops-agent');
  const created = [];
  const start = tracer.startSpan.bind(tracer);
  t.mock.method(tracer, 'startSpan', (...args) => {
    const span = start(...args), entry = { span, started: clock.value };
    const end = span.end.bind(span);
    entry.end = t.mock.method(span, 'end', (...endArgs) => { entry.finished = clock.value; return end(...endArgs); });
    created.push(entry);
    return span; // The real SDK Span is returned and exported; no fabricated Span data.
  });
  return { ...local, tracer, created, async finished() {
    const flush = local.provider.forceFlush();
    // The real InMemorySpanExporter acknowledges exports with setTimeout(..., 0).
    if (clock.fakeTimers) t.mock.timers.tick(0);
    await flush;
    return local.exporter.getFinishedSpans();
  } };
}
function setup(t, calls = [read], budget = 8) {
  const clock = { value: 0 }, local = localTracing(t, clock);
  const measurements = new InvestigationMeasurements(() => clock.value), requests = [], executions = [];
  const model = { async respond(request) {
    requests.push(structuredClone(request)); clock.value += request.kind === 'initial' ? 2 : 4;
    return request.kind === 'initial' ? batch(calls) : final;
  } };
  const executor = { async execute(call) { executions.push(call); clock.value += 3; return output(call); } };
  const agent = new AgentOrchestrator(model, executor, 2, budget, 5, 5, measurements, local.tracing);
  return { ...local, clock, measurements, requests, executions, model, executor, agent };
}
function hierarchy(spans, count) {
  assert.equal(roots(spans).length, count);
  assert.equal(new Set(spans.map(span => span.spanContext().spanId)).size, spans.length);
  for (const span of spans) {
    const id = span.spanContext();
    assert.match(id.traceId, /^[0-9a-f]{32}$/); assert.notEqual(id.traceId, '0'.repeat(32));
    assert.match(id.spanId, /^[0-9a-f]{16}$/); assert.notEqual(id.spanId, '0'.repeat(16));
    assert.equal(span.ended, true);
    assert.ok(Number.isFinite(span.duration[0]) && Number.isFinite(span.duration[1]));
    const root = roots(spans).find(root => root.spanContext().traceId === id.traceId);
    assert.ok(root);
    if (span === root) assert.equal(span.parentSpanContext, undefined);
    else assert.deepEqual(span.parentSpanContext, root.spanContext());
  }
}
function safeSpans(spans, secrets = []) {
  const allowedKeys = new Set(['investigation.outcome', 'investigation.elapsed_boundary', 'model.request_kind',
    'model.usage_available', 'model.input_tokens', 'model.output_tokens', 'model.total_tokens',
    'tool.name', 'tool.attempt', 'operation.outcome', 'error.category']);
  for (const span of spans) {
    assert.ok(['incident.investigation', 'agent.model.respond', 'agent.tool.execute'].includes(span.name));
    assert.ok(Object.keys(span.attributes).every(key => allowedKeys.has(key)));
    assert.equal(span.status.message, undefined);
    assert.ok(span.events.every(event => ['approval.requested', 'approval.resumed', 'approval.rejected'].includes(event.name)));
    assert.ok(span.events.every(event => !event.attributes || Object.keys(event.attributes).length === 0));
  }
  const serialized = JSON.stringify(spans.map(project));
  for (const secret of secrets) assert.ok(!serialized.includes(secret), `Trace leaked ${secret}`);
}

test('actual isolated SDK exports one root and correct model/tool children, ending each once; measurements coexist', async t => {
  const s = setup(t, [read], 1), priorContext = context.active();
  const result = await s.agent.investigate(incident), spans = await s.finished();
  hierarchy(spans, 1); assert.equal(spans.length, 4);
  assert.deepEqual(models(spans).map(span => span.attributes['model.request_kind']), ['initial', 'continuation']);
  assert.deepEqual(tools(spans).map(span => [span.attributes['tool.name'], span.attributes['tool.attempt']]), [['get_service_info', 1]]);
  assert.ok(spans.every(span => span.status.code === SpanStatusCode.OK));
  assert.equal(roots(spans)[0].attributes['investigation.outcome'], 'COMPLETED');
  assert.equal(roots(spans)[0].attributes['investigation.elapsed_boundary'], 'includes_backoff_and_approval_wait');
  assert.equal(context.active(), priorContext, 'No global context registration/activation');
  assert.equal(trace.getSpan(context.active()), undefined);
  assert.ok(s.created.every(entry => entry.end.mock.callCount() === 1));
  assert.deepEqual(s.measurements.get(result.investigationId).duration, { status: 'MEASURED', milliseconds: 9 });
  assert.deepEqual(result.toolExecutions, [{ callId: 'A', toolName: 'get_service_info', status: 'SUCCEEDED' }]);
  assert.deepEqual(Object.keys(result).sort(), ['diagnosis', 'incidentId', 'investigationId', 'status', 'toolExecutions']);
  assert.deepEqual(s.requests[1].outputs, [output(read)]);
  safeSpans(spans, [incident.description, incident.title, incident.id]);
});

test('model failure preserves the original error and exports safe FAILED root/model status', async t => {
  const s = setup(t), failure = new Error('SECRET_MODEL_PROMPT_AND_KEY');
  t.mock.method(s.model, 'respond', async () => { s.clock.value += 7; throw failure; });
  await assert.rejects(s.agent.investigate(incident), error => error === failure);
  const spans = await s.finished(); hierarchy(spans, 1);
  assert.equal(spans.length, 2); assert.equal(tools(spans).length, 0);
  assert.equal(roots(spans)[0].attributes['investigation.outcome'], 'FAILED');
  assert.ok(spans.every(span => span.status.code === SpanStatusCode.ERROR));
  assert.equal(models(spans)[0].attributes['operation.outcome'], 'FAILED');
  assert.equal(models(spans)[0].attributes['error.category'], 'UNKNOWN');
  assert.deepEqual(s.measurements.getAll()[0].duration, { status: 'MEASURED', milliseconds: 7 });
  safeSpans(spans, [failure.message, failure.stack]);
});

test('budget exhaustion and final model-turn requests create no spans for unexecuted calls', async t => {
  const s = setup(t, [read, { ...read, callId: 'C' }], 1);
  await assert.rejects(s.agent.investigate(incident), /tool-call budget exhausted/);
  let spans = await s.finished(); hierarchy(spans, 1);
  assert.equal(tools(spans).length, 1); assert.equal(models(spans).length, 1);
  assert.equal(s.agent.currentRecord.toolExecutions.length, 1);
  assert.equal(roots(spans)[0].attributes['investigation.outcome'], 'FAILED');
  const turnLimited = new AgentOrchestrator(s.model, s.executor, 1, 8, 1000, 1000, s.measurements, s.tracing);
  await assert.rejects(turnLimited.investigate(incident), /model turn limit/);
  spans = await s.finished(); hierarchy(spans, 2);
  assert.equal(tools(spans).length, 1); assert.equal(models(spans).length, 2);
  assert.deepEqual(turnLimited.currentRecord.toolExecutions, []);
});

for (const [error, category] of [
  [new TypeError('SECRET_BAD_ARGUMENTS'), 'TYPE_ERROR'],
  [new ToolError('INVALID_INPUT', 'SECRET_BAD_INPUT'), 'INVALID_INPUT'],
  [new ToolError('SERVICE_NOT_FOUND', 'SECRET_SERVICE'), 'SERVICE_NOT_FOUND'],
  [new MalformedMcpResultError('SECRET_SDK_BODY'), 'MALFORMED_MCP_RESULT'],
  [new SdkError(SdkErrorCode.ConnectionClosed, 'SECRET_CONNECTION'), 'MCP_ERROR'],
  [new Error('SECRET_UNKNOWN_TOOL_FAILURE'), 'UNKNOWN'],
]) {
  test(`non-retryable tool failure exports only bounded ${category} and preserves failure/budget behavior`, async t => {
    const s = setup(t, [read, { ...read, callId: 'C' }]);
    const execute = t.mock.method(s.executor, 'execute', async () => { throw error; });
    await assert.rejects(s.agent.investigate(incident), actual => actual === error);
    const spans = await s.finished(); hierarchy(spans, 1);
    assert.equal(execute.mock.callCount(), 1); assert.equal(models(spans).length, 1);
    assert.equal(tools(spans).length, 1); assert.equal(tools(spans)[0].status.code, SpanStatusCode.ERROR);
    assert.equal(tools(spans)[0].attributes['error.category'], category);
    assert.equal(roots(spans)[0].status.code, SpanStatusCode.ERROR);
    assert.deepEqual(s.agent.currentRecord.toolExecutions.map(call => call.status), ['FAILED']);
    safeSpans(spans, [error.message, error.stack]);
  });
}

test('model timeout ends caller-side spans once and late response/usage never revises them', async t => {
  const s = setup(t), pending = deferred();
  t.mock.method(s.model, 'respond', () => pending.promise);
  s.clock.fakeTimers = true; t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(s.agent.investigate(incident), OperationTimeoutError);
  await tick(t, s.clock, 5); await rejected;
  const spans = await s.finished(), before = structuredClone(spans.map(project)); hierarchy(spans, 1);
  assert.equal(models(spans)[0].attributes['operation.outcome'], 'TIMEOUT');
  assert.equal(models(spans)[0].status.code, SpanStatusCode.ERROR);
  assert.equal(roots(spans)[0].attributes['investigation.outcome'], 'FAILED');
  assert.equal(tools(spans).length, 0); assert.equal(s.measurements.getAll()[0].duration.milliseconds, 5);
  const late = structuredClone(final);
  associateProviderUsage(late, providerUsage({ input_tokens: 2, output_tokens: 3, total_tokens: 5 })); // Controlled test-only metadata.
  pending.resolve(late); await nextTurn();
  assert.deepEqual((await s.finished()).map(project), before);
  assert.ok(s.created.every(entry => entry.end.mock.callCount() === 1));
});

test('tool timeout with one-slot budget exports one failed attempt and ignores late evidence', async t => {
  const s = setup(t, [read], 1), pending = deferred();
  t.mock.method(s.executor, 'execute', () => pending.promise);
  s.clock.fakeTimers = true; t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(s.agent.investigate(incident), OperationTimeoutError);
  await nextTurn(); await tick(t, s.clock, 5); await rejected;
  const spans = await s.finished(), before = structuredClone(spans.map(project)); hierarchy(spans, 1);
  assert.equal(tools(spans).length, 1); assert.equal(models(spans).length, 1);
  assert.equal(tools(spans)[0].attributes['operation.outcome'], 'TIMEOUT');
  assert.equal(roots(spans)[0].status.code, SpanStatusCode.ERROR);
  assert.equal(s.agent.currentRecord.toolExecutions.length, 1);
  pending.resolve({ callId: read.callId, output: 'SECRET_LATE_EVIDENCE' }); await nextTurn();
  assert.deepEqual((await s.finished()).map(project), before);
  assert.equal(s.requests.length, 1);
});

test('retry spans retain distinct attempts outside backoff; a failed child does not fail a recovered root', async t => {
  const s = setup(t, [read], 2), pending = deferred(), normal = s.executor.execute.bind(s.executor);
  let first = true;
  t.mock.method(s.executor, 'execute', call => {
    if (first) { first = false; s.executions.push(call); return pending.promise; }
    return normal(call);
  });
  s.clock.fakeTimers = true; t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = s.agent.investigate(incident);
  await nextTurn(); await tick(t, s.clock, 5);
  const firstAttempt = s.created.find(entry => entry.span.name === 'agent.tool.execute');
  assert.equal(firstAttempt.span.ended, true); assert.equal(firstAttempt.finished - firstAttempt.started, 5);
  await tick(t, s.clock, 99);
  assert.equal(s.created.filter(entry => entry.span.name === 'agent.tool.execute').length, 1);
  assert.equal(s.created[0].span.ended, false);
  await tick(t, s.clock, 1);
  const result = await run, spans = await s.finished(); hierarchy(spans, 1);
  assert.deepEqual(tools(spans).map(span => [span.attributes['tool.attempt'], span.attributes['operation.outcome'], span.status.code]),
    [[1, 'TIMEOUT', SpanStatusCode.ERROR], [2, 'SUCCEEDED', SpanStatusCode.OK]]);
  const attempts = s.created.filter(entry => entry.span.name === 'agent.tool.execute');
  assert.equal(attempts[1].started - attempts[0].finished, 100);
  assert.equal(attempts[1].finished - attempts[1].started, 3);
  assert.equal(roots(spans)[0].status.code, SpanStatusCode.OK);
  assert.equal(roots(spans)[0].attributes['investigation.outcome'], 'COMPLETED');
  assert.deepEqual(result.toolExecutions.map(call => [call.callId, call.status]), [['A', 'FAILED'], ['A', 'SUCCEEDED']]);
  assert.equal(s.executions[0], s.executions[1]); assert.deepEqual(s.requests[1].outputs, [output(read)]);
  const measured = s.measurements.get(result.investigationId);
  assert.equal(measured.duration.milliseconds, 114);
  assert.deepEqual(measured.toolAttempts.map(attempt => attempt.duration.milliseconds), [5, 3]);
  const before = structuredClone(spans.map(project)); pending.resolve(output(read)); await nextTurn();
  assert.deepEqual((await s.finished()).map(project), before);
});

test('exhausted timeout retry retains two failed spans and never continues the model', async t => {
  const s = setup(t, [read], 2);
  t.mock.method(s.executor, 'execute', () => new Promise(() => {}));
  s.clock.fakeTimers = true; t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(s.agent.investigate(incident), OperationTimeoutError);
  await nextTurn(); await tick(t, s.clock, 5); await tick(t, s.clock, 100); await tick(t, s.clock, 5); await rejected;
  const spans = await s.finished(); hierarchy(spans, 1);
  assert.deepEqual(tools(spans).map(span => [span.attributes['tool.attempt'], span.attributes['operation.outcome']]), [[1, 'TIMEOUT'], [2, 'TIMEOUT']]);
  assert.equal(models(spans).length, 1); assert.equal(roots(spans)[0].status.code, SpanStatusCode.ERROR);
  assert.deepEqual(s.agent.currentRecord.toolExecutions.map(call => call.status), ['FAILED', 'FAILED']);
});

for (const choice of ['approve', 'reject']) {
  test(`approval ${choice} retains pending root, resumes the same trace and creates no unexecuted tool span`, async t => {
    const s = setup(t, [risk], 1), waiting = await s.agent.investigate(incident);
    const root = s.created[0].span, rootContext = root.spanContext();
    assert.equal(waiting.status, 'AWAITING_APPROVAL'); assert.equal(root.ended, false);
    assert.equal(root.attributes['investigation.outcome'], 'AWAITING_APPROVAL');
    assert.equal(roots(await s.finished()).length, 0); assert.equal(tools(await s.finished()).length, 0);
    assert.equal(s.measurements.getAll()[0].duration.status, 'PENDING');
    const eventsBefore = structuredClone(root.events), startsBefore = s.created.length;
    await assert.rejects(s.agent.resolveApproval({ ...decision(waiting), approvalId: 'wrong' }), /approval/);
    await assert.rejects(s.agent.resolveApproval({ ...decision(waiting), extra: 'SECRET' }), TypeError);
    assert.deepEqual(root.events, eventsBefore); assert.equal(s.created.length, startsBefore);
    s.clock.value += 1000;
    const outcomes = await Promise.allSettled([s.agent.resolveApproval(decision(waiting, choice)), s.agent.resolveApproval(decision(waiting, choice))]);
    assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected');
    const result = outcomes[0].value, spans = await s.finished(); hierarchy(spans, 1);
    const exportedRoot = roots(spans)[0]; assert.deepEqual(exportedRoot.spanContext(), rootContext);
    assert.equal(exportedRoot.attributes['investigation.outcome'], choice === 'approve' ? 'COMPLETED' : 'REJECTED');
    assert.deepEqual(exportedRoot.events.map(event => event.name), choice === 'approve'
      ? ['approval.requested', 'approval.resumed'] : ['approval.requested', 'approval.resumed', 'approval.rejected']);
    assert.equal(tools(spans).length, choice === 'approve' ? 1 : 0);
    assert.equal(models(spans).length, choice === 'approve' ? 2 : 1);
    assert.equal(s.executions.length, choice === 'approve' ? 1 : 0);
    assert.ok(s.created.every(entry => entry.end.mock.callCount() === 1));
    const measured = s.measurements.get(result.investigationId);
    assert.equal(measured.approvalWaits[0].duration.milliseconds, 1000);
    assert.equal(measured.duration.milliseconds, choice === 'approve' ? 1009 : 1002);
    const before = structuredClone(spans.map(project));
    await assert.rejects(s.agent.resolveApproval(decision(waiting)), /consumed/);
    assert.deepEqual((await s.finished()).map(project), before);
    safeSpans(spans, [waiting.pendingApproval.approvalId, risk.callId, incident.service]);
  });
}

test('approved risky timeout is one failed span with no retry, continuation or approval replay', async t => {
  const s = setup(t, [risk], 8);
  t.mock.method(s.executor, 'execute', () => new Promise(() => {}));
  s.clock.fakeTimers = true; t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = await s.agent.investigate(incident);
  const rejected = assert.rejects(s.agent.resolveApproval(decision(waiting)), OperationTimeoutError);
  await tick(t, s.clock, 5); await rejected;
  const spans = await s.finished(); hierarchy(spans, 1);
  assert.equal(tools(spans).length, 1); assert.equal(models(spans).length, 1);
  assert.equal(tools(spans)[0].attributes['tool.name'], 'restart_service');
  assert.equal(tools(spans)[0].attributes['operation.outcome'], 'TIMEOUT');
  assert.equal(roots(spans)[0].attributes['investigation.outcome'], 'FAILED');
  await assert.rejects(s.agent.resolveApproval(decision(waiting)), /consumed/);
  assert.ok(s.created.every(entry => entry.end.mock.callCount() === 1));
});

test('overlapping approval resumes use the actual original SDK root contexts, never the latest investigation', async t => {
  const local = localTracing(t), measurements = new InvestigationMeasurements(), executions = [];
  const model = { async respond(request) {
    return request.kind === 'initial' ? batch([{ ...risk, callId: JSON.parse(request.prompt).id }]) : final;
  } };
  const executor = { async execute(call) { executions.push(call); await nextTurn(); return output(call); } };
  const agent = new AgentOrchestrator(model, executor, 2, 1, 1000, 1000, measurements, local.tracing);
  const a = await agent.investigate(incidents[0]), rootA = local.created.find(entry => entry.span.name === 'incident.investigation').span;
  const b = await agent.investigate(incidents[1]), rootB = local.created.filter(entry => entry.span.name === 'incident.investigation')[1].span;
  const firstA = models(await local.finished()).find(span => span.spanContext().traceId === rootA.spanContext().traceId);
  const firstB = models(await local.finished()).find(span => span.spanContext().traceId === rootB.spanContext().traceId);
  assert.equal(firstA.parentSpanContext.spanId, rootA.spanContext().spanId);
  assert.equal(firstB.parentSpanContext.spanId, rootB.spanContext().spanId);
  assert.notEqual(rootA.spanContext().traceId, rootB.spanContext().traceId);
  await agent.resolveApproval(decision(a));
  assert.equal(rootA.ended, true); assert.equal(rootB.ended, false);
  assert.equal(agent.currentRecord.investigationId, b.investigationId);
  await agent.resolveApproval(decision(b));
  const spans = await local.finished(); hierarchy(spans, 2);
  for (const root of [rootA, rootB]) {
    const own = spans.filter(span => span.spanContext().traceId === root.spanContext().traceId);
    assert.equal(own.length, 4); assert.equal(tools(own)[0].parentSpanContext.spanId, root.spanContext().spanId);
    assert.equal(models(own).length, 2); assert.ok(own.every(span => span.ended));
  }
  assert.deepEqual(executions.map(call => call.callId), [incidents[0].id, incidents[1].id]);
  assert.equal(measurements.get(a.investigationId).status, 'COMPLETED');
  assert.equal(measurements.get(b.investigationId).status, 'COMPLETED');
});

test('concurrently outstanding model waits finish out of order with isolated SDK parentage', async t => {
  const local = localTracing(t), a = deferred(), b = deferred();
  const model = { respond(request) { return JSON.parse(request.prompt).id === incidents[0].id ? a.promise : b.promise; } };
  const agent = new AgentOrchestrator(model, {}, 2, 1, 1000, 1000, undefined, local.tracing);
  const runA = agent.investigate(incidents[0]), runB = agent.investigate(incidents[1]);
  await nextTurn();
  const [rootA, rootB] = local.created.filter(entry => entry.span.name === 'incident.investigation').map(entry => entry.span);
  b.resolve(final); await runB; assert.equal(rootA.ended, false); assert.equal(rootB.ended, true);
  a.resolve(final); await runA;
  const spans = await local.finished(); hierarchy(spans, 2);
  assert.equal(spans.length, 4);
  assert.notEqual(rootA.spanContext().traceId, rootB.spanContext().traceId);
});

test('unknown tool names, sensitive arguments/results and exception details never become span data', async t => {
  const local = localTracing(t), secret = 'SECRET_PROMPT_KEY_STACK_HEADER_RUNBOOK';
  const errorAgent = new AgentOrchestrator({ async respond() { return batch([{ callId: secret, name: secret, arguments: { query: secret } }]); } },
    new ToolExecutor({ callTool() { assert.fail('Unrecognized tool cannot reach MCP'); } }), 2, 1, 1000, 1000, undefined, local.tracing);
  await assert.rejects(errorAgent.investigate({ ...incident, title: secret, description: secret }), /Tool not allowed/);
  const validAgent = new AgentOrchestrator({ async respond(request) {
    return request.kind === 'initial' ? batch([{ ...read, arguments: { service: secret } }]) : { kind: 'final', diagnosis: { ...final.diagnosis, summary: secret } };
  } }, { async execute(call) { return { callId: call.callId, output: secret }; } }, 2, 1, 1000, 1000, undefined, local.tracing);
  await validAgent.investigate({ ...incident, description: secret });
  const spans = await local.finished(); hierarchy(spans, 2); safeSpans(spans, [secret]);
  assert.equal(tools(spans)[0].attributes['tool.name'], 'UNRECOGNIZED');
});

test('SDK startSpan failure cannot block measurements, execution or original exception propagation', async t => {
  const s = setup(t);
  t.mock.method(s.tracer, 'startSpan', () => { throw new Error('telemetry setup failed'); });
  assert.equal((await s.agent.investigate(incident)).status, 'COMPLETED');
  assert.equal(s.measurements.getAll()[0].duration.milliseconds, 9);
  const error = new Error('original model error');
  t.mock.method(s.model, 'respond', async () => { throw error; });
  await assert.rejects(s.agent.investigate(incident), actual => actual === error);
  assert.equal(s.measurements.getAll()[1].status, 'FAILED');
  assert.equal((await s.finished()).length, 0);
});

for (const method of ['setAttribute', 'setStatus', 'addEvent', 'end']) {
  test(`SDK ${method} failure never changes approved execution or prevents the measurement observer`, async t => {
    const s = setup(t, [risk], 1), start = s.tracer.startSpan.bind(s.tracer);
    t.mock.method(s.tracer, 'startSpan', (...args) => {
      const span = start(...args), original = span[method].bind(span);
      t.mock.method(span, method, (...callArgs) => {
        if (method === 'end') original(...callArgs); // Export a real ended span, then simulate processor failure.
        throw new Error('telemetry callback failed');
      });
      return span;
    });
    const waiting = await s.agent.investigate(incident);
    assert.equal((await s.agent.resolveApproval(decision(waiting))).status, 'COMPLETED');
    assert.equal(s.measurements.getAll()[0].status, 'COMPLETED');
    assert.equal(s.executions.length, 1);
    const spans = await s.finished(); hierarchy(spans, 1); assert.equal(spans.length, 4);
  });
}

test('measurement observer/setup failures do not block real tracing observations or replace original results/errors', async t => {
  const s = setup(t), originalModel = s.measurements.model.bind(s.measurements), originalTool = s.measurements.tool.bind(s.measurements);
  const throwAfter = observation => ({ succeeded(value) { observation.succeeded(value); throw Error('measurement failure'); },
    failed(error) { observation.failed(error); throw Error('measurement failure'); } });
  t.mock.method(s.measurements, 'model', (...args) => throwAfter(originalModel(...args)));
  t.mock.method(s.measurements, 'tool', (...args) => throwAfter(originalTool(...args)));
  assert.equal((await s.agent.investigate(incident)).status, 'COMPLETED');
  const original = new Error('original failure');
  t.mock.method(s.executor, 'execute', async () => { throw original; });
  await assert.rejects(s.agent.investigate(incident), error => error === original);
  t.mock.method(s.measurements, 'model', () => { throw Error('measurement setup'); });
  t.mock.method(s.measurements, 'tool', () => { throw Error('measurement setup'); });
  await assert.rejects(s.agent.investigate(incident), error => error === original);
  const spans = await s.finished(); hierarchy(spans, 3);
  assert.equal(roots(spans).filter(span => span.attributes['investigation.outcome'] === 'COMPLETED').length, 1);
  assert.equal(tools(spans).length, 3); assert.equal(models(spans).length, 4);
});

test('tracing observer/setup failures cannot block accepted measurement observations', async t => {
  const s = setup(t), original = s.tracing.model.bind(s.tracing);
  t.mock.method(s.tracing, 'model', (...args) => {
    const observation = original(...args);
    return { succeeded(value) { observation.succeeded(value); throw Error('trace observer'); },
      failed(error) { observation.failed(error); throw Error('trace observer'); } };
  });
  assert.equal((await s.agent.investigate(incident)).status, 'COMPLETED');
  assert.equal(s.measurements.getAll()[0].modelCalls.length, 2);
  assert.equal(s.measurements.getAll()[0].duration.milliseconds, 9);
  t.mock.method(s.tracing, 'model', () => { throw Error('trace setup'); });
  assert.equal((await s.agent.investigate(incident)).status, 'COMPLETED');
  assert.equal(s.measurements.getAll()[1].modelCalls.length, 2);
  assert.equal(s.measurements.getAll()[1].duration.milliseconds, 9);
  hierarchy(await s.finished(), 2);
});

test('real SDK exporter failure cannot replace application success or original failure', async t => {
  const s = setup(t);
  t.mock.method(s.exporter, 'export', (_spans, callback) => callback({ code: 1, error: new Error('offline exporter failed') }));
  assert.equal((await s.agent.investigate(incident)).status, 'COMPLETED');
  assert.equal(s.measurements.getAll()[0].status, 'COMPLETED');
  const error = new TypeError('original application error');
  t.mock.method(s.model, 'respond', async () => { throw error; });
  await assert.rejects(s.agent.investigate(incident), actual => actual === error);
  await nextTurn();
  assert.equal(s.measurements.getAll()[1].status, 'FAILED');
});

test('real OpenAI SDK local mock usage reaches spans; missing remains absent and genuine zero stays zero', async t => {
  const local = localTracing(t), previous = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_AGENT_MODEL };
  process.env.OPENAI_API_KEY = 'SECRET_LOCAL_MOCK_KEY'; process.env.OPENAI_AGENT_MODEL = 'local-mock';
  t.after(() => { for (const [key, value] of [['OPENAI_API_KEY', previous.key], ['OPENAI_AGENT_MODEL', previous.model]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const responses = [
    { output: [{ type: 'function_call', id: 'f', call_id: 'A', name: 'get_service_info', arguments: JSON.stringify(read.arguments), status: 'completed' }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(final.diagnosis) }] }] },
    { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(final.diagnosis) }] }],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
  ];
  let next = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    assert.ok(next < responses.length, 'No unexpected request/retry');
    return new Response(JSON.stringify({ id: 'mock-response', status: 'completed', error: null, ...responses[next++] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const measurements = new InvestigationMeasurements();
  const agent = new AgentOrchestrator(new OpenAIAgentModel(), { async execute(call) { return output(call); } }, 2, 1, 1000, 1000, measurements, local.tracing);
  await agent.investigate(incident); await agent.investigate(incident);
  const spans = await local.finished(); hierarchy(spans, 2);
  const calls = models(spans);
  assert.deepEqual(calls.map(span => span.attributes['model.usage_available']), [true, false, true]);
  assert.deepEqual(calls.map(span => span.attributes['model.total_tokens']), [12, undefined, 0]);
  assert.deepEqual([calls[0].attributes['model.input_tokens'], calls[0].attributes['model.output_tokens']], [10, 2]);
  const summary = summarizeMeasurements(measurements.getAll()).usage;
  assert.equal(summary.availability, 'PARTIAL'); assert.equal(summary.completeTotal, null);
  assert.deepEqual(summary.knownSubtotal, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  safeSpans(spans, ['SECRET_LOCAL_MOCK_KEY', 'mock-response', JSON.stringify(final.diagnosis)]);
});

test('narrow lexical fallback through actual in-memory MCP remains one tool span and one budget slot', async t => {
  const local = localTracing(t), measurements = new InvestigationMeasurements();
  const executor = await createTestExecutor(t, new RunbookRetriever({ async embed() { throw new SemanticRetrievalUnavailableError('SECRET_EMBEDDING_OUTAGE'); } }));
  const call = { callId: 'R', name: 'search_runbook', arguments: { query: 'cache', limit: 1 } };
  const model = { async respond(request) { return request.kind === 'initial' ? batch([call]) : final; } };
  const result = await new AgentOrchestrator(model, executor, 2, 1, 1000, 1000, measurements, local.tracing).investigate(incident);
  const spans = await local.finished(); hierarchy(spans, 1);
  assert.equal(tools(spans).length, 1); assert.equal(tools(spans)[0].attributes['operation.outcome'], 'SUCCEEDED');
  assert.equal(result.toolExecutions.length, 1); assert.equal(measurements.getAll()[0].toolAttempts.length, 1);
  safeSpans(spans, ['SECRET_EMBEDDING_OUTAGE', 'cache']);
});

test('isolated providers never replace global tracing or share exported traces', async t => {
  const a = localTracing(t), b = localTracing(t), global = trace.getTracerProvider();
  const ambient = a.tracer.startSpan('external-ambient', {}, ROOT_CONTEXT);
  const result = await new AgentOrchestrator({ async respond() { return final; } }, {}, 2, 1, 1000, 1000, undefined, b.tracing).investigate(incident);
  assert.equal(result.status, 'COMPLETED');
  assert.equal((await a.finished()).length, 0);
  hierarchy(await b.finished(), 1);
  assert.equal(roots(await b.finished())[0].parentSpanContext, undefined);
  ambient.end(); assert.equal((await a.finished()).length, 1);
  assert.equal(trace.getTracerProvider(), global);
});

test('traced 30-case evaluation exports real parentage without changing accepted scoring, reports or measurements', async t => {
  const local = localTracing(t), measurements = new InvestigationMeasurements(), results = [];
  const baseline = await runScriptedBaseline(), expanded = await runExpandedEvaluation(), measuredBefore = await runMeasuredEvaluation();
  for (const scenario of createExpandedDataset()) {
    const connection = await connectScenarioExecutor(scenario.evidence, scenario.source);
    try {
      const agent = new AgentOrchestrator(createScriptedBaselineModel(), connection.executor, 8, 8, 1000, 1000, measurements, local.tracing);
      const record = await agent.investigate(toAgentIncident(scenario.evaluationCase));
      results.push(evaluateInvestigation(scenario.evaluationCase, record));
    } finally { await connection.close(); }
  }
  assert.deepEqual(results, expanded.results); assert.deepEqual(results.slice(0, 5), baseline.results);
  const spans = await local.finished(); hierarchy(spans, 30); safeSpans(spans);
  assert.equal(spans.length, 210); assert.equal(models(spans).length, 60); assert.equal(tools(spans).length, 120);
  assert.equal(new Set(roots(spans).map(span => span.spanContext().traceId)).size, 30);
  assert.ok(models(spans).every(span => span.attributes['model.usage_available'] === false && !Object.hasOwn(span.attributes, 'model.total_tokens')));
  const summary = summarizeMeasurements(measurements.getAll());
  assert.equal(summary.investigations.outcomes.COMPLETED, 30); assert.equal(summary.modelCalls.count, 60);
  assert.equal(summary.toolAttempts.count, 120); assert.equal(summary.toolAttempts.retries, 0);
  assert.deepEqual(summary.usage, measuredBefore.measurementSummary.usage);
  assert.deepEqual(await runScriptedBaseline(), baseline); assert.deepEqual(await runExpandedEvaluation(), expanded);
  const measuredAfter = await runMeasuredEvaluation();
  assert.deepEqual(measuredAfter.results, measuredBefore.results); assert.deepEqual(measuredAfter.scoring, measuredBefore.scoring);
  assert.equal(measuredAfter.measurementSummary.modelCalls.count, 60);
  assert.equal(measuredAfter.measurementSummary.toolAttempts.count, 120);
  assert.deepEqual(measuredAfter.measurementSummary.usage, measuredBefore.measurementSummary.usage);
});
