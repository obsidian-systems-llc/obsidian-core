import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const idempotencyKey = '11111111-1111-4111-8111-111111111111';
const app = buildApp({
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  customerRepository: {
    addAddressForSubject: async () => ({ id: 'address-1', label: 'Home', value: { city: 'Test' } }),
    addDeviceForSubject: async () => ({
      id: 'device-1',
      status: 'active',
      value: { type: 'phone' },
    }),
    getForSubject: async () => null,
    registerForSubject: async () => ({ addresses: [], id: 'customer-1', value: { name: 'Test' } }),
  },
  jobRepository: {
    createRepairRequestForSubject: async () => ({
      id: '11111111-1111-4111-8111-111111111112',
      status: 'requested',
      windowEnd: new Date('2026-09-01T11:00:00Z'),
      windowStart: new Date('2026-09-01T10:00:00Z'),
    }),
    createForSubject: async () => null,
    transitionForSubject: async () => null,
  },
  verifyToken: async () => ({ sub: 'auth0|customer' }),
});
afterAll(async () => app.close());

describe('customer self-service API', () => {
  it('registers an authenticated customer without pre-existing portal access', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/customer-portal/registration',
      headers: { authorization: 'Bearer token' },
      payload: { email: 'customer@example.test', idempotencyKey, profile: { name: 'Test' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'customer-1' });
  });
  it('rejects malformed customer requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/customer-portal/repair-requests',
      headers: { authorization: 'Bearer token' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REPAIR_REQUEST' } });
  });
  it('creates an authorized repair request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/customer-portal/repair-requests',
      headers: { authorization: 'Bearer token' },
      payload: {
        addressId: '11111111-1111-4111-8111-111111111113',
        description: 'Synthetic device repair test request.',
        idempotencyKey,
        preferredWindowStart: '2026-09-01T10:00:00Z',
        preferredWindowEnd: '2026-09-01T11:00:00Z',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'requested' });
  });
});
