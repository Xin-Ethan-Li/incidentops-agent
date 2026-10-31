import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseInvestigationArgs, runInvestigationCli } from '../dist/run-investigation.js';

beforeEach(t => {
  const before = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_AGENT_MODEL };
  process.env.OPENAI_API_KEY = 'OFFLINE_KEY'; process.env.OPENAI_AGENT_MODEL = 'offline-model';
  t.mock.method(globalThis, 'fetch', () => assert.fail('CLI tests cannot access external APIs'));
  t.after(() => { for (const [name, value] of [['OPENAI_API_KEY', before.key], ['OPENAI_AGENT_MODEL', before.model]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
});

test('CLI requires opt-in, known incident, complete arguments and no unknown or duplicate flags', async () => {
  const invalid = [[], ['--incident', 'INC-001'], ['--live'], ['--live', '--incident'], ['--live', '--incident', 'missing'],
    ['--live', '--live', '--incident', 'INC-001'], ['--live', '--incident', 'INC-001', '--incident', 'INC-002'],
    ['--live', '--incident', 'INC-001', '--key', 'SECRET_INPUT'], ['--live', '--incident', '--inspect'],
    ['--live', '--incident', 'INC-001', '--inspect', '--inspect']];
  for (const args of invalid) {
    assert.throws(() => parseInvestigationArgs(args));
    const errors = [];
    const code = await runInvestigationCli(args, () => assert.fail('No investigation for invalid args'), () => assert.fail('No report'), text => errors.push(text));
    assert.equal(code, 2); assert.ok(!errors.join('').includes('SECRET_INPUT'));
  }
  assert.deepEqual(parseInvestigationArgs(['--live', '--incident', 'INC-001']), { incidentId: 'INC-001', inspect: false });
  assert.deepEqual(parseInvestigationArgs(['--incident', 'INC-002', '--inspect', '--live']), { incidentId: 'INC-002', inspect: true });
});

for (const field of ['OPENAI_API_KEY', 'OPENAI_AGENT_MODEL']) test('CLI rejects missing ' + field + ' before any resources', async () => {
  delete process.env[field]; const errors = [];
  assert.equal(await runInvestigationCli(['--live', '--incident', 'INC-001'], () => assert.fail('No paid work'), () => {}, text => errors.push(text)), 2);
  assert.ok(errors[0].includes(field));
});

test('importing both entry modules has no paid or process-creation side effects', () => {
  const code = "globalThis.fetch=()=>{throw Error('Unexpected API request')}; await import('./dist/run-investigation.js'); await import('./dist/live-investigation.js'); console.log('import-only');";
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: '', OPENAI_AGENT_MODEL: '' }, timeout: 5000 });
  assert.equal(result.trim(), 'import-only');
});

test('actual executable refuses a non-opted-in invocation without starting the agent', () => {
  const result = spawnSync(process.execPath, ['dist/run-investigation.js', '--incident', 'INC-001'], {
    encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '', OPENAI_AGENT_MODEL: '' }, timeout: 5000 });
  assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /Explicit --live/);
});

test('CLI emits successful summaries once and removes its signal handlers', async () => {
  const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
  const output = [], errors = [], report = { verificationReady: true, outcome: { status: 'COMPLETED' } };
  const code = await runInvestigationCli(['--live', '--incident', 'INC-001', '--inspect'], async (id, options) => {
    assert.equal(id, 'INC-001'); assert.equal(options.inspect, true); assert.ok(options.signal instanceof AbortSignal); return report;
  }, text => output.push(text), text => errors.push(text));
  assert.equal(code, 0); assert.equal(output.length, 1); assert.deepEqual(JSON.parse(output[0]), report); assert.deepEqual(errors, []);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), before);
});

test('CLI preserves a safe failure report without printing original SDK details', async () => {
  const output = [], errors = [], report = { verificationReady: false, failure: 'INVESTIGATION_FAILED' };
  const code = await runInvestigationCli(['--live', '--incident', 'INC-001'], async (_, options) => {
    options.onReport(report); throw new Error('SECRET_SDK_KEY_AND_BODY');
  }, text => output.push(text), text => errors.push(text));
  assert.equal(code, 1); assert.deepEqual(JSON.parse(output[0]), report);
  assert.doesNotMatch(output.join('') + errors.join(''), /SECRET_SDK_KEY_AND_BODY/);
});

test('CLI returns nonzero for pending or incomplete verification without changing the actual outcome', async () => {
  for (const status of ['AWAITING_APPROVAL', 'COMPLETED']) {
    const output = [];
    const code = await runInvestigationCli(['--live', '--incident', 'INC-001'], async () => ({ verificationReady: false, outcome: { status } }),
      text => output.push(text), () => {});
    assert.equal(code, 1); assert.equal(JSON.parse(output[0]).outcome.status, status);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) test('CLI handles ' + signal + ' with owned cancellation and handler removal', async () => {
  const before = process.listenerCount(signal), output = [];
  const code = await runInvestigationCli(['--live', '--incident', 'INC-001'], async (_, options) => {
    await new Promise(resolve => { options.signal.addEventListener('abort', resolve, { once: true }); process.emit(signal); });
    assert.ok(options.signal.aborted); options.onReport({ verificationReady: false, failure: 'INTERRUPTED' }); throw new Error('cancelled');
  }, text => output.push(text), () => {});
  assert.equal(code, 130); assert.equal(process.listenerCount(signal), before); assert.equal(JSON.parse(output[0]).failure, 'INTERRUPTED');
});
