import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { customerPortalPermissionDefinitions } from '../../src/customers.js';
const app = buildApp({
  verifyToken: async () => ({ sub: 'auth0|customer' }),
  authorizer: {
    authorize: async (_subject, requirement) => ({
      ...requirement,
      allowed: requirement.permissionKey === 'customer.profile.read',
    }),
  },
  customerRepository: {
    getForSubject: async () => ({ id: 'customer-1', value: { name: 'Customer' }, addresses: [] }),
  },
});
afterAll(async () => app.close());
describe('customer profile boundary', () => {
  it('defines every permission required by customer payment self-service routes', () => {
    expect(customerPortalPermissionDefinitions.map(([key]) => key)).toEqual(
      expect.arrayContaining(['payment-method.read', 'subscription.cancel']),
    );
  });
  it('returns only the authenticated customer profile after authorization', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/customer-portal/profile',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'customer-1' });
  });
});
