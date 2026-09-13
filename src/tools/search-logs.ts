import type { LogEntry } from '../domain/log-entry.js';
import { logs } from '../fixtures/index.js';
import { getServiceInfo } from './get-service-info.js';
import { ToolError } from './tool-error.js';
import { validateService, validateWindow, type TimeWindow } from './validate-input.js';

export interface SearchLogsInput {
  service: string;
  timeWindow: TimeWindow;
  levels?: LogEntry['level'][];
  contains?: string;
}

/** search_logs: inclusive window, empty levels selects nothing; empty contains matches all. */
export function searchLogs(input: SearchLogsInput): LogEntry[] {
  validateService(input?.service);
  const { start, end } = validateWindow(input.timeWindow);
  if (input.levels !== undefined && (!Array.isArray(input.levels)
    || !Array.from(input.levels).every(level => ['info', 'warn', 'error'].includes(level)))) {
    throw new ToolError('INVALID_INPUT', 'levels must contain only info, warn, or error');
  }
  if (input.contains !== undefined && typeof input.contains !== 'string') {
    throw new ToolError('INVALID_INPUT', 'contains must be a string');
  }
  getServiceInfo({ service: input.service });
  const text = input.contains?.toLowerCase();
  return logs.filter(log => log.service === input.service
    && Date.parse(log.timestamp) >= start && Date.parse(log.timestamp) <= end
    && (input.levels === undefined || input.levels.includes(log.level))
    && (text === undefined || log.message.toLowerCase().includes(text)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(log => ({ ...log }));
}
