import { z } from 'zod/v4';

// Shared shape check only: this module imports no evaluator cases or answer data.
const nonblank = z.string().refine(value => value.trim().length > 0);
export const evidenceSchema = z.strictObject({
  service: z.strictObject({ name: nonblank, version: nonblank, dependencies: z.array(nonblank), lastDeploymentAt: z.iso.datetime() }),
  logs: z.array(z.strictObject({ id: nonblank, service: nonblank, timestamp: z.iso.datetime(),
    level: z.enum(['info', 'warn', 'error']), message: nonblank })),
  metrics: z.array(z.strictObject({ service: nonblank, name: nonblank, unit: nonblank,
    points: z.array(z.strictObject({ timestamp: z.iso.datetime(), value: z.number().finite() })).min(1) })),
  runbooks: z.array(z.strictObject({ id: nonblank, title: nonblank, tags: z.array(nonblank), content: nonblank })).min(1),
});
