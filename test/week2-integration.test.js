import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AgentOrchestrator, ToolExecutor } from '../dist/agent/index.js';
import { RunbookRetriever } from '../dist/rag/runbook-retriever.js';
import { SemanticRetrievalUnavailableError } from '../dist/rag/semantic-retrieval-unavailable-error.js';
import { searchLogs, getMetrics, restartService, ToolError } from '../dist/tools/index.js';
import { incidents, runbooks } from '../dist/fixtures/index.js';
import { createTestExecutor } from './fixtures/mcp-memory.js';
import { connectTestMcpClient } from './fixtures/mcp-stdio.js';

const incident = incidents[0];
const logs = { callId: 'A', name: 'search_logs', arguments: { service: incident.service, timeWindow: incident.timeWindow } };
const restart = { callId: 'B', name: 'restart_service', arguments: { service: incident.service } };
const metrics = { callId: 'C', name: 'get_metrics', arguments: { service: incident.service, timeWindow: incident.timeWindow } };
const runbook = { callId: 'R', name: 'search_runbook', arguments: { query: 'cache', limit: 1 } };
const final = { kind: 'final', diagnosis: { summary: 'Controlled investigation complete.',
  probableCause: 'Further investigation needed.', confidence: 'medium', evidence: [], recommendedActions: [] } };
const entry = (call, status = 'SUCCEEDED') => ({ callId: call.callId, toolName: call.name, status });
const output = (call, value) => ({ callId: call.callId, output: JSON.stringify(value) });
const decision = (waiting, choice = 'approve') => ({ investigationId: waiting.investigationId,
  approvalId: waiting.pendingApproval.approvalId, decision: choice });
function modelFor(calls) {
  const seen = [];
  return { seen, async respond(request) {
    seen.push(structuredClone(request));
    assert.ok(seen.length <= 2, 'No extra model turn');
    return seen.length === 1 ? { kind: 'tool_calls', continuation: 'week2-original-response', calls } : final;
  } };
}
function assertPending(waiting, history) {
  assert.equal(waiting.status, 'AWAITING_APPROVAL');
  assert.deepEqual(waiting.toolExecutions, history);
  assert.deepEqual(waiting.pendingApproval, { investigationId: waiting.investigationId,
    approvalId: waiting.pendingApproval.approvalId, callId: restart.callId,
    toolName: restart.name, arguments: restart.arguments });
  assert.match(waiting.pendingApproval.approvalId, /^[0-9a-f-]{36}$/);
}
function assertContinuation(model, outputs) {
  assert.equal(model.seen.length, 2);
  assert.deepEqual(model.seen[1], { kind: 'continuation', continuation: 'week2-original-response', outputs });
}
beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Week 2 integration tests must not access external networks'));
});

test('Week 2 real stdio: read A / approve risky B / read C resumes one investigation at exact budget', async t => {
  const client = await connectTestMcpClient(t);
  const mcp = t.mock.method(client, 'callTool');
  const executor = new ToolExecutor(client);
  const execute = t.mock.method(executor, 'execute');
  const model = modelFor([logs, restart, metrics]);
  const agent = new AgentOrchestrator(model, executor, 2, 3);
  const waiting = await agent.investigate(incident);
  assertPending(waiting, [entry(logs)]);
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(mcp.mock.callCount(), 1);
  assert.equal(model.seen.length, 1);
  const result = await agent.resolveApproval(decision(waiting));
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.investigationId, waiting.investigationId);
  assert.deepEqual(result.diagnosis, final.diagnosis);
  assert.deepEqual(result.toolExecutions, [entry(logs), entry(restart), entry(metrics)]);
  assert.deepEqual(execute.mock.calls.map(call => call.arguments[0]), [logs, restart, metrics]);
  assert.deepEqual(mcp.mock.calls.map(call => call.arguments[0]), [logs, restart, metrics].map(call => ({ name: call.name, arguments: call.arguments })));
  assertContinuation(model, [output(logs, searchLogs(logs.arguments)), output(restart, restartService(restart.arguments)),
    output(metrics, getMetrics(metrics.arguments))]);
  assert.ok(!Object.hasOwn(result, 'pendingApproval'));
  await assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
  assert.equal(execute.mock.callCount(), 3, 'Duplicate approval cannot replay the risky action');
});

test('Week 2 real stdio: rejecting risky B retains read A and prevents read C and continuation', async t => {
  const client = await connectTestMcpClient(t);
  const mcp = t.mock.method(client, 'callTool');
  const executor = new ToolExecutor(client);
  const execute = t.mock.method(executor, 'execute');
  const model = modelFor([logs, restart, metrics]);
  const agent = new AgentOrchestrator(model, executor, 2, 3);
  const waiting = await agent.investigate(incident);
  assertPending(waiting, [entry(logs)]);
  const result = await agent.resolveApproval(decision(waiting, 'reject'));
  assert.equal(result.investigationId, waiting.investigationId);
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.rejection, 'Human rejected restart_service');
  assert.deepEqual(result.toolExecutions, [entry(logs)]);
  assert.equal(model.seen.length, 1);
  assert.deepEqual(execute.mock.calls.map(call => call.arguments[0]), [logs]);
  assert.equal(mcp.mock.callCount(), 1);
  for (const key of ['pendingApproval', 'diagnosis', 'failure']) assert.ok(!Object.hasOwn(result, key));
  await assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
  assert.equal(mcp.mock.callCount(), 1);
});

