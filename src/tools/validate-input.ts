import type { IncidentCase } from '../domain/incident.js';
import { ToolError } from './tool-error.js';

export type TimeWindow = IncidentCase['timeWindow'];

export function validateService(service: unknown): asserts service is string {
  if (typeof service !== 'string' || !service.trim()) {
    throw new ToolError('INVALID_INPUT', 'service must be a nonempty string');
  }
}

// Accept full ISO date-times with seconds, optional 1–3 fractional digits,
// and an explicit UTC Z or numeric offset. Reject normalized invalid dates.
function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') {
    throw new ToolError('INVALID_INPUT', 'timestamps must be ISO date-time strings');
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const time = Date.parse(value);
  const day = match ? Date.parse(match[1] + 'T00:00:00.000Z') : NaN;
  if (!match || !Number.isFinite(time) || !Number.isFinite(day)
    || new Date(day).toISOString().slice(0, 10) !== match[1]
    || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
    || (match[5] !== 'Z' && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4)) > 59))) {
    throw new ToolError('INVALID_INPUT', 'timestamps must be valid ISO date-times with a timezone');
  }
  return time;
}

export function validateWindow(window: TimeWindow): { start: number; end: number } {
  const start = parseTimestamp(window?.start);
  const end = parseTimestamp(window?.end);
  if (start > end) throw new ToolError('INVALID_INPUT', 'timeWindow.start must not exceed end');
  return { start, end };
}
