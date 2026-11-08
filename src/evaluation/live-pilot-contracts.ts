import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { assertDiagnosis } from '../domain/diagnosis.js';
import { runbooks } from '../fixtures/index.js';
import { LIVE_LIMITS } from '../live-investigation.js';

export const PILOT_VERSION = 'incidentops-live-pilot-v1' as const;
export const PILOT_SOURCE = 'LIVE_OPENAI_PILOT' as const;
export const PILOT_CASES = ['INC-001', 'INC-002', 'INC-003', 'INC-004', 'INC-005'] as const;
export type PilotCase = typeof PILOT_CASES[number];
export const PILOT_DIRECTORY = '.project-control/live-pilots';
export const EMBEDDING_MODEL = 'text-embedding-3-small' as const;

const positive = z.number().int().positive();
const nonnegative = z.number().int().nonnegative();
const text = z.string().min(1);
const runId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const caseId = z.enum(PILOT_CASES);
const sourceUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});

/** Operator-approved full per-request token allowances and USD rates, rounded up. */
export const pilotPricingSchema = z.strictObject({
  model: modelId, embeddingModel: z.literal(EMBEDDING_MODEL),
  asOf: z.iso.date(), source: sourceUrl,
  inputMicrousdPerMillion: positive, outputMicrousdPerMillion: positive, embeddingMicrousdPerMillion: positive,
  responseInputTokensPerCall: positive, embeddingTokensPerInput: positive,
});
export type PilotPricing = z.infer<typeof pilotPricingSchema>;

export function estimateCaseMicrousd(pricing: PilotPricing): number {
  const responses = BigInt(LIVE_LIMITS.maxTurns)
    * (BigInt(pricing.responseInputTokensPerCall) * BigInt(pricing.inputMicrousdPerMillion)
      + BigInt(LIVE_LIMITS.maxOutputTokens) * BigInt(pricing.outputMicrousdPerMillion));
  // Fresh MCP child per case. Reserve for a full corpus plus a query for every tool attempt.
  const embeddings = BigInt(runbooks.length + LIVE_LIMITS.maxToolCalls)
    * BigInt(pricing.embeddingTokensPerInput) * BigInt(pricing.embeddingMicrousdPerMillion);
  const rounded = (responses + embeddings + 999_999n) / 1_000_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Case cost estimate exceeds the supported range');
  return Number(rounded);
}

export const pilotManifestSchema = z.strictObject({
  schemaVersion: z.literal(PILOT_VERSION), runSource: z.literal(PILOT_SOURCE),
  runId, commit: z.string().regex(/^[a-f0-9]{40}$/), createdAt: timestamp,
  configuredModel: modelId, providerModelVersion: z.null(),
  budgetMicrousd: positive, deadlineMs: positive.max(2_147_483_647),
  reservedMicrousdPerCase: positive, pricing: pilotPricingSchema,
  liveLimits: z.strictObject({
    maxTurns: z.literal(LIVE_LIMITS.maxTurns), maxToolCalls: z.literal(LIVE_LIMITS.maxToolCalls),
    modelTimeoutMs: z.literal(LIVE_LIMITS.modelTimeoutMs), toolTimeoutMs: z.literal(LIVE_LIMITS.toolTimeoutMs),
    requestTimeoutMs: z.literal(LIVE_LIMITS.requestTimeoutMs), connectTimeoutMs: z.literal(LIVE_LIMITS.connectTimeoutMs),
    maxOutputTokens: z.literal(LIVE_LIMITS.maxOutputTokens),
  }),
  cases: z.array(caseId).length(PILOT_CASES.length).refine(cases => cases.every((id, index) => id === PILOT_CASES[index])),
}).refine(value => value.configuredModel === value.pricing.model
  && value.reservedMicrousdPerCase === estimateCaseMicrousd(value.pricing)
  && value.budgetMicrousd >= value.reservedMicrousdPerCase);
export type PilotManifest = z.infer<typeof pilotManifestSchema>;

export const pilotStartSchema = z.strictObject({ runId, caseId, startedAt: timestamp, reservedMicrousd: positive });
export type PilotStart = z.infer<typeof pilotStartSchema>;
const logicalCall = z.strictObject({ callId: text, toolName: text, attemptCount: nonnegative });
const call = z.strictObject({ callId: text, name: text, arguments: z.record(z.string(), z.json()) });
const output = z.strictObject({ callId: text, output: z.string() });
const usage = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('AVAILABLE'), source: z.literal('OPENAI_RESPONSE'),
    counts: z.strictObject({ inputTokens: nonnegative, outputTokens: nonnegative, totalTokens: nonnegative })
      .refine(value => value.inputTokens + value.outputTokens === value.totalTokens) }),
  z.strictObject({ status: z.literal('NOT_AVAILABLE'),
    reason: z.enum(['NOT_REPORTED', 'INVALID_PROVIDER_USAGE', 'CALLER_TIMEOUT', 'PENDING']) }),
]);
const waitStatus = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'TIMEOUT']);
const cleanup = z.strictObject({
  mcpClose: z.enum(['NOT_CREATED', 'SUCCEEDED', 'FAILED']),
  childExit: z.enum(['NOT_OBSERVED', 'OBSERVED']),
  tracingShutdown: z.enum(['NOT_CREATED', 'SUCCEEDED', 'FAILED']),
  errors: z.array(z.enum(['MCP_CLOSE_FAILED', 'TRACE_FLUSH_FAILED', 'TRACE_SNAPSHOT_FAILED', 'TRACE_SHUTDOWN_FAILED'])),
});

