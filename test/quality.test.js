import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { createExpandedDataset } from '../dist/evaluation/expanded-dataset.js';
import { connectScenarioExecutor } from '../dist/evaluation/fixture-mcp.js';
import { createScriptedBaselineModel, runScriptedBaseline } from '../dist/evaluation/baseline.js';
import { runExpandedEvaluation } from '../dist/evaluation/expanded.js';
import { assessQuality, assertQualityMaterial, createQualityMaterial, materialFingerprint, REVIEW_REFERENCE_PATHS, resolveReviewReference, reviewReferences } from '../dist/evaluation/quality.js';
import { generateQualityMaterials, observeQualityCase, validateQualityDataset } from '../dist/evaluation/quality-runner.js';
import { QUALITY_DIMENSIONS, QUALITY_RUBRIC, QUALITY_VERSION } from '../dist/evaluation/quality-contracts.js';

const dataset = createExpandedDataset();
let materials, good;
const diagnosis = { summary: 'Checkout is impaired during Redis access failures.',
  probableCause: 'Checkout requests time out while accessing Redis; the underlying cache or network mechanism still needs investigation.',
  confidence: 'medium', evidence: ['LOG-001-02 and LOG-001-03 show cache-access timeouts during checkout failures.'],
  recommendedActions: ['Inspect cache connectivity and timeout signals before proposing a change.'] };
beforeEach(t => { t.mock.method(globalThis, 'fetch', () => assert.fail('Quality assessment must remain offline')); });
async function runDiagnosis(scenario, value = diagnosis, changeCalls = calls => calls) {
  const connection = await connectScenarioExecutor(scenario.evidence, scenario.source);
  const script = createScriptedBaselineModel();
  const model = { async respond(request) {
    const result = await script.respond(request);
    return result.kind === 'tool_calls' ? { ...result, calls: changeCalls(result.calls) } : { kind: 'final', diagnosis: structuredClone(value) };
  } };
  try { return await observeQualityCase(scenario, model, connection.executor, 'SYNTHETIC_TEST'); }
  finally { await connection.close(); }
}
before(async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Quality fixtures must not use a real model/network'));
  materials = await generateQualityMaterials();
  good = await runDiagnosis(dataset[0]);
});

/** These are authored unit-test verdicts, NOT actual independent human reviews. */
function syntheticReview(material, changes = {}) {
  const refs = { cause: 'diagnosis.probableCause', evidence: 'diagnosis.evidence', actions: 'diagnosis.recommendedActions',
    toolSelection: material.observed.requests.length ? 'request:' + material.observed.requests[0].callId : 'scenario.requiredToolReasons' };
  return { schemaVersion: QUALITY_VERSION, caseId: material.caseId, outcomeFingerprint: material.fingerprint, provenance: 'SYNTHETIC_TEST',
    judgments: Object.fromEntries(QUALITY_DIMENSIONS.map(dimension => [dimension, {
      status: changes[dimension] ?? 'PASS', rationale: `Synthetic test-only ${dimension} adjudication for ${material.caseId}; inspect actual packet ${refs[dimension]}.`,
      references: changes[dimension] === 'NOT_EVALUATED' ? [] : [refs[dimension]],
    }])) };
}
const score = (items, reviews = []) => assessQuality(items, reviews, { allowSyntheticTests: true });

test('quality packet generation observes all existing 30 real MCP investigations without inventing source data', () => {
  validateQualityDataset(materials);
  assert.equal(materials.length, 30);
  assert.equal(materials.filter(item => item.scenario.source === 'accepted-fixtures').length, 5);
  assert.equal(materials.filter(item => item.scenario.source === 'evaluation-only').length, 25);
  assert.equal(materials.reduce((sum, item) => sum + item.observed.attempts.length, 0), 120);
  assert.equal(materials.reduce((sum, item) => sum + item.observed.requests.length, 0), 120);
  for (const material of materials) {
    assert.equal(material.observed.status, 'COMPLETED'); assert.equal(material.runSource, 'SCRIPTED_BASELINE');
    assert.equal(material.observed.deliveredOutputs.length, 4);
    assert.deepEqual(material.scenario, dataset.find(scenario => scenario.evaluationCase.caseId === material.caseId));
    assertQualityMaterial(material);
  }
  assert.match(QUALITY_RUBRIC.cause, /never a literal-match oracle/);
});

