import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const app = buildApp({
  authorizer: {
    authorize: async (_subject, requirement) => ({
      ...requirement,
      allowed: requirement.permissionKey === 'employee.profile.read',
    }),
  },
  employeeRepository: {
    getForSubject: async () => ({
      assignments: [
        {
          departmentId: 'department-1',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveTo: null,
          id: 'assignment-1',
          managerEmployeeProfileId: null,
          storeId: 'store-1',
        },
      ],
      id: 'employee-1',
      value: { jobTitle: 'Technician', name: 'Synthetic Employee' },
    }),
  },
  verifyToken: async () => ({ sub: 'auth0|employee' }),
});

afterAll(async () => app.close());

describe('employee profile boundary', () => {
  it('returns only the authenticated employee profile after authorization', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/employee-portal/profile',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      assignments: [{ departmentId: 'department-1', storeId: 'store-1' }],
      id: 'employee-1',
    });
  });

  it('denies a different employee-portal permission', async () => {
    const deniedApp = buildApp({
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      employeeRepository: { getForSubject: async () => null },
      verifyToken: async () => ({ sub: 'auth0|employee' }),
    });
    const response = await deniedApp.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/employee-portal/profile',
    });
    await deniedApp.close();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});
