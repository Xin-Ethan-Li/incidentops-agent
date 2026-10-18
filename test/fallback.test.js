import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import OpenAI from 'openai';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { RunbookRetriever } from '../dist/rag/runbook-retriever.js';
import { OpenAIEmbeddingProvider } from '../dist/rag/openai-embedding-provider.js';
import { SemanticRetrievalUnavailableError } from '../dist/rag/semantic-retrieval-unavailable-error.js';
import { AgentOrchestrator } from '../dist/agent/agent-orchestrator.js';
import { ToolExecutor, MalformedMcpResultError } from '../dist/agent/tool-executor.js';
import { OperationTimeoutError } from '../dist/agent/with-timeout.js';
import { incidents, runbooks } from '../dist/fixtures/index.js';
import { createTestExecutor } from './fixtures/mcp-memory.js';

const incident = incidents[0];
const unavailable = () => new SemanticRetrievalUnavailableError('embedding capability unavailable');
const unavailableRetriever = (documents = runbooks) => new RunbookRetriever({ async embed() { throw unavailable(); } }, documents);
const call = { callId: 'A', name: 'search_runbook', arguments: { query: 'cache', limit: 1 } };
const final = { kind: 'final', diagnosis: { summary: 'Guidance collected.', probableCause: 'Further investigation needed.', confidence: 'medium', evidence: [], recommendedActions: [] } };
function scriptedModel() {
  const seen = [];
  return { seen, async respond(request) {
    seen.push(request);
    return request.kind === 'initial' ? { kind: 'tool_calls', continuation: 'response', calls: [call] } : final;
  } };
}
function providerWithLocalKey(t) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'local-test-placeholder';
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  return new OpenAIEmbeddingProvider();
}
async function advance(t, ms) {
  t.mock.timers.tick(ms);
  await nextTurn();
}
beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Fallback tests must not access external network'));
});

test('semantic success preserves its existing scores and never executes lexical fallback', async t => {
  const retriever = new RunbookRetriever({ async embed(texts) { return texts.map(() => [1, 0]); } });
  const lexical = t.mock.method(retriever, 'retrieveLexically', () => assert.fail('No hybrid retrieval'));
  const input = { query: 'cache', limit: 2 };
  const expected = await retriever.retrieve(input);
  assert.deepEqual(await retriever.retrieveWithFallback(input), expected);
  assert.deepEqual(expected, runbooks.slice(0, 2).map(runbook => ({ runbook, score: 1 })));
  assert.equal(lexical.mock.callCount(), 0);
});

test('a valid empty semantic response stays empty even when lexical matching could find evidence', async t => {
  const retriever = unavailableRetriever();
  t.mock.method(retriever, 'retrieve', async () => []);
  const lexical = t.mock.method(retriever, 'retrieveLexically', () => assert.fail('Zero results are not a failure'));
  assert.deepEqual(await retriever.retrieveWithFallback({ query: 'cache' }), []);
  assert.equal(lexical.mock.callCount(), 0);
});

test('empty corpus remains an empty semantic success without fallback or embedding', async t => {
  const retriever = new RunbookRetriever({ embed() { assert.fail('No corpus to embed'); } }, []);
  const lexical = t.mock.method(retriever, 'retrieveLexically', () => assert.fail('No fallback needed'));
  assert.deepEqual(await retriever.retrieveWithFallback({ query: 'cache' }), []);
  assert.equal(lexical.mock.callCount(), 0);
});

test('explicit semantic unavailability invokes lexical retrieval once in the unchanged result shape', async t => {
  const retriever = unavailableRetriever();
  const lexical = t.mock.method(retriever, 'retrieveLexically');
  const result = await retriever.retrieveWithFallback({ query: 'REDIS-cache', limit: 1 });
  assert.equal(lexical.mock.callCount(), 1);
  assert.deepEqual(result, [{ runbook: runbooks[0], score: 2 }]);
  assert.deepEqual(Object.keys(result[0]).sort(), ['runbook', 'score']);
  assert.deepEqual(Object.keys(result[0].runbook).sort(), ['content', 'id', 'tags', 'title']);
});

