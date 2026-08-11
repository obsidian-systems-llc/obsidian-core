import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const methodId = '11111111-1111-4111-8111-111111111112';
const app = buildApp({
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  customerRepository: { getForSubject: async () => null },
  deviceCareRepository: {
    cancelForSubject: async () => ({
      id: 'subscription-1',
      providerSubscriptionReference: 'provider-subscription',
      renewalAt: null,
      status: 'active',
    }),
    enrollForSubject: async () => null,
    listPaymentMethodsForSubject: async () => [
      {
        brand: 'VISA',
        expMonth: 12,
        expYear: 2030,
        id: methodId,
        isPrimary: true,
        last4: '1111',
        status: 'active',
      },
    ],
    removePaymentMethodForSubject: async () => 'in_use',
    savePaymentMethodForSubject: async () => null,
    setPrimaryPaymentMethodForSubject: async () => ({
      brand: 'VISA',
      expMonth: 12,
      expYear: 2030,
      id: methodId,
      isPrimary: true,
      last4: '1111',
      status: 'active',
    }),
  },
  verifyToken: async () => ({ sub: 'auth0|customer' }),
});
afterAll(async () => app.close());

describe('customer payment method lifecycle API', () => {
  it('lists only safe payment metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/customer-portal/payment-methods',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        brand: 'VISA',
        expMonth: 12,
        expYear: 2030,
        id: methodId,
        isPrimary: true,
        last4: '1111',
        status: 'active',
      },
    ]);
  });
  it('rejects deletion of a method attached to an active subscription', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/customer-portal/payment-methods/${methodId}`,
      headers: { authorization: 'Bearer token' },
      payload: { idempotencyKey: '11111111-1111-4111-8111-111111111111' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'PAYMENT_METHOD_IN_USE' } });
  });
  it('cancels the caller’s Device Care agreement', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/customer-portal/subscriptions/device-care/cancel',
      headers: { authorization: 'Bearer token' },
      payload: { idempotencyKey: '11111111-1111-4111-8111-111111111111' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'subscription-1' });
  });
});
