import { describe, expect, it } from 'vitest';
import { SquareDeviceCareProvider } from '../../src/device-care.js';

const square = {
  accessToken: 'token',
  apiVersion: '2026-07-15',
  applicationId: 'app',
  environment: 'sandbox' as const,
  locationId: 'location',
  webhookNotificationUrl: 'https://api.example.test/webhook',
  webhookSignatureKey: 'signature',
};
const deviceCare = {
  environment: 'sandbox' as const,
  locationId: 'location',
  orderTemplateId: 'customer-neutral-order',
  planVariationId: 'monthly-variation',
};

describe('Square Device Care provider', () => {
  it('creates a subscription against the configured plan and customer-neutral order template', async () => {
    const provider = new SquareDeviceCareProvider(square, deviceCare, async (_url, init) => {
      expect(init.headers).toMatchObject({ 'Square-Version': '2026-07-15' });
      expect(JSON.parse(String(init.body))).toEqual({
        card_id: 'card-1',
        customer_id: 'customer-1',
        idempotency_key: '11111111-1111-4111-8111-111111111111',
        location_id: 'location',
        plan_variation_id: 'monthly-variation',
        phases: [{ ordinal: 0, order_template_id: 'customer-neutral-order' }],
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ subscription: { id: 'subscription-1', status: 'ACTIVE' } }),
      };
    });
    await expect(
      provider.createSubscription({
        cardReference: 'card-1',
        customerReference: 'customer-1',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toMatchObject({ providerSubscriptionReference: 'subscription-1', status: 'active' });
  });
});