test('lexical ranking uses unique whole tokens, descending scores, ascending ID ties and the existing limit', async () => {
  const documents = [
    { id: 'RB-C', title: 'CACHE', tags: ['redis'], content: 'queue queue queue' },
    { id: 'RB-B', title: 'cache', tags: ['redis'], content: 'noise' },
    { id: 'RB-A', title: 'queue', tags: ['redis'], content: 'other' },
    { id: 'RB-Z', title: 'cache', tags: [], content: 'noise' },
    { id: 'RB-N', title: 'cachet', tags: [], content: 'unrelated' },
  ];
  const retriever = unavailableRetriever(documents);
  const input = { query: 'CACHE, redis QUEUE! cache' };
  for (let run = 0; run < 3; run++) {
    const matches = await retriever.retrieveWithFallback(input);
    assert.deepEqual(matches.map(match => [match.runbook.id, match.score]), [['RB-C', 3], ['RB-A', 2], ['RB-B', 2], ['RB-Z', 1]]);
    assert.deepEqual(await retriever.retrieveWithFallback({ ...input, limit: 2 }), matches.slice(0, 2));
  }
});

test('fallback keeps the semantic corpus snapshot and does not expose or retain caller mutations', async () => {
  const documents = [{ ...structuredClone(runbooks[0]), privateAnswer: 'not a visible runbook field' }];
  const retriever = unavailableRetriever(documents);
  documents[0].title = 'caller replacement';
  documents[0].tags.push('caller-tag');
  const input = { query: 'cache' };
  const first = await retriever.retrieveWithFallback(input);
  assert.deepEqual(first, [{ runbook: runbooks[0], score: 1 }]);
  first[0].runbook.title = 'changed result';
  first[0].runbook.tags.push('changed result');
  assert.deepEqual(await retriever.retrieveWithFallback(input), [{ runbook: runbooks[0], score: 1 }]);
});

test('fallback with no positive lexical overlap or no tokens returns valid empty evidence', async t => {
  const retriever = unavailableRetriever();
  const lexical = t.mock.method(retriever, 'retrieveLexically');
  assert.deepEqual(await retriever.retrieveWithFallback({ query: 'zzzzunmatchedtoken' }), []);
  assert.deepEqual(await retriever.retrieveWithFallback({ query: '!!!' }), []);
  assert.equal(lexical.mock.callCount(), 2);
});

