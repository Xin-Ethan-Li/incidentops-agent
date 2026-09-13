// Test/evaluation answers only. Import explicitly; never expose through the fixture index.
export interface IncidentGroundTruth {
  incidentId: string;
  expectedCause: string;
  relevantLogIds: string[];
  relevantMetricNames: string[];
  relevantRunbookIds: string[];
}

export const groundTruth: IncidentGroundTruth[] = [
  {
    "incidentId": "INC-001",
    "expectedCause": "Redis dependency connection timeouts are causing checkout failures.",
    "relevantLogIds": [
      "LOG-001-02",
      "LOG-001-03"
    ],
    "relevantMetricNames": [
      "http_5xx_rate",
      "redis_connection_timeouts"
    ],
    "relevantRunbookIds": [
      "RB-001"
    ]
  },
  {
    "incidentId": "INC-002",
    "expectedCause": "The downstream payment provider is degraded, increasing authorization latency and timeouts.",
    "relevantLogIds": [
      "LOG-002-02",
      "LOG-002-03"
    ],
    "relevantMetricNames": [
      "request_latency_p95",
      "provider_timeout_rate"
    ],
    "relevantRunbookIds": [
      "RB-002"
    ]
  },
  {
    "incidentId": "INC-003",
    "expectedCause": "The queue consumer loop exited after a payload parsing exception while the worker process stayed alive.",
    "relevantLogIds": [
      "LOG-003-02",
      "LOG-003-03"
    ],
    "relevantMetricNames": [
      "queue_depth",
      "processing_rate",
      "enqueue_rate"
    ],
    "relevantRunbookIds": [
      "RB-003"
    ]
  },
  {
    "incidentId": "INC-004",
    "expectedCause": "The database connection pool is exhausted by long-held connections, leaving requests waiting for acquisition.",
    "relevantLogIds": [
      "LOG-004-02",
      "LOG-004-03"
    ],
    "relevantMetricNames": [
      "db_pool_connections_in_use",
      "db_pool_capacity",
      "db_pool_waiting_requests",
      "request_latency_p95"
    ],
    "relevantRunbookIds": [
      "RB-004"
    ]
  },
  {
    "incidentId": "INC-005",
    "expectedCause": "Deployment 1.3.0 changed the notification provider path to unsupported /v2/send, causing delivery failures.",
    "relevantLogIds": [
      "LOG-005-01",
      "LOG-005-02",
      "LOG-005-03",
      "LOG-005-04"
    ],
    "relevantMetricNames": [
      "delivery_failure_rate",
      "provider_http_404_rate"
    ],
    "relevantRunbookIds": [
      "RB-005"
    ]
  }
];
