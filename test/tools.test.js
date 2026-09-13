import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { searchLogs, getMetrics, getServiceInfo, searchRunbook, ToolError } from '../dist/tools/index.js';
import * as fixtures from '../dist/fixtures/index.js';

const timeWindow = { start: '2026-09-01T10:00:00.000Z', end: '2026-09-01T10:10:00.000Z' };
const checkout = { service: 'checkout-api', timeWindow };
const ids = results => results.map(result => result.id);
const errorCode = code => error => error instanceof ToolError && error.code === code && error.message.length > 0;

test('searchLogs returns only service logs in inclusive timestamp order', () => {
  assert.deepEqual(ids(searchLogs(checkout)), ['LOG-001-01', 'LOG-001-02', 'LOG-001-03']);
  assert.deepEqual(ids(searchLogs({ ...checkout, timeWindow: { start: timeWindow.end, end: timeWindow.end } })), ['LOG-001-03']);
});

test('searchLogs filters by level and case-insensitive message text together', () => {
  assert.deepEqual(ids(searchLogs({ ...checkout, levels: ['error'] })), ['LOG-001-02']);
  assert.deepEqual(ids(searchLogs({ ...checkout, contains: 'REDIS-CACHE' })), ['LOG-001-02']);
  assert.deepEqual(searchLogs({ ...checkout, levels: ['info'], contains: 'REDIS-CACHE' }), []);
});

test('searchLogs returns [] for known service without matching evidence', () => {
  assert.deepEqual(searchLogs({ ...checkout, contains: 'not-present' }), []);
  assert.deepEqual(searchLogs({ ...checkout, levels: [] }), []);
  assert.deepEqual(searchLogs({ ...checkout, timeWindow: { start: '2020-01-01T00:00:00Z', end: '2020-01-02T00:00:00Z' } }), []);
});

test('searchLogs rejects invalid optional filters', () => {
  for (const levels of [['debug'], 'error', null, [null]]) {
    assert.throws(() => searchLogs({ ...checkout, levels }), errorCode('INVALID_INPUT'));
  }
  assert.throws(() => searchLogs({ ...checkout, contains: 1 }), errorCode('INVALID_INPUT'));
});

test('getMetrics returns expected service series in name order', () => {
  const result = getMetrics(checkout);
  assert.deepEqual(result.map(metric => metric.name), ['http_5xx_rate', 'redis_connection_timeouts']);
  assert.ok(result.every(metric => metric.service === checkout.service && metric.points.length === 3));
});

test('getMetrics filters metric names and returns exact inclusive point range', () => {
  const result = getMetrics({ ...checkout, metricNames: ['redis_connection_timeouts'],
    timeWindow: { start: '2026-09-01T10:05:00Z', end: timeWindow.end } });
  assert.deepEqual(result, [{ service: 'checkout-api', name: 'redis_connection_timeouts', unit: 'count/min', points: [
    { timestamp: '2026-09-01T10:05:00.000Z', value: 45 },
    { timestamp: '2026-09-01T10:10:00.000Z', value: 61 },
  ] }]);
  assert.equal(getMetrics({ ...checkout, metricNames: ['http_5xx_rate'],
    timeWindow: { start: timeWindow.start, end: timeWindow.start } })[0].points.length, 1);
});

test('getMetrics omits unknown metrics and series with no points', () => {
  assert.deepEqual(getMetrics({ ...checkout, metricNames: ['unknown'] }), []);
  assert.deepEqual(getMetrics({ ...checkout, metricNames: [] }), []);
  assert.deepEqual(getMetrics({ ...checkout, timeWindow: { start: '2020-01-01T00:00:00Z', end: '2020-01-02T00:00:00Z' } }), []);
});

test('getMetrics rejects malformed metric filters', () => {
  for (const metricNames of ['http_5xx_rate', null, [''], [12]]) {
    assert.throws(() => getMetrics({ ...checkout, metricNames }), errorCode('INVALID_INPUT'));
  }
});

test('getServiceInfo returns only the existing service metadata', () => {
  assert.deepEqual(getServiceInfo({ service: 'checkout-api' }), {
    name: 'checkout-api', version: '1.4.2', dependencies: ['redis-cache', 'payment-api'],
    lastDeploymentAt: '2026-08-30T09:00:00.000Z',
  });
});

