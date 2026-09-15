import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { AgentOrchestrator, ToolExecutor } from '../dist/agent/index.js';
import { RunbookRetriever } from '../dist/rag/index.js';
import { incidents, logs, metrics, services, runbooks } from '../dist/fixtures/index.js';

// Only decisions and vectors are scripted. All evidence and execution use real components.
beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('Integration tests must not access the network'); });
});

async function investigate(incident) {
  const evidence = {};
  const states = [];
  const embeddingInputs = [];
  const query = `Investigate ${incident.service}`;
  const bookIndex = runbooks.findIndex(book => book.tags.includes(incident.service));
  assert.ok(bookIndex >= 0);
  const provider = { async embed(texts) {
    embeddingInputs.push([...texts]);
    return texts.map(text => {
      const index = text === query ? bookIndex : runbooks.findIndex(book => text.startsWith(`Title: ${book.title}\n`));
      assert.ok(index >= 0, 'Only visible runbook documents or the scripted query are embedded');
      return runbooks.map((_, i) => i === index ? 1 : 0);
    });
  } };
  const executor = new ToolExecutor(new RunbookRetriever(provider));
  const steps = [
    { name: 'search_logs', arguments: { service: incident.service, timeWindow: incident.timeWindow, levels: null, contains: null } },
    { name: 'get_metrics', arguments: { service: incident.service, timeWindow: incident.timeWindow, metricNames: null } },
    { name: 'get_service_info', arguments: { service: incident.service } },
    { name: 'search_runbook', arguments: { query, limit: 1 } },
  ];
  const inWindow = timestamp => Date.parse(timestamp) >= Date.parse(incident.timeWindow.start)
    && Date.parse(timestamp) <= Date.parse(incident.timeWindow.end);
  let turn = 0;
  let expectedDiagnosis;
  let agent;
  const model = { async respond(request) {
    assert.ok(turn <= steps.length, 'Bounded script: four tools then final diagnosis');
    states.push(agent.currentRecord.status);
    if (turn === 0) {
      assert.equal(request.kind, 'initial');
      assert.equal(agent.currentRecord.status, 'STARTED');
      const visible = JSON.parse(request.prompt);
      assert.deepEqual(visible, {
        id: incident.id, title: incident.title, service: incident.service,
        description: incident.description,
        timeWindow: { start: incident.timeWindow.start, end: incident.timeWindow.end },
      });
    } else {
      assert.equal(request.kind, 'continuation');
      assert.equal(request.continuation, `response-${turn}`);
      assert.equal(request.outputs.length, 1);
      assert.equal(request.outputs[0].callId, `call-${turn}`);
      assert.equal(agent.currentRecord.status, 'INVESTIGATING');
      const previousTool = steps[turn - 1].name;
      const value = JSON.parse(request.outputs[0].output);
      evidence[previousTool] = value;
      switch (previousTool) {
        case 'search_logs':
          assert.ok(value.length > 0);
          assert.deepEqual(value, logs.filter(log => log.service === incident.service && inWindow(log.timestamp)));
          break;
        case 'get_metrics':
          assert.ok(value.length > 0);
          assert.deepEqual(value, metrics.filter(series => series.service === incident.service)
            .map(series => ({ ...series, points: series.points.filter(point => inWindow(point.timestamp)) }))
            .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          break;
        case 'get_service_info':
          assert.deepEqual(value, services.find(service => service.name === incident.service));
          break;
        case 'search_runbook':
          assert.deepEqual(value, [{ runbook: runbooks[bookIndex], score: 1 }]);
          break;
      }
      assert.equal(agent.currentRecord.toolExecutions.length, turn);
    }
    if (turn < steps.length) {
      const step = steps[turn++];
      return { kind: 'tool_calls', continuation: `response-${turn}`, calls: [
        { callId: `call-${turn}`, name: step.name, arguments: step.arguments },
      ] };
    }
    // Test-owned wording from returned evidence; this is not cause correctness scoring.
    expectedDiagnosis = {
      summary: `Collected logs, metrics, service metadata and guidance for ${evidence.get_service_info.name}.`,
      probableCause: 'The observed service errors require further investigation using the collected evidence.',
      confidence: 'medium',
      evidence: [evidence.search_logs[0].message,
        `Metric ${evidence.get_metrics[0].name}: ${evidence.get_metrics[0].points.map(point => point.value).join(', ')}`,
        `Runbook: ${evidence.search_runbook[0].runbook.title}`],
      recommendedActions: ['Review the collected evidence before proposing operational changes.'],
    };
    turn++;
    return { kind: 'final', diagnosis: expectedDiagnosis };
  } };
  agent = new AgentOrchestrator(model, executor);
  const record = await agent.investigate(incident);
  states.push(record.status);
  assert.equal(turn, 5);
  assert.deepEqual(states, ['STARTED', 'INVESTIGATING', 'INVESTIGATING', 'INVESTIGATING', 'INVESTIGATING', 'COMPLETED']);
  assert.equal(record.status, 'COMPLETED');
  assert.equal(record.incidentId, incident.id);
  assert.ok(!Object.hasOwn(record, 'failure'));
  assert.deepEqual(record.diagnosis, expectedDiagnosis);
  assert.deepEqual(record.toolExecutions, steps.map((step, i) => ({ callId: `call-${i + 1}`, toolName: step.name, status: 'SUCCEEDED' })));
  assert.deepEqual(agent.currentRecord, record);
  assert.equal(embeddingInputs.length, 2);
  assert.equal(embeddingInputs[0].length, runbooks.length);
  assert.deepEqual(embeddingInputs[1], [query]);
  return { record, evidence };
}

test('INC-001 full Week 1 path returns real evidence, semantic context and a completed record', async () => {
  const { record, evidence } = await investigate(incidents.find(incident => incident.id === 'INC-001'));
  assert.deepEqual(evidence.search_logs.map(log => log.id), ['LOG-001-01', 'LOG-001-02', 'LOG-001-03']);
  assert.equal(evidence.get_metrics.find(series => series.name === 'redis_connection_timeouts').points[1].value, 45);
  assert.equal(evidence.get_service_info.version, '1.4.2');
  assert.equal(evidence.search_runbook[0].runbook.id, 'RB-001');
  assert.ok(evidence.search_runbook[0].runbook.content.includes('cache connection timeouts'));
  assert.equal(evidence.search_runbook[0].score, 1);
  assert.equal(record.diagnosis.confidence, 'medium'); // Relevance does not determine confidence.
});

const ids = ['INC-001', 'INC-002', 'INC-003', 'INC-004', 'INC-005'];
for (const id of ids) {
  test(`${id} repeats the fixture-backed pipeline with stable evidence and result`, async () => {
    assert.deepEqual(incidents.map(incident => incident.id), ids);
    const incident = incidents.find(incident => incident.id === id);
    const first = await investigate(incident);
    const second = await investigate(incident);
    assert.notEqual(first.record.investigationId, second.record.investigationId);
    const { investigationId: firstId, ...firstContent } = first.record;
    const { investigationId: secondId, ...secondContent } = second.record;
    assert.deepEqual(firstContent, secondContent);
    assert.deepEqual(first.evidence, second.evidence);
  });
}
