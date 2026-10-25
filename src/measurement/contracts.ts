export type Duration = { status: 'MEASURED'; milliseconds: number }
  | { status: 'PENDING' }
  | { status: 'NOT_AVAILABLE'; reason: string };

export interface TokenCounts { inputTokens: number; outputTokens: number; totalTokens: number }
export type ModelUsage = { status: 'AVAILABLE'; source: 'OPENAI_RESPONSE'; counts: TokenCounts }
  | { status: 'NOT_AVAILABLE'; reason: 'NOT_REPORTED' | 'INVALID_PROVIDER_USAGE' | 'CALLER_TIMEOUT' | 'PENDING' };
export type WaitStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'TIMEOUT';
export interface ModelCallMeasurement {
  sequence: number;
  requestKind: 'initial' | 'continuation';
  status: WaitStatus;
  duration: Duration;
  usage: ModelUsage;
}
export interface ToolAttemptMeasurement {
  sequence: number;
  callId: string;
  toolName: string;
  attempt: number;
  status: WaitStatus;
  duration: Duration;
}
export interface InvestigationMeasurement {
  investigationId: string;
  incidentId: string;
  status: 'RUNNING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'REJECTED';
  unit: 'milliseconds';
  boundary: 'workflow-start-to-terminal-return-including-backoff-and-approval-wait';
  duration: Duration;
  approvalWaits: { duration: Duration }[];
  modelCalls: ModelCallMeasurement[];
  toolAttempts: ToolAttemptMeasurement[];
}
export interface DurationStatistics {
  unit: 'milliseconds';
  observations: number;
  measured: number;
  pending: number;
  notAvailable: number;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
}
export interface UsageSummary {
  availability: 'AVAILABLE' | 'PARTIAL' | 'NOT_AVAILABLE';
  modelCalls: number;
  reportedCalls: number;
  unavailableCalls: number;
  /** Sum of observed provider metadata only, never a replacement for missing calls. */
  knownSubtotal: TokenCounts | null;
  /** Only all-reported, terminal investigations support a complete observed-call total. */
  completeTotal: TokenCounts | null;
  reason?: string;
}
