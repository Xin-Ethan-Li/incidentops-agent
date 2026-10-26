import { readFile } from 'node:fs/promises';
import { QUALITY_DIMENSIONS, QUALITY_RUBRIC, QUALITY_VERSION } from './quality-contracts.js';
import { assessQuality, REVIEW_REFERENCE_PATHS, reviewReferences } from './quality.js';
import { generateQualityMaterials, validateQualityDataset } from './quality-runner.js';

// Default: full reviewer-only packet/report on stdout. --summary omits large evidence packets.
// Optional --material <saved packet> --reviews <explicit human records>. No implicit file writes.
try {
  const args = process.argv.slice(2), options = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--summary', '--material', '--reviews'].includes(key) || options.has(key)) throw new TypeError('Unknown or duplicate quality option');
    if (key === '--summary') options.set(key, true);
    else { const value = args[++i]; if (!value || value.startsWith('--')) throw new TypeError('Quality option requires a file path'); options.set(key, value); }
  }
  const json = async (path: string) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  const saved = options.has('--material') ? await json(options.get('--material') as string) : undefined;
  const materials: unknown = saved === undefined ? await generateQualityMaterials() : saved.materials;
  validateQualityDataset(materials);
  const reviews: unknown = options.has('--reviews') ? await json(options.get('--reviews') as string) : [];
  const report = assessQuality(materials, reviews); // Production CLI never accepts synthetic-test reviews.
  const templates = materials.map(material => ({ schemaVersion: QUALITY_VERSION, caseId: material.caseId,
    outcomeFingerprint: material.fingerprint, provenance: 'UNREVIEWED_TEMPLATE',
    judgments: Object.fromEntries(QUALITY_DIMENSIONS.map(dimension => [dimension, { status: 'NOT_EVALUATED',
      rationale: 'Replace after independent case-specific review', references: [] }])),
    allowedReferences: reviewReferences(material) }));
  const displayedReport = options.has('--summary') ? { schemaVersion: report.schemaVersion, scope: report.scope, summary: report.summary,
    notEvaluatedCases: { taskSuccess: report.results.filter(item => item.taskSuccess.status === 'NOT_EVALUATED').map(item => item.caseId),
      toolCorrectness: report.results.filter(item => item.toolCorrectness.status === 'NOT_EVALUATED').map(item => item.caseId) },
    failures: report.results.filter(item => item.taskSuccess.status === 'FAIL' || item.toolCorrectness.status === 'FAIL')
      .map(item => ({ caseId: item.caseId, taskSuccess: item.taskSuccess, toolCorrectness: item.toolCorrectness })), limitations: report.limitations } : report;
  console.log(JSON.stringify({ schemaVersion: QUALITY_VERSION, mode: 'OFFLINE_SCRIPTED_CASE_QUALITY', report: displayedReport,
    ...(options.has('--summary') ? {} : { rubric: QUALITY_RUBRIC,
      referenceIdentifiers: { kind: 'Logical identifiers, not literal packet paths', fixedPaths: REVIEW_REFERENCE_PATHS,
        'request:<callId>': 'Entire observed.requests entry whose callId exactly matches <callId>',
        'observed-output:<callId>': 'Entire observed.deliveredOutputs entry whose callId exactly matches <callId>',
        resolution: 'Paths are relative to each material. Unavailable diagnosis references are omitted. Unknown or unavailable identifiers are rejected by resolveReviewReference.' },
      materials, reviewTemplates: templates }),
    reviewInstructions: 'Reviewer-only data includes Ground Truth. Save only to an explicitly chosen ignored local path. Templates are not assessments. After independent review supply a JSON array with INDEPENDENT_HUMAN provenance, matching fingerprints, rationale and packet references; remove allowedReferences. No personal data required. No automatic files or invented human outcomes.' }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : 'Quality evaluation failed'); process.exitCode = 1; }
