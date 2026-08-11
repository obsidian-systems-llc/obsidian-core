import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const app = buildApp({
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  customerRepository: {
    getForSubject: async () => null,
    portalOverviewForSubject: async () => ({
      addresses: [],
      devices: [],
      id: '11111111-1111-4111-8111-111111111111',
      jobs: [],
      page: { limit: 50, nextOffset: null, offset: 0 },
      quotes: [],
      subscriptions: [],
      value: { name: 'Synthetic Customer' },
    }),
  },
  verifyToken: async () => ({ sub: 'auth0|customer' }),
});
afterAll(async () => app.close());

describe('customer portal overview boundary', () => {
  it('returns the authenticated customer overview after portal authorization', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/customer-portal/overview?limit=50&offset=0',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ value: { name: 'Synthetic Customer' }, devices: [] });
  });

  it('rejects unsafe pagination values', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/customer-portal/overview?limit=101',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_CUSTOMER_PORTAL_PAGINATION' },
    });
  });

  it('denies overview access without the portal permission', async () => {
    const denied = buildApp({
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      customerRepository: {
        getForSubject: async () => null,
        portalOverviewForSubject: async () => null,
      },
      verifyToken: async () => ({ sub: 'auth0|customer' }),
    });
    const response = await denied.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/customer-portal/overview',
    });
    await denied.close();
    expect(response.statusCode).toBe(403);
  });
});
