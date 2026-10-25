import { ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Context, type Span, type Tracer } from '@opentelemetry/api';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import type { InvestigationStatus } from '../domain/investigation.js';
import type { AgentModelResult, AgentToolOutput } from '../agent/agent-model.js';
import { MalformedMcpResultError } from '../agent/tool-executor.js';
import { observeSafely, OperationTimeoutError, type WaitObservation } from '../agent/with-timeout.js';
import { ToolError } from '../tools/tool-error.js';
import { usageForOutcome } from '../measurement/provider-usage.js';

const TOOL_NAMES = new Set(['search_logs', 'get_metrics', 'get_service_info', 'search_runbook', 'restart_service']);
function category(error: unknown): string {
  if (error instanceof OperationTimeoutError || (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)) return 'TIMEOUT';
  if (error instanceof ToolError && ['INVALID_INPUT', 'SERVICE_NOT_FOUND'].includes(error.code)) return error.code;
  if (error instanceof TypeError) return 'TYPE_ERROR';
  if (error instanceof MalformedMcpResultError) return 'MALFORMED_MCP_RESULT';
  if (error instanceof SdkError) return 'MCP_ERROR';
  return 'UNKNOWN'; // Never inspect/export error messages, stacks, bodies or arbitrary error names.
}

/** Explicit contexts survive generator suspension without global SDK/context registration. */
export class InvestigationTracing {
  #runs = new Map<string, { span: Span; context: Context; awaitingApproval: boolean }>();
  constructor(private readonly tracer: Tracer) {}

  start(id: string): void {
    const span = observeSafely(() => this.tracer.startSpan('incident.investigation', { attributes: {
      'investigation.outcome': 'RUNNING',
      'investigation.elapsed_boundary': 'includes_backoff_and_approval_wait',
    } }, ROOT_CONTEXT));
    if (span) this.#runs.set(id, { span, context: trace.setSpan(ROOT_CONTEXT, span), awaitingApproval: false });
  }
  suspend(id: string): void {
    const run = this.#runs.get(id);
    if (!run || run.awaitingApproval) return;
    run.awaitingApproval = true;
    observeSafely(() => run.span.setAttribute('investigation.outcome', 'AWAITING_APPROVAL'));
    observeSafely(() => run.span.addEvent('approval.requested'));
  }
  resume(id: string): void {
    const run = this.#runs.get(id);
    if (!run?.awaitingApproval) return;
    run.awaitingApproval = false;
    observeSafely(() => run.span.setAttribute('investigation.outcome', 'RUNNING'));
    observeSafely(() => run.span.addEvent('approval.resumed'));
  }
  finish(id: string, status: InvestigationStatus, error?: unknown): void {
    const run = this.#runs.get(id);
    if (!run || !['COMPLETED', 'FAILED', 'REJECTED'].includes(status)) return;
    this.#runs.delete(id); // Claim the terminal end before invoking any SDK code.
    observeSafely(() => run.span.setAttribute('investigation.outcome', status));
    if (status === 'REJECTED') observeSafely(() => run.span.addEvent('approval.rejected'));
    if (status === 'FAILED') observeSafely(() => run.span.setAttribute('error.category', category(error)));
    // Rejection is a successful application-enforced decision, not an execution exception.
    observeSafely(() => run.span.setStatus({ code: status === 'FAILED' ? SpanStatusCode.ERROR : SpanStatusCode.OK }));
    observeSafely(() => run.span.end());
  }
  model(id: string, requestKind: 'initial' | 'continuation'): WaitObservation<AgentModelResult> | undefined {
    return this.wait(id, 'agent.model.respond', { 'model.request_kind': requestKind }, true);
  }
  tool(id: string, toolName: string, attempt: number): WaitObservation<AgentToolOutput> | undefined {
    return this.wait(id, 'agent.tool.execute', {
      'tool.name': TOOL_NAMES.has(toolName) ? toolName : 'UNRECOGNIZED', 'tool.attempt': attempt,
    }, false);
  }
  private wait<T>(id: string, name: string, attributes: Attributes, model: boolean): WaitObservation<T> | undefined {
    const run = this.#runs.get(id);
    if (!run) return;
    const span = observeSafely(() => this.tracer.startSpan(name, { attributes }, run.context));
    if (!span) return;
    let ended = false;
    const settle = (failed: boolean, value: unknown) => {
      if (ended) return;
      ended = true;
      const errorCategory = failed ? observeSafely(() => category(value)) ?? 'UNKNOWN' : undefined;
      observeSafely(() => span.setAttribute('operation.outcome', failed ? errorCategory === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED' : 'SUCCEEDED'));
      if (errorCategory) observeSafely(() => span.setAttribute('error.category', errorCategory));
      observeSafely(() => span.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK }));
      if (model) observeSafely(() => {
        const usage = usageForOutcome(value);
        span.setAttribute('model.usage_available', usage.status === 'AVAILABLE');
        if (usage.status === 'AVAILABLE') span.setAttributes({
          'model.input_tokens': usage.counts.inputTokens, 'model.output_tokens': usage.counts.outputTokens,
          'model.total_tokens': usage.counts.totalTokens,
        });
      });
      observeSafely(() => span.end());
    };
    return { succeeded: value => settle(false, value), failed: error => settle(true, error) };
  }
}
