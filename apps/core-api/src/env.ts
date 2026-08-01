import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORE_API_HOST: z.string().min(1).default('127.0.0.1'),
  CORE_API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  AUTH0_DOMAIN: z.string().min(1),
  AUTH0_AUDIENCE: z.string().url(),
  FIELD_ENCRYPTION_KEY: z.string().min(1),
  FIELD_ENCRYPTION_KEY_ID: z.string().min(1),
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const result = environmentSchema.safeParse(source);
  if (!result.success)
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  return result.data;
}
