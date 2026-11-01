import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';

// Explicit test preload, never part of the production image or an application import.
assert.equal(process.env.OPENAI_API_KEY, 'docker-offline-key');
assert.equal(process.env.OPENAI_AGENT_MODEL, 'docker-offline-model');
assert.equal(process.env.OPENAI_BASE_URL, undefined);
const mode = process.env.DOCKER_MOCK_MODE ?? 'success';
assert.ok(['success', 'failure', 'interrupt'].includes(mode));

const incident = {
  id: 'INC-001', title: 'Checkout error rate elevated', service: 'checkout-api',
  description: 'Checkout requests intermittently return 5xx responses. Investigate the increase during the supplied window.',
  timeWindow: { start: '2026-09-01T10:00:00.000Z', end: '2026-09-01T10:10:00.000Z' },
};
const expectedLogs = [
  { id: 'LOG-001-01', timestamp: incident.timeWindow.start, service: 'checkout-api', level: 'info',
    message: 'Checkout completed; cache read took 4 ms.' },
  { id: 'LOG-001-02', timestamp: '2026-09-01T10:05:00.000Z', service: 'checkout-api', level: 'error',
    message: 'Connection to redis-cache exceeded 1000 ms; checkout returned 503.' },
  { id: 'LOG-001-03', timestamp: incident.timeWindow.end, service: 'checkout-api', level: 'warn',
    message: 'Cache connection deadline exceeded; payment-api health probe returned 200 in 35 ms.' },
];

export const callId = 'docker-offline-search-logs';
export const diagnosis = {
  summary: 'Offline container fixture verification.',
  probableCause: 'Synthetic fixture logs record Redis connection deadlines; this is a scripted test, not model inference.',
  confidence: 'low', evidence: ['LOG-001-02 records a Redis timeout and checkout 503.'],
  recommendedActions: ['Inspect the fixture cache dependency; perform no infrastructure action.'],
};

const mark = value => writeSync(2, 'DOCKER_MOCK ' + JSON.stringify(value) + '\n');
let requests = 0;
// No real fetch fallback, embedding endpoint, model list or arbitrary URL is supported.
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://api.openai.com/v1/responses');
  assert.equal(init?.method, 'POST');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'docker-offline-model');
  assert.equal(body.max_output_tokens, 2048);
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.tools.map(tool => tool.name), ['search_logs', 'get_metrics', 'get_service_info', 'search_runbook']);
  assert.ok(body.tools.every(tool => tool.strict));
  assert.equal(body.text.format.strict, true);
  requests++;
  if (requests === 1) {
    assert.deepEqual(JSON.parse(body.input), incident);
    assert.equal(body.previous_response_id, undefined);
    mark({ event: 'initial', mode });
    if (mode === 'failure') return new Response(JSON.stringify({ error: {
      message: 'DOCKER_OFFLINE_PROVIDER_FAILURE', type: 'server_error',
    } }), { status: 500, headers: { 'content-type': 'application/json' } });
    if (mode === 'interrupt') return new Promise((_, reject) => {
      const abort = () => reject(new DOMException('Offline cancellation', 'AbortError'));
      if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
    });
    return jsonResponse('docker-response-1', [{ type: 'function_call', id: 'docker-item', call_id: callId,
      name: 'search_logs', status: 'completed', arguments: JSON.stringify({ service: incident.service,
        timeWindow: incident.timeWindow, levels: null, contains: null }) }]);
  }
  assert.equal(mode, 'success');
  assert.equal(requests, 2, 'No unexpected SDK retry or additional turn');
  assert.equal(body.previous_response_id, 'docker-response-1');
  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].type, 'function_call_output');
  assert.equal(body.input[0].call_id, callId);
  // Assert the actual production MCP result, not merely a matching tool request.
  assert.deepEqual(JSON.parse(body.input[0].output), expectedLogs);
  mark({ event: 'continuation-verified', callId, logIds: expectedLogs.map(log => log.id) });
  return jsonResponse('docker-response-2', [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify(diagnosis) }] }]);
};

function jsonResponse(id, output) {
  return new Response(JSON.stringify({ id, status: 'completed', error: null, output,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }), {
    headers: { 'content-type': 'application/json' },
  });
}

process.once('exit', () => mark({ event: 'exit', requests }));
