import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const idempotencyKey = '22222222-2222-4222-8222-222222222222';
const app = buildApp({
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  jobRepository: {
    createForSubject: async () => null,
    listForAssignedSubject: async () => [
      {
        id: jobId,
        status: 'assigned',
        windowEnd: new Date('2026-08-10T11:00:00.000Z'),
        windowStart: new Date('2026-08-10T10:00:00.000Z'),
      },
    ],
    transitionForAssignedSubject: async () => ({
      id: jobId,
      status: 'accepted',
      windowEnd: new Date('2026-08-10T11:00:00.000Z'),
      windowStart: new Date('2026-08-10T10:00:00.000Z'),
    }),
    transitionForSubject: async () => null,
  },
  mobileTimekeepingRepository: {
    mobileStateForSubject: async () => ({ activeBreakStartedAt: null, clockedInAt: null }),
    recordMobileEvent: async () => ({
      activeBreakStartedAt: null,
      clockedInAt: new Date('2026-08-10T10:00:00.000Z'),
    }),
  },
  verifyToken: async () => ({ sub: 'auth0|employee' }),
});

afterAll(async () => app.close());

describe('employee mobile boundary', () => {
  it('returns only the authorized employee mobile contract', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/employee-mobile/jobs',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{ id: jobId, status: 'assigned' }]);
  });

  it('validates and records idempotent mobile clock commands', async () => {
    const invalid = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      payload: { eventType: 'clock_in', idempotencyKey: 'not-a-uuid' },
      url: '/v1/employee-mobile/time-events',
    });
    const accepted = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      payload: { eventType: 'clock_in', idempotencyKey },
      url: '/v1/employee-mobile/time-events',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_MOBILE_TIME_EVENT' } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ clockedInAt: '2026-08-10T10:00:00.000Z' });
  });

  it('denies mobile routes without the application permission', async () => {
    const denied = buildApp({
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      mobileTimekeepingRepository: {
        mobileStateForSubject: async () => null,
        recordMobileEvent: async () => null,
      },
      verifyToken: async () => ({ sub: 'auth0|employee' }),
    });
    const response = await denied.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/employee-mobile/timekeeping-state',
    });
    await denied.close();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});
