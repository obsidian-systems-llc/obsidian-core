import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const customerProfileId = '11111111-1111-4111-8111-111111111111';
const entitlement = {
  availableMinor: '6000',
  balanceMinor: '6000',
  discounts: { repairsBasisPoints: 1000, accessoriesBasisPoints: 1500 },
  maxStatus: false,
  membershipActive: true,
  policyVersion: 1,
  usable: true,
  benefits: [],
};
const repository = {
  forSubject: async () => entitlement,
  list: async () => ({ items: [], limit: 25, offset: 0, total: 0 }),
  get: async () => entitlement,
  addHouseholdMember: async () => ({ id: randomUUID(), status: 'active' as const }),
  applyRepairCredit: async () => ({ id: randomUUID(), amountMinor: '1500' }),
  adjustCredit: async () => ({ id: randomUUID(), amountMinor: '-1500' }),
  redeemBenefit: async () => ({ id: randomUUID(), status: 'redeemed' as const }),
  createMembershipPolicy: async () => ({ id: randomUUID(), version: 2 }),
};
const app = buildApp({
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  deviceCareEntitlementRepository: repository as never,
  verifyToken: async () => ({ sub: 'core|customer' }),
});
afterAll(async () => app.close());

describe('Device Care administrative API', () => {
  it('provides authorized, paginated member state and rejects malformed credit applications', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/core-admin/device-care/members',
      headers: { authorization: 'Bearer token' },
    });
    expect(list.statusCode).toBe(200);
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/core-admin/device-care/repair-credits/applications',
      headers: { authorization: 'Bearer token' },
      payload: { jobId: customerProfileId },
    });
    expect(invalid.statusCode).toBe(400);
  });
  it('accepts a controlled household verification and benefit redemption request', async () => {
    const household = await app.inject({
      method: 'POST',
      url: `/v1/core-admin/device-care/members/${customerProfileId}/household-members`,
      headers: { authorization: 'Bearer token' },
      payload: {
        memberCustomerProfileId: '22222222-2222-4222-8222-222222222222',
        relationship: 'spouse',
        idempotencyKey: randomUUID(),
      },
    });
    expect(household.statusCode).toBe(200);
    const benefit = await app.inject({
      method: 'POST',
      url: '/v1/core-admin/device-care/benefit-redemptions',
      headers: { authorization: 'Bearer token' },
      payload: { customerProfileId, benefitType: 'free_diagnostic', idempotencyKey: randomUUID() },
    });
    expect(benefit.statusCode).toBe(200);
  });
  it('validates staff credit adjustments', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/core-admin/device-care/credit-adjustments',
      headers: { authorization: 'Bearer token' },
      payload: { customerProfileId, amountMinor: 1500 },
    });
    expect(invalid.statusCode).toBe(400);
    const adjustment = await app.inject({
      method: 'POST',
      url: '/v1/core-admin/device-care/credit-adjustments',
      headers: { authorization: 'Bearer token' },
      payload: {
        customerProfileId,
        entryType: 'reversal',
        amountMinor: -1500,
        reason: 'Corrected duplicate credit.',
        idempotencyKey: randomUUID(),
      },
    });
    expect(adjustment.statusCode).toBe(200);
  });
  it('accepts a complete versioned membership-policy command', async () => {
    const policy = await app.inject({
      method: 'POST',
      url: '/v1/executive/device-care/membership-policy-versions',
      headers: { authorization: 'Bearer token' },
      payload: {
        accrualMinor: 1500,
        unlockMinor: 6000,
        capMinor: 35000,
        gracePeriodDays: 7,
        forfeitureAfterDays: 8,
        effectiveFrom: new Date().toISOString(),
        idempotencyKey: randomUUID(),
      },
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toMatchObject({ version: 2 });
  });
});
