import { describe, expect, it } from 'vitest';
import { loadSquareAdapterConfiguration, paymentRequestSchema } from '../../src/payments.js';

const sandbox = {
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_SANDBOX_ACCESS_TOKEN: 'token',
  SQUARE_SANDBOX_APPLICATION_ID: 'app',
  SQUARE_SANDBOX_LOCATION_ID: 'location',
};
describe('payment adapter contract', () => {
  it('uses sandbox configuration and integer payment amounts', () => {
    expect(loadSquareAdapterConfiguration(sandbox)).toMatchObject({ environment: 'sandbox' });
    expect(
      paymentRequestSchema.safeParse({
        amountMinor: 1999n,
        currency: 'USD',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        paymentMethodReference: 'provider-token',
      }).success,
    ).toBe(true);
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
});