test('Week 2 real stdio: terminal non-retryable mid-batch failure retains history without evidence or continuation', async t => {
  const client = await connectTestMcpClient(t);
  const mcp = t.mock.method(client, 'callTool');
  const executor = new ToolExecutor(client);
  const execute = t.mock.method(executor, 'execute');
  const missing = { callId: 'missing', name: 'get_service_info', arguments: { service: 'missing-service' } };
  const model = modelFor([logs, missing, runbook]);
  const agent = new AgentOrchestrator(model, executor, 2, 4);
  await assert.rejects(agent.investigate(incident), error => error instanceof ToolError && error.code === 'SERVICE_NOT_FOUND');
  const failed = agent.currentRecord;
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.failure, /missing-service/);
  assert.deepEqual(failed.toolExecutions, [entry(logs), entry(missing, 'FAILED')]);
  assert.deepEqual(execute.mock.calls.map(call => call.arguments[0]), [logs, missing]);
  assert.equal(mcp.mock.callCount(), 2);
  assert.equal(model.seen.length, 1);
  assert.ok(!Object.hasOwn(failed, 'diagnosis'));
});

for (const budget of [4, 3]) {
  test(`Week 2 combined controls: timeout retry + lexical fallback + approval with budget ${budget}`, async t => {
    const embedding = { async embed() { throw new SemanticRetrievalUnavailableError('Deterministic semantic outage'); } };
    const retriever = new RunbookRetriever(embedding);
    const lexical = t.mock.method(retriever, 'retrieveLexically');
    const embed = t.mock.method(embedding, 'embed');
    const executor = await createTestExecutor(t, retriever);
    const mcp = t.mock.method(executor.client, 'callTool');
    const realExecute = executor.execute.bind(executor);
    let resolveLate;
    const late = new Promise(resolve => { resolveLate = resolve; });
    // Only the first wait is injected. All successful executions use the SDK,
    // server input schemas and real business handlers over in-memory transport.
    let first = true;
    const execute = t.mock.method(executor, 'execute', call => {
      if (first) { first = false; return late; }
      return realExecute(call);
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const model = modelFor([logs, runbook, restart]);
    const agent = new AgentOrchestrator(model, executor, 2, budget, 50, 5);
    const pending = agent.investigate(incident);
    await nextTurn();
    const investigationId = agent.currentRecord.investigationId;
    assert.equal(agent.currentRecord.status, 'INVESTIGATING');
    t.mock.timers.tick(5);
    await nextTurn();
    assert.deepEqual(agent.currentRecord.toolExecutions, [entry(logs, 'FAILED')]);
    t.mock.timers.tick(99);
    await nextTurn();
    assert.equal(execute.mock.callCount(), 1, 'Fixed 100ms backoff has not finished');
    assert.equal(mcp.mock.callCount(), 0);
    t.mock.timers.tick(1);
    await nextTurn();
    const waiting = await pending;
    const prefix = [entry(logs, 'FAILED'), entry(logs), entry(runbook)];
    assert.equal(waiting.investigationId, investigationId);
    assertPending(waiting, prefix);
    assert.deepEqual(execute.mock.calls.map(call => call.arguments[0]), [logs, logs, runbook]);
    assert.equal(mcp.mock.callCount(), 2, 'Fallback adds no MCP request');
    assert.equal(lexical.mock.callCount(), 1);
    assert.equal(embed.mock.callCount(), 1);
    assert.equal(model.seen.length, 1);
    t.mock.timers.tick(1000);
    await nextTurn();
    assert.equal(execute.mock.callCount(), 3, 'Waiting approval consumes no attempt or deadline');
    let terminal;
    if (budget === 4) {
      terminal = await agent.resolveApproval(decision(waiting));
      assert.equal(terminal.status, 'COMPLETED');
      assert.deepEqual(terminal.diagnosis, final.diagnosis);
      assert.deepEqual(terminal.toolExecutions, [...prefix, entry(restart)]);
      assert.deepEqual(execute.mock.calls.map(call => call.arguments[0]), [logs, logs, runbook, restart]);
      assertContinuation(model, [output(logs, searchLogs(logs.arguments)),
        output(runbook, [{ runbook: runbooks[0], score: 1 }]), output(restart, restartService(restart.arguments))]);
    } else {
      await assert.rejects(agent.resolveApproval(decision(waiting)), /^Error: Agent tool-call budget exhausted \(3\)$/);
      terminal = agent.currentRecord;
      assert.equal(terminal.status, 'FAILED');
      assert.equal(terminal.failure, 'Agent tool-call budget exhausted (3)');
      assert.deepEqual(terminal.toolExecutions, prefix, 'No record for the unexecuted approved action');
      assert.equal(execute.mock.callCount(), 3, 'Approval cannot reset the used budget');
      assert.equal(model.seen.length, 1);
      assert.ok(!Object.hasOwn(terminal, 'diagnosis'));
    }
    assert.equal(terminal.investigationId, investigationId);
    assert.equal(mcp.mock.callCount(), budget - 1, 'Injected timeout has no MCP request; every successful tool has exactly one');
    assert.deepEqual(mcp.mock.calls.map(call => call.arguments[0]), (budget === 4 ? [logs, runbook, restart] : [logs, runbook])
      .map(call => ({ name: call.name, arguments: call.arguments })));
    assert.ok(!Object.hasOwn(terminal, 'pendingApproval'));
    await assert.rejects(agent.resolveApproval(decision(waiting)), /consumed approval/);
    resolveLate(output(logs, { source: 'late timed-out attempt must not become evidence' }));
    await nextTurn();
    assert.deepEqual(agent.currentRecord, terminal, 'Timeout did not cancel the wait; its late output still cannot change history');
    assert.equal(model.seen.length, budget === 4 ? 2 : 1);
  });
}
