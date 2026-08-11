import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const notificationUrl = 'https://api.example.test/v1/webhooks/square/sandbox';
const signatureKey = 'test-signature-key';
const app = buildApp({
  squareWebhookRepository: {
    processSquareWebhook: async () => 'processed',
  },
  squareWebhooks: { sandbox: { environment: 'sandbox', notificationUrl, signatureKey } },
});
afterAll(async () => app.close());

describe('Square webhook boundary', () => {
  it('accepts a correctly signed event without authentication', async () => {
    const payload = JSON.stringify({
      event_id: 'event-1',
      type: 'payment.updated',
      data: { object: { payment: { id: 'payment-1', status: 'COMPLETED' } } },
    });
    const signature = createHmac('sha256', signatureKey)
      .update(notificationUrl + payload)
      .digest('base64');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/square/sandbox',
      payload,
      headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'processed' });
  });
  it('rejects an unsigned event', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/square/sandbox',
      payload: { event_id: 'event-1', type: 'payment.updated', data: { object: {} } },
    });
    expect(response.statusCode).toBe(403);
  });
});