test('completed material rejects a proposed logical request without any actual attempt', () => {
  const observed = structuredClone(good.observed), id = observed.requests[0].callId;
  observed.attempts = observed.attempts.filter(attempt => attempt.call.callId !== id);
  observed.deliveredOutputs = observed.deliveredOutputs.filter(output => output.callId !== id);
  assert.throws(() => createQualityMaterial(good.scenario, observed, 'SYNTHETIC_TEST'), /Completed material has undelivered or failed logical executions/);
});

test('completed material rejects a successful proposed request whose evidence was not delivered', () => {
  const observed = structuredClone(good.observed);
  observed.deliveredOutputs.pop();
  assert.throws(() => createQualityMaterial(good.scenario, observed, 'SYNTHETIC_TEST'), /Completed material has undelivered or failed logical executions/);
});

test('actual attempts must match a real logical proposal in either direction of validation', () => {
  const observed = structuredClone(good.observed);
  observed.requests.shift();
  assert.throws(() => createQualityMaterial(good.scenario, observed, 'SYNTHETIC_TEST'), /Attempt does not match an actual request/);
});

test('unexecuted proposals remain valid for nonterminal, rejected and failed observations', () => {
  for (const status of ['STARTED', 'INVESTIGATING', 'AWAITING_APPROVAL', 'REJECTED', 'FAILED']) {
    const observed = { ...structuredClone(good.observed), status, diagnosis: null, attempts: [], deliveredOutputs: [] };
    const material = createQualityMaterial(good.scenario, observed, 'SYNTHETIC_TEST');
    assertQualityMaterial(material);
    assert.ok(!reviewReferences(material).some(reference => reference.startsWith('diagnosis.')));
    for (const reference of reviewReferences(material)) assert.notEqual(resolveReviewReference(material, reference), undefined);
    assert.throws(() => resolveReviewReference(material, 'diagnosis.probableCause'), /unavailable quality review reference/);
  }
});

test('every published review reference resolves to its actual packet value in all 30 cases', () => {
  for (const material of materials) {
    const expected = {
      'scenario.expectedCause': material.scenario.evaluationCase.expectations.groundTruth.expectedCause,
      'scenario.evidenceCondition': material.scenario.evidenceCondition,
      'scenario.requiredToolReasons': material.scenario.requiredToolReasons,
      'scenario.evidence': material.scenario.evidence,
      'diagnosis.probableCause': material.observed.diagnosis.probableCause,
      'diagnosis.confidence': material.observed.diagnosis.confidence,
      'diagnosis.evidence': material.observed.diagnosis.evidence,
      'diagnosis.recommendedActions': material.observed.diagnosis.recommendedActions,
      ...Object.fromEntries(material.observed.requests.map(call => ['request:' + call.callId, call])),
      ...Object.fromEntries(material.observed.deliveredOutputs.map(output => ['observed-output:' + output.callId, output])),
    };
    assert.deepEqual(reviewReferences(material), Object.keys(expected));
    for (const reference of reviewReferences(material)) {
      assert.deepEqual(resolveReviewReference(material, reference), expected[reference]);
      if (Object.hasOwn(REVIEW_REFERENCE_PATHS, reference)) {
        const value = REVIEW_REFERENCE_PATHS[reference].split('.').reduce((node, key) => node[key], material);
        assert.deepEqual(resolveReviewReference(material, reference), value);
      }
    }
  }
});

test('dynamic references preserve full call IDs, reject missing entries and return detached content', () => {
  const observed = structuredClone(good.observed), oldId = observed.requests[0].callId, id = 'read:logs:1';
  observed.requests[0].callId = id;
  for (const attempt of observed.attempts) if (attempt.call.callId === oldId) attempt.call.callId = id;
  for (const output of observed.deliveredOutputs) if (output.callId === oldId) output.callId = id;
  const material = createQualityMaterial(good.scenario, observed, 'SYNTHETIC_TEST');
  assert.deepEqual(resolveReviewReference(material, 'request:' + id), observed.requests[0]);
  assert.deepEqual(resolveReviewReference(material, 'observed-output:' + id), observed.deliveredOutputs[0]);
  resolveReviewReference(material, 'request:' + id).arguments.service = 'changed';
  assert.deepEqual(material.observed.requests[0], observed.requests[0]);
  for (const reference of ['request:missing', 'observed-output:missing', 'diagnosis.missing', 'toString', '__proto__']) {
    assert.throws(() => resolveReviewReference(material, reference), /Unknown or unavailable/);
    assert.ok(!reviewReferences(material).includes(reference));
  }
});

