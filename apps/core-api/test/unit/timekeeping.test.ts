import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const timeEntryId = '11111111-1111-4111-8111-111111111111';
const app = buildApp({
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  timekeepingRepository: {
    correctForSubject: async () => ({
      correctedAt: new Date('2026-08-01T12:00:00Z'),
      endedAt: new Date('2026-08-01T17:00:00Z'),
      id: timeEntryId,
      source: 'web',
      startedAt: new Date('2026-08-01T09:00:00Z'),
      totalSeconds: 28800,
    }),
    createForSubject: async () => ({
      correctedAt: null,
      endedAt: new Date('2026-08-01T17:00:00Z'),
      id: timeEntryId,
      source: 'web',
      startedAt: new Date('2026-08-01T09:00:00Z'),
      totalSeconds: 28800,
    }),
    listForSubject: async () => [],
  },
  verifyToken: async () => ({ sub: 'auth0|employee' }),
});

afterAll(async () => app.close());

describe('timekeeping boundary', () => {
  it('creates a self-service time entry after employee-portal authorization', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      payload: {
        endedAt: '2026-08-01T17:00:00Z',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        source: 'web',
        startedAt: '2026-08-01T09:00:00Z',
      },
      url: '/v1/employee-portal/time-entries',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: timeEntryId, totalSeconds: 28800 });
  });

  it('rejects invalid durations before reaching the repository', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      payload: {
        endedAt: '2026-08-01T09:00:00Z',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        source: 'web',
        startedAt: '2026-08-01T17:00:00Z',
      },
      url: '/v1/employee-portal/time-entries',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_TIME_ENTRY' } });
  });

  it('denies timekeeping without the required permission', async () => {
    const deniedApp = buildApp({
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      timekeepingRepository: {
        correctForSubject: async () => null,
        createForSubject: async () => null,
        listForSubject: async () => null,
      },
      verifyToken: async () => ({ sub: 'auth0|employee' }),
    });
    const response = await deniedApp.inject({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      url: '/v1/employee-portal/time-entries',
    });
    await deniedApp.close();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});
