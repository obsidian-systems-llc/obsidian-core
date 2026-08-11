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
    closeAccountForSubject: async (_subject, input) =>
      input.reason === 'subscription still active'
        ? 'active_subscription'
        : { closedAt: new Date('2026-08-11T00:00:00Z'), status: 'closed' },
    getForSubject: async () => null,
    registerForSubject: async () => ({ addresses: [], id: 'customer-1', value: { name: 'Test' } }),
    updateForSubject: async (_subject, input) => ({
      addresses: [],
      id: 'customer-1',
      value: input.profile,
    }),
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
  it('updates only the authenticated customer profile with an idempotency key', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/customer-portal/profile',
      headers: { authorization: 'Bearer token' },
      payload: { idempotencyKey, profile: { name: 'Updated Customer', phone: '555-0100' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ value: { name: 'Updated Customer' } });
  });
  it('requires an explicit confirmation before closing an account', async () => {
    const invalid = await app.inject({
      method: 'DELETE',
      url: '/v1/customer-portal/account',
      headers: { authorization: 'Bearer token' },
      payload: { idempotencyKey },
    });
    expect(invalid.statusCode).toBe(400);
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/customer-portal/account',
      headers: { authorization: 'Bearer token' },
      payload: { confirmation: 'CLOSE_MY_ACCOUNT', idempotencyKey },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'closed' });
  });
  it('does not close an account while a subscription remains active', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/customer-portal/account',
      headers: { authorization: 'Bearer token' },
      payload: {
        confirmation: 'CLOSE_MY_ACCOUNT',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        reason: 'subscription still active',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'ACTIVE_SUBSCRIPTION_REQUIRES_CANCELLATION' },
    });
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
