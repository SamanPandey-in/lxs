import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Core } from './core.js';

export type ExpressRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

/**
 * Express adapter. Must be the first middleware: decoy paths are answered here and never reach the app's router.
 * Route collisions are detected best-effort on the first request and reported once.
 */
export function expressMiddleware(
  getCore: () => Core,
  mounts: readonly string[] = [],
): ExpressRequestHandler {
  const core = getCore();
  let checked = false;
  return (req, res, next) => {
    if (core.process(req, res) === 'pass') {
      next();
      if (!checked) {
        checked = true;
        setImmediate(() => warnCollisions(req, mounts));
      }
    }
  };
}

interface Layer {
  route?: { path?: unknown };
}

/** Looks at the router stack (Express 4 `_router`, Express 5 `router`) for routes shadowed by decoys. */
function warnCollisions(req: IncomingMessage, shadow: readonly string[]): void {
  try {
    const app = (req as unknown as { app?: Record<string, unknown> }).app;
    if (!app) return;
    let stack: Layer[] | undefined;
    try {
      stack = (app._router as { stack?: Layer[] } | undefined)?.stack;
    } catch {
      /* ignore */
    }
    if (!stack) {
      try {
        stack = (app.router as { stack?: Layer[] } | undefined)?.stack;
      } catch {
        /* Express 4 throws on app.router */
      }
    }
    if (!stack) return;
    const hits = stack
      .map((l) => l.route?.path)
      .filter(
        (p): p is string =>
          typeof p === 'string' && shadow.some((m) => p === m || p.startsWith(`${m}/`)),
      );
    if (hits.length > 0) {
      console.warn(
        `lxs: these real routes are shadowed by decoys (the decoy wins): ${hits.join(', ')}`,
      );
    }
  } catch {
    /* best effort */
  }
}
