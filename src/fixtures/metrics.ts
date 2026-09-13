import type { MetricSeries } from '../domain/metric-series.js';

// Fixed synthetic data; not production observations.
export const metrics: MetricSeries[] = [
  {
    "service": "checkout-api",
    "name": "http_5xx_rate",
    "unit": "percent",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 0.2
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 18
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 24
      }
    ]
  },
  {
    "service": "checkout-api",
    "name": "redis_connection_timeouts",
    "unit": "count/min",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 0
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 45
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 61
      }
    ]
  },
  {
    "service": "payment-api",
    "name": "request_latency_p95",
    "unit": "ms",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 240
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 3100
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 3200
      }
    ]
  },
  {
    "service": "payment-api",
    "name": "provider_timeout_rate",
    "unit": "percent",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 0
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 32
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 40
      }
    ]
  },
  {
    "service": "order-worker",
    "name": "queue_depth",
    "unit": "messages",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 20
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 20
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 620
      }
    ]
  },
  {
    "service": "order-worker",
    "name": "processing_rate",
    "unit": "messages/min",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 120
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 0
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 0
      }
    ]
  },
  {
    "service": "order-worker",
    "name": "enqueue_rate",
    "unit": "messages/min",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 120
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 120
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 120
      }
    ]
  },
  {
    "service": "inventory-api",
    "name": "db_pool_connections_in_use",
    "unit": "connections",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 6
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 20
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 20
      }
    ]
  },
  {
    "service": "inventory-api",
    "name": "db_pool_capacity",
    "unit": "connections",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 20
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 20
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 20
      }
    ]
  },
  {
    "service": "inventory-api",
    "name": "db_pool_waiting_requests",
    "unit": "requests",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 0
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 15
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 38
      }
    ]
  },
  {
    "service": "inventory-api",
    "name": "request_latency_p95",
    "unit": "ms",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 55
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 2050
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 2200
      }
    ]
  },
  {
    "service": "notification-api",
    "name": "delivery_failure_rate",
    "unit": "percent",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 0
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 100
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 100
      }
    ]
  },
  {
    "service": "notification-api",
    "name": "provider_http_404_rate",
    "unit": "percent",
    "points": [
      {
        "timestamp": "2026-09-01T10:00:00.000Z",
        "value": 0
      },
      {
        "timestamp": "2026-09-01T10:05:00.000Z",
        "value": 100
      },
      {
        "timestamp": "2026-09-01T10:10:00.000Z",
        "value": 100
      }
    ]
  }
];
