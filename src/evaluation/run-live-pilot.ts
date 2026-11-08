import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planLivePilot, readPilotJson, runLivePilot } from './live-pilot.js';

type Command = { mode: 'plan' }
  | { mode: 'live'; runId: string; budgetMicrousd: number; deadlineMs?: number; pricingPath: string }
  | { mode: 'review'; runId: string; reviewsPath?: string };

export function parsePilotCommand(args: string[]): Command {
  if (!args.length || args.length === 1 && args[0] === '--plan') return { mode: 'plan' };
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flags.has(flag) || values.has(flag)) throw new TypeError('Duplicate pilot option');
    if (['--live', '--authorize-paid', '--review'].includes(flag)) flags.add(flag);
    else if (['--run-id', '--budget-microusd', '--deadline-ms', '--pricing', '--reviews'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new TypeError('Pilot option requires a value');
      values.set(flag, value);
    } else throw new TypeError('Unknown pilot option');
  }
  const runId = values.get('--run-id');
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new TypeError('A valid --run-id is required');
  if (flags.size === 1 && flags.has('--review') && [...values.keys()].every(flag => ['--run-id', '--reviews'].includes(flag))) {
    return { mode: 'review', runId, reviewsPath: values.get('--reviews') };
  }
  if (flags.size !== 2 || !flags.has('--live') || !flags.has('--authorize-paid') || values.has('--reviews')) {
    throw new TypeError('Live execution requires both --live and --authorize-paid');
  }
  const integer = (key: string) => {
    const value = values.get(key);
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new TypeError('Invalid positive integer option');
    return Number(value);
  };
  const pricingPath = values.get('--pricing');
  if (!pricingPath) throw new TypeError('--pricing requires a dated pricing JSON file');
  return { mode: 'live', runId, pricingPath, budgetMicrousd: integer('--budget-microusd'),
    deadlineMs: values.has('--deadline-ms') ? integer('--deadline-ms') : undefined };
}

async function main(args: string[]) {
  let command: Command;
  try { command = parsePilotCommand(args); }
  catch (error) { console.error((error as Error).message); return 2; }
  if (command.mode === 'plan') {
    console.log(JSON.stringify(planLivePilot(), null, 2));
    return 0;
  }
  if (command.mode === 'review') {
    const { reviewLivePilot } = await import('./live-pilot-review.js');
    console.log(JSON.stringify(reviewLivePilot(command.runId, command.reviewsPath), null, 2));
    return 0;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const result = await runLivePilot({
      live: true, authorizePaid: true, runId: command.runId, budgetMicrousd: command.budgetMicrousd,
      deadlineMs: command.deadlineMs, pricing: readPilotJson(resolve(command.pricingPath)),
    }, controller.signal);
    console.log(JSON.stringify(result, null, 2));
    return controller.signal.aborted ? 130 : result.mode === 'LIVE_PILOT' && result.stop === 'COMPLETED' ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    console.error('Pilot stopped. Check the local prerequisites or reconcile the existing run journal before any further execution.');
    process.exitCode = 1;
  });
}
