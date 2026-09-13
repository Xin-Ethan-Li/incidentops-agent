import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { RunbookRetriever, cosineSimilarity } from '../dist/rag/index.js';
import { runbooks } from '../dist/fixtures/index.js';

const textFor = doc => `Title: ${doc.title}\nTags: ${doc.tags.join(', ')}\nContent: ${doc.content}`;
const fixedVectors = [[1, 0], [0.8, 0.6], [0, 1], [-1, 0], [0, -1]];
class FakeEmbeddingProvider {
  calls = [];
  table = new Map([
    ...runbooks.map((doc, i) => [textFor(doc), fixedVectors[i]]),
    ['purchases are waiting without being handled', [0, 1]],
    ['cache connectivity', [1, 0]],
  ]);
  async embed(texts) {
    this.calls.push([...texts]);
    return texts.map(text => {
      assert.ok(this.table.has(text), 'Unexpected embedding input: ' + text);
      return [...this.table.get(text)];
    });
  }
}

test('fake provider maps known inputs to one predefined vector each', async () => {
  const provider = new FakeEmbeddingProvider();
  assert.deepEqual(await provider.embed(['cache connectivity', 'purchases are waiting without being handled']), [[1, 0], [0, 1]]);
});

test('semantic retrieval ranks the intended runbook using fixed vectors, not lexical overlap', async () => {
  const matches = await new RunbookRetriever(new FakeEmbeddingProvider()).retrieve({ query: 'purchases are waiting without being handled' });
  assert.deepEqual(matches.map(match => match.runbook.id), ['RB-003', 'RB-002', 'RB-001', 'RB-004', 'RB-005']);
  assert.deepEqual(matches.map(match => match.score), [1, 0.6, 0, 0, -1]);
});

test('ties use ascending runbook ID and limit applies after ranking', async () => {
  const documents = [runbooks[2], runbooks[0], runbooks[1]];
  const provider = { async embed(texts) { return texts.map(() => [1, 0]); } };
  const matches = await new RunbookRetriever(provider, documents).retrieve({ query: 'same direction', limit: 2 });
  assert.deepEqual(matches.map(match => match.runbook.id), ['RB-001', 'RB-002']);
});

test('invalid queries and limits fail before any provider call', async () => {
  const provider = new FakeEmbeddingProvider();
  const retriever = new RunbookRetriever(provider);
  for (const query of ['', ' \t ', null, 1]) await assert.rejects(retriever.retrieve({ query }), TypeError);
  await assert.rejects(retriever.retrieve(null), TypeError);
  for (const limit of [0, -1, 1.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(retriever.retrieve({ query: 'cache connectivity', limit }), TypeError);
  }
  assert.deepEqual(provider.calls, []);
});

test('document vectors are cached once while each query is embedded separately', async () => {
  const provider = new FakeEmbeddingProvider();
  const retriever = new RunbookRetriever(provider);
  await retriever.retrieve({ query: 'cache connectivity' });
  await retriever.retrieve({ query: 'purchases are waiting without being handled' });
  assert.deepEqual(provider.calls, [runbooks.map(textFor), ['cache connectivity'], ['purchases are waiting without being handled']]);
});

test('concurrent initial queries share document embedding work', async () => {
  const provider = new FakeEmbeddingProvider();
  const retriever = new RunbookRetriever(provider);
  await Promise.all([retriever.retrieve({ query: 'cache connectivity' }), retriever.retrieve({ query: 'cache connectivity' })]);
  assert.deepEqual(provider.calls, [runbooks.map(textFor), ['cache connectivity'], ['cache connectivity']]);
});

test('runbook text and returned results preserve the visible-data boundary and copy safety', async () => {
  const before = structuredClone(runbooks);
  const documents = runbooks.map(doc => ({ ...structuredClone(doc), expectedCause: 'must not leave caller' }));
  const provider = new FakeEmbeddingProvider();
  const retriever = new RunbookRetriever(provider, documents);
  documents[0].title = 'changed';
  documents[0].tags.push('changed');
  const result = await retriever.retrieve({ query: 'cache connectivity' });
  assert.deepEqual(provider.calls[0], before.map(textFor));
  assert.deepEqual(Object.keys(result[0].runbook).sort(), ['content', 'id', 'tags', 'title']);
  result[0].runbook.title = 'caller changed';
  result[0].runbook.tags.push('caller changed');
  result[0].runbook.content = 'caller changed';
  assert.deepEqual(runbooks, before);
  assert.deepEqual((await retriever.retrieve({ query: 'cache connectivity' }))[0].runbook, before[0]);
});

test('cosine handles identical, orthogonal, opposite, and large/small finite vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [2, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.ok(Math.abs(cosineSimilarity([1e308, 1e308], [1e-300, 1e-300]) - 1) < 1e-12);
});

test('cosine rejects empty, zero, nonfinite, nonnumeric, and mismatched vectors', () => {
  for (const vector of [[], [0, 0], [NaN, 1], [Infinity, 1], ['1', 0], [1]]) {
    assert.throws(() => cosineSimilarity([1, 0], vector), /vector/);
  }
});

for (const [label, invalid] of [
  ['wrong count', []], ['empty vector', [[]]], ['zero vector', [[0, 0]]],
  ['nonfinite value', [[NaN, 1]]], ['nonnumeric value', [['1', 0]]],
]) {
  test('retriever rejects document embedding ' + label, async () => {
    const retriever = new RunbookRetriever({ async embed() { return invalid; } }, [runbooks[0]]);
    await assert.rejects(retriever.retrieve({ query: 'query' }), /vector/);
  });
}

test('retriever rejects inconsistent document dimensions', async () => {
  const retriever = new RunbookRetriever({ async embed() { return [[1, 0], [1]]; } }, runbooks.slice(0, 2));
  await assert.rejects(retriever.retrieve({ query: 'query' }), /dimension mismatch/);
});

test('retriever validates query count, values, norm, and dimensions against cached documents', async () => {
  for (const queryVectors of [[], [[1], [1]], [[]], [[0, 0]], [[1]], [[Infinity, 0]]]) {
    let call = 0;
    const retriever = new RunbookRetriever({ async embed() { return ++call === 1 ? [[1, 0]] : queryVectors; } }, [runbooks[0]]);
    await assert.rejects(retriever.retrieve({ query: 'query' }), /vector/);
  }
});

test('provider failures propagate without automatic retries or partial cache results', async () => {
  let calls = 0;
  const failure = new Error('embedding unavailable');
  const retriever = new RunbookRetriever({ async embed() { calls++; throw failure; } });
  await assert.rejects(retriever.retrieve({ query: 'query' }), error => error === failure);
  await assert.rejects(retriever.retrieve({ query: 'query' }), error => error === failure);
  assert.equal(calls, 1);
});

test('empty corpus returns [] without invoking provider', async () => {
  const provider = new FakeEmbeddingProvider();
  assert.deepEqual(await new RunbookRetriever(provider, []).retrieve({ query: 'cache connectivity' }), []);
  assert.deepEqual(provider.calls, []);
});

test('RAG modules do not import ground truth or incident fixture data', () => {
  const directory = new URL('../src/rag/', import.meta.url);
  for (const filename of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(filename, directory), 'utf8');
    assert.doesNotMatch(source, /ground-truth|expectedCause/);
    for (const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]*fixtures[^'"]*)['"]/g)) {
      assert.equal(match[1].trim(), 'runbooks');
      assert.equal(match[2], '../fixtures/index.js');
    }
  }
});
