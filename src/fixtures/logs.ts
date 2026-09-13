import type { LogEntry } from '../domain/log-entry.js';

// Fixed synthetic data; not production observations.
export const logs: LogEntry[] = [
  {
    "id": "LOG-001-01",
    "timestamp": "2026-09-01T10:00:00.000Z",
    "service": "checkout-api",
    "level": "info",
    "message": "Checkout completed; cache read took 4 ms."
  },
  {
    "id": "LOG-001-02",
    "timestamp": "2026-09-01T10:05:00.000Z",
    "service": "checkout-api",
    "level": "error",
    "message": "Connection to redis-cache exceeded 1000 ms; checkout returned 503."
  },
  {
    "id": "LOG-001-03",
    "timestamp": "2026-09-01T10:10:00.000Z",
    "service": "checkout-api",
    "level": "warn",
    "message": "Cache connection deadline exceeded; payment-api health probe returned 200 in 35 ms."
  },
  {
    "id": "LOG-002-01",
    "timestamp": "2026-09-01T10:00:00.000Z",
    "service": "payment-api",
    "level": "info",
    "message": "payment-provider authorization returned 200 in 180 ms."
  },
  {
    "id": "LOG-002-02",
    "timestamp": "2026-09-01T10:05:00.000Z",
    "service": "payment-api",
    "level": "warn",
    "message": "payment-provider authorization exceeded 3000 ms; local validation completed in 4 ms."
  },
  {
    "id": "LOG-002-03",
    "timestamp": "2026-09-01T10:10:00.000Z",
    "service": "payment-api",
    "level": "error",
    "message": "payment-provider returned HTTP 504 after 3000 ms."
  },
  {
    "id": "LOG-003-01",
    "timestamp": "2026-09-01T10:00:00.000Z",
    "service": "order-worker",
    "level": "info",
    "message": "orders-queue consumer active; 120 orders acknowledged in the last minute."
  },
  {
    "id": "LOG-003-02",
    "timestamp": "2026-09-01T10:05:00.000Z",
    "service": "order-worker",
    "level": "error",
    "message": "Consumer loop exited after an unhandled payload parsing exception; process remains alive."
  },
  {
    "id": "LOG-003-03",
    "timestamp": "2026-09-01T10:10:00.000Z",
    "service": "order-worker",
    "level": "warn",
    "message": "No acknowledgements in the last five minutes; orders-queue connection open; orders-db probe completed in 8 ms."
  },
  {
    "id": "LOG-004-01",
    "timestamp": "2026-09-01T10:00:00.000Z",
    "service": "inventory-api",
    "level": "info",
    "message": "inventory-db connection acquired in 2 ms; 6 of 20 pool connections in use."
  },
  {
    "id": "LOG-004-02",
    "timestamp": "2026-09-01T10:05:00.000Z",
    "service": "inventory-api",
    "level": "warn",
    "message": "inventory-db pool has 20 of 20 connections in use; oldest checked-out connection age is 290 s."
  },
  {
    "id": "LOG-004-03",
    "timestamp": "2026-09-01T10:10:00.000Z",
    "service": "inventory-api",
    "level": "error",
    "message": "Connection acquisition exceeded 2000 ms; 38 requests waiting; inventory lookup returned 503."
  },
  {
    "id": "LOG-005-01",
    "timestamp": "2026-09-01T10:00:00.000Z",
    "service": "notification-api",
    "level": "info",
    "message": "notification-provider accepted delivery at /v1/send with HTTP 202."
  },
  {
    "id": "LOG-005-02",
    "timestamp": "2026-09-01T10:04:00.000Z",
    "service": "notification-api",
    "level": "info",
    "message": "Version 1.3.0 started; effective notification-provider path is /v2/send."
  },
  {
    "id": "LOG-005-03",
    "timestamp": "2026-09-01T10:05:00.000Z",
    "service": "notification-api",
    "level": "error",
    "message": "notification-provider returned HTTP 404 for /v2/send in 24 ms."
  },
  {
    "id": "LOG-005-04",
    "timestamp": "2026-09-01T10:10:00.000Z",
    "service": "notification-api",
    "level": "error",
    "message": "Delivery request to /v2/send returned HTTP 404; provider health probe returned 200."
  }
];
