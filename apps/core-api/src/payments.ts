import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { createAuditEvent } from './audit.js';

export const paymentRequestSchema = z.object({
  amountMinor: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => BigInt(value))
    .pipe(z.bigint().positive()),
  currency: z.string().regex(/^[A-Z]{3}$/),
  idempotencyKey: z.uuid(),
  paymentMethodReference: z.string().min(1).max(500),
});
export type PaymentRequest = z.infer<typeof paymentRequestSchema>;
export const refundRequestSchema = z.object({
  amountMinor: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => BigInt(value))
    .pipe(z.bigint().positive()),
  idempotencyKey: z.uuid(),
  reason: z.string().min(1).max(192),
});
export type RefundRequest = z.infer<typeof refundRequestSchema>;

export type PaymentProvider = {
  createPayment(
    request: PaymentRequest,
  ): Promise<{ providerPaymentId: string; status: PaymentStatus }>;
  refund(input: {
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
    providerPaymentId: string;
    reason: string;
  }): Promise<{ providerRefundId: string; status: RefundStatus }>;
};
export type PaymentStatus = 'approved' | 'completed' | 'cancelled' | 'failed' | 'pending';
export type RefundStatus = 'approved' | 'failed' | 'pending' | 'refunded';
export type SquareAdapterConfiguration = {
  accessToken: string;
  applicationId: string;
  environment: 'production' | 'sandbox';
  locationId: string;
  apiVersion: string;
  webhookNotificationUrl: string;
  webhookSignatureKey: string;
};
export type SquareWebhookConfiguration = {
  environment: 'production' | 'sandbox';
  notificationUrl: string;
  signatureKey: string;
};
export type SquareDeviceCareConfiguration = {
  environment: 'production' | 'sandbox';
  locationId: string;
  planVariationId: string;
  orderTemplateId: string;
};
export type WorldpayAdapterConfiguration = {
  baseUrl: string;
  environment: 'production' | 'try';
  password: string;
  username: string;
};
export type PaymentProcessorConfiguration =
  | { processor: 'square'; configuration: SquareAdapterConfiguration }
  | { processor: 'worldpay'; configuration: WorldpayAdapterConfiguration };
type PaymentEnvironment = {
  NODE_ENV?: string;
  PAYMENT_PROCESSOR?: string;
  SQUARE_ENVIRONMENT?: string;
  SQUARE_API_VERSION?: string;
  SQUARE_PRODUCTION_ACCESS_TOKEN?: string;
  SQUARE_PRODUCTION_APPLICATION_ID?: string;
  SQUARE_PRODUCTION_LOCATION_ID?: string;
  SQUARE_PRODUCTION_DEVICE_CARE_PLAN_VARIATION_ID?: string;
  SQUARE_PRODUCTION_DEVICE_CARE_ORDER_TEMPLATE_ID?: string;
  SQUARE_PRODUCTION_WEBHOOK_NOTIFICATION_URL?: string;
  SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY?: string;
  SQUARE_SANDBOX_ACCESS_TOKEN?: string;
  SQUARE_SANDBOX_APPLICATION_ID?: string;
  SQUARE_SANDBOX_LOCATION_ID?: string;
  SQUARE_SANDBOX_DEVICE_CARE_PLAN_VARIATION_ID?: string;
  SQUARE_SANDBOX_DEVICE_CARE_ORDER_TEMPLATE_ID?: string;
  SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL?: string;
  SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY?: string;
  WORLDPAY_BASE_URL?: string;
  WORLDPAY_ENVIRONMENT?: string;
  WORLDPAY_PASSWORD?: string;
  WORLDPAY_USERNAME?: string;
};

