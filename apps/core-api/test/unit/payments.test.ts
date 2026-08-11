import { describe, expect, it } from 'vitest';
import {
  loadPaymentProcessorConfiguration,
  loadSquareAdapterConfiguration,
  loadSquareDeviceCareConfiguration,
  loadSquareWebhookConfiguration,
  paymentRequestSchema,
  SquarePaymentProvider,
  verifySquareWebhookSignature,
} from '../../src/payments.js';
import { createHmac } from 'node:crypto';

const sandbox = {
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_SANDBOX_ACCESS_TOKEN: 'token',
  SQUARE_SANDBOX_APPLICATION_ID: 'app',
  SQUARE_SANDBOX_LOCATION_ID: 'location',
  SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL: 'https://api.example.test/v1/webhooks/square/sandbox',
  SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'signature-key',
};
describe('payment adapter contract', () => {
  it('uses sandbox configuration and integer payment amounts', () => {
    expect(loadSquareAdapterConfiguration(sandbox)).toMatchObject({ environment: 'sandbox' });
    expect(
      paymentRequestSchema.safeParse({
        amountMinor: '1999',
        currency: 'USD',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        paymentMethodReference: 'provider-token',
      }).success,
    ).toBe(true);
  });
  it('loads a webhook listener without enabling outbound payment processing', () => {
    expect(loadSquareWebhookConfiguration('sandbox', sandbox)).toEqual({
      environment: 'sandbox',
      notificationUrl: sandbox.SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL,
      signatureKey: sandbox.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY,
    });
    expect(loadSquareWebhookConfiguration('production', sandbox)).toBeUndefined();
  });
  it('requires both Square identifiers before Device Care enrollment is enabled', () => {
    expect(loadSquareDeviceCareConfiguration(sandbox)).toBeUndefined();
    expect(
      loadSquareDeviceCareConfiguration({
        ...sandbox,
        SQUARE_SANDBOX_DEVICE_CARE_PLAN_VARIATION_ID: 'variation',
        SQUARE_SANDBOX_DEVICE_CARE_ORDER_TEMPLATE_ID: 'order-template',
      }),
    ).toMatchObject({ environment: 'sandbox', planVariationId: 'variation' });
  });
  it('rejects production Square mode outside production', () =>
    expect(() =>
      loadSquareAdapterConfiguration({
        ...sandbox,
        SQUARE_ENVIRONMENT: 'production',
        SQUARE_PRODUCTION_ACCESS_TOKEN: 'token',
        SQUARE_PRODUCTION_APPLICATION_ID: 'app',
        SQUARE_PRODUCTION_LOCATION_ID: 'location',
        NODE_ENV: 'development',
      }),
    ).toThrow('NODE_ENV=production'));
  it('normalizes the Commerce360 selection to Access Worldpay configuration', () => {
    expect(
      loadPaymentProcessorConfiguration({
        PAYMENT_PROCESSOR: 'commerce360',
        WORLDPAY_ENVIRONMENT: 'try',
        WORLDPAY_PASSWORD: 'password',
        WORLDPAY_USERNAME: 'username',
      }),
    ).toMatchObject({
      processor: 'worldpay',
      configuration: { baseUrl: 'https://try.access.worldpay.com', environment: 'try' },
    });
  });
  it('sends only a provider token to Square and maps its response', async () => {
    const provider = new SquarePaymentProvider(
      loadSquareAdapterConfiguration(sandbox),
      async (_url, init) => {
        expect(init.headers).toMatchObject({ 'Square-Version': '2026-07-15' });
        expect(JSON.parse(String(init.body))).toMatchObject({
          source_id: 'provider-token',
          amount_money: { amount: 1999 },
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ payment: { id: 'square-payment', status: 'COMPLETED' } }),
        };
      },
    );
    await expect(
      provider.createPayment({
        amountMinor: 1999n,
        currency: 'USD',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        paymentMethodReference: 'provider-token',
      }),
    ).resolves.toEqual({ providerPaymentId: 'square-payment', status: 'completed' });
  });
  it('verifies Square webhook signatures in constant time', () => {
    const payload = '{"event_id":"event"}';
    const notificationUrl = sandbox.SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL;
    const signature = createHmac('sha256', sandbox.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY)
      .update(notificationUrl + payload)
      .digest('base64');
    expect(
      verifySquareWebhookSignature({
        notificationUrl,
        payload,
        signature,
        signatureKey: sandbox.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY,
      }),
    ).toBe(true);
    expect(
      verifySquareWebhookSignature({
        notificationUrl,
        payload,
        signature: 'not-valid',
        signatureKey: sandbox.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY,
      }),
    ).toBe(false);
  });
});
