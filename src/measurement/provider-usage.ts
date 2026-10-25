import type { ModelUsage } from './contracts.js';

// Preserve the accepted result/error JSON shapes and avoid retaining model results.
const usageByOutcome = new WeakMap<object, ModelUsage>();

export function providerUsage(value: unknown): ModelUsage {
  if (value == null) return { status: 'NOT_AVAILABLE', reason: 'NOT_REPORTED' };
  const usage = value as { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
  const counts = [usage.input_tokens, usage.output_tokens, usage.total_tokens];
  if (!counts.every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
    || (usage.input_tokens as number) + (usage.output_tokens as number) !== usage.total_tokens) {
    return { status: 'NOT_AVAILABLE', reason: 'INVALID_PROVIDER_USAGE' };
  }
  return { status: 'AVAILABLE', source: 'OPENAI_RESPONSE', counts: {
    inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number, totalTokens: usage.total_tokens as number,
  } };
}

/** Called only with metadata received by the OpenAI adapter; no estimates or defaults. */
export function associateProviderUsage(outcome: unknown, usage: ModelUsage): void {
  if (outcome !== null && typeof outcome === 'object') usageByOutcome.set(outcome, structuredClone(usage));
}

export function usageForOutcome(outcome: unknown): ModelUsage {
  return structuredClone(outcome !== null && typeof outcome === 'object' ? usageByOutcome.get(outcome)
    ?? { status: 'NOT_AVAILABLE', reason: 'NOT_REPORTED' } : { status: 'NOT_AVAILABLE', reason: 'NOT_REPORTED' });
}
