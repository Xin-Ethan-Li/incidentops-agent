import type { RunbookDocument } from '../domain/runbook.js';

// Fixed synthetic data; not production observations.
export const runbooks: RunbookDocument[] = [
  {
    "id": "RB-001",
    "title": "Investigating cache connectivity and checkout errors",
    "tags": [
      "checkout-api",
      "redis-cache",
      "timeouts"
    ],
    "content": "Compare checkout errors with cache connection timeouts and check the service dependency list. Distinguish cache connection failures from payment failures using downstream response logs. Check whether a recent deployment changed cache settings. If connectivity is impaired, collect evidence for the dependency owner before proposing changes."
  },
  {
    "id": "RB-002",
    "title": "Investigating payment latency",
    "tags": [
      "payment-api",
      "payment-provider",
      "latency"
    ],
    "content": "Separate local validation duration from outbound authorization duration. Compare provider timeout rates and response codes with request latency. A slow or failing provider can affect payments even when local validation remains fast. Check provider status and deployment timing before recommending an operational action."
  },
  {
    "id": "RB-003",
    "title": "Investigating an order processing backlog",
    "tags": [
      "order-worker",
      "orders-queue",
      "backlog"
    ],
    "content": "Compare queue depth, enqueue rate, and processing rate. When arrivals continue but acknowledgements stop, inspect consumer-loop errors and verify whether the process and queue connection are still alive. Check database connectivity to distinguish a blocked dependency from an exited processing loop. Preserve the offending payload for review before proposing a worker restart."
  },
  {
    "id": "RB-004",
    "title": "Investigating database connection acquisition delays",
    "tags": [
      "inventory-api",
      "inventory-db",
      "connection-pool"
    ],
    "content": "Compare in-use connections with pool capacity and waiting requests. Inspect connection acquisition deadlines and long-held connections. Connection acquisition latency is different from query execution latency. Check transaction lifetimes and connection release paths before proposing capacity changes; pool saturation alone does not prove a connection leak."
  },
  {
    "id": "RB-005",
    "title": "Investigating notification failures after a release",
    "tags": [
      "notification-api",
      "notification-provider",
      "deployment"
    ],
    "content": "Align deployment time with the change in delivery failures. Compare effective provider paths before and after release. The supported delivery endpoint is /v1/send; a healthy provider can still return 404 for an unsupported path. Inspect release configuration differences and request approval before proposing rollback or configuration changes."
  }
];
