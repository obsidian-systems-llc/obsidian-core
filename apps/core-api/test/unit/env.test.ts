import { describe, expect, it } from 'vitest';

import { loadEnvironment } from '../../src/env.js';

describe('environment validation', () => {
  it('accepts a valid PostgreSQL connection configuration', () => {
    expect(
      loadEnvironment({
        DATABASE_URL: 'postgresql://user:password@localhost:5432/obsidian_core',
      }),
    ).toMatchObject({ CORE_API_HOST: '127.0.0.1', CORE_API_PORT: 3000 });
  });

  it('rejects missing database configuration at startup', () => {
    expect(() => loadEnvironment({})).toThrow('Invalid environment configuration');
  });
});
