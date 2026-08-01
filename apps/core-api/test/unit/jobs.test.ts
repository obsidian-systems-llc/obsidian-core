import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const app = buildApp({
  authorizer: { authorize: async (_s, r) => ({ ...r, allowed: true }) },
  jobRepository: {
    createForSubject: async () => ({
      id: jobId,
      status: 'requested',
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 3600000),
    }),
    transitionForSubject: async () => ({
      id: jobId,
      status: 'scheduled',
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 3600000),
    }),
  },
  verifyToken: async () => ({ sub: 'auth0|job' }),
});
afterAll(async () => app.close());
describe('job workflow boundary', () => {
  it('creates authorized jobs and rejects malformed transitions', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/core-admin/jobs',
      headers: { authorization: 'Bearer token' },
      payload: {
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        windowStart: '2026-08-01T09:00:00Z',
        windowEnd: '2026-08-01T10:00:00Z',
      },
    });
    const invalid = await app.inject({
      method: 'POST',
      url: `/v1/core-admin/jobs/${jobId}/transitions`,
      headers: { authorization: 'Bearer token' },
      payload: { idempotencyKey: 'bad', toStatus: 'scheduled' },
    });
    expect(created.statusCode).toBe(200);
    expect(invalid.statusCode).toBe(400);
  });
  it('denies a caller without job permissions', async () => {
    const denied = buildApp({
      authorizer: { authorize: async (_s, r) => ({ ...r, allowed: false }) },
      jobRepository: { createForSubject: async () => null, transitionForSubject: async () => null },
      verifyToken: async () => ({ sub: 'auth0|job' }),
    });
    const response = await denied.inject({
      method: 'POST',
      url: '/v1/core-admin/jobs',
      headers: { authorization: 'Bearer token' },
      payload: {},
    });
    await denied.close();
    expect(response.statusCode).toBe(403);
  });
});