test('invalid query and limit retain TypeError and never enter embedding or fallback', async t => {
  const retriever = new RunbookRetriever({ embed() { assert.fail('Validate input first'); } });
  const lexical = t.mock.method(retriever, 'retrieveLexically', () => assert.fail('Invalid input is not unavailability'));
  for (const input of [null, { query: '' }, { query: ' \t ' }, { query: 42 }]) {
    await assert.rejects(retriever.retrieveWithFallback(input), { name: 'TypeError', message: 'query must be nonempty' });
  }
  for (const limit of [0, -1, 1.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(retriever.retrieveWithFallback({ query: 'cache', limit }), {
      name: 'TypeError', message: 'limit must be a positive safe integer',
    });
  }
  assert.equal(lexical.mock.callCount(), 0);
});

test('generic internal failures and errors with an unavailable-looking name/message do not fallback', async t => {
  for (const failure of [new Error('semantic retrieval unavailable'), new TypeError('internal validation failed'),
    Object.assign(new Error('embedding capability unavailable'), { name: 'SemanticRetrievalUnavailableError' }),
    new OperationTimeoutError('Agent tool execution timed out after 5ms')]) {
    const retriever = new RunbookRetriever({ async embed() { throw failure; } });
    const lexical = t.mock.method(retriever, 'retrieveLexically', () => assert.fail('Only explicit type permits fallback'));
    await assert.rejects(retriever.retrieveWithFallback({ query: 'cache' }), error => error === failure);
    assert.equal(lexical.mock.callCount(), 0);
  }
});

test('invalid document or query embeddings still fail validation without lexical fallback', async t => {
  for (const failQuery of [false, true]) {
    let embeds = 0;
    const retriever = new RunbookRetriever({ async embed() {
      return ++embeds === 1 && failQuery ? [[1, 0]] : [[0, 0]];
    } }, [runbooks[0]]);
    const lexical = t.mock.method(retriever, 'retrieveLexically', () => assert.fail('Malformed vectors are not unavailable'));
    await assert.rejects(retriever.retrieveWithFallback({ query: 'cache' }), /nonzero norm/);
    assert.equal(lexical.mock.callCount(), 0);
  }
});

test('a query embedding dependency can report explicit unavailability after documents are cached', async t => {
  let embeds = 0;
  const retriever = new RunbookRetriever({ async embed(texts) {
    if (++embeds === 1) return texts.map(() => [1, 0]);
    throw unavailable();
  } });
  const lexical = t.mock.method(retriever, 'retrieveLexically');
  assert.deepEqual(await retriever.retrieveWithFallback({ query: 'cache', limit: 1 }), [{ runbook: runbooks[0], score: 1 }]);
  assert.equal(embeds, 2);
  assert.equal(lexical.mock.callCount(), 1);
});

test('lexical failure propagates the original error without a third retrieval strategy', async t => {
  const failure = new Error('lexical retrieval failed');
  const retriever = unavailableRetriever();
  const lexical = t.mock.method(retriever, 'retrieveLexically', () => { throw failure; });
  await assert.rejects(retriever.retrieveWithFallback({ query: 'cache' }), error => error === failure);
  assert.equal(lexical.mock.callCount(), 1);
});

for (const [label, failure] of [
  ['connection', new OpenAI.APIConnectionError({ message: 'embedding connection unavailable' })],
  ['rate limit', new OpenAI.RateLimitError(429, {}, 'embedding rate limited', new Headers())],
  ['server', new OpenAI.InternalServerError(503, {}, 'embedding service unavailable', new Headers())],
]) {
  test(`embedding ${label} failure becomes explicit semantic unavailability with its original cause`, async t => {
    const provider = providerWithLocalKey(t);
    t.mock.method(provider.client.embeddings, 'create', async () => { throw failure; });
    await assert.rejects(provider.embed(['cache']), error => {
      assert.ok(error instanceof SemanticRetrievalUnavailableError);
      assert.equal(error.cause, failure);
      return true;
    });
  });
}

test('provider input, API request/authentication, MCP and unrelated errors are never reclassified as unavailable', async t => {
  const provider = providerWithLocalKey(t);
  const create = t.mock.method(provider.client.embeddings, 'create', () => assert.fail('Invalid input must not call SDK'));
  await assert.rejects(provider.embed([' ']), TypeError);
  assert.equal(create.mock.callCount(), 0);
  for (const failure of [new TypeError('SDK programming error'), new Error('unknown SDK failure'),
    new OpenAI.BadRequestError(400, {}, 'bad request', new Headers()),
    new OpenAI.AuthenticationError(401, {}, 'invalid credentials', new Headers()),
    new SdkError(SdkErrorCode.ConnectionClosed, 'MCP connection closed'),
    new OperationTimeoutError('outer timeout')]) {
    create.mock.mockImplementation(async () => { throw failure; });
    const retriever = new RunbookRetriever(provider);
    const lexical = t.mock.method(retriever, 'retrieveLexically', () => assert.fail('Not an embedding availability failure'));
    await assert.rejects(retriever.retrieveWithFallback({ query: 'cache' }), error => error === failure);
    assert.equal(lexical.mock.callCount(), 0);
  }
});

test('real SDK mocked HTTP failure falls back through MCP within one tool slot and one SUCCEEDED record', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'embedding service unavailable' } }), {
    status: 503, headers: { 'content-type': 'application/json' },
  }));
  const retriever = new RunbookRetriever(providerWithLocalKey(t));
  const lexical = t.mock.method(retriever, 'retrieveLexically');
  const executor = await createTestExecutor(t, retriever);
  const execute = t.mock.method(executor, 'execute');
  const mcp = t.mock.method(executor.client, 'callTool');
  const model = scriptedModel();
  const result = await new AgentOrchestrator(model, executor, 2, 1).investigate(incident);
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.toolExecutions, [{ callId: 'A', toolName: 'search_runbook', status: 'SUCCEEDED' }]);
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(mcp.mock.callCount(), 1);
  assert.equal(fetch.mock.callCount(), 1, 'Embedding SDK retries remain disabled');
  assert.equal(lexical.mock.callCount(), 1);
  assert.equal(model.seen.length, 2);
  assert.deepEqual(model.seen[1].outputs.map(item => item.callId), ['A']);
  assert.deepEqual(JSON.parse(model.seen[1].outputs[0].output), [{ runbook: runbooks[0], score: 1 }]);
});

