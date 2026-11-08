import { setTimeout as delay } from 'node:timers/promises';
import { AgentOrchestrator } from './agent/agent-orchestrator.js';
import type { AgentModel, AgentToolCall, AgentToolOutput } from './agent/agent-model.js';
import { OpenAIAgentModel, type OpenAIAgentModelOptions } from './agent/openai-agent-model.js';
import { ToolExecutor, type McpToolCaller } from './agent/tool-executor.js';
import { observeSafely, OperationTimeoutError } from './agent/with-timeout.js';
import type { InvestigationRecord } from './domain/investigation.js';
import { incidents } from './fixtures/index.js';
import { IncidentOpsMcpClient } from './mcp/client.js';
import { InvestigationMeasurements } from './measurement/collector.js';
import { summarizeMeasurements } from './measurement/report.js';
import { createInMemoryTracing } from './tracing/local.js';

export const LIVE_LIMITS = Object.freeze({ maxTurns: 5, maxToolCalls: 4, modelTimeoutMs: 30_000,
  toolTimeoutMs: 30_000, requestTimeoutMs: 31_000, connectTimeoutMs: 10_000, maxOutputTokens: 2048 });
const reads = new Set(['search_logs', 'get_metrics', 'get_service_info', 'search_runbook']);

export class LiveInputError extends Error {}

export function validateLiveInput(incidentId: string): void {
  if (typeof incidentId !== 'string' || !incidents.some(incident => incident.id === incidentId)) {
    throw new LiveInputError('Select an existing supported Incident ID');
  }
  if (!process.env.OPENAI_API_KEY?.trim()) throw new LiveInputError('OPENAI_API_KEY is required');
  if (!process.env.OPENAI_AGENT_MODEL?.trim()) throw new LiveInputError('OPENAI_AGENT_MODEL is required');
}

interface OwnedMcpClient extends McpToolCaller {
  readonly pid: number | null;
  connect(options?: Parameters<IncidentOpsMcpClient['connect']>[0]): Promise<void>;
  close(): Promise<void>;
}

/** Narrow construction seams for offline SDK/stdio tests, not another provider framework. */
export interface LiveDependencies {
  createModel?(options: OpenAIAgentModelOptions): AgentModel;
  createClient?(): OwnedMcpClient;
  createTracing?(): ReturnType<typeof createInMemoryTracing>;
}

export interface LiveOptions {
  signal?: AbortSignal;
  /** Explicit local inspection only; default output omits raw arguments and tool outputs. */
  inspect?: boolean;
  onReport?(report: LiveInvestigationReport): void;
  /** Synchronous, passive observations for a caller-owned local evaluation. */
  onObservation?(event: LiveObservation): undefined;
}

export type LiveObservation =
  | { kind: 'model-return'; sequence: number; requests: AgentToolCall[]; continuationOutputs: AgentToolOutput[] }
  | { kind: 'tool-start'; sequence: number; call: AgentToolCall }
  | { kind: 'tool-return'; sequence: number; output: AgentToolOutput };

export interface LiveInvestigationReport {
  execution: 'OPENAI_ADAPTER';
  incidentId: string;
  outcome: {
    status: InvestigationRecord['status'] | 'NOT_STARTED';
    investigationId?: string;
    diagnosis?: InvestigationRecord['diagnosis'];
    toolExecutions: InvestigationRecord['toolExecutions'];
  };
  measurements: ReturnType<InvestigationMeasurements['getAll']>;
  measurementSummary: ReturnType<typeof summarizeMeasurements>;
  spans: { name: string; traceId: string; spanId: string; parentSpanId: string | null;
    status: number; attributes: Record<string, unknown>; events: string[]; duration: [number, number] }[];
  traceComplete: boolean;
  verificationReady: boolean;
  humanDiagnosisReview: 'PENDING';
  observed: { requestedTools: { callId: string; toolName: string }[]; deliveredCallIds: string[] };
  inspection?: { scope: 'LOCAL_REVIEW_ONLY'; requests: AgentToolCall[]; deliveredOutputs: AgentToolOutput[] };
  failure?: 'INTERRUPTED' | 'TIMEOUT' | 'INITIALIZATION_FAILED' | 'INVESTIGATION_FAILED';
  cleanup: { mcpClose: 'NOT_CREATED' | 'SUCCEEDED' | 'FAILED';
    childExit: 'NOT_OBSERVED' | 'OBSERVED'; tracingShutdown: 'NOT_CREATED' | 'SUCCEEDED' | 'FAILED'; errors: string[] };
  limitations: string[];
}

