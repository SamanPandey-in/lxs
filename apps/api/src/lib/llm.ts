import Anthropic from '@anthropic-ai/sdk';

/**
 * Provider-agnostic LLM adapter. The narrator is its only caller: one prompt in, one
 * JSON document out. No tools are ever passed, so model output cannot trigger anything.
 */

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const DEFAULT_GOOGLE_MODEL = 'gemini-3.8-flash';
const GOOGLE_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface LlmConfig {
  provider: 'anthropic' | 'openai' | 'google';
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** JSON Schema of the reply. */
  schema: Record<string, unknown>;
}

export interface LlmReply {
  text: string;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmReply>;
}

/** Any provider failure the narrator should answer with the template. */
export class LlmError extends Error {
  override name = 'LlmError';
}

/** Placeholder keys never leave the process: attacker data is not sent to a provider that will 401. */
export const isPlaceholderKey = (key: string): boolean => key.toLowerCase().startsWith('mock-');

/** Resolve the config from the environment. Null means "use templates": the platform runs fine without an LLM. */
export function llmConfigFrom(env: {
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  LLM_TIMEOUT_MS: number;
}): LlmConfig | null {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey || isPlaceholderKey(apiKey)) return null;
  const provider = (env.LLM_PROVIDER?.trim() || 'anthropic').toLowerCase();
  const baseUrl = env.LLM_BASE_URL?.trim() || undefined;
  const timeoutMs = env.LLM_TIMEOUT_MS;
  const model = env.LLM_MODEL?.trim();
  if (provider === 'anthropic')
    return { provider, apiKey, model: model || DEFAULT_ANTHROPIC_MODEL, baseUrl, timeoutMs };
  if (provider === 'google')
    return {
      provider,
      apiKey,
      model: model || DEFAULT_GOOGLE_MODEL,
      baseUrl: baseUrl || GOOGLE_API_BASE_URL,
      timeoutMs,
    };
  // An OpenAI-compatible endpoint serves whatever it serves, so there is no sane default model.
  if (provider === 'openai' && model) return { provider, apiKey, model, baseUrl, timeoutMs };
  return null;
}

/** Models that accept server-side refusal fallbacks. Others answer the parameter with a 400. */
const SUPPORTS_FALLBACKS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

function anthropicProvider(cfg: LlmConfig): LlmProvider {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs,
    maxRetries: 1,
  });
  return {
    name: 'anthropic',
    model: cfg.model,
    async complete(req) {
      const fallbacks = SUPPORTS_FALLBACKS.test(cfg.model);
      let res: Anthropic.Beta.BetaMessage;
      try {
        res = await client.beta.messages.create({
          model: cfg.model,
          max_tokens: 4000,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
          // Security text can trip safety classifiers; a decline should reroute, not cost the summary.
          ...(fallbacks && {
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default' as const,
          }),
        });
      } catch (err) {
        throw new LlmError(err instanceof Error ? err.message : String(err));
      }
      if (res.stop_reason !== 'end_turn')
        throw new LlmError(`Model stopped early: ${res.stop_reason}`);
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { text, model: res.model };
    },
  };
}

function openAiProvider(cfg: LlmConfig): LlmProvider {
  const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    name: cfg.provider,
    model: cfg.model,
    async complete(req) {
      let res: Response;
      let body: {
        model?: string;
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      };
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          signal: AbortSignal.timeout(cfg.timeoutMs),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: `${req.system}\n\nReply with one JSON object matching this JSON Schema:\n${JSON.stringify(req.schema)}`,
              },
              { role: 'user', content: req.user },
            ],
          }),
        });
        body = (await res.json()) as typeof body;
      } catch (err) {
        throw new LlmError(err instanceof Error ? err.message : String(err));
      }
      if (!res.ok) throw new LlmError(`Provider answered HTTP ${res.status}`);
      const choice = body.choices?.[0];
      if (choice?.finish_reason && choice.finish_reason !== 'stop')
        throw new LlmError(`Model stopped early: ${choice.finish_reason}`);
      return { text: choice?.message?.content ?? '', model: body.model ?? cfg.model };
    },
  };
}

function googleProvider(cfg: LlmConfig): LlmProvider {
  const base = (cfg.baseUrl ?? GOOGLE_API_BASE_URL).replace(/\/+$/, '');
  return {
    name: 'google',
    model: cfg.model,
    async complete(req) {
      let res: Response;
      let body: {
        model?: string;
        status?: string;
        output_text?: string;
        output?: { type?: string; text?: string }[];
        steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
      };
      try {
        res = await fetch(`${base}/interactions`, {
          method: 'POST',
          signal: AbortSignal.timeout(cfg.timeoutMs),
          headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
          body: JSON.stringify({
            model: cfg.model,
            input: req.user,
            system_instruction: req.system,
            generation_config: { thinking_level: 'low', max_output_tokens: 1200 },
            response_format: {
              type: 'text',
              mime_type: 'application/json',
              schema: req.schema,
            },
          }),
        });
        body = (await res.json()) as typeof body;
      } catch (err) {
        throw new LlmError(err instanceof Error ? err.message : String(err));
      }
      if (!res.ok) throw new LlmError(`Provider answered HTTP ${res.status}`);
      if (body.status && body.status !== 'completed')
        throw new LlmError(`Model interaction ended with status: ${body.status}`);
      const text =
        body.output_text ??
        body.steps
          ?.filter((step) => step.type === 'model_output')
          .flatMap((step) =>
            (step.content ?? []).flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])),
          )
          .join('') ??
        body.output?.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])).join('') ??
        '';
      if (!text) throw new LlmError('Provider returned no text output');
      return { text, model: body.model ?? cfg.model };
    },
  };
}

export const createLlmProvider = (cfg: LlmConfig): LlmProvider =>
  cfg.provider === 'anthropic'
    ? anthropicProvider(cfg)
    : cfg.provider === 'google'
      ? googleProvider(cfg)
      : openAiProvider(cfg);
