import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const app = buildApp({
  verifyToken: async (token) => {
    if (token === 'valid-token') return { sub: 'auth0|user-123' };
    throw new Error('invalid token');
  },
  authorizer: {
    authorize: async (_subject, requirement) => ({
      ...requirement,
      allowed: requirement.permissionKey === 'authorization.read',
      userId: 'f4793d8c-ea47-4ee4-9a8c-926dc6a3db7d',
    }),
  },
});

afterAll(async () => {
  await app.close();
});

describe('authorization boundary', () => {
  it('denies authenticated users without an application entitlement and permission', async () => {
    const deniedApp = buildApp({
      verifyToken: async () => ({ sub: 'auth0|user-123' }),
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
    });
    const response = await deniedApp.inject({
      method: 'GET',
      url: '/v1/core-admin/authorization/access',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'You are not authorized to perform this action.' },
    });
    await deniedApp.close();
  });

  it('allows a user with the required entitlement and permission', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/core-admin/authorization/access',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'authorized' });
  });

  it('does not treat authentication as authorization', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/core-admin/authorization/access',
      headers: { authorization: 'Bearer invalid-token' },
    });
    expect(response.statusCode).toBe(401);
  });
});
