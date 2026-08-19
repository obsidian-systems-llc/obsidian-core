import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const role = {
  id: '11111111-1111-4111-8111-111111111111',
  applicationKey: 'employee-portal',
  key: 'technician',
  name: 'Technician',
  permissionKeys: ['communication.call.read'],
};
const repository = {
  assignRole: async () => ({
    id: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    roleId: role.id,
    effectiveFrom: new Date(),
    effectiveTo: null,
  }),
  createRole: async () => role,
  grantEntitlement: async () => ({
    id: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    applicationKey: 'employee-portal',
    effectiveFrom: new Date(),
    effectiveTo: null,
  }),
  listRoles: async () => [role],
  replaceRolePermissions: async () => role,
  revokeEntitlement: async () => true,
  revokeRoleAssignment: async () => true,
};
const app = buildApp({
  authorizationAdminRepository: repository,
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  apiSecurity: {
    allowedOrigins: [],
    sensitiveRateLimitMax: 100,
    sensitiveRateLimitWindowMs: 60_000,
    stepUpClaim: 'https://obsidian-systems.tech/step_up',
    stepUpValue: 'true',
  },
  verifyToken: async () => ({
    sub: 'auth0|admin',
    'https://obsidian-systems.tech/step_up': 'true',
  }),
});
afterAll(async () => app.close());

describe('authorization administration API', () => {
  it('requires administrative authorization and step-up before creating a role', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/core-admin/authorization/roles',
      headers: { authorization: 'Bearer token' },
      payload: {
        applicationKey: 'employee-portal',
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
        key: 'technician',
        name: 'Technician',
        permissionKeys: ['communication.call.read'],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ key: 'technician' });
  });

  it('denies a caller without authorization management access', async () => {
    const denied = buildApp({
      authorizationAdminRepository: repository,
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      verifyToken: async () => ({ sub: 'auth0|admin' }),
    });
    const response = await denied.inject({
      method: 'GET',
      url: '/v1/core-admin/authorization/roles',
      headers: { authorization: 'Bearer token' },
    });
    await denied.close();
    expect(response.statusCode).toBe(403);
  });
});
