import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const apiKey = 'retell-test-key';
const app = buildApp({
  retell: {
    apiKey,
    repository: {
      assign: async () => false,
      claimForEmployee: async () => 'unavailable',
      completeFollowUpForEmployee: async () => false,
      getForEmployee: async () => null,
      listAll: async () => [],
      listForEmployee: async () => [],
      processWebhook: async () => 'processed',
    },
  },
});
afterAll(async () => app.close());

describe('Retell webhook boundary', () => {
  it('accepts a current signed call event', async () => {
    const payload = JSON.stringify({ event: 'call_started', call: { call_id: 'retell-call-1' } });
    const timestamp = Date.now();
    const signature = `v=${timestamp},d=${createHmac('sha256', apiKey)
      .update(payload + timestamp)
      .digest('hex')}`;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/retell',
      payload,
      headers: { 'content-type': 'application/json', 'x-retell-signature': signature },
    });
    expect(response.statusCode).toBe(202);
  });
  it('rejects an unsigned event', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/retell',
      payload: { event: 'call_started', call: { call_id: 'retell-call-1' } },
    });
    expect(response.statusCode).toBe(403);
  });
});
