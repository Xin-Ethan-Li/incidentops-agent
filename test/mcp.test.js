import assert from 'node:assert/strict';
import test from 'node:test';
import { connectTestMcpClient as connect } from './fixtures/mcp-stdio.js';
import { ToolExecutor, AgentOrchestrator } from '../dist/agent/index.js';
import { searchLogs, getMetrics, getServiceInfo, ToolError } from '../dist/tools/index.js';
import { incidents, runbooks } from '../dist/fixtures/index.js';

const incident = incidents[0];
const call = (name, args, callId = 'agent-original-call-id') => ({ name, arguments: args, callId });

test('real stdio discovers four read tools plus one simulated action and preserves read business logic', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No external network'));
  const client = await connect(t);
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map(tool => tool.name).sort(), ['get_metrics', 'get_service_info', 'restart_service', 'search_logs', 'search_runbook']);
  for (const tool of listing.tools) {
    assert.ok(tool.description);
    assert.equal(tool.inputSchema.type, 'object');
  }
  const executor = new ToolExecutor(client);
  const args = { service: incident.service, timeWindow: incident.timeWindow };
  for (const [name, input, expected] of [
    ['search_logs', args, searchLogs(args)],
    ['get_metrics', args, getMetrics(args)],
    ['get_service_info', { service: incident.service }, getServiceInfo({ service: incident.service })],
    ['search_runbook', { query: 'cache connectivity', limit: 1 }, [{ runbook: runbooks[0], score: 1 }]],
  ]) {
    const result = await executor.execute(call(name, input));
    assert.equal(result.callId, 'agent-original-call-id');
    assert.deepEqual(JSON.parse(result.output), expected);
  }
});

test('real stdio failures preserve meaningful categories and never become successful evidence', async t => {
  const client = await connect(t);
  const executor = new ToolExecutor(client);
  await assert.rejects(executor.execute(call('get_metrics', {
    service: incident.service, timeWindow: incident.timeWindow, metricNames: 7,
  })), error => error instanceof ToolError && error.code === 'INVALID_INPUT');
  await assert.rejects(executor.execute(call('get_service_info', { service: 'missing-service' })),
    error => error instanceof ToolError && error.code === 'SERVICE_NOT_FOUND');
  await assert.rejects(executor.execute(call('search_runbook', { query: ' ' })), TypeError);
  const businessError = await client.callTool({ name: 'get_service_info', arguments: { service: 'missing-service' } });
  assert.equal(businessError.isError, true);
  assert.equal(JSON.parse(businessError.content[0].text).error.code, 'SERVICE_NOT_FOUND');
  // SDK may express an unknown tool as a protocol rejection or an isError result.
  let unknown;
  try { unknown = await client.callTool({ name: 'not_registered', arguments: {} }); }
  catch (error) { assert.match(error.message, /not.found|unknown|not.registered/i); return; }
  assert.equal(unknown.isError, true);
});

test('real stdio preserves Agent continuation, diagnosis and execution state', async t => {
  const client = await connect(t);
  let turn = 0;
  const diagnosis = { summary: 'Evidence collected.', probableCause: 'Further investigation needed.', confidence: 'medium', evidence: ['Service metadata and runbook received.'], recommendedActions: [] };
  const model = { async respond(request) {
    if (turn++ === 0) return { kind: 'tool_calls', continuation: 'model-response-id', calls: [
      call('get_service_info', { service: incident.service }, 'metadata-id'),
      call('search_runbook', { query: 'cache failures', limit: 1 }, 'runbook-id'),
    ] };
    assert.equal(request.continuation, 'model-response-id');
    assert.deepEqual(request.outputs.map(output => output.callId), ['metadata-id', 'runbook-id']);
    assert.equal(JSON.parse(request.outputs[0].output).name, incident.service);
    assert.equal(JSON.parse(request.outputs[1].output)[0].runbook.id, 'RB-001');
    return { kind: 'final', diagnosis };
  } };
  const record = await new AgentOrchestrator(model, new ToolExecutor(client)).investigate(incident);
  assert.equal(record.status, 'COMPLETED');
  assert.deepEqual(record.diagnosis, diagnosis);
  assert.deepEqual(record.toolExecutions.map(item => [item.callId, item.status]), [['metadata-id', 'SUCCEEDED'], ['runbook-id', 'SUCCEEDED']]);
});

test('Application allowlist rejects arbitrary names before MCP call', async () => {
  const executor = new ToolExecutor({ async callTool() { assert.fail('Must reject before MCP'); } });
  for (const name of ['delete_database', 'constructor', '__proto__', 'toString']) {
    await assert.rejects(executor.execute(call(name, {})), /Tool not allowed/);
  }
});

