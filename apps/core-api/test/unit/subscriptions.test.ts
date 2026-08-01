import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { DEFAULT_DEVICE_PROTECTION_PLAN } from '../../src/subscriptions.js';

const app = buildApp({
  authorizer: { authorize: async (_s, r) => ({ ...r, allowed: true }) },
  subscriptionPlanRepository: {
    createVersion: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  },
  verifyToken: async () => ({ sub: 'auth0|executive' }),
});
afterAll(async () => app.close());
describe('subscription plans', () => {
  it('uses a configurable $15 monthly protection-plan default', () =>
    expect(DEFAULT_DEVICE_PROTECTION_PLAN.amountMinor).toBe(1500n));
});
