import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { ToolError } from '../tools/tool-error.js';
import { MalformedMcpResultError } from './tool-executor.js';
import { OperationTimeoutError } from './with-timeout.js';

export const MAX_TOOL_RETRIES = 1;
export const TOOL_RETRY_BACKOFF_MS = 100;
const RETRY_SAFE_READ_TOOLS = new Set(['search_logs', 'get_metrics', 'get_service_info', 'search_runbook']);
export type ToolFailureClassification = 'RETRYABLE' | 'NON_RETRYABLE' | 'UNKNOWN';

export function classifyToolFailure(toolName: string, error: unknown): ToolFailureClassification {
  if (error instanceof OperationTimeoutError || (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)) {
    return RETRY_SAFE_READ_TOOLS.has(toolName) ? 'RETRYABLE' : 'NON_RETRYABLE';
  }
  if ((error instanceof ToolError && ['INVALID_INPUT', 'SERVICE_NOT_FOUND'].includes(error.code))
    || error instanceof TypeError || error instanceof MalformedMcpResultError) return 'NON_RETRYABLE';
  if (error instanceof SdkError && [SdkErrorCode.ConnectionClosed, SdkErrorCode.SendFailed, SdkErrorCode.InvalidResult].includes(error.code)) {
    return 'NON_RETRYABLE';
  }
  return 'UNKNOWN'; // No retry without an explicitly recognized safe failure.
}