for (const [name, tool] of [['searchLogs', searchLogs], ['getMetrics', getMetrics], ['getServiceInfo', getServiceInfo]]) {
  test(name + ' distinguishes unknown services from invalid service inputs', () => {
    assert.throws(() => tool({ ...checkout, service: 'missing-service' }), errorCode('SERVICE_NOT_FOUND'));
    for (const service of ['', '  ', null, 42]) {
      assert.throws(() => tool({ ...checkout, service }), errorCode('INVALID_INPUT'));
    }
    assert.throws(() => tool(null), errorCode('INVALID_INPUT'));
  });
}

for (const [name, tool] of [['searchLogs', searchLogs], ['getMetrics', getMetrics]]) {
  test(name + ' rejects invalid or reversed windows before service lookup', () => {
    for (const window of [null, {},
      { start: 'invalid', end: timeWindow.end },
      { start: timeWindow.start, end: 'invalid' },
      { start: timeWindow.end, end: timeWindow.start },
      { start: '2026-02-30T10:00:00Z', end: timeWindow.end },
      { start: '2026-09-01', end: timeWindow.end },
      { start: '2026-09-01T10:00:00', end: timeWindow.end },
      { start: '2026-09-01T24:00:00Z', end: '2026-09-03T00:00:00Z' },
    ]) assert.throws(() => tool({ service: 'missing-service', timeWindow: window }), errorCode('INVALID_INPUT'));
  });
  test(name + ' compares equivalent ISO offsets as instants', () => {
    assert.deepEqual(tool({ ...checkout, timeWindow: {
      start: '2026-09-01T11:00:00+01:00', end: '2026-09-01T11:10:00+01:00',
    } }), tool(checkout));
  });
}

test('searchRunbook matches title, tags, and body with case-insensitive terms', () => {
  assert.deepEqual(ids(searchRunbook({ query: 'redis-cache' })), ['RB-001']);
  assert.deepEqual(ids(searchRunbook({ query: 'REDIS-CACHE' })), ['RB-001']);
  assert.deepEqual(ids(searchRunbook({ query: 'acknowledgements' })), ['RB-003']);
  assert.equal(searchRunbook({ query: 'payment' })[0].id, 'RB-002');
});

test('searchRunbook returns [] for no match', () => {
  assert.deepEqual(searchRunbook({ query: 'not-present-xyz' }), []);
});

test('searchRunbook rejects empty and malformed queries', () => {
  for (const query of ['', ' \t\n', null, 42]) {
    assert.throws(() => searchRunbook({ query }), errorCode('INVALID_INPUT'));
  }
  assert.throws(() => searchRunbook(null), errorCode('INVALID_INPUT'));
});

test('searchRunbook rejects limits that are not positive safe integers', () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => searchRunbook({ query: 'payment', limit }), errorCode('INVALID_INPUT'));
  }
});

test('searchRunbook ranks before limiting and breaks equal scores by ID', () => {
  assert.deepEqual(ids(searchRunbook({ query: 'payment', limit: 1 })), ['RB-002']);
  const expected = ['RB-001', 'RB-002', 'RB-003', 'RB-004', 'RB-005'];
  assert.deepEqual(ids(searchRunbook({ query: 'Investigating' })), expected);
  assert.deepEqual(ids(searchRunbook({ query: ' Investigating investigating ', limit: 2 })), expected.slice(0, 2));
  assert.deepEqual(searchRunbook({ query: 'payment' }), searchRunbook({ query: 'payment' }));
});

test('tools neither mutate fixtures nor return mutable aliases to fixture evidence', () => {
  const before = structuredClone({ ...fixtures });
  const logs = searchLogs(checkout);
  const metrics = getMetrics(checkout);
  const service = getServiceInfo({ service: checkout.service });
  const runbooks = searchRunbook({ query: 'payment' });
  assert.deepEqual({ ...fixtures }, before);
  logs[0].message = 'changed by caller';
  metrics[0].points[0].value = -999;
  metrics[0].points.reverse();
  service.dependencies.push('caller-dependency');
  runbooks[0].tags.push('caller-tag');
  runbooks[0].content = 'caller-content';
  assert.deepEqual({ ...fixtures }, before);
});

test('tool modules use the normal fixture boundary and do not depend on ground truth', () => {
  const dir = new URL('../src/tools/', import.meta.url);
  for (const name of readdirSync(dir).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    assert.doesNotMatch(source, /ground-truth|expectedCause|@nestjs/);
    for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
      if (match[1].includes('fixtures/')) assert.equal(match[1], '../fixtures/index.js');
    }
  }
  const output = JSON.stringify([searchLogs(checkout), getMetrics(checkout),
    getServiceInfo({ service: checkout.service }), searchRunbook({ query: 'payment' })]);
  assert.doesNotMatch(output, /expectedCause|rootCause|diagnosis|confidence|recommendation/);
});
