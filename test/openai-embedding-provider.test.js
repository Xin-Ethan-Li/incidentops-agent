import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIEmbeddingProvider } from '../dist/rag/index.js';

function configureLocalTransport(t, data, status = 200) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'local-test-placeholder';
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  // Replace fetch entirely: no network and no real credentials used by these tests.
  return t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data }), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

test('OpenAI provider uses embeddings endpoint, default model and input ordering with local mocked transport', async t => {
  const fetch = configureLocalTransport(t, [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }]);
  assert.deepEqual(await new OpenAIEmbeddingProvider().embed(['first', 'second']), [[1, 0], [0, 1]]);
  assert.equal(fetch.mock.calls.length, 1);
  const [url, request] = fetch.mock.calls[0].arguments;
  assert.equal(String(url), 'https://api.openai.com/v1/embeddings');
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), { model: 'text-embedding-3-small', input: ['first', 'second'], encoding_format: 'float' });
});

test('OpenAI provider supports a configured model and skips empty input batches', async t => {
  const fetch = configureLocalTransport(t, [{ index: 0, embedding: [1, 0] }]);
  const provider = new OpenAIEmbeddingProvider('text-embedding-3-large');
  assert.deepEqual(await provider.embed([]), []);
  assert.equal(fetch.mock.calls.length, 0);
  await provider.embed(['one']);
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).model, 'text-embedding-3-large');
});

test('OpenAI provider rejects missing credentials, blank model and invalid input locally', async t => {
  const fetch = configureLocalTransport(t, []);
  const provider = new OpenAIEmbeddingProvider();
  assert.throws(() => new OpenAIEmbeddingProvider('  '), /model/);
  for (const input of [null, [''], [' '], [42]]) await assert.rejects(provider.embed(input), TypeError);
  delete process.env.OPENAI_API_KEY;
  assert.throws(() => new OpenAIEmbeddingProvider(), /OPENAI_API_KEY/);
  assert.equal(fetch.mock.calls.length, 0);
});

test('OpenAI provider rejects response count and index mismatches', async t => {
  configureLocalTransport(t, [{ index: 1, embedding: [1, 0] }]);
  const provider = new OpenAIEmbeddingProvider();
  await assert.rejects(provider.embed(['one']), /indices/);
  await assert.rejects(provider.embed(['one', 'two']), /count/);
});

test('OpenAI provider propagates API failure with SDK retries disabled', async t => {
  const fetch = configureLocalTransport(t, [], 500);
  await assert.rejects(new OpenAIEmbeddingProvider().embed(['one']));
  assert.equal(fetch.mock.calls.length, 1);
});
