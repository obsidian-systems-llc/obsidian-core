import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { SensitiveRouteRateLimiter } from '../../src/security.js';

const apiSecurity = {
  allowedOrigins: ['https://panel.example.test'],
  sensitiveRateLimitMax: 10,
  sensitiveRateLimitWindowMs: 60_000,
  stepUpClaim: 'https://obsidian-systems.tech/authentication',
  stepUpValue: 'mfa',
};
const app = buildApp({
  apiSecurity,
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  subscriptionPlanRepository: {
    createVersion: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  },
  verifyToken: async () => ({
    sub: 'auth0|executive',
    'https://obsidian-systems.tech/authentication': ['mfa'],
  }),
});
afterAll(async () => app.close());

describe('API perimeter security', () => {
  it('limits sensitive routes within a bounded window', () => {
    const limiter = new SensitiveRouteRateLimiter(1, 1000);
    expect(limiter.allow('ip', 100)).toBe(true);
    expect(limiter.allow('ip', 200)).toBe(false);
    expect(limiter.allow('ip', 1200)).toBe(true);
  });

  it('allows configured CORS origins and rejects unconfigured origins', async () => {
    const allowed = await app.inject({
      headers: { origin: 'https://panel.example.test' },
      method: 'OPTIONS',
      url: '/v1/executive/overview',
    });
    const denied = await app.inject({
      headers: { origin: 'https://untrusted.example.test' },
      method: 'GET',
      url: '/health',
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://panel.example.test');
    expect(denied.statusCode).toBe(403);
  });

  it('accepts a step-up claim for subscription plan changes', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      payload: {
        amountMinor: '1500',
        cadence: 'monthly',
        currency: 'USD',
        effectiveFrom: '2026-08-04T00:00:00Z',
        name: 'Test plan',
        planKey: 'test-plan',
      },
      url: '/v1/executive/subscription-plan-versions',
    });
    expect(response.statusCode).toBe(200);
  });
});