export function loadSquareAdapterConfiguration(
  source: PaymentEnvironment = process.env,
): SquareAdapterConfiguration {
  const environment = source.SQUARE_ENVIRONMENT ?? 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production')
    throw new Error('SQUARE_ENVIRONMENT must be sandbox or production.');
  if (environment === 'production' && source.NODE_ENV !== 'production')
    throw new Error('Square production mode requires NODE_ENV=production.');
  const prefix = environment === 'production' ? 'SQUARE_PRODUCTION' : 'SQUARE_SANDBOX';
  const value = (name: string) => source[`${prefix}_${name}` as keyof PaymentEnvironment];
  const accessToken = value('ACCESS_TOKEN');
  const applicationId = value('APPLICATION_ID');
  const locationId = value('LOCATION_ID');
  const webhookNotificationUrl = value('WEBHOOK_NOTIFICATION_URL');
  const webhookSignatureKey = value('WEBHOOK_SIGNATURE_KEY');
  if (
    !accessToken ||
    !applicationId ||
    !locationId ||
    !webhookNotificationUrl ||
    !webhookSignatureKey
  )
    throw new Error(`Incomplete ${environment} Square configuration.`);
  if (!z.url().safeParse(webhookNotificationUrl).success)
    throw new Error('Square webhook notification URL must be an absolute URL.');
  return {
    accessToken,
    applicationId,
    environment,
    locationId,
    webhookNotificationUrl,
    webhookSignatureKey,
    apiVersion: source.SQUARE_API_VERSION ?? '2026-07-15',
  };
}

/**
 * Loads only the configuration necessary to authenticate a Square webhook.
 * Webhook intake is deliberately independent from outbound payment processing so
 * Core can record provider lifecycle events before card charging is enabled.
 */
export function loadSquareWebhookConfiguration(
  environment: 'sandbox' | 'production',
  source: PaymentEnvironment = process.env,
): SquareWebhookConfiguration | undefined {
  const prefix = environment === 'production' ? 'SQUARE_PRODUCTION' : 'SQUARE_SANDBOX';
  const notificationUrl = source[`${prefix}_WEBHOOK_NOTIFICATION_URL` as keyof PaymentEnvironment];
  const signatureKey = source[`${prefix}_WEBHOOK_SIGNATURE_KEY` as keyof PaymentEnvironment];
  if (!notificationUrl && !signatureKey) return undefined;
  if (!notificationUrl || !signatureKey)
    throw new Error(`Incomplete ${environment} Square webhook configuration.`);
  if (!z.url().safeParse(notificationUrl).success)
    throw new Error('Square webhook notification URL must be an absolute URL.');
  return { environment, notificationUrl, signatureKey };
}

/** Loads the opt-in Device Care catalog mapping without enabling card collection by itself. */
export function loadSquareDeviceCareConfiguration(
  source: PaymentEnvironment = process.env,
): SquareDeviceCareConfiguration | undefined {
  const environment = source.SQUARE_ENVIRONMENT ?? 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production')
    throw new Error('SQUARE_ENVIRONMENT must be sandbox or production.');
  const prefix = environment === 'production' ? 'SQUARE_PRODUCTION' : 'SQUARE_SANDBOX';
  const value = (name: string) => source[`${prefix}_${name}` as keyof PaymentEnvironment];
  const locationId = value('LOCATION_ID');
  const planVariationId = value('DEVICE_CARE_PLAN_VARIATION_ID');
  const orderTemplateId = value('DEVICE_CARE_ORDER_TEMPLATE_ID');
  if (!planVariationId && !orderTemplateId) return undefined;
  if (!locationId || !planVariationId || !orderTemplateId)
    throw new Error(`Incomplete ${environment} Device Care Square configuration.`);
  return { environment, locationId, planVariationId, orderTemplateId };
}

export function loadWorldpayAdapterConfiguration(
  source: PaymentEnvironment = process.env,
): WorldpayAdapterConfiguration {
  const environment = source.WORLDPAY_ENVIRONMENT ?? 'try';
  if (environment !== 'try' && environment !== 'production')
    throw new Error('WORLDPAY_ENVIRONMENT must be try or production.');
  if (environment === 'production' && source.NODE_ENV !== 'production')
    throw new Error('Worldpay production mode requires NODE_ENV=production.');
  if (!source.WORLDPAY_USERNAME || !source.WORLDPAY_PASSWORD)
    throw new Error(`Incomplete ${environment} Worldpay configuration.`);
  return {
    baseUrl:
      source.WORLDPAY_BASE_URL ??
      (environment === 'production'
        ? 'https://access.worldpay.com'
        : 'https://try.access.worldpay.com'),
    environment,
    password: source.WORLDPAY_PASSWORD,
    username: source.WORLDPAY_USERNAME,
  };
}

export function loadPaymentProcessorConfiguration(
  source: PaymentEnvironment = process.env,
): PaymentProcessorConfiguration {
  const selected = source.PAYMENT_PROCESSOR ?? 'square';
  if (selected === 'square')
    return { processor: 'square', configuration: loadSquareAdapterConfiguration(source) };
  if (selected === 'worldpay' || selected === 'commerce360')
    return { processor: 'worldpay', configuration: loadWorldpayAdapterConfiguration(source) };
  throw new Error('PAYMENT_PROCESSOR must be square, worldpay, or commerce360.');
}

