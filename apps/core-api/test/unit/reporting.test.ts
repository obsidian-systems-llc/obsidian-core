import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { laborCostMinor, laborToSalesBasisPoints } from '../../src/reporting.js';
describe('operating aggregates', () =>
  it('uses integer minor units and labels zero sales as undefined', () => {
    const v = {
      collectedRevenueMinor: 0n,
      estimatedCommissionsMinor: 1000n,
      estimatedHourlyWagesMinor: 3000n,
      netSalesMinor: 20000n,
    };
    expect(laborCostMinor(v)).toBe(4000n);
    expect(laborToSalesBasisPoints(v)).toBe(2000n);
    expect(laborToSalesBasisPoints({ ...v, netSalesMinor: 0n })).toBeNull();
  }));

const overviewApp = buildApp({
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  reportingRepository: {
    listForSubject: async () => [],
    overviewForSubject: async () => ({ current: null, previous: null }),
  },
  verifyToken: async () => ({ sub: 'auth0|executive' }),
});
afterAll(async () => overviewApp.close());

describe('executive overview boundary', () => {
  it('requires authenticated executive authorization before returning an overview', async () => {
    const allowed = await overviewApp.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/executive/overview',
    });
    const deniedApp = buildApp({
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      reportingRepository: { listForSubject: async () => [], overviewForSubject: async () => null },
      verifyToken: async () => ({ sub: 'auth0|executive' }),
    });
    const denied = await deniedApp.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/executive/overview',
    });
    await deniedApp.close();
    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
  });
});
