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

  it('uses a managed-platform port and public listener when PORT is injected', () => {
    expect(
      loadEnvironment({
        DATABASE_URL: 'postgresql://user:password@localhost:5432/obsidian_core',
        AUTH0_DOMAIN: 'obsidian-core-dev.us.auth0.com',
        AUTH0_AUDIENCE: 'https://api.obsidian-systems.tech',
        FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        FIELD_ENCRYPTION_KEY_ID: 'test-key',
        PORT: '10000',
      }),
    ).toMatchObject({ CORE_API_HOST: '0.0.0.0', CORE_API_PORT: 10000 });
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

  it('requires a fragment-free invitation page and transactional email configuration when invitations are enabled', () => {
    expect(() =>
      loadEnvironment({
        DATABASE_URL: 'postgresql://user:password@localhost:5432/obsidian_core',
        AUTH0_DOMAIN: 'obsidian-core-dev.us.auth0.com',
        AUTH0_AUDIENCE: 'https://api.obsidian-systems.tech',
        FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        FIELD_ENCRYPTION_KEY_ID: 'test-key',
        STAFF_INVITATIONS_ENABLED: 'true',
      }),
    ).toThrow('RESEND_API_KEY');
    expect(() =>
      loadEnvironment({
        DATABASE_URL: 'postgresql://user:password@localhost:5432/obsidian_core',
        AUTH0_DOMAIN: 'obsidian-core-dev.us.auth0.com',
        AUTH0_AUDIENCE: 'https://api.obsidian-systems.tech',
        FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        FIELD_ENCRYPTION_KEY_ID: 'test-key',
        STAFF_INVITATIONS_ENABLED: 'true',
        RESEND_API_KEY: 're_test',
        RESEND_FROM_EMAIL: 'Obsidian Systems <receipts@example.test>',
        INVITATION_ACCEPT_URL: 'https://admin.example.test/invitations#invite=unsafe',
      }),
    ).toThrow('must not include a query string or fragment');
  });
});
