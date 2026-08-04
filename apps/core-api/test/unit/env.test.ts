import { describe, expect, it } from 'vitest';

import { loadEnvironment } from '../../src/env.js';

describe('environment validation', () => {
  it('accepts a valid PostgreSQL connection configuration', () => {
    expect(
      loadEnvironment({
        DATABASE_URL: 'postgresql://user:password@localhost:5432/obsidian_core',
        AUTH0_DOMAIN: 'obsidian-core-dev.us.auth0.com',
        AUTH0_AUDIENCE: 'https://api.obsidian-systems.tech',
        FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        FIELD_ENCRYPTION_KEY_ID: 'test-key',
      }),
    ).toMatchObject({ CORE_API_HOST: '127.0.0.1', CORE_API_PORT: 3000 });
  });

  it('rejects missing database configuration at startup', () => {
    expect(() => loadEnvironment({})).toThrow('Invalid environment configuration');
  });

  it('rejects production without HTTPS origins and an Auth0 step-up claim', () => {
    expect(() =>
      loadEnvironment({
        AUTH0_AUDIENCE: 'https://api.example.test',
        AUTH0_DOMAIN: 'tenant.example.test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/core',
        FIELD_ENCRYPTION_KEY: 'key',
        FIELD_ENCRYPTION_KEY_ID: 'key-1',
        NODE_ENV: 'production',
      }),
    ).toThrow('Production requires HTTPS API_ALLOWED_ORIGINS');
  });
});