test('Task Success PASS requires actual completion and all explicit synthetic quality judgments', () => {
  const report = score([good], [syntheticReview(good)]);
  assert.equal(report.results[0].taskSuccess.status, 'PASS'); assert.equal(report.results[0].toolCorrectness.status, 'PASS');
  assert.equal(report.results[0].taskSuccess.origin, 'SYNTHETIC_TEST');
  assert.equal(report.summary.syntheticTestReviewRecords, 1); assert.equal(report.summary.humanReviewRecords, 0);
  assert.deepEqual(report.summary.taskSuccess, { total: 1, evaluated: 1, passed: 1, failed: 0, notEvaluated: 0, passRateAmongEvaluated: 1 });
});

test('wrong-cause reviewed FAIL overrides COMPLETED and other unreviewed dimensions', async () => {
  const wrong = await runDiagnosis(dataset[0], { ...diagnosis, probableCause: 'An unrelated database migration caused this cache incident.' });
  const review = syntheticReview(wrong, { cause: 'FAIL', evidence: 'NOT_EVALUATED', actions: 'NOT_EVALUATED' });
  review.judgments.cause.rationale = `${wrong.caseId}: observed cache timeouts do not support a database-migration attribution.`;
  const result = score([wrong], [review]).results[0];
  assert.equal(wrong.observed.status, 'COMPLETED'); assert.equal(result.taskSuccess.status, 'FAIL');
  assert.equal(result.judgments.evidence.status, 'NOT_EVALUATED');
});

test('unsupported certainty fails adjudication while justified uncertainty can pass on ambiguous evidence', async () => {
  const scenario = dataset.find(item => item.family === 'redis-dependency-timeout' && item.evidenceCondition === 'ambiguous');
  const certain = await runDiagnosis(scenario, { ...diagnosis, probableCause: 'Packet loss is definitely the sole cause.', confidence: 'high' });
  const uncertain = await runDiagnosis(scenario, { ...diagnosis,
    probableCause: 'Cache requests exceed deadlines, but pool pressure and packet loss cannot be separated as primary causes.', confidence: 'low',
    evidence: scenario.evaluationCase.expectations.groundTruth.relevantLogIds.map(id => `Observed log ${id}; stage attribution is missing.`),
    recommendedActions: ['Collect request-stage timing before choosing a remediation.'] });
  const failed = syntheticReview(certain, { cause: 'FAIL' });
  failed.judgments.cause.references.push('scenario.evidenceCondition');
  failed.judgments.cause.rationale = `${certain.caseId}: concurrent pool pressure contradicts the asserted unique network cause.`;
  assert.equal(score([certain], [failed]).results[0].taskSuccess.status, 'FAIL');
  assert.equal(score([uncertain], [syntheticReview(uncertain)]).results[0].taskSuccess.status, 'PASS');
});

test('unsupported evidence claims fail the explicit evidence dimension, not a generic output-received check', async () => {
  const unsupported = await runDiagnosis(dataset[0], { ...diagnosis, evidence: ['Observed a database deletion that is absent from all tool outputs.'] });
  const review = syntheticReview(unsupported, { evidence: 'FAIL' });
  review.judgments.evidence.references.push('observed-output:logs');
  review.judgments.evidence.rationale = `${unsupported.caseId}: delivered logs show Redis timeouts, not a database deletion.`;
  assert.equal(score([unsupported], [review]).results[0].taskSuccess.status, 'FAIL');
  assert.equal(assessQuality([unsupported]).results[0].taskSuccess.status, 'NOT_EVALUATED', 'No manufactured automatic semantic verdict');
});

