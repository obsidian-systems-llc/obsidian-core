import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const app = buildApp({
  authorizer: { authorize: async (_s, r) => ({ ...r, allowed: true }) },
  compensationRepository: {
    addCommissionEvent: async (_s, id, input) => ({ id, status: input.status }),
    assign: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    createCommission: async () => ({
      id: '11111111-1111-4111-8111-111111111111',
      amountMinor: '1000',
    }),
    earnings: async () => ({ estimatedCommissionMinor: '1000', pendingCommissionMinor: '1000' }),
  },
  verifyToken: async () => ({ sub: 'auth0|employee' }),
});
afterAll(async () => app.close());

describe('compensation API', () => {
  it('authorizes a commission lifecycle event and exposes an estimate through distinct routes', async () => {
    const event = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      url: '/v1/core-admin/commissions/11111111-1111-4111-8111-111111111111/events',
      payload: { status: 'approved', reason: 'Manager review' },
    });
    const earnings = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/employee-portal/earnings-estimate',
    });
    expect(event.statusCode).toBe(200);
    expect(earnings.json()).toMatchObject({
      estimatedCommissionMinor: '1000',
      pendingCommissionMinor: '1000',
    });
  });
  it('denies compensation writes without permission', async () => {
    const denied = buildApp({
      authorizer: { authorize: async (_s, r) => ({ ...r, allowed: false }) },
      compensationRepository: {
        assign: async () => null,
        createCommission: async () => null,
        addCommissionEvent: async () => null,
        earnings: async () => null,
      },
      verifyToken: async () => ({ sub: 'auth0|employee' }),
    });
    const response = await denied.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      url: '/v1/core-admin/commissions',
      payload: {},
    });
    await denied.close();
    expect(response.statusCode).toBe(403);
  });
});
