import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const wallet = {
  availableMinor: '6000',
  balanceMinor: '6000',
  discounts: { accessoriesBasisPoints: 1500, repairsBasisPoints: 1000 },
  maxStatus: false,
  membershipActive: true,
  usable: true,
};
const app = buildApp({
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  deviceCareWalletRepository: { forSubject: async () => wallet },
  verifyToken: async () => ({ sub: 'auth0|customer' }),
});
afterAll(async () => app.close());

describe('Device Care wallet API', () => {
  it('returns only Core-calculated membership and wallet state', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/customer-portal/device-care/wallet',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(wallet);
  });

  it('requires customer portal access', async () => {
    const denied = buildApp({
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      deviceCareWalletRepository: { forSubject: async () => wallet },
      verifyToken: async () => ({ sub: 'auth0|customer' }),
    });
    const response = await denied.inject({
      method: 'GET',
      url: '/v1/customer-portal/device-care/wallet',
      headers: { authorization: 'Bearer token' },
    });
    await denied.close();
    expect(response.statusCode).toBe(403);
  });
});
