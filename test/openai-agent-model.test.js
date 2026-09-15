import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIAgentModel, TOOL_DEFINITIONS } from '../dist/agent/index.js';
import { INVESTIGATION_INSTRUCTIONS } from '../dist/agent/agent-model.js';

const fn = (args = '{"service":"checkout-api"}') => ({ type: 'function_call', id: 'fc-item', call_id: 'call-original', name: 'get_service_info', arguments: args, status: 'completed' });
const message = text => ({ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const response = (output, id = 'resp-original') => ({ id, object: 'response', status: 'completed', error: null, output });
function localTransport(t, responses, status = 200) {
  const previous = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_AGENT_MODEL };
  process.env.OPENAI_API_KEY = 'local-test-placeholder';
  process.env.OPENAI_AGENT_MODEL = 'test-model';
  t.after(() => {
    for (const [name, value] of [['OPENAI_API_KEY', previous.key], ['OPENAI_AGENT_MODEL', previous.model]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  let index = 0;
  return t.mock.method(globalThis, 'fetch', async () => {
    assert.ok(index < responses.length, 'Unexpected request/retry');
    return new Response(JSON.stringify(responses[index++]), { status, headers: { 'content-type': 'application/json' } });
  });
}

test('Responses first request includes strict tools and instructions and maps call_id and JSON', async t => {
  const fetch = localTransport(t, [response([fn()])]);
  const result = await new OpenAIAgentModel().respond({ kind: 'initial', prompt: 'visible incident' });
  assert.deepEqual(result, { kind: 'tool_calls', continuation: 'resp-original', calls: [
    { callId: 'call-original', name: 'get_service_info', arguments: { service: 'checkout-api' } },
  ] });
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(String(url), 'https://api.openai.com/v1/responses');
  assert.equal(options.method, 'POST');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.input, 'visible incident');
  assert.equal(body.instructions, INVESTIGATION_INSTRUCTIONS);
  assert.equal(body.parallel_tool_calls, false);
  assert.ok(!('previous_response_id' in body));
  assert.deepEqual(body.tools.map(tool => tool.name), ['search_logs', 'get_metrics', 'get_service_info', 'search_runbook']);
  function strictObjects(schema) {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(strictObjects);
    }
  }
  for (const tool of body.tools) { assert.equal(tool.type, 'function'); assert.equal(tool.strict, true); strictObjects(tool.parameters); }
  assert.deepEqual(body.tools[0].parameters.properties.levels.type, ['array', 'null']);
  assert.doesNotMatch(JSON.stringify(TOOL_DEFINITIONS), /embedding|vectors|cosine|expectedCause|ground.truth/i);
});

test('continuation sends previous response ID and original call IDs, repeats instructions, then maps final text', async t => {
  const fetch = localTransport(t, [response([fn(), { ...fn(), call_id: 'another-call' }]), response([message('Evidence-based conclusion.')], 'resp-next')]);
  const model = new OpenAIAgentModel();
  const first = await model.respond({ kind: 'initial', prompt: 'incident' });
  const outputs = first.calls.map((call, i) => ({ callId: call.callId, output: JSON.stringify({ evidence: i }) }));
  assert.deepEqual(await model.respond({ kind: 'continuation', continuation: first.continuation, outputs }), { kind: 'final', text: 'Evidence-based conclusion.' });
  const body = JSON.parse(fetch.mock.calls[1].arguments[1].body);
  assert.equal(body.previous_response_id, 'resp-original');
  assert.equal(body.instructions, INVESTIGATION_INSTRUCTIONS);
  assert.deepEqual(body.input, outputs.map(output => ({ type: 'function_call_output', call_id: output.callId, output: output.output })));
  assert.equal(body.tools.length, 4);
});

test('provider ignores reasoning items and does not treat text accompanying tool calls as final', async t => {
  localTransport(t, [response([{ type: 'reasoning', id: 'reasoning', summary: [] }, message('Checking evidence.'), fn()])]);
  assert.equal((await new OpenAIAgentModel().respond({ kind: 'initial', prompt: 'incident' })).kind, 'tool_calls');
});

test('missing credentials or model configuration fails locally', t => {
  const fetch = localTransport(t, []);
  delete process.env.OPENAI_API_KEY;
  assert.throws(() => new OpenAIAgentModel(), /OPENAI_API_KEY/);
  process.env.OPENAI_API_KEY = 'local-test-placeholder';
  delete process.env.OPENAI_AGENT_MODEL;
  assert.throws(() => new OpenAIAgentModel(), /OPENAI_AGENT_MODEL/);
  process.env.OPENAI_AGENT_MODEL = ' ';
  assert.throws(() => new OpenAIAgentModel(), /OPENAI_AGENT_MODEL/);
  assert.equal(fetch.mock.calls.length, 0);
});

test('malformed JSON, nonobject arguments and duplicate call IDs fail clearly', async t => {
  const cases = [response([fn('{bad')]), response([fn('[]')]), response([fn('null')]), response([fn(), fn()]), response([{ ...fn(), call_id: '' }])];
  localTransport(t, cases);
  const model = new OpenAIAgentModel();
  for (const item of cases) await assert.rejects(model.respond({ kind: 'initial', prompt: 'incident' }), /Malformed/);
});

test('incomplete, empty, refused and unsupported response protocols are not accepted as final', async t => {
  const cases = [
    { ...response([message('partial')]), status: 'incomplete' }, response([]),
    response([{ ...message(''), content: [{ type: 'refusal', refusal: 'refused' }] }]),
    response([{ type: 'web_search_call', id: 'unsupported' }]), response([{ ...fn(), status: 'incomplete' }]),
  ];
  localTransport(t, cases);
  const model = new OpenAIAgentModel();
  for (const item of cases) await assert.rejects(model.respond({ kind: 'initial', prompt: 'incident' }));
});

test('malformed local continuation fails before transport', async t => {
  const fetch = localTransport(t, []);
  const model = new OpenAIAgentModel();
  for (const request of [null, { kind: 'initial', prompt: '' }, { kind: 'continuation', continuation: '', outputs: [] },
    { kind: 'continuation', continuation: 'r', outputs: [{ callId: 'x', output: '{}' }, { callId: 'x', output: '{}' }] }]) {
    await assert.rejects(model.respond(request));
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test('API failures propagate without SDK retry', async t => {
  const fetch = localTransport(t, [{ error: { message: 'local failure', type: 'server_error' } }], 500);
  await assert.rejects(new OpenAIAgentModel().respond({ kind: 'initial', prompt: 'incident' }));
  assert.equal(fetch.mock.calls.length, 1);
});
