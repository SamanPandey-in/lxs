import type { ResolvedConfig } from '../types.js';
import type { Core } from './core.js';

/** Structurally compatible with Fastify's FastifyPluginAsync without depending on fastify's types. */
// biome-ignore lint/suspicious/noExplicitAny: structural typing against fastify
export type FastifyPluginLike = (instance: any, opts?: any) => Promise<void>;

/**
 * Fastify adapter: a global onRequest hook (the plugin opts out of encapsulation, like fastify-plugin does),
 * plus a collision check on `onReady`. The hook runs before body parsing so the raw request can be piped to ds-web.
 */
export function fastifyPlugin(getCore: () => Core, cfg: ResolvedConfig): FastifyPluginLike {
  const mounts = cfg.decoys.flatMap((d) =>
    d.type === 'web-admin' || d.type === 'web-bait' ? [d.mount] : [],
  );

  const plugin: FastifyPluginLike = async (instance) => {
    const core = getCore();
    instance.addHook(
      'onRequest',
      // biome-ignore lint/suspicious/noExplicitAny: fastify request/reply
      async (req: any, reply: any) => {
        if (core.process(req.raw, reply.raw) === 'handled') {
          reply.hijack();
          return reply;
        }
        return undefined;
      },
    );
    instance.addHook('onReady', async () => {
      if (typeof instance.hasRoute !== 'function') return;
      const clashes = mounts.filter((m) => instance.hasRoute({ method: 'GET', url: m }));
      if (clashes.length > 0) {
        throw new Error(
          `lxs: real routes collide with declared decoys: ${clashes.join(', ')}. ` +
            'The decoy would shadow the real route. Rename the decoy or the route.',
        );
      }
    });
    instance.addHook('onClose', async () => core.close());
  };

  (plugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
  (plugin as unknown as Record<symbol, unknown>)[Symbol.for('fastify.display-name')] = 'lxs';
  return plugin;
}
