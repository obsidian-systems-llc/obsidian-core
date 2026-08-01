import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const hierarchy = {
  organizations: [
    { id: 'organization-1', code: 'OBS', name: 'Obsidian Systems', businessUnits: [] },
  ],
  unassignedDepartments: [],
};
const app = buildApp({
  verifyToken: async () => ({ sub: 'auth0|user-123' }),
  authorizer: {
    authorize: async (_subject, requirement) => ({
      ...requirement,
      allowed: requirement.permissionKey === 'organization.read',
    }),
  },
  organizationRepository: { getHierarchy: async () => hierarchy },
});

afterAll(async () => {
  await app.close();
});

describe('organization hierarchy boundary', () => {
  it('returns hierarchy only to users with the organization permission', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/core-admin/organization-hierarchy',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(hierarchy);
  });

  it('denies users without the organization permission', async () => {
    const deniedApp = buildApp({
      verifyToken: async () => ({ sub: 'auth0|user-123' }),
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      organizationRepository: { getHierarchy: async () => hierarchy },
    });
    const response = await deniedApp.inject({
      method: 'GET',
      url: '/v1/core-admin/organization-hierarchy',
      headers: { authorization: 'Bearer token' },
    });
    expect(response.statusCode).toBe(403);
    await deniedApp.close();
  });
});
