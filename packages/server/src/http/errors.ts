export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details: unknown;
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
