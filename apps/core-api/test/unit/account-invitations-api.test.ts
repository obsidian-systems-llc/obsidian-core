import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const invitation = {
  id: '11111111-1111-4111-8111-111111111111',
  applicationKey: 'executive-panel',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  recipientEmail: 'partner@example.test',
  roleKey: 'executive',
  roleName: 'Executive',
  status: 'queued' as const,
};
const repository = {
  isRegistrationEligible: async () => true,
  accept: async () => ({
    applicationKey: 'executive-panel',
    roleKey: 'executive',
    roleName: 'Executive',
  }),
  create: async () => invitation,
  deliverPending: async () => 0,
  list: async () => [invitation],
  revoke: async () => true,
};
const app = buildApp({
  accountInvitationRepository: repository,
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  apiSecurity: {
    allowedOrigins: [],
    sensitiveRateLimitMax: 100,
    sensitiveRateLimitWindowMs: 60_000,
    stepUpClaim: 'https://obsidian-systems.tech/step_up',
    stepUpValue: 'true',
  },
  invitationEmailClaim: 'email',
  verifyToken: async () => ({
    sub: 'auth0|invited',
    email: 'partner@example.test',
    'https://obsidian-systems.tech/step_up': 'true',
  }),
});
afterAll(async () => app.close());

describe('account invitation API', () => {
  it('requires invitation permission and step-up to issue an email-specific invitation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/core-admin/account-invitations',
      headers: { authorization: 'Bearer token' },
      payload: {
        email: 'partner@example.test',
        roleId: '22222222-2222-4222-8222-222222222222',
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ recipientEmail: 'partner@example.test' });
  });

  it('allows an authenticated invitee to accept without pre-existing Core access', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/account-invitations/accept',
      headers: { authorization: 'Bearer token' },
      payload: {
        token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        idempotencyKey: '33333333-3333-4333-8333-333333333334',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ applicationKey: 'executive-panel' });
  });

  it('does not expose invitation routes to a caller without invitation authorization', async () => {
    const denied = buildApp({
      accountInvitationRepository: repository,
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      invitationEmailClaim: 'email',
      verifyToken: async () => ({ sub: 'auth0|denied', email: 'partner@example.test' }),
    });
    const response = await denied.inject({
      method: 'GET',
      url: '/v1/core-admin/account-invitations',
      headers: { authorization: 'Bearer token' },
    });
    await denied.close();
    expect(response.statusCode).toBe(403);
  });
});
