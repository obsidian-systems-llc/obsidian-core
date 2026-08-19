import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const employee = {
  employeeNumber: 'EMP-100',
  employmentStatus: 'active',
  id: '11111111-1111-4111-8111-111111111111',
  startDate: '2026-08-01',
  endDate: null,
  value: { name: 'Synthetic Employee', title: 'Technician' },
};
const repository = {
  getForAdmin: async () => employee,
  create: async () => employee,
  replaceProfile: async () => employee,
  deactivate: async () => true,
  reactivate: async () => true,
  createAssignment: async () => ({
    id: '22222222-2222-4222-8222-222222222222',
    storeId: '33333333-3333-4333-8333-333333333333',
    departmentId: null,
    managerEmployeeProfileId: null,
    effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    effectiveTo: null,
  }),
  endAssignment: async () => true,
  listManaged: async () => ({ items: [employee], nextOffset: null }),
};
const app = buildApp({
  employeeAdministrationRepository: repository,
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  apiSecurity: {
    allowedOrigins: [],
    sensitiveRateLimitMax: 100,
    sensitiveRateLimitWindowMs: 60_000,
    stepUpClaim: 'https://obsidian-systems.tech/step_up',
    stepUpValue: 'true',
  },
  verifyToken: async () => ({
    sub: 'auth0|administrator',
    'https://obsidian-systems.tech/step_up': 'true',
  }),
});
afterAll(async () => app.close());

describe('employee administration API', () => {
  it('creates encrypted employee lifecycle records only with employee.manage and step-up', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/core-admin/employees',
      headers: { authorization: 'Bearer token' },
      payload: {
        userId: '44444444-4444-4444-8444-444444444444',
        employeeNumber: 'EMP-100',
        profile: { name: 'Synthetic Employee' },
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ employeeNumber: 'EMP-100' });
  });

  it('lets an authorized manager read only Core-scoped employee records', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/employee-portal/managed-employees',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ employeeNumber: 'EMP-100' }] });
  });

  it('denies a caller without manager scope permission', async () => {
    const denied = buildApp({
      employeeAdministrationRepository: repository,
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      verifyToken: async () => ({ sub: 'auth0|employee' }),
    });
    const response = await denied.inject({
      method: 'GET',
      url: '/v1/employee-portal/managed-employees',
      headers: { authorization: 'Bearer token' },
    });
    await denied.close();
    expect(response.statusCode).toBe(403);
  });
});
