import assert from 'node:assert/strict';
import test from 'node:test';
import * as fixtures from '../dist/fixtures/index.js';
import { groundTruth } from '../dist/fixtures/ground-truth.js';

const { incidents, services, logs, metrics, runbooks } = fixtures;
const serviceByName = new Map(services.map(service => [service.name, service]));
const incidentById = new Map(incidents.map(incident => [incident.id, incident]));
const logById = new Map(logs.map(log => [log.id, log]));
const runbookById = new Map(runbooks.map(runbook => [runbook.id, runbook]));

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, label + ' must be unique');
}

function timestamp(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(value).toISOString(), value);
  return Date.parse(value);
}

function inWindow(value, incident) {
  const time = timestamp(value);
  assert.ok(time >= timestamp(incident.timeWindow.start) && time <= timestamp(incident.timeWindow.end),
    incident.id + ': evidence must be inside the incident window');
}

test('exactly five incidents and unique collection identifiers', () => {
  assert.equal(incidents.length, 5);
  assert.deepEqual(incidents.map(incident => incident.id).sort(),
    ['INC-001', 'INC-002', 'INC-003', 'INC-004', 'INC-005']);
  unique(incidents.map(incident => incident.id), 'incident IDs');
  unique(services.map(service => service.name), 'service names');
  unique(logs.map(log => log.id), 'log IDs');
  unique(runbooks.map(runbook => runbook.id), 'runbook IDs');
  unique(metrics.map(metric => metric.service + ':' + metric.name), 'service/metric pairs');
});

test('service identifiers, incident references, and time windows are valid', () => {
  for (const service of services) {
    assert.match(service.name, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    assert.ok(service.version.length > 0);
    timestamp(service.lastDeploymentAt);
    unique(service.dependencies, service.name + ' dependencies');
    for (const dependency of service.dependencies) {
      assert.match(dependency, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    }
  }
  for (const incident of incidents) {
    assert.ok(serviceByName.has(incident.service), incident.id + ': unknown service');
    assert.ok(timestamp(incident.timeWindow.start) < timestamp(incident.timeWindow.end));
    assert.ok(timestamp(serviceByName.get(incident.service).lastDeploymentAt) <= timestamp(incident.timeWindow.end));
    assert.ok(incident.title.trim() && incident.description.trim());
  }
});

test('ground truth has exactly one entry per incident and no orphan entries', () => {
  unique(groundTruth.map(truth => truth.incidentId), 'ground truth incident IDs');
  assert.equal(groundTruth.length, incidents.length);
  for (const incident of incidents) {
    assert.equal(groundTruth.filter(truth => truth.incidentId === incident.id).length, 1);
  }
  for (const truth of groundTruth) {
    assert.ok(incidentById.has(truth.incidentId));
    assert.ok(truth.expectedCause.trim());
  }
});

test('all logs identify known services and fall within a scenario window', () => {
  for (const log of logs) {
    assert.ok(serviceByName.has(log.service), log.id);
    assert.ok(['info', 'warn', 'error'].includes(log.level));
    assert.ok(log.message.trim());
    timestamp(log.timestamp);
    assert.ok(incidents.some(incident => incident.service === log.service
      && log.timestamp >= incident.timeWindow.start && log.timestamp <= incident.timeWindow.end), log.id);
  }
});

test('ground truth log references exist and match the incident service and window', () => {
  for (const truth of groundTruth) {
    const incident = incidentById.get(truth.incidentId);
    assert.ok(truth.relevantLogIds.length > 0);
    unique(truth.relevantLogIds, truth.incidentId + ' log references');
    for (const id of truth.relevantLogIds) {
      const log = logById.get(id);
      assert.ok(log, 'Missing log: ' + id);
      assert.equal(log.service, incident.service, id);
      inWindow(log.timestamp, incident);
    }
  }
});

test('metric series have known services, finite values, and ordered fixed timestamps', () => {
  for (const metric of metrics) {
    assert.ok(serviceByName.has(metric.service));
    assert.ok(metric.name.trim() && metric.unit.trim());
    assert.ok(metric.points.length >= 2);
    let previous = -Infinity;
    for (const point of metric.points) {
      const time = timestamp(point.timestamp);
      assert.ok(time > previous, metric.name + ': timestamps must increase');
      assert.ok(Number.isFinite(point.value));
      previous = time;
    }
  }
});

test('ground truth metric references exist for the intended service and time window', () => {
  for (const truth of groundTruth) {
    const incident = incidentById.get(truth.incidentId);
    assert.ok(truth.relevantMetricNames.length > 0);
    unique(truth.relevantMetricNames, truth.incidentId + ' metric references');
    for (const name of truth.relevantMetricNames) {
      const metric = metrics.find(item => item.service === incident.service && item.name === name);
      assert.ok(metric, incident.id + ': missing service metric ' + name);
      for (const point of metric.points) inWindow(point.timestamp, incident);
    }
  }
});

test('referenced runbooks exist and contain operational documents', () => {
  for (const runbook of runbooks) {
    assert.ok(runbook.title.trim() && runbook.content.trim());
    assert.ok(runbook.tags.length > 0);
    unique(runbook.tags, runbook.id + ' tags');
  }
  for (const truth of groundTruth) {
    assert.ok(truth.relevantRunbookIds.length > 0);
    unique(truth.relevantRunbookIds, truth.incidentId + ' runbook references');
    for (const id of truth.relevantRunbookIds) assert.ok(runbookById.has(id), 'Missing runbook: ' + id);
  }
});

test('normal fixture exports and incident requests exclude ground truth answers', () => {
  assert.deepEqual(Object.keys(fixtures).sort(), ['incidents', 'logs', 'metrics', 'runbooks', 'services']);
  for (const incident of incidents) {
    assert.deepEqual(Object.keys(incident).sort(), ['description', 'id', 'service', 'timeWindow', 'title']);
  }
  const visibleData = JSON.stringify(fixtures);
  assert.doesNotMatch(visibleData, /expectedCause|expectedDiagnosis|groundTruth|ROOT_CAUSE|EXPECTED_CAUSE|THIS_INCIDENT_IS_CAUSED_BY/);
  for (const truth of groundTruth) assert.ok(!visibleData.includes(truth.expectedCause));
});
