// npm run build; node dist/evaluation/run-measured.js
import { runMeasuredEvaluation } from './measured.js';

try {
  const report = await runMeasuredEvaluation();
  // Full per-investigation/call/attempt records are retained by runMeasuredEvaluation().
  // Keep CLI output small while displaying a clearly labeled individual example.
  console.log(JSON.stringify({ model: report.model, caseCount: report.caseCount, scoring: report.scoring,
    measurementSummary: report.measurementSummary, exampleInvestigation: report.measurements[0] ?? null,
    limitations: report.limitations }, null, 2));
  if (report.results.some(result => result.criteria.completion.status === 'FAIL' || result.criteria.toolSelection.status === 'FAIL')) process.exitCode = 1;
} catch (error) { console.error(error); process.exitCode = 1; }
