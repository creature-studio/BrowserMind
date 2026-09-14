/** Error taxonomy used across the runtime, the extension and plugins. */

export class BrowserMindError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export class NotFoundError extends BrowserMindError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('not_found', message, details);
  }
}

export class TimeoutError extends BrowserMindError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('timeout', message, details);
  }
}

export class ValidationError extends BrowserMindError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', message, details);
  }
}

export class PageUnavailableError extends BrowserMindError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('page_unavailable', message, details);
  }
}

export class LoginRequiredError extends BrowserMindError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('login_required', message, details);
  }
}

export class AbortedError extends BrowserMindError {
  constructor(message = 'Operation aborted') {
    super('aborted', message);
  }
}

export function toErrorPayload(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof BrowserMindError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return { code: typeof code === 'string' ? code : 'internal_error', message: error.message };
  }
  return { code: 'internal_error', message: String(error) };
}

export function reviveError(payload: { code?: string; message?: string; details?: unknown }): BrowserMindError {
  const code = payload?.code ?? 'internal_error';
  const message = payload?.message ?? 'Unknown error';
  const details = (payload?.details as Record<string, unknown> | undefined) ?? undefined;
  switch (code) {
    case 'not_found':
      return new NotFoundError(message, details);
    case 'timeout':
      return new TimeoutError(message, details);
    case 'validation_error':
      return new ValidationError(message, details);
    case 'page_unavailable':
      return new PageUnavailableError(message, details);
    case 'login_required':
      return new LoginRequiredError(message, details);
    case 'aborted':
      return new AbortedError(message);
    default:
      return new BrowserMindError(code, message, details);
  }
}
