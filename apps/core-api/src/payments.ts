import { z } from 'zod';

export const paymentRequestSchema = z.object({
  amountMinor: z.bigint().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  idempotencyKey: z.uuid(),
  paymentMethodReference: z.string().min(1).max(500),
});
export type PaymentRequest = z.infer<typeof paymentRequestSchema>;
export type PaymentProvider = {
  createPayment(
    request: PaymentRequest,
  ): Promise<{ providerPaymentId: string; status: 'approved' | 'pending' }>;
  refund(input: {
    amountMinor: bigint;
    idempotencyKey: string;
    providerPaymentId: string;
  }): Promise<{ providerRefundId: string; status: 'pending' | 'refunded' }>;
};
export type SquareAdapterConfiguration = {
  accessToken: string;
  applicationId: string;
  environment: 'production' | 'sandbox';
  locationId: string;
};
type SquareEnvironment = {
  NODE_ENV?: string;
  SQUARE_ENVIRONMENT?: string;
  SQUARE_PRODUCTION_ACCESS_TOKEN?: string;
  SQUARE_PRODUCTION_APPLICATION_ID?: string;
  SQUARE_PRODUCTION_LOCATION_ID?: string;
  SQUARE_SANDBOX_ACCESS_TOKEN?: string;
  SQUARE_SANDBOX_APPLICATION_ID?: string;
  SQUARE_SANDBOX_LOCATION_ID?: string;
};
export function loadSquareAdapterConfiguration(
  source: SquareEnvironment = process.env,
): SquareAdapterConfiguration {
  const environment = source.SQUARE_ENVIRONMENT ?? 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production')
    throw new Error('SQUARE_ENVIRONMENT must be sandbox or production.');
  if (environment === 'production' && source.NODE_ENV !== 'production')
    throw new Error('Square production mode requires NODE_ENV=production.');
  const prefix = environment === 'production' ? 'SQUARE_PRODUCTION' : 'SQUARE_SANDBOX';
  const accessToken = source[`${prefix}_ACCESS_TOKEN` as keyof SquareEnvironment];
  const applicationId = source[`${prefix}_APPLICATION_ID` as keyof SquareEnvironment];
  const locationId = source[`${prefix}_LOCATION_ID` as keyof SquareEnvironment];
  if (!accessToken || !applicationId || !locationId)
    throw new Error(`Incomplete ${environment} Square configuration.`);
  return { accessToken, applicationId, environment, locationId };
}
