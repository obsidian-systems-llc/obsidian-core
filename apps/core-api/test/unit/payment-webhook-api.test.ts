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

describe('Stripe webhook boundary', () => {
  const stripeSecret = 'whsec_test';
  const stripeApp = buildApp({
    stripeWebhookRepository: { processStripeWebhook: async () => 'processed' },
    stripeWebhooks: {
      test: {
        environment: 'test',
        notificationUrl: 'https://api.example.test/v1/webhooks/stripe/test',
        signingSecret: stripeSecret,
        toleranceSeconds: 3600,
      },
    },
  });
  afterAll(async () => stripeApp.close());
  it('accepts a current correctly signed Stripe event and rejects stale or invalid messages', async () => {
    const payload = JSON.stringify({
      id: 'evt_1',
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'in_1',
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_1' },
          },
        },
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', stripeSecret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    const accepted = await stripeApp.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe/test',
      payload,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${signature}`,
      },
    });
    expect(accepted.statusCode).toBe(202);
    const rejected = await stripeApp.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe/test',
      payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
    });
    expect(rejected.statusCode).toBe(403);
  });
});
