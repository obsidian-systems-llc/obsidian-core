import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const quoteId = '11111111-1111-4111-8111-111111111111';
const app = buildApp({
  authorizer: { authorize: async (_subject, requirement) => ({ ...requirement, allowed: true }) },
  quoteRepository: {
    createForSubject: async () => ({
      currency: 'USD',
      id: quoteId,
      items: [
        {
          catalogItemKey: 'screen-repair',
          catalogItemVersionId: '22222222-2222-4222-8222-222222222222',
          lineAmountMinor: '1999',
          name: 'Synthetic Repair',
          quantity: 1,
          unitAmountMinor: '1999',
        },
      ],
      totalAmountMinor: '1999',
    }),
  },
  verifyToken: async () => ({ sub: 'auth0|quote-creator' }),
});

afterAll(async () => app.close());

describe('quote boundary', () => {
  it('creates a Core-priced quote after server-side authorization', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      payload: {
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        items: [{ catalogItemKey: 'screen-repair', quantity: 1 }],
      },
      url: '/v1/core-admin/quotes',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: quoteId, totalAmountMinor: '1999' });
  });

  it('rejects invalid quote input before pricing', async () => {
    const response = await app.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      payload: { idempotencyKey: 'not-a-uuid', items: [] },
      url: '/v1/core-admin/quotes',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_QUOTE' } });
  });

  it('denies quote creation without its permission', async () => {
    const deniedApp = buildApp({
      authorizer: {
        authorize: async (_subject, requirement) => ({ ...requirement, allowed: false }),
      },
      quoteRepository: { createForSubject: async () => null },
      verifyToken: async () => ({ sub: 'auth0|quote-creator' }),
    });
    const response = await deniedApp.inject({
      headers: { authorization: 'Bearer token' },
      method: 'POST',
      payload: {
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        items: [{ catalogItemKey: 'screen-repair', quantity: 1 }],
      },
      url: '/v1/core-admin/quotes',
    });
    await deniedApp.close();
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});
