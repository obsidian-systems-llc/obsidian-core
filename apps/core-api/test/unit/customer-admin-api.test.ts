import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const customer = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'active',
  value: { name: 'Synthetic Customer' },
};
const repository = {
  create: async () => customer,
  get: async () => customer,
  update: async () => customer,
  associateRepair: async () => ({
    id: '22222222-2222-4222-8222-222222222222',
    customerProfileId: customer.id,
    status: 'requested',
    windowStart: new Date(),
    windowEnd: new Date(),
  }),
  listPortalRepairs: async () => ({
    items: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        status: 'requested',
        windowStart: new Date(),
        windowEnd: new Date(),
      },
    ],
    nextOffset: null,
  }),
};
const app = buildApp({
  customerAdministrationRepository: repository,
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  apiSecurity: {
    allowedOrigins: [],
    sensitiveRateLimitMax: 100,
    sensitiveRateLimitWindowMs: 60_000,
    stepUpClaim: 'https://obsidian-systems.tech/step_up',
    stepUpValue: 'true',
  },
  verifyToken: async () => ({
    sub: 'auth0|admin',
    'https://obsidian-systems.tech/step_up': 'true',
  }),
});
afterAll(async () => app.close());

describe('customer and repair administration API', () => {
  it('creates an encrypted admin customer only after authorization and step-up', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/core-admin/customers',
      headers: { authorization: 'Bearer token' },
      payload: {
        profile: { name: 'Synthetic Customer' },
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: customer.id });
  });
  it('returns the customer-safe repair status portal contract', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/customer-portal/repairs',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ status: 'requested' }] });
  });
  it('denies a missing customer-management permission', async () => {
    const denied = buildApp({
      customerAdministrationRepository: repository,
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      verifyToken: async () => ({ sub: 'auth0|admin' }),
    });
    const response = await denied.inject({
      method: 'POST',
      url: '/v1/core-admin/customers',
      headers: { authorization: 'Bearer token' },
      payload: {
        profile: { name: 'Synthetic Customer' },
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
      },
    });
    await denied.close();
    expect(response.statusCode).toBe(403);
  });
});
