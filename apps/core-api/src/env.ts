import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORE_API_HOST: z.string().min(1).default('127.0.0.1'),
  CORE_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  AUTH0_DOMAIN: z.string().min(1),
  AUTH0_AUDIENCE: z.string().url(),
  FIELD_ENCRYPTION_KEY: z.string().min(1),
  FIELD_ENCRYPTION_KEY_ID: z.string().min(1),
  API_ALLOWED_ORIGINS: z.string().optional(),
  API_SENSITIVE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10000).default(60),
  API_SENSITIVE_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3_600_000)
    .default(60_000),
  AUTH0_STEP_UP_CLAIM: z.string().min(1).optional(),
  AUTH0_STEP_UP_VALUE: z.string().min(1).optional(),
  PAYMENTS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RETELL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RETELL_API_KEY: z.string().min(1).optional(),
  RETELL_WEBHOOK_SECRET: z.string().min(1).optional(),
  CUSTOMER_EMAIL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().min(3).optional(),
  RESEND_REPLY_TO: z.string().email().optional(),
  CUSTOMER_EMAIL_SEND_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CUSTOMER_EMAIL_DELIVERY_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(60_000),
  STAFF_INVITATIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  INVITATION_ACCEPT_URL: z.string().url().optional(),
  AUTH0_INVITATION_EMAIL_CLAIM: z.string().min(1).default('email'),
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const result = environmentSchema.safeParse(source);
  if (!result.success)
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  const environment = result.data;
  if (environment.RETELL_ENABLED && !environment.RETELL_API_KEY)
    throw new Error('RETELL_API_KEY is required when RETELL_ENABLED=true.');
  if (
    (environment.CUSTOMER_EMAIL_ENABLED || environment.STAFF_INVITATIONS_ENABLED) &&
    (!environment.RESEND_API_KEY || !environment.RESEND_FROM_EMAIL)
  )
    throw new Error(
      'RESEND_API_KEY and RESEND_FROM_EMAIL are required when transactional email or staff invitations are enabled.',
    );
  if (environment.STAFF_INVITATIONS_ENABLED && !environment.INVITATION_ACCEPT_URL)
    throw new Error('INVITATION_ACCEPT_URL is required when STAFF_INVITATIONS_ENABLED=true.');
  if (environment.STAFF_INVITATIONS_ENABLED) {
    const invitationUrl = new URL(environment.INVITATION_ACCEPT_URL!);
    if (invitationUrl.search || invitationUrl.hash)
      throw new Error('INVITATION_ACCEPT_URL must not include a query string or fragment.');
    if (environment.NODE_ENV === 'production' && invitationUrl.protocol !== 'https:')
      throw new Error(
        'Production STAFF_INVITATIONS_ENABLED requires an HTTPS INVITATION_ACCEPT_URL.',
      );
  }
  const origins =
    environment.API_ALLOWED_ORIGINS?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];
  if (environment.NODE_ENV === 'production') {
    if (!origins.length || origins.some((origin) => !origin.startsWith('https://')))
      throw new Error('Production requires HTTPS API_ALLOWED_ORIGINS.');
    if (!environment.AUTH0_STEP_UP_CLAIM || !environment.AUTH0_STEP_UP_VALUE)
      throw new Error('Production requires AUTH0_STEP_UP_CLAIM and AUTH0_STEP_UP_VALUE.');
  }
  return {
    ...environment,
    CORE_API_HOST: environment.PORT ? '0.0.0.0' : environment.CORE_API_HOST,
    CORE_API_PORT: environment.PORT ?? environment.CORE_API_PORT,
  };
}