test('unsafe or unjustified recommendations fail the action review without executing any action', async () => {
  const unsafe = await runDiagnosis(dataset[0], { ...diagnosis, recommendedActions: ['Restart all production services immediately without approval.'] });
  const review = syntheticReview(unsafe, { actions: 'FAIL' });
  review.judgments.actions.rationale = `${unsafe.caseId}: broad unapproved restarts are unsupported by the observed cache timeouts.`;
  assert.equal(score([unsafe], [review]).results[0].taskSuccess.status, 'FAIL');
  assert.ok(unsafe.observed.requests.every(call => call.name !== 'restart_service'));
});

test('an empty action list may pass when the case-specific review finds no warranted operation', async () => {
  const noAction = await runDiagnosis(dataset[0], { ...diagnosis, recommendedActions: [] });
  const review = syntheticReview(noAction);
  review.judgments.actions.rationale = `${noAction.caseId}: mechanism remains uncertain; no operational mutation is warranted by these observations.`;
  assert.equal(score([noAction], [review]).results[0].taskSuccess.status, 'PASS');
});

test('unreviewed scripted results remain NOT_EVALUATED despite completion and passing structural checks', () => {
  const report = assessQuality(materials);
  assert.equal(report.summary.humanReviewRecords, 0); assert.equal(report.summary.syntheticTestReviewRecords, 0);
  assert.equal(report.summary.unreviewedCases, 30);
  for (const key of ['taskSuccess', 'toolCorrectness']) assert.deepEqual(report.summary[key], {
    total: 30, evaluated: 0, passed: 0, failed: 0, notEvaluated: 30, passRateAmongEvaluated: null,
  });
  assert.equal(report.summary.structuralRequestChecks.passed, 30);
  assert.ok(report.results.every(item => item.judgments.cause.status === 'NOT_EVALUATED'));
});

test('partial reviews never promote the remaining unreviewed task dimensions to PASS', () => {
  const review = syntheticReview(good, { cause: 'PASS', evidence: 'NOT_EVALUATED', actions: 'NOT_EVALUATED', toolSelection: 'NOT_EVALUATED' });
  const report = score([good], [review]);
  assert.equal(report.results[0].taskSuccess.status, 'NOT_EVALUATED');
  assert.equal(report.summary.dimensions.cause.evaluated, 1); assert.equal(report.summary.dimensions.evidence.evaluated, 0);
  assert.equal(report.summary.taskSuccess.passRateAmongEvaluated, null);
});

test('execution failure establishes Task Success FAIL without pretending the diagnosis was human-reviewed', async () => {
  const connection = await connectScenarioExecutor(dataset[2].evidence, dataset[2].source);
  let failed;
  try { failed = await observeQualityCase(dataset[2], { async respond() { throw new Error('Controlled model failure'); } }, connection.executor, 'SYNTHETIC_TEST'); }
  finally { await connection.close(); }
  const report = assessQuality([failed]);
  assert.equal(report.results[0].taskSuccess.status, 'FAIL'); assert.equal(report.results[0].taskSuccess.origin, 'EXECUTION_FAILURE');
  assert.equal(report.results[0].judgments.cause.status, 'NOT_EVALUATED'); assert.equal(report.summary.humanReviewRecords, 0);
  assert.equal(report.summary.unreviewedCases, 1); assert.equal(report.summary.taskSuccess.evaluated, 1);
  assert.equal(report.results[0].toolCorrectness.status, 'NOT_EVALUATED', 'No model decision is not a reviewed bad tool choice');
  assert.equal(report.results[0].requestChecks.omissionsAssessed, false);
});

test('pending approval is nonterminal and the quality observer does not execute a risky proposal', async () => {
  const connection = await connectScenarioExecutor(dataset[0].evidence, dataset[0].source);
  let pending;
  try { pending = await observeQualityCase(dataset[0], { async respond() { return { kind: 'tool_calls', continuation: 'pending',
    calls: [{ callId: 'risk', name: 'restart_service', arguments: { service: dataset[0].evaluationCase.incident.service } }] }; } }, connection.executor, 'SYNTHETIC_TEST'); }
  finally { await connection.close(); }
  assert.equal(pending.observed.status, 'AWAITING_APPROVAL'); assert.equal(pending.observed.attempts.length, 0);
  assert.equal(pending.observed.requests.length, 1); assertQualityMaterial(pending);
  assert.equal(assessQuality([pending]).results[0].taskSuccess.status, 'NOT_EVALUATED');
  assert.equal(assessQuality([pending]).results[0].toolCorrectness.status, 'NOT_EVALUATED');
});

