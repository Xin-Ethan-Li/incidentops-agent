// npm run build; node dist/evaluation/run-expanded.js
import { runExpandedEvaluation } from './expanded.js';

try {
  const report = await runExpandedEvaluation();
  console.log(JSON.stringify(report, null, 2));
  if (report.results.some(result => result.criteria.completion.status === 'FAIL' || result.criteria.toolSelection.status === 'FAIL')) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
