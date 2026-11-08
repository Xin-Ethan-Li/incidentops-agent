import { metrics } from '../fixtures/metrics.js';
import { services } from '../fixtures/services.js';

const metricServices = new Set(metrics.map(series => series.service));
const queryableMetricServices = services.filter(service => metricServices.has(service.name)).map(service => service.name);

export const READ_ONLY_METRICS_GUIDANCE = `Use a registered service name. Services with metrics: ${queryableMetricServices.join(', ')}. `
  + 'A dependency listed by get_service_info is not automatically a metric source. '
  + 'If a dependency has no metrics of its own, use evidence from the service that depends on it.';

const timeWindow = {
  type: 'object', additionalProperties: false,
  properties: { start: { type: 'string', description: 'ISO date-time with timezone, inclusive.' }, end: { type: 'string', description: 'ISO date-time with timezone, inclusive.' } },
  required: ['start', 'end'],
};

/** Descriptions/schemas only. The executor independently enforces the allowed set. */
export const TOOL_DEFINITIONS = [
  {
    name: 'search_logs', description: 'Read service logs in a time window, optionally filtered by level and message substring.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { service: { type: 'string' }, timeWindow,
        levels: { type: ['array', 'null'], items: { type: 'string', enum: ['info', 'warn', 'error'] } },
        contains: { type: ['string', 'null'] } },
      required: ['service', 'timeWindow', 'levels', 'contains'],
    },
  },
  {
    name: 'get_metrics', description: 'Read service metric points in a time window, optionally selecting metric names.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { service: { type: 'string' }, timeWindow, metricNames: { type: ['array', 'null'], items: { type: 'string' } } },
      required: ['service', 'timeWindow', 'metricNames'],
    },
  },
  {
    name: 'get_service_info', description: 'Read existing service version, dependencies and deployment timestamp.',
    parameters: { type: 'object', additionalProperties: false, properties: { service: { type: 'string' } }, required: ['service'] },
  },
  {
    name: 'search_runbook', description: 'Retrieve operational runbooks relevant to a natural-language query. Scores indicate retrieval relevance, not diagnosis confidence.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string' }, limit: { type: ['integer', 'null'], minimum: 1 } },
      required: ['query', 'limit'],
    },
  },
  {
    name: 'restart_service', description: 'Propose a simulated service restart. Requires explicit human approval enforced by the application; the model cannot approve it. No real infrastructure is changed.',
    parameters: { type: 'object', additionalProperties: false, properties: { service: { type: 'string' } }, required: ['service'] },
  },
];
