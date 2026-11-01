import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Explicit only: node --test test/docker/container.test.js
// Never load .env, forward host credentials, or require Docker from npm test.
const root = fileURLToPath(new URL('../../', import.meta.url));
const mockPath = fileURLToPath(new URL('./mock-openai.mjs', import.meta.url));
const execute = promisify(execFile);
const image = 'incidentops-agent:week4-step2';
const prefix = 'incidentops-docker-' + randomUUID().slice(0, 8);
const callId = 'docker-offline-search-logs';

async function docker(args, { status = 0, timeout = 60_000 } = {}) {
  let result;
  try { result = { ...await execute('docker', args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }), code: 0 }; }
  catch (error) {
    if (typeof error.code !== 'number' || error.killed) throw new Error('Docker process failed: ' + args[0], { cause: error });
    result = { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
  assert.equal(result.code, status, 'docker ' + args[0] + '\n' + result.stdout + '\n' + result.stderr);
  return result;
}

function parseOutput(result) {
  const combined = result.stdout + '\n' + result.stderr;
  const json = combined.match(/^\{[\s\S]*^\}/m);
  return { report: json ? JSON.parse(json[0]) : undefined,
    events: combined.split(/\r?\n/).filter(line => line.startsWith('DOCKER_MOCK '))
      .map(line => JSON.parse(line.slice('DOCKER_MOCK '.length))) };
}

function assertCleanup(report) {
  assert.deepEqual(report.cleanup, { mcpClose: 'SUCCEEDED', childExit: 'OBSERVED', tracingShutdown: 'SUCCEEDED', errors: [] });
  assert.equal(report.traceComplete, true);
  const roots = report.spans.filter(span => span.name === 'incident.investigation');
  assert.equal(roots.length, 1); assert.equal(roots[0].parentSpanId, null);
  for (const span of report.spans.filter(span => span !== roots[0])) {
    assert.equal(span.parentSpanId, roots[0].spanId); assert.equal(span.traceId, roots[0].traceId);
  }
}

async function waitUntil(check, message, timeout = 20_000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  assert.fail(message);
}

test('Docker: locked build, final-image service and offline Agent/MCP execution', { timeout: 900_000 }, async t => {
  await docker(['info'], { timeout: 15_000 }); // Fail rather than auto-start/repair Docker.
  const containers = new Set();
  const name = suffix => { const value = prefix + '-' + suffix; containers.add(value); return value; };
  async function remove(value) { await docker(['rm', '--force', value]); containers.delete(value); }
  t.after(async () => {
    for (const value of containers) await docker(['rm', '--force', value]);
    const remaining = await docker(['ps', '--all', '--quiet', '--filter', 'name=' + prefix]);
    assert.equal(remaining.stdout.trim(), '', 'No test containers left behind');
  });

  let built = false;
  await t.test('build-test actually runs all 380 tests in Linux with network disabled', async () => {
    const result = await docker(['build', '--target', 'build-test', '--no-cache', '--progress=plain', '.'], { timeout: 600_000 });
    const log = result.stdout + result.stderr;
    assert.match(log, /# tests 380\b/); assert.match(log, /# pass 380\b/);
    assert.match(log, /# fail 0\b/); assert.match(log, /# cancelled 0\b/); assert.match(log, /# skipped 0\b/);
    assert.equal(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts.test,
      'npm run build && node --test test/*.test.js', 'Keep the Docker test expansion aligned with npm test');
    assert.match(readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8'),
      /RUN --network=none npm run build && node --test --test-concurrency=1 test\/\*\.test\.js/);
    t.diagnostic('Linux build/test: 380/380 PASS; the test RUN executed without build cache.');
    built = true;
  });
  if (!built) return;

  let imageId;
  await t.test('build final production image and verify runtime metadata', async () => {
    await docker(['build', '--target', 'runtime', '--tag', image, '--progress=plain', '.'], { timeout: 600_000 });
    const inspected = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
    imageId = inspected.Id;
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(inspected.Os, 'linux'); assert.equal(inspected.Config.User, 'node');
    assert.deepEqual(inspected.Config.Entrypoint, ['node']); assert.deepEqual(inspected.Config.Cmd, ['dist/main.js']);
    assert.ok(Object.hasOwn(inspected.Config.ExposedPorts, '3000/tcp'));
    assert.ok(!inspected.Config.Env.some(value => /^(?:OPENAI_|DOCKER_MOCK_|NODE_OPTIONS=)/.test(value)));
    t.diagnostic(JSON.stringify({ image, imageId, architecture: inspected.Architecture }));
  });
  if (!imageId) return;

  const base = value => ['run', '--name', value, '--init', '--network=none'];
  const dummyEnv = ['--env', 'OPENAI_API_KEY=docker-offline-key', '--env', 'OPENAI_AGENT_MODEL=docker-offline-model'];
  const mounted = ['--mount', 'type=bind,source=' + mockPath + ',target=/smoke/mock-openai.mjs,readonly'];
  const cli = ['--import', '/smoke/mock-openai.mjs', 'dist/run-investigation.js', '--live', '--incident', 'INC-001', '--inspect'];

  await t.test('runtime contents and project-copy layers exclude private inputs and development tools', async () => {
    const value = name('contents');
    const code = `import {readdirSync,existsSync} from 'node:fs';
      console.log(JSON.stringify({uid:process.getuid(),version:process.version,root:readdirSync('/app').sort(),
        entries:['dist/main.js','dist/run-investigation.js','dist/mcp/stdio-server.js','dist/fixtures/incidents.js','dist/fixtures/runbooks.js'].map(p=>[p,existsSync(p)]),
        devTools:['typescript','concurrently'].filter(p=>existsSync('node_modules/'+p))}));`;
    const result = JSON.parse((await docker([...base(value), image, '--input-type=module', '-e', code])).stdout);
    assert.equal(result.uid, 1000); assert.match(result.version, /^v22\./);
    assert.deepEqual(result.root, ['dist', 'node_modules', 'package-lock.json', 'package.json']);
    assert.ok(result.entries.every(([, present]) => present)); assert.deepEqual(result.devTools, []);
    const history = (await docker(['history', '--no-trunc', '--format', '{{.CreatedBy}}', image])).stdout;
    assert.doesNotMatch(history, /OPENAI_API_KEY|OPENAI_AGENT_MODEL|\.project-control|COPY \. \.|COPY.*\.env/);
    t.diagnostic('Runtime UID ' + result.uid + ', Node ' + result.version + '; project root/COPY history contain no private inputs.');
    await remove(value);
  });

  await t.test('service serves mapped TCP health as non-root and stops without forced termination', async () => {
    const value = name('service');
    const healthStarted = performance.now();
    let attempt = 0;
    const phase = (phase, details = {}) => writeSync(2, 'DOCKER_HEALTH_PHASE ' + JSON.stringify({
      elapsedMs: Number((performance.now() - healthStarted).toFixed(3)), phase, attempt, ...details,
    }) + '\n');
    phase('SERVICE_RUN_START', { container: value });
    await docker(['run', '--detach', '--name', value, '--init', '--publish', '127.0.0.1::3000', image]);
    phase('SERVICE_RUN_DONE');
    phase('PORT_INSPECT_START');
    const binding = JSON.parse((await docker(['inspect', value])).stdout)[0].NetworkSettings.Ports['3000/tcp'][0];
    phase('PORT_INSPECT_DONE');
    phase('POLL_START');
    await waitUntil(async () => {
      attempt++;
      phase('STATE_INSPECT_START');
      const state = JSON.parse((await docker(['inspect', value])).stdout)[0].State;
      phase('STATE_INSPECT_DONE', { running: state.Running });
      assert.ok(state.Running, 'Service unexpectedly stopped');
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new DOMException('Health request timed out', 'TimeoutError')), 1000);
      try {
        phase('FETCH_START');
        const response = await fetch('http://127.0.0.1:' + binding.HostPort + '/health', { signal: controller.signal });
        phase('FETCH_HEADERS_RECEIVED', { status: response.status });
        if (!response.ok) return false;
        assert.equal(response.status, 200);
        phase('BODY_READ_START');
        assert.deepEqual(await response.json(), { status: 'ok' });
        phase('BODY_READ_DONE');
        phase('HEALTH_VALIDATED');
        return true;
      } catch (error) {
        phase('FETCH_ERROR', {
          errorName: ['TypeError', 'TimeoutError', 'AbortError', 'SyntaxError', 'AssertionError', 'Error'].includes(error?.name) ? error.name : 'OTHER',
          causeCode: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR',
            'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
            'UND_ERR_ABORTED'].includes(error?.cause?.code) ? error.cause.code : null,
        });
        if (error instanceof assert.AssertionError) throw error;
        return false;
      } finally {
        clearTimeout(deadline);
        // Also release an unread response body when a non-success status returns early.
        controller.abort();
      }
    }, 'Mapped health endpoint never became ready');
    phase('POLL_DONE');
    phase('UID_CHECK_START');
    assert.equal((await docker(['exec', value, 'node', '-p', 'process.getuid()'])).stdout.trim(), '1000');
    phase('UID_CHECK_DONE');
    phase('STOP_START');
    await docker(['stop', '--time', '10', value], { timeout: 20_000 });
    phase('STOP_DONE');
    phase('STOP_STATE_INSPECT_START');
    const state = JSON.parse((await docker(['inspect', value])).stdout)[0].State;
    phase('STOP_STATE_INSPECT_DONE');
    assert.equal(state.Running, false); assert.equal(state.OOMKilled, false);
    assert.equal(state.ExitCode, 143, 'SIGTERM exit; no claim of Nest shutdown hooks');
    phase('STOP_STATE_VERIFIED', { exitCode: state.ExitCode });
    phase('REMOVE_START');
    await remove(value);
    phase('REMOVE_DONE');
  });

  for (const [suffix, args, missingKey, reason] of [
    ['no-opt-in', ['--incident', 'INC-001'], false, /Explicit --live/],
    ['unknown', ['--live', '--incident', 'UNKNOWN'], false, /existing supported Incident/],
    ['no-config', ['--live', '--incident', 'INC-001'], true, /OPENAI_API_KEY/],
  ]) await t.test('CLI validation: ' + suffix + ' exits 2 with no provider traffic', async () => {
    const value = name(suffix);
    const result = await docker([...base(value), ...(missingKey ? [] : [...dummyEnv, ...mounted]), image,
      ...(missingKey ? [] : ['--import', '/smoke/mock-openai.mjs']), 'dist/run-investigation.js', ...args], { status: 2 });
    assert.equal(result.stdout, ''); assert.match(result.stderr, reason);
    const events = parseOutput(result).events;
    if (!missingKey) assert.deepEqual(events, [{ event: 'exit', requests: 0 }]);
    await remove(value);
  });

  await t.test('actual final-image Agent -> MCP stdio -> search_logs -> provider continuation -> Diagnosis', async () => {
    const value = name('success');
    const { report, events } = parseOutput(await docker([...base(value), ...dummyEnv, ...mounted, image, ...cli]));
    assert.equal(report.outcome.status, 'COMPLETED'); assert.equal(report.verificationReady, true);
    assert.equal(report.humanDiagnosisReview, 'PENDING'); assert.equal(report.outcome.diagnosis.confidence, 'low');
    assert.deepEqual(Object.keys(report.outcome.diagnosis).sort(), ['confidence', 'evidence', 'probableCause', 'recommendedActions', 'summary']);
    assert.equal(report.outcome.diagnosis.summary, 'Offline container fixture verification.');
    assert.deepEqual(report.observed.requestedTools, [{ callId, toolName: 'search_logs' }]);
    assert.deepEqual(report.outcome.toolExecutions, [{ callId, toolName: 'search_logs', status: 'SUCCEEDED' }]);
    assert.deepEqual(report.observed.deliveredCallIds, [callId]);
    assert.equal(report.inspection.requests[0].name, 'search_logs');
    assert.equal(report.inspection.requests[0].arguments.service, 'checkout-api');
    const actualLogs = JSON.parse(report.inspection.deliveredOutputs[0].output);
    assert.deepEqual(actualLogs.map(log => log.id), ['LOG-001-01', 'LOG-001-02', 'LOG-001-03']);
    assert.equal(actualLogs[1].message, 'Connection to redis-cache exceeded 1000 ms; checkout returned 503.');
    assert.deepEqual(events, [{ event: 'initial', mode: 'success' },
      { event: 'continuation-verified', callId, logIds: actualLogs.map(log => log.id) }, { event: 'exit', requests: 2 }]);
    assert.equal(report.measurementSummary.modelCalls.count, 2); assert.equal(report.measurementSummary.toolAttempts.count, 1);
    assert.equal(report.measurementSummary.toolAttempts.retries, 0);
    assert.equal(report.measurements[0].toolAttempts[0].status, 'SUCCEEDED');
    assert.deepEqual(report.measurementSummary.usage.completeTotal, { inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    assert.equal(report.spans.length, 4); assertCleanup(report);
    t.diagnostic('One actual MCP tool attempt, original call ID and all three fixture logs verified at the provider continuation.');
    await remove(value);
  });

  await t.test('mocked provider failure is terminal, never retries, and cleans the actual child', async () => {
    const value = name('failure');
    const result = await docker([...base(value), ...dummyEnv, ...mounted, '--env', 'DOCKER_MOCK_MODE=failure', image, ...cli], { status: 1 });
    const { report, events } = parseOutput(result);
    assert.equal(report.outcome.status, 'FAILED'); assert.equal(report.failure, 'INVESTIGATION_FAILED');
    assert.equal(report.verificationReady, false); assert.deepEqual(report.outcome.toolExecutions, []);
    assert.deepEqual(events, [{ event: 'initial', mode: 'failure' }, { event: 'exit', requests: 1 }]);
    assert.doesNotMatch(result.stdout + result.stderr, /DOCKER_OFFLINE_PROVIDER_FAILURE/);
    assertCleanup(report); await remove(value);
  });

  await t.test('SIGTERM after the mock signals readiness cancels the request and cleans resources', async () => {
    const value = name('interrupt');
    await docker(['run', '--detach', '--name', value, '--init', '--network=none', ...dummyEnv, ...mounted,
      '--env', 'DOCKER_MOCK_MODE=interrupt', image, ...cli]);
    await waitUntil(async () => {
      const result = await docker(['logs', value]);
      return parseOutput(result).events.some(event => event.event === 'initial' && event.mode === 'interrupt');
    }, 'Pending provider mock never signalled readiness');
    await docker(['kill', '--signal=SIGTERM', value]);
    assert.equal((await docker(['wait', value], { timeout: 15_000 })).stdout.trim(), '130');
    const { report, events } = parseOutput(await docker(['logs', value]));
    assert.equal(report.outcome.status, 'FAILED'); assert.equal(report.failure, 'INTERRUPTED');
    assert.equal(report.verificationReady, false); assert.deepEqual(report.outcome.toolExecutions, []);
    assert.deepEqual(events, [{ event: 'initial', mode: 'interrupt' }, { event: 'exit', requests: 1 }]);
    assertCleanup(report); await remove(value);
  });
});
