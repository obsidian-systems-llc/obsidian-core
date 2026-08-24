import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';

const repository = {
  registerCustomer: vi.fn(async () => ({
    profileId: '11111111-1111-4111-8111-111111111111',
    verificationRequired: true as const,
  })),
  registerWorkforce: vi.fn(async () => ({ verificationRequired: true as const })),
  linkLegacyIdentity: vi.fn(async () => ({
    accessToken: 'linked-access-token',
    refreshToken: 'linked-refresh-token',
    expiresIn: 900,
  })),
  login: vi.fn(async () => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 900,
  })),
  refresh: vi.fn(async () => ({
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
    expiresIn: 900,
  })),
  logout: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => [
    {
      id: '11111111-1111-4111-8111-111111111114',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      lastUsedAt: null,
      authenticationMethods: ['pwd'],
    },
  ]),
  revokeSession: vi.fn(async () => true as const),
  confirmEmail: vi.fn(async () => true as const),
  requestPasswordReset: vi.fn(async () => undefined),
  confirmPasswordReset: vi.fn(async () => true as const),
  beginMfaEnrollment: vi.fn(async () => ({
    factorId: '11111111-1111-4111-8111-111111111113',
    otpauthUri: 'otpauth://totp/Obsidian',
    recoveryCodes: ['synthetic-recovery-code'],
  })),
  confirmMfaEnrollment: vi.fn(async () => true as const),
  stepUp: vi.fn(async () => ({ accessToken: 'step-up-token', expiresIn: 300 })),
};
const workforceInvitationRepository = {
  isRegistrationEligible: vi.fn(async () => true),
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  accept: vi.fn(),
  deliverPending: vi.fn(),
};
const app = buildApp({
  coreIdentityRepository: repository,
  accountInvitationRepository: workforceInvitationRepository,
  coreIdentitySessionCookie: { maxAgeSeconds: 2_592_000, name: 'core_session', secure: true },
  verifyToken: async () => ({ sub: 'core|user' }),
});

afterAll(async () => app.close());

describe('Core-owned identity API', () => {
  const registration = {
    email: 'customer@example.test',
    password: 'a secure synthetic password',
    profile: { firstName: 'Synthetic', lastName: 'Customer' },
    idempotencyKey: '11111111-1111-4111-8111-111111111112',
  };
  it('creates a customer account without an existing identity-provider token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/identity/customer-registration',
      payload: registration,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      profileId: '11111111-1111-4111-8111-111111111111',
      verificationRequired: true,
    });
  });
  it('does not return a verification secret from registration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/identity/customer-registration',
      payload: registration,
    });
    expect(JSON.stringify(response.json())).not.toContain('token');
  });
  it('requires an active email-specific invitation for workforce registration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/identity/workforce-registration',
      payload: {
        email: 'employee@example.test',
        password: registration.password,
        invitationToken: 'a'.repeat(43),
        idempotencyKey: '11111111-1111-4111-8111-111111111115',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ verificationRequired: true });
    expect(workforceInvitationRepository.isRegistrationEligible).toHaveBeenCalledWith(
      'a'.repeat(43),
      'employee@example.test',
    );
  });
  it('returns a short-lived bearer access token and rotating refresh credential after login', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/identity/login',
      payload: { email: registration.email, password: registration.password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accessToken: 'access-token',
      expiresIn: 900,
      tokenType: 'Bearer',
    });
    expect(response.headers['set-cookie']).toContain('HttpOnly');
  });
  it('rejects malformed password reset requests and accepts a generic request response', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/identity/password-reset/request',
      payload: { email: 'invalid' },
    });
    expect(malformed.statusCode).toBe(400);
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/identity/password-reset/request',
      payload: { email: registration.email },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ status: 'accepted' });
  });
  it('requires a valid token-shaped secret for verification and session changes', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/identity/email-verification/confirm',
      payload: { token: 'short' },
    });
    expect(invalid.statusCode).toBe(400);
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/identity/session/refresh',
      payload: { token: 'a'.repeat(43) },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ accessToken: 'new-access-token' });
    expect(refreshed.headers['set-cookie']).toContain('new-refresh-token');
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/identity/logout',
      payload: { token: 'a'.repeat(43) },
    });
    expect(logout.statusCode).toBe(204);
  });
  it('enrolls and confirms MFA, then issues a short-lived step-up token', async () => {
    const enrolled = await app.inject({
      method: 'POST',
      url: '/v1/identity/mfa/enrollment',
      headers: { authorization: 'Bearer synthetic' },
    });
    expect(enrolled.statusCode).toBe(201);
    expect(enrolled.json()).toMatchObject({ factorId: expect.any(String) });
    const confirmed = await app.inject({
      method: 'POST',
      url: '/v1/identity/mfa/enrollment/confirm',
      headers: { authorization: 'Bearer synthetic' },
      payload: { code: '123456' },
    });
    expect(confirmed.statusCode).toBe(200);
    const steppedUp = await app.inject({
      method: 'POST',
      url: '/v1/identity/mfa/step-up',
      headers: { authorization: 'Bearer synthetic' },
      payload: { code: '123456' },
    });
    expect(steppedUp.json()).toEqual({
      accessToken: 'step-up-token',
      expiresIn: 300,
      tokenType: 'Bearer',
    });
  });
  it('lists and revokes only Core-owned sessions', async () => {
    const sessions = await app.inject({
      method: 'GET',
      url: '/v1/identity/sessions',
      headers: { authorization: 'Bearer synthetic' },
    });
    expect(sessions.statusCode).toBe(200);
    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/identity/sessions/11111111-1111-4111-8111-111111111114/revoke',
      headers: { authorization: 'Bearer synthetic' },
      payload: { reason: 'Synthetic session test.' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ status: 'revoked' });
  });
});
