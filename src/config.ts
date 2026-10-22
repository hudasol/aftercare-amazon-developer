/**
 * Validated runtime configuration. Every setting has a safe local default;
 * nothing here is a secret unless AFTERCARE_ACCESS_TOKEN is set.
 */
import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('var/aftercare.db'),
  /** Fictional customer the demo surface acts as. */
  AFTERCARE_DEMO_CUSTOMER: z.string().default('cus_demo_maya'),
  /** When set, /api and /mcp require "Authorization: Bearer <token>". Required when HOST is not loopback. */
  AFTERCARE_ACCESS_TOKEN: z.string().min(16).optional(),
  /**
   * Allows a non-loopback HOST without AFTERCARE_ACCESS_TOKEN, for the hosted judging demo.
   * Only safe because every record is fictional and the web app sends no token; never set
   * it for real customer data.
   */
  AFTERCARE_PUBLIC_DEMO: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Extra browser origins allowed to call /mcp and /api (comma-separated). */
  AFTERCARE_ALLOWED_ORIGINS: z.string().default(''),
  /** Overrides the pinned demo case date (YYYY-MM-DD). */
  AFTERCARE_CASE_DATE: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /**
   * Optional language model interpreter (OpenAI compatible chat completions).
   * Used only when both the base URL and the model are set; otherwise the rules
   * interpreter runs alone.
   */
  AFTERCARE_LLM_BASE_URL: z.url().optional(),
  AFTERCARE_LLM_MODEL: z.string().min(1).optional(),
  /** Optional: a local server needs no key. Never logged. */
  AFTERCARE_LLM_API_KEY: z.string().min(1).optional(),
  AFTERCARE_LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(8000),
  SANDBOX_LATENCY_MS: z.coerce.number().int().min(0).max(10_000).default(250),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().min(0).max(30_000).default(1500),
  /** Requests per client per minute on /mcp and /api; 0 turns the limit off. */
  AFTERCARE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(100_000).default(600),
  /**
   * Take the client address for the rate limit from the last X-Forwarded-For
   * entry. Defaults to true on Render (which sets RENDER=true) and false elsewhere.
   */
  AFTERCARE_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Serve the built web app from web/dist. */
  SERVE_WEB: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    ...(env['RENDER'] === 'true' ? { AFTERCARE_TRUST_PROXY: 'true' } : {}),
    ...env,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const config = parsed.data;
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.HOST);
  if (!loopback && !config.AFTERCARE_ACCESS_TOKEN && !config.AFTERCARE_PUBLIC_DEMO) {
    throw new Error(
      'Refusing to listen on a non-loopback address without AFTERCARE_ACCESS_TOKEN. Set a token of 16+ characters, or AFTERCARE_PUBLIC_DEMO=true for a fictional-data public demo.',
    );
  }
  return config;
}
