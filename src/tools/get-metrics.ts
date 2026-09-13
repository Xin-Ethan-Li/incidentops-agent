import type { MetricSeries } from '../domain/metric-series.js';
import { metrics } from '../fixtures/index.js';
import { getServiceInfo } from './get-service-info.js';
import { ToolError } from './tool-error.js';
import { validateService, validateWindow, type TimeWindow } from './validate-input.js';

export interface GetMetricsInput {
  service: string;
  timeWindow: TimeWindow;
  metricNames?: string[];
}

/** get_metrics: series sorted by name, points by time; omit series without matching points. */
export function getMetrics(input: GetMetricsInput): MetricSeries[] {
  validateService(input?.service);
  const { start, end } = validateWindow(input.timeWindow);
  if (input.metricNames !== undefined && (!Array.isArray(input.metricNames)
    || !Array.from(input.metricNames).every(name => typeof name === 'string' && name.trim().length > 0))) {
    throw new ToolError('INVALID_INPUT', 'metricNames must be an array of nonempty strings');
  }
  getServiceInfo({ service: input.service });
  return metrics.filter(metric => metric.service === input.service
    && (input.metricNames === undefined || input.metricNames.includes(metric.name)))
    .map(metric => ({ ...metric, points: metric.points
      .filter(point => Date.parse(point.timestamp) >= start && Date.parse(point.timestamp) <= end)
      .map(point => ({ ...point }))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)) }))
    .filter(metric => metric.points.length > 0)
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
