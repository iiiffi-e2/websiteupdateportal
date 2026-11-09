export class PortalError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = "PortalError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export function asPortalError(error: unknown): PortalError {
  if (error instanceof PortalError) return error;
  const message = error instanceof Error ? error.message : "Unexpected failure.";
  return new PortalError("internal", message, { retryable: true });
}
