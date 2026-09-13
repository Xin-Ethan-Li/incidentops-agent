import type { IncidentCase } from '../domain/incident.js';

// Fixed synthetic data; not production observations.
export const incidents: IncidentCase[] = [
  {
    "id": "INC-001",
    "title": "Checkout error rate elevated",
    "service": "checkout-api",
    "description": "Checkout requests intermittently return 5xx responses. Investigate the increase during the supplied window.",
    "timeWindow": {
      "start": "2026-09-01T10:00:00.000Z",
      "end": "2026-09-01T10:10:00.000Z"
    }
  },
  {
    "id": "INC-002",
    "title": "Payment requests slowing down",
    "service": "payment-api",
    "description": "Payment requests are taking longer and some exceed the request deadline.",
    "timeWindow": {
      "start": "2026-09-01T10:00:00.000Z",
      "end": "2026-09-01T10:10:00.000Z"
    }
  },
  {
    "id": "INC-003",
    "title": "Orders waiting for processing",
    "service": "order-worker",
    "description": "Pending order count is rising while completed orders have stopped increasing.",
    "timeWindow": {
      "start": "2026-09-01T10:00:00.000Z",
      "end": "2026-09-01T10:10:00.000Z"
    }
  },
  {
    "id": "INC-004",
    "title": "Inventory requests timing out",
    "service": "inventory-api",
    "description": "Inventory lookups show higher latency and intermittent 503 responses.",
    "timeWindow": {
      "start": "2026-09-01T10:00:00.000Z",
      "end": "2026-09-01T10:10:00.000Z"
    }
  },
  {
    "id": "INC-005",
    "title": "Notification delivery failures increasing",
    "service": "notification-api",
    "description": "Notification requests began failing shortly after a release. Determine which evidence explains the change.",
    "timeWindow": {
      "start": "2026-09-01T10:00:00.000Z",
      "end": "2026-09-01T10:10:00.000Z"
    }
  }
];