test('malformed or unreviewed PASS records require explicit provenance, dimensions, rationale and references', () => {
  for (const corrupt of [
    review => { delete review.provenance; }, review => { delete review.judgments.evidence; },
    review => { review.judgments.cause.rationale = ' '; }, review => { review.judgments.cause.references = []; },
    review => { review.judgments.cause.status = 'APPROVED'; }, review => { review.reviewerEmail = 'not-required'; },
    review => { review.provenance = 'UNREVIEWED_TEMPLATE'; },
  ]) {
    const review = syntheticReview(good); corrupt(review);
    assert.throws(() => score([good], [review]), TypeError);
  }
  assert.throws(() => score([good], [{ caseId: good.caseId, status: 'PASS' }]), /Malformed quality reviews/);
});

test('duplicate/conflicting reviews cannot overwrite an earlier per-case adjudication', () => {
  assert.throws(() => score([good], [syntheticReview(good), syntheticReview(good, { cause: 'FAIL' })]), /Duplicate\/conflicting/);
  const other = syntheticReview(good); other.caseId = 'UNKNOWN-CASE';
  assert.throws(() => score([good], [other]), /unknown case/);
});

test('a different actual diagnosis invalidates an earlier review fingerprint', async () => {
  const changed = await runDiagnosis(dataset[0], { ...diagnosis, summary: 'Changed actual model output.' });
  assert.notEqual(good.fingerprint, changed.fingerprint);
  assert.throws(() => score([changed], [syntheticReview(good)]), /Stale review fingerprint/);
});

test('material fingerprint also binds arguments, actual outputs and evaluator evidence/annotations', () => {
  for (const change of [
    packet => { packet.observed.requests[0].arguments.service = 'other'; },
    packet => { packet.observed.deliveredOutputs[0].output = '[]'; },
    packet => { packet.scenario.evaluationCase.expectations.groundTruth.expectedCause = 'Changed annotation'; },
    packet => { packet.observed.diagnosis.summary = 'Changed diagnosis'; },
  ]) {
    const modified = structuredClone(good); change(modified);
    assert.throws(() => assertQualityMaterial(modified), TypeError);
  }
});

test('canonical fingerprints tolerate JSON key ordering without accepting stale scenarios', () => {
  const reordered = structuredClone(materials);
  for (const packet of reordered) {
    packet.scenario = Object.fromEntries(Object.entries(packet.scenario).reverse());
    packet.observed.diagnosis = Object.fromEntries(Object.entries(packet.observed.diagnosis).reverse());
    assert.equal(packet.fingerprint, materialFingerprint(packet));
  }
  validateQualityDataset(reordered);
  const stale = structuredClone(materials);
  stale[5].scenario.evaluationCase.expectations.groundTruth.expectedCause = 'Changed evaluator annotation';
  stale[5].fingerprint = materialFingerprint(stale[5]);
  assert.throws(() => validateQualityDataset(stale), /stale/);
});

test('test judgments are excluded by default and cannot be relabeled into a human benchmark', () => {
  assert.throws(() => assessQuality([good], [syntheticReview(good)]), /not human reviews/);
  const fakeHuman = syntheticReview(good); fakeHuman.provenance = 'INDEPENDENT_HUMAN';
  assert.throws(() => assessQuality([good], [fakeHuman]), /Test material cannot count/);
});

test('packet references must exist and an all-NOT_EVALUATED submission is still unreviewed', () => {
  const invalid = syntheticReview(good); invalid.judgments.evidence.references = ['observed-output:never-delivered'];
  assert.throws(() => score([good], [invalid]), /case-specific packet references/);
  const review = syntheticReview(good, Object.fromEntries(QUALITY_DIMENSIONS.map(key => [key, 'NOT_EVALUATED'])));
  const report = score([good], [review]);
  assert.equal(report.summary.submittedReviewRecords, 1); assert.equal(report.summary.casesWithAnyJudgment, 0);
  assert.equal(report.summary.unreviewedCases, 1); assert.equal(report.summary.taskSuccess.evaluated, 0);
});

