import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertDiagnosis } from '../dist/domain/diagnosis.js';
import { AgentOrchestrator } from '../dist/agent/index.js';
import { incidents } from '../dist/fixtures/index.js';

const valid = () => ({
  summary: 'Checkout failures require further investigation.',
  probableCause: 'Dependency connectivity may be impaired.',
  confidence: 'medium',
  evidence: ['The supplied incident reports elevated checkout errors.'],
  recommendedActions: ['Inspect dependency connectivity.'],
});

test('valid diagnosis permits all qualitative confidence values and empty evidence/actions', () => {
  for (const confidence of ['low', 'medium', 'high']) {
    assert.doesNotThrow(() => assertDiagnosis({ ...valid(), confidence, evidence: [], recommendedActions: [] }));
  }
});

const invalidCases = [
  ['null object', () => null], ['array object', () => []], ['JSON string', () => JSON.stringify(valid())],
  ['numeric confidence', () => ({ ...valid(), confidence: 0.9 })],
  ['unknown confidence', () => ({ ...valid(), confidence: 'very-high' })],
  ['uppercase confidence', () => ({ ...valid(), confidence: 'HIGH' })],
  ['blank summary', () => ({ ...valid(), summary: ' \t' })],
  ['blank probableCause', () => ({ ...valid(), probableCause: '' })],
  ['null probableCause', () => ({ ...valid(), probableCause: null })],
  ['blank evidence item', () => ({ ...valid(), evidence: ['ok', ' '] })],
  ['blank action item', () => ({ ...valid(), recommendedActions: ['\n'] })],
  ['nonnumeric evidence expected', () => ({ ...valid(), evidence: [2] })],
  ['evidence is not array', () => ({ ...valid(), evidence: 'log evidence' })],
  ['actions is not array', () => ({ ...valid(), recommendedActions: null })],
  ['sparse array', () => ({ ...valid(), evidence: new Array(1) })],
  ['extra field', () => ({ ...valid(), severity: 'high' })],
  ['inherited fields', () => Object.create(valid())],
  ['symbol field', () => ({ ...valid(), [Symbol('extra')]: true })],
];
for (const field of Object.keys(valid())) {
  invalidCases.push(['missing ' + field, () => { const value = valid(); delete value[field]; return value; }]);
}
for (const [label, createValue] of invalidCases) {
  test('runtime rejects ' + label + ' even from a fake AgentModel', async () => {
    const value = createValue();
    assert.throws(() => assertDiagnosis(value), /Malformed diagnosis/);
    const model = { async respond() { return { kind: 'final', diagnosis: value }; } };
    const executor = { async execute() { assert.fail('Invalid final must not execute tools'); } };
    await assert.rejects(new AgentOrchestrator(model, executor).investigate(incidents[0]), /Malformed diagnosis/);
  });
}

test('recommended actions remain returned data and do not execute tools', async () => {
  const diagnosis = { ...valid(), recommendedActions: ['Restart the affected consumer.'] };
  let calls = 0;
  const model = { async respond() { return { kind: 'final', diagnosis }; } };
  const executor = { async execute() { calls++; assert.fail('Recommendations must not execute'); } };
  const result = await new AgentOrchestrator(model, executor).investigate(incidents[0]);
  assert.deepEqual(result.diagnosis, diagnosis);
  assert.equal(typeof result.diagnosis, 'object');
  assert.equal(calls, 0);
});

test('legacy plain-text final responses are rejected', async () => {
  const model = { async respond() { return { kind: 'final', text: 'legacy final' }; } };
  await assert.rejects(new AgentOrchestrator(model, {}).investigate(incidents[0]), /Malformed final/);
});

test('Diagnosis runtime does not import fixtures or evaluate hidden answers', () => {
  const source = readFileSync(new URL('../src/domain/diagnosis.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ground-truth|expectedCause|fixtures\//);
});
