// Reproduce without a new package script: npm run build; node dist/evaluation/run-baseline.js
import { runScriptedBaseline } from './baseline.js';

try {
  const report = await runScriptedBaseline();
  console.log(JSON.stringify(report, null, 2));
  if (report.results.some(result => result.criteria.completion.status === 'FAIL' || result.criteria.toolSelection.status === 'FAIL')) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