test('genuine appropriate tool selection can PASS with justified extra reads, without exact-set penalties', async () => {
  const scenario = dataset.find(item => item.evidenceCondition === 'strong-signal');
  const material = await runDiagnosis(scenario);
  assert.equal(scenario.evaluationCase.expectations.requiredTools.length, 2); assert.equal(material.observed.requests.length, 4);
  const review = syntheticReview(material);
  review.judgments.toolSelection.rationale = `${material.caseId}: logs/metrics collect the saturation signals; extra service context and runbook guidance are reasonable investigation reads.`;
  const result = score([material], [review]).results[0];
  assert.equal(result.requestChecks.status, 'PASS'); assert.equal(result.toolCorrectness.status, 'PASS');
  assert.equal(result.requestChecks.logicalSelections.length, 4);
});

test('a missing necessary tool fails correctness even if the workflow completes and a reviewer marks selection PASS', async () => {
  const missing = await runDiagnosis(dataset[0], diagnosis, calls => calls.filter(call => call.name !== 'search_runbook'));
  assert.equal(missing.observed.status, 'COMPLETED');
  const result = score([missing], [syntheticReview(missing)]).results[0];
  assert.equal(result.toolCorrectness.status, 'FAIL'); assert.equal(result.toolCorrectness.origin, 'AUTOMATED_REQUEST_CHECKS');
  assert.ok(result.requestChecks.issues.some(issue => issue.code === 'MISSING_NECESSARY_TOOL'));
});