test('MCP isError result marks investigation FAILED rather than supplying error evidence', async () => {
  const executor = new ToolExecutor({ async callTool() { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { name: 'Error', message: 'read failed' } }) }] }; } });
  let turns = 0;
  const agent = new AgentOrchestrator({ async respond() {
    turns++;
    return { kind: 'tool_calls', continuation: 'response', calls: [call('get_service_info', { service: incident.service })] };
  } }, executor);
  await assert.rejects(agent.investigate(incident), /read failed/);
  assert.equal(turns, 1);
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.equal(agent.currentRecord.toolExecutions[0].status, 'FAILED');
  assert.ok(!agent.currentRecord.diagnosis);
});

test('malformed MCP success content is rejected and transport errors propagate unchanged', async () => {
  for (const result of [null, {}, { content: [] }, { content: [{ type: 'image', data: 'x' }] },
    { content: [{ type: 'text', text: 'not json' }] }, { isError: 'false', content: [{ type: 'text', text: '{}' }] }]) {
    const executor = new ToolExecutor({ async callTool() { return result; } });
    await assert.rejects(executor.execute(call('get_service_info', { service: incident.service })), /Malformed MCP/);
  }
  const error = new Error('connection lost');
  const executor = new ToolExecutor({ async callTool() { throw error; } });
  await assert.rejects(executor.execute(call('get_service_info', { service: incident.service })), caught => caught === error);
});

for (const [args, message] of [
  [{ query: 42 }, 'query must be nonempty'],
  [{ query: 'valid', limit: '1' }, 'limit must be a positive safe integer'],
]) {
  test('runbook semantic regression preserves TypeError: ' + JSON.stringify(args), async () => {
    let mcpCalls = 0;
    const executor = new ToolExecutor({ async callTool() { mcpCalls++; assert.fail('Invalid semantics must fail before MCP'); } });
    const agent = new AgentOrchestrator({ async respond() {
      return { kind: 'tool_calls', continuation: 'response', calls: [call('search_runbook', args)] };
    } }, executor);
    await assert.rejects(agent.investigate(incident), error => error instanceof TypeError && error.message === message);
    assert.equal(mcpCalls, 0);
    assert.equal(agent.currentRecord.status, 'FAILED');
    assert.equal(agent.currentRecord.failure, message);
    assert.equal(agent.currentRecord.toolExecutions[0].status, 'FAILED');
    assert.ok(!agent.currentRecord.diagnosis);
  });
}

test('real stdio executes only an approved simulated restart and returns its evidence once', async t => {
  const client = await connect(t);
  const mcp = t.mock.method(client, 'callTool');
  let turns = 0;
  const model = { async respond(request) {
    if (++turns === 1) return { kind: 'tool_calls', continuation: 'restart-response', calls: [
      call('restart_service', { service: incident.service }, 'restart-id'),
    ] };
    assert.equal(request.continuation, 'restart-response');
    assert.deepEqual(request.outputs.map(item => item.callId), ['restart-id']);
    assert.deepEqual(JSON.parse(request.outputs[0].output), {
      service: incident.service, action: 'restart_service', simulated: true, status: 'SIMULATED',
    });
    return { kind: 'final', diagnosis: { summary: 'Simulated action completed.', probableCause: 'Further investigation needed.', confidence: 'medium', evidence: [], recommendedActions: [] } };
  } };
  const agent = new AgentOrchestrator(model, new ToolExecutor(client), 2, 1);
  const waiting = await agent.investigate(incident);
  assert.equal(waiting.status, 'AWAITING_APPROVAL');
  assert.equal(mcp.mock.callCount(), 0);
  const result = await agent.resolveApproval({ investigationId: waiting.investigationId,
    approvalId: waiting.pendingApproval.approvalId, decision: 'approve' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(mcp.mock.callCount(), 1);
  assert.deepEqual(result.toolExecutions, [{ callId: 'restart-id', toolName: 'restart_service', status: 'SUCCEEDED' }]);
});

test('unrecognized MCP errors remain generic failures, never INVALID_INPUT', async () => {
  for (const text of ['upstream unavailable', '{}', JSON.stringify({ error: { name: 'ToolError', code: 'UNKNOWN', message: 'unknown failure' } })]) {
    const executor = new ToolExecutor({ async callTool() { return { isError: true, content: [{ type: 'text', text }] }; } });
    await assert.rejects(executor.execute(call('get_service_info', { service: incident.service })), error => {
      assert.equal(error.constructor, Error);
      assert.equal(error instanceof ToolError, false);
      assert.equal(error.code, undefined);
      return true;
    });
  }
});
