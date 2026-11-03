/** Thrown at declaration/build time. `code` is stable and documented; `hint` says how to fix it. */
export class LXSConfigError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(`${code}: ${message}${hint ? ` ${hint}` : ''}`);
    this.name = 'LXSConfigError';
    this.code = code;
    this.hint = hint;
  }
}
