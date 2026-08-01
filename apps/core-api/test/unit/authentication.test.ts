import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const app = buildApp({
  verifyToken: async (token) => {
    if (token !== 'valid-token') throw new Error('invalid token');
    return { sub: 'auth0|user-123' };
  },
});

afterAll(async () => {
  await app.close();
});

describe('Auth0 authentication boundary', () => {
  it('rejects a protected route with no bearer token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/identity/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
    });
  });

  it('rejects a protected route with an invalid bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/identity/me',
      headers: { authorization: 'Bearer invalid-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a verified Auth0 subject', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/identity/me',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subject: 'auth0|user-123' });
  });

  it('keeps liveness public', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });
});