/** A closed SDK transport/pid=null is not proof of OS process exit. Never sends a signal. */
async function observeExit(pid: number | null): Promise<'OBSERVED' | 'NOT_OBSERVED'> {
  if (pid === null) return 'NOT_OBSERVED';
  const until = performance.now() + 1000;
  do {
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'OBSERVED' : 'NOT_OBSERVED'; }
    await delay(20);
  } while (performance.now() < until);
  return 'NOT_OBSERVED';
}

/** One-shot local session. Unexpected approval is abandoned, never approved or relabeled terminal. */
export async function runLiveInvestigation(incidentId: string, options: LiveOptions = {}, dependencies: LiveDependencies = {}): Promise<LiveInvestigationReport> {
  validateLiveInput(incidentId); // Before creating a child, tracer or API adapter.
  const incident = structuredClone(incidents.find(item => item.id === incidentId)!);
  const controller = new AbortController();
  const collector = new InvestigationMeasurements();
  let client: OwnedMcpClient | undefined, local: ReturnType<typeof createInMemoryTracing> | undefined;
  let agent: AgentOrchestrator | undefined, record: InvestigationRecord | undefined, pid: number | null = null;
  let primary: unknown, failed = false, closing: Promise<void> | undefined;
  let failure: LiveInvestigationReport['failure'];
  const cleanup: LiveInvestigationReport['cleanup'] = { mcpClose: 'NOT_CREATED', childExit: 'NOT_OBSERVED',
    tracingShutdown: 'NOT_CREATED', errors: [] };
  const requestedTools: { callId: string; toolName: string }[] = [];
  const requests: AgentToolCall[] = [];
  const returnedContinuations: { sequence: number; callIds: string[]; outputs: AgentToolOutput[] }[] = [];
  const observe = (event: LiveObservation) => observeSafely(() => options.onObservation?.(structuredClone(event)));
  let modelSequence = 0;
  let toolSequence = 0;
  let spans: LiveInvestigationReport['spans'] = [];
  const closeMcp = () => {
    if (!client) return Promise.resolve();
    closing ??= Promise.resolve().then(() => client!.close()).then(() => { cleanup.mcpClose = 'SUCCEEDED'; }, () => {
      cleanup.mcpClose = 'FAILED'; cleanup.errors.push('MCP_CLOSE_FAILED');
    });
    return closing;
  };
  const interrupt = () => { controller.abort(); void closeMcp(); };
  try {
    options.signal?.throwIfAborted();
    const model = (dependencies.createModel ?? (settings => new OpenAIAgentModel(settings)))({ readOnly: true,
      maxOutputTokens: LIVE_LIMITS.maxOutputTokens, requestTimeoutMs: LIVE_LIMITS.requestTimeoutMs, signal: controller.signal });
    client = (dependencies.createClient ?? (() => new IncidentOpsMcpClient()))();
    options.signal?.addEventListener('abort', interrupt, { once: true });
    if (options.signal?.aborted) interrupt();
    controller.signal.throwIfAborted();
    local = (dependencies.createTracing ?? createInMemoryTracing)();
    const connecting = client.connect({ timeout: LIVE_LIMITS.connectTimeoutMs, signal: controller.signal });
    pid = client.pid; // Capture before SDK initialization-failure cleanup can clear the transport.
    await connecting;
    pid ??= client.pid;
    const observedModel: AgentModel = { async respond(request) {
      const sequence = ++modelSequence;
      const continuation = request.kind === 'continuation' ? {
        sequence, callIds: request.outputs.map(output => output.callId),
        outputs: options.inspect ? structuredClone(request.outputs) : [],
      } : undefined;
      const result = await model.respond(request);
      if (continuation) returnedContinuations.push(continuation);
      if (result?.kind === 'tool_calls' && Array.isArray(result.calls)) {
        requestedTools.push(...result.calls.map(call => ({ callId: call.callId, toolName: call.name })));
        if (options.inspect) requests.push(...structuredClone(result.calls));
      }
      if (options.onObservation) observe({ kind: 'model-return', sequence,
        requests: result?.kind === 'tool_calls' && Array.isArray(result.calls) ? result.calls : [],
        continuationOutputs: request.kind === 'continuation' ? request.outputs : [] });
      return result; // Keep the original object and its WeakMap usage metadata.
    } };
    const executor = new ToolExecutor(client);
    if (options.onObservation) {
      const execute = executor.execute.bind(executor);
      executor.execute = async call => {
        const sequence = ++toolSequence;
        observe({ kind: 'tool-start', sequence, call });
        const output = await execute(call);
        observe({ kind: 'tool-return', sequence, output });
        return output;
      };
    }
    agent = new AgentOrchestrator(observedModel, executor, LIVE_LIMITS.maxTurns, LIVE_LIMITS.maxToolCalls,
      LIVE_LIMITS.modelTimeoutMs, LIVE_LIMITS.toolTimeoutMs, collector, local.tracing);
    record = await agent.investigate(incident);
  } catch (error) {
    primary = error; failed = true; record = agent?.currentRecord;
    failure = options.signal?.aborted ? 'INTERRUPTED' : error instanceof OperationTimeoutError ? 'TIMEOUT'
      : agent ? 'INVESTIGATION_FAILED' : 'INITIALIZATION_FAILED';
  } finally {
    options.signal?.removeEventListener('abort', interrupt);
    controller.abort(); // Cancel a timed-out parent SDK request; does not undo provider work/billing.
    pid ??= client?.pid ?? null;
    await closeMcp();
    cleanup.childExit = await observeExit(pid);
    if (local) {
      try { await local.provider.forceFlush(); } catch { cleanup.errors.push('TRACE_FLUSH_FAILED'); }
      try {
        spans = local.exporter.getFinishedSpans().map(span => ({ name: span.name, traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId, parentSpanId: span.parentSpanContext?.spanId ?? null, status: span.status.code,
          attributes: { ...span.attributes }, events: span.events.map(event => event.name), duration: [...span.duration] }));
      } catch { cleanup.errors.push('TRACE_SNAPSHOT_FAILED'); }
      try { await local.provider.shutdown(); cleanup.tracingShutdown = 'SUCCEEDED'; }
      catch { cleanup.tracingShutdown = 'FAILED'; cleanup.errors.push('TRACE_SHUTDOWN_FAILED'); }
    }
  }
  const terminal = record !== undefined && ['COMPLETED', 'FAILED', 'REJECTED'].includes(record.status);
  const traceComplete = terminal && spans.filter(span => span.name === 'incident.investigation').length === 1;
  const executions = record?.toolExecutions ?? [];
  const measurements = collector.getAll();
  // A returned request can still have lost the caller's timeout race during cleanup.
  const completedContinuations = returnedContinuations.filter(item => measurements[0]?.modelCalls[item.sequence - 1]?.status === 'SUCCEEDED');
  const deliveredCallIds = completedContinuations.flatMap(item => item.callIds);
  const deliveredOutputs = completedContinuations.flatMap(item => item.outputs);
  const evidenceDelivered = executions.some(call => call.status === 'SUCCEEDED' && reads.has(call.toolName)
    && requestedTools.some(request => request.callId === call.callId && request.toolName === call.toolName)
    && deliveredCallIds.includes(call.callId));
  const report: LiveInvestigationReport = { execution: 'OPENAI_ADAPTER', incidentId,
    outcome: { status: record?.status ?? 'NOT_STARTED', ...(record ? { investigationId: record.investigationId } : {}),
      ...(record?.diagnosis ? { diagnosis: record.diagnosis } : {}), toolExecutions: executions },
    measurements, measurementSummary: summarizeMeasurements(measurements), spans, traceComplete,
    verificationReady: !failed && record?.status === 'COMPLETED' && evidenceDelivered && traceComplete
      && cleanup.errors.length === 0 && cleanup.childExit === 'OBSERVED', humanDiagnosisReview: 'PENDING',
    observed: { requestedTools, deliveredCallIds }, ...(options.inspect ? {
      inspection: { scope: 'LOCAL_REVIEW_ONLY', requests, deliveredOutputs } as const } : {}),
    ...(failure ? { failure } : {}), cleanup,
    limitations: ['OPENAI_ADAPTER identifies the execution path, not proof of a live provider or human quality PASS.',
      'Caller waits include backoff and approval suspension, exclude MCP setup/cleanup; timeouts are not a financial limit.',
      'Usage covers observed model responses only; embedding usage, billing and late provider work are not included.',
      'Application-side spans are not distributed MCP tracing. Raw evidence requires explicit local inspection.',
      'AWAITING_APPROVAL abandons this one-shot session without approval/resume or a fabricated terminal outcome.'] };
  observeSafely(() => options.onReport?.(report));
  if (failed) throw primary; // Cleanup/inspection cannot replace the actual investigation failure.
  return report;
}