type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type PaymentFetch = (url: string, init: RequestInit) => Promise<FetchResponse>;
const squarePaymentSchema = z.object({
  payment: z.object({ id: z.string().min(1), status: z.string().min(1) }),
});
const squareRefundSchema = z.object({
  refund: z.object({ id: z.string().min(1), status: z.string().min(1) }),
});

function safeMinorAmount(amountMinor: bigint): number {
  if (amountMinor > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Payment amount is too large.');
  return Number(amountMinor);
}
function paymentStatus(status: string): PaymentStatus {
  const value = status.toLowerCase();
  return value === 'completed' ||
    value === 'approved' ||
    value === 'cancelled' ||
    value === 'failed'
    ? value
    : 'pending';
}
function refundStatus(status: string): RefundStatus {
  const value = status.toLowerCase();
  return value === 'approved' || value === 'failed' || value === 'pending' ? value : 'refunded';
}
function subscriptionStatus(
  status: string,
): 'pending' | 'active' | 'past_due' | 'grace' | 'cancelled' {
  switch (status.toLowerCase()) {
    case 'active':
      return 'active';
    case 'pending':
      return 'pending';
    case 'past_due':
      return 'past_due';
    case 'grace':
      return 'grace';
    case 'canceled':
    case 'cancelled':
    case 'deactivated':
      return 'cancelled';
    default:
      return 'pending';
  }
}

export class SquarePaymentProvider implements PaymentProvider {
  private readonly apiBaseUrl: string;
  constructor(
    private readonly configuration: SquareAdapterConfiguration,
    private readonly fetcher: PaymentFetch = fetch,
  ) {
    this.apiBaseUrl =
      configuration.environment === 'sandbox'
        ? 'https://connect.squareupsandbox.com'
        : 'https://connect.squareup.com';
  }
  async createPayment(
    request: PaymentRequest,
  ): Promise<{ providerPaymentId: string; status: PaymentStatus }> {
    const response = await this.fetcher(`${this.apiBaseUrl}/v2/payments`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        idempotency_key: request.idempotencyKey,
        source_id: request.paymentMethodReference,
        location_id: this.configuration.locationId,
        amount_money: { amount: safeMinorAmount(request.amountMinor), currency: request.currency },
      }),
    });
    const body = await response.json();
    if (!response.ok)
      throw new PaymentProviderError('Square payment request was not accepted.', response.status);
    const parsed = squarePaymentSchema.safeParse(body);
    if (!parsed.success)
      throw new PaymentProviderError('Square payment response was invalid.', 502);
    return {
      providerPaymentId: parsed.data.payment.id,
      status: paymentStatus(parsed.data.payment.status),
    };
  }
  async refund(input: {
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
    providerPaymentId: string;
    reason: string;
  }): Promise<{ providerRefundId: string; status: RefundStatus }> {
    const response = await this.fetcher(`${this.apiBaseUrl}/v2/refunds`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        idempotency_key: input.idempotencyKey,
        payment_id: input.providerPaymentId,
        amount_money: { amount: safeMinorAmount(input.amountMinor), currency: input.currency },
        reason: input.reason,
      }),
    });
    const body = await response.json();
    if (!response.ok)
      throw new PaymentProviderError('Square refund request was not accepted.', response.status);
    const parsed = squareRefundSchema.safeParse(body);
    if (!parsed.success) throw new PaymentProviderError('Square refund response was invalid.', 502);
    return {
      providerRefundId: parsed.data.refund.id,
      status: refundStatus(parsed.data.refund.status),
    };
  }
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.configuration.accessToken}`,
      'Content-Type': 'application/json',
      'Square-Version': this.configuration.apiVersion,
    };
  }
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export function verifySquareWebhookSignature(input: {
  notificationUrl: string;
  payload: string;
  signature: string;
  signatureKey: string;
}): boolean {
  const expected = createHmac('sha256', input.signatureKey)
    .update(input.notificationUrl + input.payload, 'utf8')
    .digest();
  const received = Buffer.from(input.signature, 'base64');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export const squareWebhookEventSchema = z.object({
  event_id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  created_at: z.string().datetime().optional(),
  data: z.object({
    object: z.object({
      payment: z.object({ id: z.string().min(1), status: z.string().min(1) }).optional(),
      invoice: z
        .object({
          id: z.string().min(1),
          subscription_id: z.string().min(1).optional(),
          status: z.string().min(1).optional(),
        })
        .optional(),
      subscription: z
        .object({
          id: z.string().min(1),
          status: z.string().min(1),
          version: z.number().int().nonnegative().optional(),
          charged_through_date: z.string().optional(),
        })
        .optional(),
    }),
  }),
});

export type PaymentRepository = {
  createForSubject(
    subject: string,
    request: PaymentRequest,
    correlationId: string,
  ): Promise<PaymentOperation | null>;
  refundForSubject(
    subject: string,
    paymentId: string,
    request: RefundRequest,
    correlationId: string,
  ): Promise<PaymentRefund | null>;
  processSquareWebhook(
    event: z.infer<typeof squareWebhookEventSchema>,
    payload: string,
    environment?: 'sandbox' | 'production',
  ): Promise<'processed' | 'duplicate'>;
};
export type PaymentOperation = {
  amountMinor: string;
  currency: string;
  id: string;
  providerPaymentReference: string | null;
  status: PaymentStatus;
};
export type PaymentRefund = {
  amountMinor: string;
  id: string;
  providerRefundReference: string | null;
  status: RefundStatus;
};

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(
    private readonly databaseUrl: string,
    private readonly provider?: PaymentProvider,
  ) {}
  async createForSubject(
    subject: string,
    request: PaymentRequest,
    correlationId: string,
  ): Promise<PaymentOperation | null> {
    if (!this.provider)
      throw new PaymentProviderError('Outbound payment processing is disabled.', 503);
    const client = new Client({ connectionString: this.databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      const actor = await client.query<{ id: string }>(
        "SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND u.archived_at IS NULL",
        [subject],
      );
      if (!actor.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const existing = await client.query<PaymentOperation>(
        'SELECT id, amount_minor::text AS "amountMinor", currency, provider_payment_reference AS "providerPaymentReference", status FROM payment_operations WHERE provider=\'square\' AND idempotency_key=$1',
        [request.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
      const id = randomUUID();
      await client.query(
        "INSERT INTO payment_operations (id, provider, status, currency, amount_minor, idempotency_key, created_by_user_id) VALUES ($1,'square','pending',$2,$3,$4,$5)",
        [
          id,
          request.currency,
          request.amountMinor.toString(),
          request.idempotencyKey,
          actor.rows[0].id,
        ],
      );
      await client.query('COMMIT');
      try {
        const result = await this.provider.createPayment(request);
        await client.query('BEGIN');
        await client.query(
          'UPDATE payment_operations SET provider_payment_reference=$2,status=$3,updated_at=now() WHERE id=$1',
          [id, result.providerPaymentId, result.status],
        );
        await this.audit(client, actor.rows[0].id, 'payment.created', id, correlationId, {
          provider: 'square',
          status: result.status,
        });
        await client.query('COMMIT');
        return {
          id,
          amountMinor: request.amountMinor.toString(),
          currency: request.currency,
          providerPaymentReference: result.providerPaymentId,
          status: result.status,
        };
      } catch (error) {
        await client.query(
          "UPDATE payment_operations SET status='failed',updated_at=now() WHERE id=$1",
          [id],
        );
        throw error;
      }
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The transaction may already have been closed before an external-provider failure.
      }
      throw error;
    } finally {
      await client.end();
    }
  }
  async refundForSubject(
    subject: string,
    paymentId: string,
    request: RefundRequest,
    correlationId: string,
  ): Promise<PaymentRefund | null> {
    if (!this.provider)
      throw new PaymentProviderError('Outbound payment processing is disabled.', 503);
    const client = new Client({ connectionString: this.databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      const payment = await client.query<{
        amount_minor: string;
        currency: string;
        provider_payment_reference: string;
        user_id: string;
      }>(
        "SELECT po.amount_minor::text,po.currency,po.provider_payment_reference, i.user_id FROM payment_operations po JOIN identities i ON i.user_id=po.created_by_user_id WHERE po.id=$1 AND i.provider='auth0' AND i.provider_subject=$2 AND po.provider='square' FOR UPDATE",
        [paymentId, subject],
      );
      const source = payment.rows[0];
      if (!source?.provider_payment_reference) {
        await client.query('ROLLBACK');
        return null;
      }
      if (request.amountMinor > BigInt(source.amount_minor))
        throw new Error('Refund amount exceeds payment amount.');
      const refundTotal = await client.query<{ total: string }>(
        "SELECT COALESCE(SUM(amount_minor),0)::text AS total FROM payment_refunds WHERE payment_operation_id=$1 AND status IN ('pending','approved','refunded')",
        [paymentId],
      );
      if (
        request.amountMinor + BigInt(refundTotal.rows[0]?.total ?? '0') >
        BigInt(source.amount_minor)
      )
        throw new Error('Refund amount exceeds remaining payment balance.');
      const existing = await client.query<PaymentRefund>(
        'SELECT id, amount_minor::text AS "amountMinor", provider_refund_reference AS "providerRefundReference", status FROM payment_refunds WHERE payment_operation_id=$1 AND idempotency_key=$2',
        [paymentId, request.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
      const id = randomUUID();
      await client.query(
        "INSERT INTO payment_refunds (id,payment_operation_id,status,amount_minor,idempotency_key) VALUES ($1,$2,'pending',$3,$4)",
        [id, paymentId, request.amountMinor.toString(), request.idempotencyKey],
      );
      await client.query('COMMIT');
      try {
        const result = await this.provider.refund({
          ...request,
          currency: source.currency,
          providerPaymentId: source.provider_payment_reference,
        });
        await client.query('BEGIN');
        await client.query(
          'UPDATE payment_refunds SET provider_refund_reference=$2,status=$3,updated_at=now() WHERE id=$1',
          [id, result.providerRefundId, result.status],
        );
        await this.audit(client, source.user_id, 'payment.refunded', paymentId, correlationId, {
          refundId: id,
          status: result.status,
        });
        await client.query('COMMIT');
        return {
          id,
          amountMinor: request.amountMinor.toString(),
          providerRefundReference: result.providerRefundId,
          status: result.status,
        };
      } catch (error) {
        await client.query(
          "UPDATE payment_refunds SET status='failed',updated_at=now() WHERE id=$1",
          [id],
        );
        throw error;
      }
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The transaction may already have been closed before an external-provider failure.
      }
      throw error;
    } finally {
      await client.end();
    }
  }
  async processSquareWebhook(
    event: z.infer<typeof squareWebhookEventSchema>,
    payload: string,
    environment?: 'sandbox' | 'production',
  ): Promise<'processed' | 'duplicate'> {
    const client = new Client({ connectionString: this.databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      const stored = await client.query(
        'INSERT INTO payment_webhook_events (provider,provider_event_reference,event_type,payload_sha256,occurred_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider,provider_event_reference) DO NOTHING RETURNING id',
        [
          'square',
          event.event_id,
          event.type,
          createHash('sha256').update(payload).digest('hex'),
          event.created_at ?? new Date().toISOString(),
        ],
      );
      if (!stored.rows[0]) {
        await client.query('ROLLBACK');
        return 'duplicate';
      }
      const payment = event.data.object.payment;
      if (payment) {
        const updated = await client.query<{ id: string }>(
          'UPDATE payment_operations SET status=$2,updated_at=now() WHERE provider=$1 AND provider_payment_reference=$3 RETURNING id',
          ['square', paymentStatus(payment.status), payment.id],
        );
        if (updated.rows[0])
          await this.audit(
            client,
            null,
            'payment.webhook_processed',
            updated.rows[0].id,
            randomUUID(),
            { provider: 'square', eventType: event.type, status: paymentStatus(payment.status) },
          );
      }
      const subscription = event.data.object.subscription;
      if (subscription) {
        const status = subscriptionStatus(subscription.status);
        const updated = await client.query<{ id: string }>(
          `UPDATE customer_subscriptions
           SET status=$1, provider_version=COALESCE($2, provider_version),
               renewal_at=COALESCE($3::date, renewal_at), updated_at=now(),
               cancelled_at=CASE WHEN $1='cancelled' THEN COALESCE(cancelled_at,now()) ELSE cancelled_at END
           WHERE provider='square' AND provider_subscription_reference=$4
             AND ($5::text IS NULL OR provider_environment=$5)
           RETURNING id`,
          [
            status,
            subscription.version ?? null,
            subscription.charged_through_date ?? null,
            subscription.id,
            environment ?? null,
          ],
        );
        if (updated.rows[0])
          await this.audit(
            client,
            null,
            'subscription.webhook_reconciled',
            updated.rows[0].id,
            randomUUID(),
            { provider: 'square', eventType: event.type, status },
            'customer_subscription',
          );
      }
      const invoice = event.data.object.invoice;
      if (event.type === 'invoice.payment_made' && invoice?.subscription_id) {
        await this.accrueDeviceCareCredit(client, {
          eventId: event.event_id,
          invoiceId: invoice.id,
          providerSubscriptionReference: invoice.subscription_id,
          ...(environment ? { environment } : {}),
        });
      }
      await client.query(
        "UPDATE payment_webhook_events SET processed_at=now(), status='processed' WHERE id=$1",
        [stored.rows[0].id],
      );
      await client.query('COMMIT');
      return 'processed';
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A duplicate event intentionally rolls back before this defensive guard executes.
      }
      throw error;
    } finally {
      await client.end();
    }
  }
  private async accrueDeviceCareCredit(
    client: Client,
    input: {
      eventId: string;
      invoiceId: string;
      providerSubscriptionReference: string;
      environment?: 'sandbox' | 'production';
    },
  ): Promise<void> {
    const subscription = await client.query<{
      id: string;
      policy_id: string;
      accrual_minor: string;
      cap_minor: string;
    }>(
      `SELECT cs.id, policy.id AS policy_id, policy.accrual_minor::text, policy.cap_minor::text
       FROM customer_subscriptions cs
       JOIN subscription_plan_versions spv ON spv.id=cs.subscription_plan_version_id
       JOIN subscription_plans sp ON sp.id=spv.subscription_plan_id AND sp.key='device-care'
       JOIN LATERAL (
         SELECT id,accrual_minor,cap_minor FROM device_care_membership_policies
         WHERE effective_from<=now() AND (effective_to IS NULL OR effective_to>now())
         ORDER BY version_number DESC LIMIT 1
       ) policy ON true
       WHERE cs.provider='square' AND cs.provider_subscription_reference=$1
         AND cs.status='active' AND ($2::text IS NULL OR cs.provider_environment=$2)
       FOR UPDATE`,
      [input.providerSubscriptionReference, input.environment ?? null],
    );
    const row = subscription.rows[0];
    if (!row) return;
    const existing = await client.query(
      'SELECT 1 FROM device_care_credit_ledger WHERE provider_invoice_reference=$1',
      [input.invoiceId],
    );
    if (existing.rows[0]) return;
    const total = await client.query<{ balance: string }>(
      'SELECT COALESCE(SUM(amount_minor),0)::text AS balance FROM device_care_credit_ledger WHERE customer_subscription_id=$1',
      [row.id],
    );
    const remaining = BigInt(row.cap_minor) - BigInt(total.rows[0]?.balance ?? '0');
    const credit =
      remaining > 0n
        ? remaining < BigInt(row.accrual_minor)
          ? remaining
          : BigInt(row.accrual_minor)
        : 0n;
    if (credit === 0n) return;
    await client.query(
      `INSERT INTO device_care_credit_ledger
       (customer_subscription_id,membership_policy_id,entry_type,amount_minor,provider_invoice_reference,provider_event_reference)
       VALUES ($1,$2,'accrual',$3,$4,$5)`,
      [row.id, row.policy_id, credit.toString(), input.invoiceId, input.eventId],
    );
    await this.audit(
      client,
      null,
      'device_care.credit_accrued',
      row.id,
      randomUUID(),
      {
        amountMinor: credit.toString(),
        provider: 'square',
        providerInvoiceReference: input.invoiceId,
      },
      'customer_subscription',
    );
  }
  private async audit(
    client: Client,
    actorUserId: string | null,
    action: string,
    targetId: string,
    correlationId: string,
    afterValue: Record<string, unknown>,
    targetType = 'payment_operation',
  ): Promise<void> {
    const event = createAuditEvent({
      actorUserId,
      action,
      targetType,
      targetId,
      correlationId,
      reason: null,
      beforeValue: null,
      afterValue,
    });
    await client.query(
      'INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,reason,before_value,after_value,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        event.actorUserId,
        event.action,
        event.targetType,
        event.targetId,
        event.correlationId,
        event.reason,
        event.beforeValue,
        event.afterValue,
        event.occurredAt,
      ],
    );
  }
}
