export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required', code = 'unauthorized') =>
  new HttpError(401, code, msg);
export const forbidden = (msg = 'Forbidden', code = 'forbidden') => new HttpError(403, code, msg);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (msg: string, details?: unknown) =>
  new HttpError(409, 'conflict', msg, details);
export const invalid = (msg: string, details?: unknown) =>
  new HttpError(422, 'validation_failed', msg, details);
export const unavailable = (msg = 'Service unavailable') => new HttpError(503, 'unavailable', msg);
