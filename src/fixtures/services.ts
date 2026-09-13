import type { ServiceInfo } from '../domain/service-info.js';

// Fixed synthetic data; not production observations.
export const services: ServiceInfo[] = [
  {
    "name": "checkout-api",
    "version": "1.4.2",
    "dependencies": [
      "redis-cache",
      "payment-api"
    ],
    "lastDeploymentAt": "2026-08-30T09:00:00.000Z"
  },
  {
    "name": "payment-api",
    "version": "2.1.0",
    "dependencies": [
      "payment-provider"
    ],
    "lastDeploymentAt": "2026-08-29T12:00:00.000Z"
  },
  {
    "name": "order-worker",
    "version": "1.8.1",
    "dependencies": [
      "orders-queue",
      "orders-db"
    ],
    "lastDeploymentAt": "2026-08-31T08:00:00.000Z"
  },
  {
    "name": "inventory-api",
    "version": "3.0.2",
    "dependencies": [
      "inventory-db"
    ],
    "lastDeploymentAt": "2026-08-30T14:00:00.000Z"
  },
  {
    "name": "notification-api",
    "version": "1.3.0",
    "dependencies": [
      "notification-provider"
    ],
    "lastDeploymentAt": "2026-09-01T10:04:00.000Z"
  }
];