test('failed lexical fallback produces one FAILED MCP execution and no continuation or retry', async t => {
  const retriever = unavailableRetriever();
  const lexical = t.mock.method(retriever, 'retrieveLexically', () => { throw new Error('lexical retrieval failed'); });
  const executor = await createTestExecutor(t, retriever);
  const execute = t.mock.method(executor, 'execute');
  const model = scriptedModel();
  const agent = new AgentOrchestrator(model, executor);
  await assert.rejects(agent.investigate(incident), { message: 'lexical retrieval failed' });
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(lexical.mock.callCount(), 1);
  assert.equal(model.seen.length, 1);
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.deepEqual(agent.currentRecord.toolExecutions, [{ callId: 'A', toolName: 'search_runbook', status: 'FAILED' }]);
  assert.ok(!Object.hasOwn(agent.currentRecord, 'diagnosis'));
});

test('other read tools never enter runbook retrieval or fallback', async t => {
  const retriever = unavailableRetriever();
  const retrieval = t.mock.method(retriever, 'retrieveWithFallback', () => assert.fail('Only search_runbook can fallback'));
  const executor = await createTestExecutor(t, retriever);
  for (const name of ['search_logs', 'get_metrics', 'get_service_info']) {
    const args = name === 'get_service_info' ? { service: incident.service } : { service: incident.service, timeWindow: incident.timeWindow };
    await executor.execute({ callId: name, name, arguments: args });
  }
  assert.equal(retrieval.mock.callCount(), 0);
});

test('outer search_runbook timeout retains one Step 4 retry and never switches to lexical retrieval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let embeddings = 0;
  const retriever = new RunbookRetriever({ embed() { embeddings++; return new Promise(() => {}); } });
  const lexical = t.mock.method(retriever, 'retrieveLexically', () => assert.fail('A waiting deadline is not semantic unavailability'));
  let mcpCalls = 0;
  const executor = new ToolExecutor({ async callTool({ arguments: args }) {
    mcpCalls++;
    return { content: [{ type: 'text', text: JSON.stringify(await retriever.retrieveWithFallback(args)) }] };
  } });
  const execute = t.mock.method(executor, 'execute');
  const model = scriptedModel();
  const agent = new AgentOrchestrator(model, executor, 8, 2, 50, 5);
  const rejected = assert.rejects(agent.investigate(incident), error =>
    error instanceof OperationTimeoutError && error.message === 'Agent tool execution timed out after 5ms');
  await nextTurn();
  await advance(t, 5);
  await advance(t, 99);
  assert.equal(execute.mock.callCount(), 1);
  await advance(t, 1);
  assert.equal(execute.mock.callCount(), 2);
  await advance(t, 5);
  await rejected;
  assert.equal(lexical.mock.callCount(), 0);
  assert.equal(mcpCalls, 2);
  assert.equal(embeddings, 1, 'The first operation remains pending and shares the existing document cache');
  assert.equal(model.seen.length, 1);
  assert.deepEqual(agent.currentRecord.toolExecutions, [
    { callId: 'A', toolName: 'search_runbook', status: 'FAILED' },
    { callId: 'A', toolName: 'search_runbook', status: 'FAILED' },
  ]);
});

for (const code of [SdkErrorCode.ConnectionClosed, SdkErrorCode.SendFailed, SdkErrorCode.InvalidResult]) {
  test(`MCP ${code} propagates without lexical fallback or reconnect`, async t => {
    const failure = new SdkError(code, 'MCP boundary failed');
    let mcpCalls = 0;
    const executor = new ToolExecutor({ async callTool() { mcpCalls++; throw failure; } });
    const model = scriptedModel();
    const agent = new AgentOrchestrator(model, executor);
    await assert.rejects(agent.investigate(incident), error => error === failure);
    assert.equal(mcpCalls, 1);
    assert.equal(model.seen.length, 1);
    assert.deepEqual(agent.currentRecord.toolExecutions, [{ callId: 'A', toolName: 'search_runbook', status: 'FAILED' }]);
  });
}

test('malformed MCP result remains a failed execution, never lexical evidence', async () => {
  const model = scriptedModel();
  const executor = new ToolExecutor({ async callTool() { return { content: [] }; } });
  const agent = new AgentOrchestrator(model, executor);
  await assert.rejects(agent.investigate(incident), MalformedMcpResultError);
  assert.equal(model.seen.length, 1);
  assert.equal(agent.currentRecord.status, 'FAILED');
  assert.deepEqual(agent.currentRecord.toolExecutions, [{ callId: 'A', toolName: 'search_runbook', status: 'FAILED' }]);
});
