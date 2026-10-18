import type { Diagnosis } from './diagnosis.js';

export type InvestigationStatus = 'STARTED' | 'INVESTIGATING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'REJECTED';

export interface PendingApproval {
  readonly investigationId: string;
  readonly approvalId: string;
  readonly callId: string;
  readonly toolName: 'restart_service';
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ToolExecutionRecord {
  callId: string;
  toolName: string;
  status: 'SUCCEEDED' | 'FAILED';
}

/** In-memory execution history, not persistence, telemetry or correctness evaluation. */
export interface InvestigationRecord {
  investigationId: string;
  incidentId: string;
  status: InvestigationStatus;
  toolExecutions: ToolExecutionRecord[];
  diagnosis?: Diagnosis;
  failure?: string;
  pendingApproval?: PendingApproval;
  rejection?: string;
}
