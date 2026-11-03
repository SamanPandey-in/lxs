import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  resolveAsset,
  resolveHoneytokens,
  resolveOptions,
  resolvePostgres,
  resolveRedis,
  resolveSsh,
  resolveWebAdmin,
  resolveWebBait,
} from './config.js';
import { LXSConfigError } from './errors.js';
import { type Core, createCore } from './middleware/core.js';
import { type ExpressRequestHandler, expressMiddleware } from './middleware/express.js';
import { type FastifyPluginLike, fastifyPlugin } from './middleware/fastify.js';
import type {
  AssetOptions,
  AssetSpec,
  DecoySpec,
  HoneytokenOptions,
  HoneytokenSpec,
  LXSOptions,
  Path,
  PostgresOptions,
  RedisOptions,
  ResolvedConfig,
  ResolvedOptions,
  SshOptions,
  WebAdminOptions,
  WebBaitOptions,
} from './types.js';

export const INSTANCE_MARKER = Symbol.for('lxs.instance');

/**
 * Declare decoys and sensitive real assets; compile (CLI) or run (middleware) from the same object.
 * Nothing here is secret: the config is safe to commit.
 */
export class LXS {
  readonly [INSTANCE_MARKER] = true;
  readonly options: ResolvedOptions;
  private readonly _decoys: DecoySpec[] = [];
  private readonly _assets: AssetSpec[] = [];
  private _honeytokens: HoneytokenSpec | null = null;
  private _core: Core | null = null;
  private readonly _logger: Pick<Console, 'warn' | 'error'>;

  constructor(options: LXSOptions = {}) {
    this.options = resolveOptions(options);
    this._logger = options.logger ?? console;
  }

  create(type: 'web-admin', path: Path, options?: WebAdminOptions): this;
  create(type: 'web-bait', path: Path, options?: WebBaitOptions): this;
  create(type: 'ssh', port: number, options?: SshOptions): this;
  create(type: 'redis', port: number, options?: RedisOptions): this;
  create(type: 'postgres', port: number, options?: PostgresOptions): this;
  create(type: string, mountOrPort: Path | number, options?: object): this {
    let spec: DecoySpec;
    switch (type) {
      case 'web-admin':
        spec = resolveWebAdmin(mountOrPort, options as WebAdminOptions);
        break;
      case 'web-bait':
        spec = resolveWebBait(mountOrPort, options as WebBaitOptions);
        break;
      case 'ssh':
        spec = resolveSsh(mountOrPort, options as SshOptions);
        break;
      case 'redis':
        spec = resolveRedis(mountOrPort, options as RedisOptions);
        break;
      case 'postgres':
        spec = resolvePostgres(mountOrPort, options as PostgresOptions);
        break;
      default:
        throw new LXSConfigError(
          'E_TYPE_UNKNOWN',
          `unknown decoy type '${type}'.`,
          "Use 'web-admin', 'web-bait', 'ssh', 'redis' or 'postgres'.",
        );
    }
    this.assertUnique(spec);
    this._decoys.push(spec);
    return this;
  }

  asset(pattern: Path, options: AssetOptions = {}): this {
    const spec = resolveAsset(pattern, options);
    if (this._assets.some((a) => a.pattern === spec.pattern)) {
      throw new LXSConfigError('E_ASSET_DUPLICATE', `asset '${spec.pattern}' is declared twice.`);
    }
    this._assets.push(spec);
    return this;
  }

  honeytokens(options: HoneytokenOptions = {}): this {
    this._honeytokens = resolveHoneytokens(options);
    return this;
  }

  get decoys(): ReadonlyArray<DecoySpec> {
    return this._decoys;
  }

  get assets(): ReadonlyArray<AssetSpec> {
    return this._assets;
  }

  /** Snapshot of everything declared, used by the CLI and the middleware. */
  resolve(): ResolvedConfig {
    return {
      options: this.options,
      decoys: [...this._decoys],
      assets: [...this._assets],
      honeytokens: this._honeytokens,
    };
  }

  private get core(): Core {
    this._core ??= createCore(this.resolve(), this._logger);
    return this._core;
  }

  /** Express middleware. Must be the first middleware. */
  express(): ExpressRequestHandler {
    const mounts = this._decoys.flatMap((d) =>
      d.type === 'web-admin' || d.type === 'web-bait' ? [d.mount] : [],
    );
    return expressMiddleware(() => this.core, mounts);
  }

  /** Fastify plugin: registers a global onRequest hook and checks route collisions on ready. */
  fastify(): FastifyPluginLike {
    return fastifyPlugin(() => this.core, this.resolve());
  }

  /** Framework-agnostic `(req, res, next)` handler for node:http / connect-style stacks. */
  handler(): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
    return (req, res, next) => {
      if (this.core.process(req, res) === 'pass') next();
    };
  }

  /** Stop the policy poller and signal flusher (both are unref'd, so this is only needed in tests / graceful shutdown). */
  close(): void {
    this._core?.close();
    this._core = null;
  }

  private assertUnique(spec: DecoySpec): void {
    if (this._decoys.some((d) => d.id === spec.id)) {
      throw new LXSConfigError(
        'E_ID_COLLISION',
        `decoy id '${spec.id}' is used twice.`,
        'Use id: to tell them apart.',
      );
    }
    if (spec.type === 'web-admin' || spec.type === 'web-bait') {
      if (
        this._decoys.some(
          (d) => (d.type === 'web-admin' || d.type === 'web-bait') && d.mount === spec.mount,
        )
      ) {
        throw new LXSConfigError(
          'E_MOUNT_COLLISION',
          `'${spec.mount}' is declared twice.`,
          'Use id: to tell them apart.',
        );
      }
    } else if (
      this._decoys.some(
        (d) => d.type !== 'web-admin' && d.type !== 'web-bait' && d.port === spec.port,
      )
    ) {
      throw new LXSConfigError('E_PORT_COLLISION', `host port ${spec.port} is declared twice.`);
    }
  }
}

export function isLXS(x: unknown): x is LXS {
  return (
    typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[INSTANCE_MARKER] === true
  );
}
