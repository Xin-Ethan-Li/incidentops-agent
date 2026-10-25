import type { Duration, DurationStatistics, InvestigationMeasurement, TokenCounts, UsageSummary } from './contracts.js';

export function durationStatistics(observations: Duration[]): DurationStatistics {
  const values = observations.flatMap(value => value.status === 'MEASURED' ? [value.milliseconds] : []);
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new TypeError('Invalid measured duration');
  return { unit: 'milliseconds', observations: observations.length, measured: values.length,
    pending: observations.filter(value => value.status === 'PENDING').length,
    notAvailable: observations.filter(value => value.status === 'NOT_AVAILABLE').length,
    minimum: values.length ? Math.min(...values) : null, maximum: values.length ? Math.max(...values) : null,
    // Divide before summing to avoid overflowing a sum of otherwise finite durations.
    mean: values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : null };
}

export function usageSummary(records: InvestigationMeasurement[]): UsageSummary {
  const calls = records.flatMap(record => record.modelCalls);
  const known = calls.flatMap(call => call.usage.status === 'AVAILABLE' ? [call.usage.counts] : []);
  let subtotal: TokenCounts | null = null;
  if (known.length) {
    const sum = (key: keyof TokenCounts) => known.reduce((total, counts) => total + BigInt(counts[key]), 0n);
    const input = sum('inputTokens'), output = sum('outputTokens'), total = sum('totalTokens');
    if ([input, output, total].every(value => value <= BigInt(Number.MAX_SAFE_INTEGER))) {
      subtotal = { inputTokens: Number(input), outputTokens: Number(output), totalTokens: Number(total) };
    }
  }
  const allTerminal = records.every(record => ['COMPLETED', 'FAILED', 'REJECTED'].includes(record.status));
  const allReported = calls.length > 0 && calls.length === known.length;
  return { availability: known.length === 0 ? 'NOT_AVAILABLE' : allReported && allTerminal ? 'AVAILABLE' : 'PARTIAL',
    modelCalls: calls.length, reportedCalls: known.length, unavailableCalls: calls.length - known.length,
    knownSubtotal: subtotal, completeTotal: allReported && allTerminal ? subtotal : null,
    ...(known.length && !subtotal ? { reason: 'Provider counter sum exceeds safe integer range' }
      : known.length === 0 ? { reason: 'No observed provider-reported model usage; unavailable is not zero' }
        : !allReported || !allTerminal ? { reason: 'Observed subtotal only; some model waits lack usage or investigation is nonterminal' } : {}) };
}

export function summarizeMeasurements(records: InvestigationMeasurement[]) {
  const terminal = records.filter(record => ['COMPLETED', 'FAILED', 'REJECTED'].includes(record.status));
  const models = records.flatMap(record => record.modelCalls), tools = records.flatMap(record => record.toolAttempts);
  const outcomes = (items: { status: string }[], names: string[]) => Object.fromEntries(names.map(name => [name, items.filter(item => item.status === name).length]));
  return {
    investigations: { observed: records.length, terminal: terminal.length, nonterminal: records.length - terminal.length,
      outcomes: outcomes(records, ['RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'REJECTED']) },
    investigationElapsed: durationStatistics(terminal.map(record => record.duration)),
    modelCalls: { count: models.length, outcomes: outcomes(models, ['PENDING', 'SUCCEEDED', 'FAILED', 'TIMEOUT']),
      durations: durationStatistics(models.map(call => call.duration)) },
    toolAttempts: { count: tools.length,
      logicalCalls: records.reduce((sum, record) => sum + new Set(record.toolAttempts.map(attempt => attempt.callId)).size, 0),
      retries: tools.filter(attempt => attempt.attempt > 1).length,
      outcomes: outcomes(tools, ['PENDING', 'SUCCEEDED', 'FAILED', 'TIMEOUT']),
      durations: durationStatistics(tools.map(attempt => attempt.duration)) },
    approvalSuspensions: durationStatistics(records.flatMap(record => record.approvalWaits.map(wait => wait.duration))),
    usage: usageSummary(records),
    denominators: 'Investigation durations include measured terminal outcomes of every status; each call/attempt contributes its own wait. Means exclude pending/unavailable durations. No-sample statistics are null.',
  };
}
