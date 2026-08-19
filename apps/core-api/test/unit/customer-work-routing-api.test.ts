import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
const work = {
  id: '11111111-1111-4111-8111-111111111111',
  workType: 'repair_job' as const,
  employeeProfileId: '22222222-2222-4222-8222-222222222222',
  priority: 'high',
  status: 'routed',
};
const repository = {
  route: async () => work,
  escalate: async () => work,
  complete: async () => true,
  listForEmployee: async () => ({ work: [work], notifications: [] }),
};
const app = buildApp({
  customerWorkRoutingRepository: repository,
  authorizer: { authorize: async (_s, r) => ({ ...r, allowed: true }) },
  verifyToken: async () => ({ sub: 'auth0|employee' }),
});
afterAll(async () => app.close());
describe('customer work routing API', () => {
  it('routes repair work through the manager permission', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/employee-portal/customer-work/repair_job/11111111-1111-4111-8111-111111111111/route',
      headers: { authorization: 'Bearer t' },
      payload: {
        employeeProfileId: '22222222-2222-4222-8222-222222222222',
        priority: 'high',
        reason: 'Manager assignment',
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(r.statusCode).toBe(200);
  });
  it('denies routing without permission', async () => {
    const denied = buildApp({
      customerWorkRoutingRepository: repository,
      authorizer: { authorize: async (_s, r) => ({ ...r, allowed: false }) },
      verifyToken: async () => ({ sub: 'auth0|employee' }),
    });
    const r = await denied.inject({
      method: 'GET',
      url: '/v1/employee-portal/customer-work',
      headers: { authorization: 'Bearer t' },
    });
    await denied.close();
    expect(r.statusCode).toBe(403);
  });
});