const pilotEvidenceSchema = z.strictObject({
  manifest: pilotManifestSchema,
  start: pilotStartSchema, finishedAt: timestamp,
  status: z.enum(['NOT_STARTED', 'STARTED', 'INVESTIGATING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'REJECTED']),
  failure: z.enum(['INTERRUPTED', 'TIMEOUT', 'INITIALIZATION_FAILED', 'INVESTIGATION_FAILED', 'NO_SESSION_REPORT']).nullable(),
  cancellation: z.enum(['NONE', 'DEADLINE_REQUESTED', 'OPERATOR_REQUESTED']),
  diagnosis: z.record(z.string(), z.json()).nullable(),
  observationComplete: z.boolean(),
  requests: z.array(call),
  logicalCalls: z.array(logicalCall),
  attempts: z.array(z.strictObject({
    callId: text, toolName: text, call: call.nullable(),
    status: z.enum(['SUCCEEDED', 'FAILED']), waitStatus: waitStatus.nullable(), output: z.string().nullable(),
  })).max(LIVE_LIMITS.maxToolCalls),
  deliveredOutputs: z.array(output),
  modelCalls: z.array(z.strictObject({ sequence: positive, status: waitStatus, usage })).max(LIVE_LIMITS.maxTurns),
  embeddingUsage: z.literal('NOT_OBSERVED'),
  cleanup: cleanup.nullable(),
  traceComplete: z.boolean(),
  evidenceFingerprint: fingerprint,
});
type EvidenceShape = z.infer<typeof pilotEvidenceSchema>;
export type PilotEvidence = EvidenceShape;

export function pilotLogicalCalls(requests: Pick<PilotEvidence['requests'][number], 'callId' | 'name'>[],
  attempts: Pick<PilotEvidence['attempts'][number], 'callId' | 'toolName'>[]) {
  const calls = new Map<string, { callId: string; toolName: string; attemptCount: number }>();
  for (const request of requests) {
    if (!calls.has(request.callId)) calls.set(request.callId, { callId: request.callId, toolName: request.name, attemptCount: 0 });
  }
  for (const attempt of attempts) {
    const existing = calls.get(attempt.callId);
    if (existing) existing.attemptCount++;
    else calls.set(attempt.callId, { callId: attempt.callId, toolName: attempt.toolName, attemptCount: 1 });
  }
  return [...calls.values()];
}

export function pilotFingerprint(value: unknown): string {
  const canonical = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(canonical);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, canonical(item)]));
    }
    return node;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function freezePilotEvidence(data: object): PilotEvidence {
  return parsePilotEvidence({ ...data, evidenceFingerprint: pilotFingerprint(data) });
}

export function parsePilotEvidence(input: unknown): PilotEvidence {
  const result = pilotEvidenceSchema.safeParse(input);
  if (!result.success) throw new TypeError('Invalid pilot evidence schema');
  const evidence = result.data;
  const { evidenceFingerprint, ...data } = evidence;
  if (pilotFingerprint(data) !== evidenceFingerprint || data.start.runId !== data.manifest.runId
    || data.start.reservedMicrousd !== data.manifest.reservedMicrousdPerCase
    || Date.parse(data.start.startedAt) < Date.parse(data.manifest.createdAt) || Date.parse(data.finishedAt) < Date.parse(data.start.startedAt)
    || data.modelCalls.some((item, index) => item.sequence !== index + 1)
    || pilotFingerprint(data.logicalCalls) !== pilotFingerprint(pilotLogicalCalls(data.requests, data.attempts))) {
    throw new TypeError('Pilot evidence binding mismatch');
  }
  if (evidence.status === 'COMPLETED') assertDiagnosis(evidence.diagnosis);
  else if (evidence.diagnosis !== null) throw new TypeError('Non-completed pilot case contains a diagnosis');
  const proposalIds = new Set(data.requests.map(request => request.callId));
  const successes = new Map<string, string>();
  const attemptCounts = new Map<string, number>();
  let previous: typeof data.attempts[number] | undefined;
  if (data.status === 'COMPLETED' && proposalIds.size !== data.requests.length) throw new TypeError('Duplicate completed pilot tool proposal');
  for (const attempt of data.attempts) {
    const count = (attemptCounts.get(attempt.callId) ?? 0) + 1;
    attemptCounts.set(attempt.callId, count);
    if (count > 2 || count === 2 && (previous?.callId !== attempt.callId || previous.status !== 'FAILED'
      || previous.toolName !== attempt.toolName)) throw new TypeError('Invalid pilot retry history');
    previous = attempt;
    if (attempt.call && (attempt.call.callId !== attempt.callId || attempt.call.name !== attempt.toolName
      || !data.requests.some(proposal => pilotFingerprint(attempt.call) === pilotFingerprint(proposal)))) {
      throw new TypeError('Unbound pilot tool attempt');
    }
    if (attempt.status === 'FAILED' && attempt.output !== null) throw new TypeError('Failed tool attempt contains output');
    if (data.observationComplete && (!attempt.call || !attempt.waitStatus || attempt.waitStatus === 'PENDING'
      || (attempt.status === 'SUCCEEDED') !== (attempt.waitStatus === 'SUCCEEDED')
      || attempt.status === 'SUCCEEDED' && attempt.output === null)) throw new TypeError('Incomplete pilot tool history');
    if (attempt.status === 'SUCCEEDED' && attempt.output !== null) successes.set(attempt.callId, attempt.output);
  }
  const delivered = new Set<string>();
  for (const item of data.deliveredOutputs) {
    if (delivered.has(item.callId) || successes.get(item.callId) !== item.output) throw new TypeError('Unbound pilot continuation output');
    delivered.add(item.callId);
  }
  if (data.observationComplete && data.status === 'COMPLETED'
    && [...proposalIds].some(id => !delivered.has(id))) throw new TypeError('Completed pilot case has undelivered proposals');
  return evidence;
}
