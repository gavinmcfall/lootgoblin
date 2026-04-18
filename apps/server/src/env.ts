import { z } from 'zod';

const AuthMethod = z.enum(['forms', 'oidc', 'none']);

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(7393),
    LOOTGOBLIN_SECRET: z.string().min(32, 'LOOTGOBLIN_SECRET must be at least 32 bytes'),
    AUTH_SECRET: z.string().min(32).optional(),
    DATABASE_URL: z.string().default('file:./lootgoblin.db'),
    AUTH_METHODS: z
      .string()
      .default('forms')
      .transform((s) => s.split(',').map((x) => x.trim()))
      .pipe(z.array(AuthMethod).min(1)),
    OIDC_ISSUER_URL: z.string().url().optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    OIDC_REDIRECT_URI: z.string().url().optional(),
    OIDC_SCOPES: z.string().default('openid profile email groups'),
    OIDC_ADMIN_GROUP: z.string().optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
    WORKER_PER_SOURCE_CONCURRENCY: z.coerce.number().int().positive().default(1),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    OTEL_SERVICE_NAME: z.string().default('lootgoblin'),
  })
  .superRefine((val, ctx) => {
    if (val.AUTH_METHODS.includes('none') && val.AUTH_METHODS.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: "AUTH_METHODS=none is exclusive and cannot be combined with other methods",
        path: ['AUTH_METHODS'],
      });
    }
    if (val.AUTH_METHODS.includes('oidc')) {
      const required = ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'] as const;
      for (const k of required) {
        if (!val[k]) {
          ctx.addIssue({ code: 'custom', message: `${k} required when oidc is enabled`, path: [k] });
        }
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return result.data;
}

export const env: Env = parseEnv();
