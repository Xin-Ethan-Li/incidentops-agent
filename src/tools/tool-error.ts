export class ToolError extends Error {
  constructor(
    public readonly code: 'SERVICE_NOT_FOUND' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
