import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LiveInputError, runLiveInvestigation, validateLiveInput, type LiveInvestigationReport } from './live-investigation.js';

export function parseInvestigationArgs(args: string[]) {
  let live = false, incidentId: string | undefined, inspect = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live' && !live) live = true;
    else if (args[i] === '--inspect' && !inspect) inspect = true;
    else if (args[i] === '--incident' && incidentId === undefined && args[i + 1] && !args[i + 1].startsWith('--')) incidentId = args[++i];
    else throw new LiveInputError('Invalid or duplicate arguments; use --live --incident <supported ID> [--inspect]');
  }
  if (!live) throw new LiveInputError('Explicit --live opt-in is required');
  if (!incidentId) throw new LiveInputError('--incident is required');
  validateLiveInput(incidentId);
  return { incidentId, inspect };
}

/** No execution at import; process signal handlers belong only to an explicitly invoked CLI. */
export async function runInvestigationCli(args: string[], run: typeof runLiveInvestigation = runLiveInvestigation,
  output: (text: string) => void = text => process.stdout.write(text),
  errorOutput: (text: string) => void = text => process.stderr.write(text)): Promise<number> {
  let input: ReturnType<typeof parseInvestigationArgs>;
  try { input = parseInvestigationArgs(args); }
  catch (error) { errorOutput((error instanceof LiveInputError ? error.message : 'Invalid configuration') + '\n'); return 2; }
  const controller = new AbortController();
  let interrupted = false, report: LiveInvestigationReport | undefined, failed = false;
  const interrupt = () => { interrupted = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    report = await run(input.incidentId, { signal: controller.signal, inspect: input.inspect, onReport: value => { report = value; } });
  } catch { failed = true; }
  finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (report) output(JSON.stringify(report, null, 2) + '\n');
  if (failed) errorOutput('Investigation failed; raw provider/tool error details are omitted.\n');
  return interrupted ? 130 : failed || !report?.verificationReady ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runInvestigationCli(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    process.stderr.write('Investigation CLI failed\n'); process.exitCode = 1;
  });
}
