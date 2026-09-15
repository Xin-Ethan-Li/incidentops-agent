import type { Diagnosis } from './diagnosis.js';

export type InvestigationStatus = 'STARTED' | 'INVESTIGATING' | 'COMPLETED' | 'FAILED';

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
}
