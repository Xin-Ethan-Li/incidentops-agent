import { performance } from 'node:perf_hooks';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import type { InvestigationRecord, InvestigationStatus } from '../domain/investigation.js';
import type { AgentModelResult, AgentToolOutput } from '../agent/agent-model.js';
import { OperationTimeoutError, type WaitObservation } from '../agent/with-timeout.js';
import { usageForOutcome } from './provider-usage.js';
import type { Duration, InvestigationMeasurement, ModelCallMeasurement, ToolAttemptMeasurement } from './contracts.js';

interface RunningMeasurement {
  record: InvestigationMeasurement;
  started: number | null;
  approval?: { started: number | null; interval: { duration: Duration } };
}

/** Optional in-memory measurements only; no workflow policy, callbacks, I/O or timers. */
export class InvestigationMeasurements {
  #runs = new Map<string, RunningMeasurement>();
  #lastClock = -Infinity;
  constructor(private readonly clock: () => number = () => performance.now()) {}

  private now(): number | null {
    try {
      const value = this.clock();
      if (!Number.isFinite(value) || value < this.#lastClock) return null;
      this.#lastClock = value;
      return value;
    } catch { return null; } // Measurement unavailability must not change Agent behavior.
  }
  private elapsed(start: number | null): Duration {
    const end = this.now();
    return start === null || end === null || !Number.isFinite(end - start) ? { status: 'NOT_AVAILABLE', reason: 'Monotonic clock unavailable or invalid' }
      : { status: 'MEASURED', milliseconds: end - start };
  }
  start(record: InvestigationRecord): void {
    this.#runs.set(record.investigationId, { started: this.now(), record: {
      investigationId: record.investigationId, incidentId: record.incidentId, status: 'RUNNING', unit: 'milliseconds',
      boundary: 'workflow-start-to-terminal-return-including-backoff-and-approval-wait',
      duration: { status: 'PENDING' }, approvalWaits: [], modelCalls: [], toolAttempts: [],
    } });
  }
  model(id: string, requestKind: 'initial' | 'continuation'): WaitObservation<AgentModelResult> | undefined {
    const run = this.#runs.get(id);
    if (!run) return;
    const sample: ModelCallMeasurement = { sequence: run.record.modelCalls.length + 1, requestKind,
      status: 'PENDING', duration: { status: 'PENDING' }, usage: { status: 'NOT_AVAILABLE', reason: 'PENDING' } };
    run.record.modelCalls.push(sample);
    return this.wait(sample, true);
  }
  tool(id: string, callId: string, toolName: string): WaitObservation<AgentToolOutput> | undefined {
    const run = this.#runs.get(id);
    if (!run) return;
    const sample: ToolAttemptMeasurement = { sequence: run.record.toolAttempts.length + 1, callId, toolName,
      attempt: run.record.toolAttempts.filter(attempt => attempt.callId === callId).length + 1,
      status: 'PENDING', duration: { status: 'PENDING' } };
    run.record.toolAttempts.push(sample);
    return this.wait(sample, false);
  }
  private wait<T>(sample: ModelCallMeasurement | ToolAttemptMeasurement, model: boolean): WaitObservation<T> {
    const started = this.now();
    const settle = (status: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT', outcome: unknown) => {
      if (sample.status !== 'PENDING') return;
      sample.duration = this.elapsed(started);
      sample.status = status;
      if (model) {
        const usage = usageForOutcome(outcome);
        (sample as ModelCallMeasurement).usage = status === 'TIMEOUT' && usage.status === 'NOT_AVAILABLE'
          ? { status: 'NOT_AVAILABLE', reason: 'CALLER_TIMEOUT' } : usage;
      }
    };
    return { succeeded: value => settle('SUCCEEDED', value), failed: error => settle(
      error instanceof OperationTimeoutError || (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) ? 'TIMEOUT' : 'FAILED', error) };
  }
  suspend(id: string): void {
    const run = this.#runs.get(id);
    if (!run || run.approval) return;
    const interval = { duration: { status: 'PENDING' } as Duration };
    run.approval = { started: this.now(), interval };
    run.record.approvalWaits.push(interval);
    run.record.status = 'AWAITING_APPROVAL';
  }
  resume(id: string): void {
    const run = this.#runs.get(id);
    if (!run?.approval) return;
    run.approval.interval.duration = this.elapsed(run.approval.started);
    delete run.approval;
    run.record.status = 'RUNNING';
  }
  finish(id: string, status: InvestigationStatus): void {
    const run = this.#runs.get(id);
    if (!run || run.record.duration.status !== 'PENDING' || !['COMPLETED', 'FAILED', 'REJECTED'].includes(status)) return;
    run.record.duration = this.elapsed(run.started);
    run.record.status = status as 'COMPLETED' | 'FAILED' | 'REJECTED';
  }
  get(id: string): InvestigationMeasurement | undefined {
    const run = this.#runs.get(id);
    return run && structuredClone(run.record);
  }
  getAll(): InvestigationMeasurement[] { return [...this.#runs.values()].map(run => structuredClone(run.record)); }
}