for (const variant of ['service', 'window']) {
  test(`incorrect ${variant} request may execute successfully but still fails separate tool correctness`, async () => {
    const material = await runDiagnosis(dataset[0], diagnosis, calls => calls.map(call => {
      if (variant === 'service' && call.name === 'get_service_info') return { ...call, arguments: { service: dataset[1].evaluationCase.incident.service } };
      if (variant === 'window' && call.name === 'search_logs') return { ...call, arguments: { ...call.arguments,
        timeWindow: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-01T00:10:00.000Z' } } };
      return call;
    }));
    assert.equal(material.observed.status, 'COMPLETED'); assert.ok(material.observed.attempts.every(attempt => attempt.status === 'SUCCEEDED'));
    const result = assessQuality([material]).results[0];
    assert.equal(result.toolCorrectness.status, 'FAIL');
    assert.ok(result.requestChecks.issues.some(issue => issue.code === (variant === 'service' ? 'WRONG_SERVICE' : 'WRONG_TIME_WINDOW')));
    assert.equal(result.taskSuccess.status, 'NOT_EVALUATED');
  });
}

for (const [args, code] of [[{ query: 42 }, 'INVALID_QUERY'], [{ query: 'valid', limit: '1' }, 'INVALID_LIMIT']]) {
  test(`invalid runbook ${code} is explained without mistaking execution for semantic correctness`, async () => {
    const material = await runDiagnosis(dataset[0], diagnosis, calls => calls.map(call => call.name === 'search_runbook' ? { ...call, arguments: args } : call));
    assert.equal(material.observed.status, 'FAILED');
    assert.ok(assessQuality([material]).results[0].requestChecks.issues.some(issue => issue.code === code));
  });
}

test('query relevance and unjustified selections require explicit case-specific adjudication beyond syntax', () => {
  const material = structuredClone(materials[0]);
  const review = syntheticReview(material, { cause: 'NOT_EVALUATED', evidence: 'NOT_EVALUATED', actions: 'NOT_EVALUATED', toolSelection: 'FAIL' });
  review.judgments.toolSelection.references = ['request:runbook'];
  review.judgments.toolSelection.rationale = `${material.caseId}: synthetic test judgment that the proposed query/limit does not cover the reviewer-identified evidence need.`;
  const result = score([material], [review]).results[0];
  assert.equal(result.requestChecks.status, 'PASS'); assert.equal(result.toolCorrectness.status, 'FAIL');
  assert.equal(assessQuality([material]).results[0].toolCorrectness.status, 'NOT_EVALUATED');
});

test('retry remains one logical request with two actual attempts and no delivered failed-attempt evidence', async t => {
  const connection = await connectScenarioExecutor(dataset[0].evidence, dataset[0].source);
  const original = connection.executor.execute.bind(connection.executor); let first = true;
  t.mock.method(connection.executor, 'execute', call => {
    if (first) { first = false; throw new SdkError(SdkErrorCode.RequestTimeout, 'Controlled read timeout'); }
    return original(call);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = observeQualityCase(dataset[0], createScriptedBaselineModel(), connection.executor, 'SYNTHETIC_TEST');
    await nextTurn(); t.mock.timers.tick(100); await nextTurn();
    const material = await pending, result = assessQuality([material]).results[0];
    assert.equal(material.observed.status, 'COMPLETED'); assert.equal(material.observed.requests.length, 4);
    assert.equal(material.observed.attempts.length, 5); assert.equal(material.observed.deliveredOutputs.length, 4);
    assertQualityMaterial(material);
    assert.equal(material.observed.attempts[0].status, 'FAILED'); assert.equal(material.observed.attempts[0].output, null);
    assert.equal(result.requestChecks.logicalSelections.length, 4);
    assert.equal(result.requestChecks.logicalSelections[0].attempts, 2);
    assert.equal(result.requestChecks.actualAttempts, 5);
  } finally { await connection.close(); }
});

test('Ground Truth, rubric and judgments never enter model or tool inputs through the quality observation boundary', async () => {
  for (const scenario of [dataset[0], dataset[7], dataset[10]]) {
    const connection = await connectScenarioExecutor(scenario.evidence, scenario.source), seen = [];
    const script = createScriptedBaselineModel(request => seen.push(structuredClone(request)));
    const execute = connection.executor.execute.bind(connection.executor), calls = [];
    connection.executor.execute = call => { calls.push(structuredClone(call)); return execute(call); };
    try {
      const packet = await observeQualityCase(scenario, script, connection.executor, 'SCRIPTED_BASELINE');
      const actual = JSON.stringify({ seen, calls });
      for (const key of ['groundTruth', 'expectedCause', 'requiredTools', 'requiredToolReasons', 'faultCondition', 'judgments', 'provenance', 'QUALITY_RUBRIC']) {
        assert.ok(!actual.includes(key), key + ' must stay reviewer-only');
      }
      assert.ok(!actual.includes(scenario.evaluationCase.expectations.groundTruth.expectedCause));
      assert.deepEqual(JSON.parse(seen[0].prompt), scenario.evaluationCase.incident);
      assert.equal(packet.scenario.evaluationCase.expectations.groundTruth.expectedCause, scenario.evaluationCase.expectations.groundTruth.expectedCause);
      assert.deepEqual(packet.observed.deliveredOutputs, seen[1].outputs);
      assert.ok(reviewReferences(packet).includes('observed-output:logs'));
    } finally { await connection.close(); }
  }
});

test('late timed-out tool evidence cannot change an already fingerprinted quality packet', async t => {
  const connection = await connectScenarioExecutor(dataset[0].evidence, dataset[0].source);
  const execute = connection.executor.execute.bind(connection.executor);
  let completeLate, first = true;
  const late = new Promise(done => { completeLate = done; });
  t.mock.method(connection.executor, 'execute', call => {
    if (first) { first = false; return late; }
    return execute(call);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = observeQualityCase(dataset[0], createScriptedBaselineModel(), connection.executor, 'SYNTHETIC_TEST');
    await nextTurn(); t.mock.timers.tick(30_000); await nextTurn(); t.mock.timers.tick(100); await nextTurn();
    const packet = await pending, snapshot = structuredClone(packet);
    assert.equal(packet.observed.attempts.length, 5);
    assert.equal(packet.observed.attempts[0].status, 'FAILED'); assert.equal(packet.observed.attempts[0].output, null);
    completeLate({ callId: packet.observed.requests[0].callId, output: 'SECRET_LATE_UNOBSERVED_EVIDENCE' });
    await nextTurn();
    assert.deepEqual(packet, snapshot); assert.equal(packet.fingerprint, materialFingerprint(packet));
    assert.ok(!JSON.stringify(packet).includes('SECRET_LATE_UNOBSERVED_EVIDENCE'));
  } finally { await connection.close(); }
});

test('assessment denominators exclude NOT_EVALUATED and execution failure remains distinct from semantic failure', async () => {
  const connection = await connectScenarioExecutor(dataset[2].evidence, dataset[2].source);
  let failed;
  try { failed = await observeQualityCase(dataset[2], { async respond() { throw Error('Controlled failure'); } }, connection.executor, 'SYNTHETIC_TEST'); }
  finally { await connection.close(); }
  const report = score([good, materials[1], failed], [syntheticReview(good)]);
  assert.deepEqual(report.summary.taskSuccess, { total: 3, evaluated: 2, passed: 1, failed: 1, notEvaluated: 1, passRateAmongEvaluated: 0.5 });
  assert.equal(report.summary.unreviewedCases, 2); assert.equal(report.summary.humanReviewRecords, 0);
  assert.equal(report.results[2].taskSuccess.origin, 'EXECUTION_FAILURE');
  const empty = assessQuality([]);
  assert.equal(empty.summary.taskSuccess.passRateAmongEvaluated, null);
  assert.doesNotMatch(JSON.stringify(empty), /NaN|Infinity/);
});

test('literal expected-cause equality never creates semantic PASS without an independent judgment', () => {
  const observed = structuredClone(good.observed);
  observed.diagnosis.probableCause = good.scenario.evaluationCase.expectations.groundTruth.expectedCause;
  const material = createQualityMaterial(good.scenario, observed, 'SYNTHETIC_TEST');
  assert.equal(assessQuality([material]).results[0].taskSuccess.status, 'NOT_EVALUATED');
  assert.equal(score([material], [syntheticReview(material, { cause: 'FAIL' })]).results[0].taskSuccess.status, 'FAIL');
});

test('quality artifacts and actual observations do not extend accepted evaluation reports or mutate original fixtures', async () => {
  const baseline = await runScriptedBaseline(), expanded = await runExpandedEvaluation(), snapshot = createExpandedDataset();
  const regenerated = await generateQualityMaterials();
  assert.deepEqual(regenerated.map(item => item.fingerprint), materials.map(item => item.fingerprint));
  assert.deepEqual(await runScriptedBaseline(), baseline); assert.deepEqual(await runExpandedEvaluation(), expanded);
  assert.deepEqual(createExpandedDataset(), snapshot);
  assert.equal(baseline.summary.criteria.diagnosisCorrectness.notEvaluated, 5);
  assert.equal(expanded.summary.criteria.diagnosisCorrectness.notEvaluated, 30);
  assert.ok(!Object.hasOwn(baseline.results[0], 'taskSuccess'));
  assert.ok(!Object.hasOwn(expanded.results[0], 'toolCorrectness'));
  assert.throws(() => validateQualityDataset(materials.slice(1)), /existing 30 cases/);
});

test('offline CLI produces zero human-reviewed quality results and can replay an explicitly saved packet without network', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'incidentops-quality-'));
  assert.equal(dirname(directory), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('incidentops-quality-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packetPath = join(directory, 'packet.json'), reviewPath = join(directory, 'reviews.json');
  await writeFile(packetPath, JSON.stringify({ materials })); await writeFile(reviewPath, '[]');
  const options = { encoding: 'utf8', maxBuffer: 2_000_000 };
  const result = JSON.parse(execFileSync(process.execPath, ['dist/evaluation/run-quality.js', '--summary', '--material', packetPath, '--reviews', reviewPath], options));
  assert.equal(result.report.summary.humanReviewRecords, 0); assert.equal(result.report.summary.taskSuccess.notEvaluated, 30);
  assert.equal(result.report.summary.toolCorrectness.evaluated, 0); assert.equal(result.report.summary.taskSuccess.passRateAmongEvaluated, null);
  assert.equal(result.report.notEvaluatedCases.taskSuccess.length, 30);
  const full = JSON.parse(execFileSync(process.execPath, ['dist/evaluation/run-quality.js', '--material', packetPath], options));
  assert.deepEqual(full.referenceIdentifiers.fixedPaths, REVIEW_REFERENCE_PATHS);
  assert.match(full.referenceIdentifiers.kind, /Logical identifiers/);
  for (const [index, template] of full.reviewTemplates.entries()) {
    assert.deepEqual(template.allowedReferences, reviewReferences(full.materials[index]));
    for (const reference of template.allowedReferences) assert.notEqual(resolveReviewReference(full.materials[index], reference), undefined);
  }
  await writeFile(reviewPath, JSON.stringify([syntheticReview(materials[0])]));
  const invalid = spawnSync(process.execPath, ['dist/evaluation/run-quality.js', '--summary', '--material', packetPath, '--reviews', reviewPath], options);
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /not human reviews/);
});
