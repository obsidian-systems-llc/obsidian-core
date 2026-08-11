import { Client } from 'pg';
import { z } from 'zod';
import { createAuditEvent } from './audit.js';
import type {
  PaymentFetch,
  SquareAdapterConfiguration,
  SquareDeviceCareConfiguration,
} from './payments.js';

export const savePaymentMethodSchema = z.object({
  cardholderName: z.string().trim().min(2).max(200),
  idempotencyKey: z.uuid(),
  saveCardConsent: z.literal(true),
  sourceId: z.string().trim().min(1).max(500),
  verificationToken: z.string().trim().min(1).max(2000).optional(),
});
export const enrollDeviceCareSchema = z.object({
  idempotencyKey: z.uuid(),
  paymentMethodId: z.uuid(),
});
export type SavedPaymentMethod = {
  brand: string | null;
  expMonth: number | null;
  expYear: number | null;
  id: string;
  last4: string | null;
  status: string;
};
export type DeviceCareEnrollment = {
  id: string;
  providerSubscriptionReference: string | null;
  renewalAt: Date | null;
  status: string;
};

type SquareCardProvider = {
  createCustomer(input: {
    email: string;
    idempotencyKey: string;
    name: string;
    referenceId: string;
  }): Promise<string>;
  saveCard(input: {
    customerReference: string;
    cardholderName: string;
    idempotencyKey: string;
    sourceId: string;
    verificationToken?: string;
  }): Promise<Omit<SavedPaymentMethod, 'id'>> & Promise<{ providerCardReference: string }>;
  createSubscription(input: {
    cardReference: string;
    customerReference: string;
    idempotencyKey: string;
  }): Promise<{ providerSubscriptionReference: string; renewalAt: Date | null; status: string }>;
};

const customerResponseSchema = z.object({ customer: z.object({ id: z.string().min(1) }) });
const cardResponseSchema = z.object({
  card: z.object({
    card_brand: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    exp_month: z.number().int().nullable().optional(),
    exp_year: z.number().int().nullable().optional(),
    id: z.string().min(1),
    last_4: z.string().nullable().optional(),
  }),
});
const subscriptionResponseSchema = z.object({
  subscription: z.object({
    charged_through_date: z.string().date().nullable().optional(),
    id: z.string().min(1),
    status: z.string().min(1),
  }),
});

export class SquareDeviceCareProvider implements SquareCardProvider {
  private readonly apiBaseUrl: string;
  constructor(
    private readonly square: SquareAdapterConfiguration,
    private readonly deviceCare: SquareDeviceCareConfiguration,
    private readonly fetcher: PaymentFetch = fetch,
  ) {
    this.apiBaseUrl =
      square.environment === 'sandbox'
        ? 'https://connect.squareupsandbox.com'
        : 'https://connect.squareup.com';
  }
  async createCustomer(input: {
    email: string;
    idempotencyKey: string;
    name: string;
    referenceId: string;
  }) {
    const [givenName, ...familyParts] = input.name.split(/\s+/);
    const body = await this.post('/v2/customers', {
      email_address: input.email,
      given_name: givenName,
      ...(familyParts.length ? { family_name: familyParts.join(' ') } : {}),
      idempotency_key: input.idempotencyKey,
      reference_id: input.referenceId,
    });
    const parsed = customerResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error('Square customer response was invalid.');
    return parsed.data.customer.id;
  }
  async saveCard(input: {
    customerReference: string;
    cardholderName: string;
    idempotencyKey: string;
    sourceId: string;
    verificationToken?: string;
  }) {
    const body = await this.post('/v2/cards', {
      card: { cardholder_name: input.cardholderName, customer_id: input.customerReference },
      idempotency_key: input.idempotencyKey,
      source_id: input.sourceId,
      ...(input.verificationToken ? { verification_token: input.verificationToken } : {}),
    });
    const parsed = cardResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error('Square card response was invalid.');
    const card = parsed.data.card;
    return {
      brand: card.card_brand ?? null,
      expMonth: card.exp_month ?? null,
      expYear: card.exp_year ?? null,
      last4: card.last_4 ?? null,
      providerCardReference: card.id,
      status: card.enabled === false ? 'inactive' : 'active',
    };
  }
  async createSubscription(input: {
    cardReference: string;
    customerReference: string;
    idempotencyKey: string;
  }) {
    const body = await this.post('/v2/subscriptions', {
      card_id: input.cardReference,
      customer_id: input.customerReference,
      idempotency_key: input.idempotencyKey,
      location_id: this.deviceCare.locationId,
      plan_variation_id: this.deviceCare.planVariationId,
      phases: [{ ordinal: 0, order_template_id: this.deviceCare.orderTemplateId }],
    });
    const parsed = subscriptionResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error('Square subscription response was invalid.');
    const subscription = parsed.data.subscription;
    return {
      providerSubscriptionReference: subscription.id,
      renewalAt: subscription.charged_through_date
        ? new Date(`${subscription.charged_through_date}T00:00:00.000Z`)
        : null,
      status: mapSubscriptionStatus(subscription.status),
    };
  }
  private async post(path: string, body: object): Promise<unknown> {
    const response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.square.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': this.square.apiVersion,
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Square request was not accepted (${response.status}).`);
    return result;
  }
}

export type DeviceCareRepository = {
  enrollForSubject(
    subject: string,
    input: z.infer<typeof enrollDeviceCareSchema>,
    correlationId: string,
  ): Promise<DeviceCareEnrollment | null>;
  savePaymentMethodForSubject(
    subject: string,
    input: z.infer<typeof savePaymentMethodSchema>,
    correlationId: string,
  ): Promise<SavedPaymentMethod | null>;
};

export class PostgresDeviceCareRepository implements DeviceCareRepository {
  constructor(
    private readonly databaseUrl: string,
    private readonly provider: SquareCardProvider,
    private readonly environment: 'sandbox' | 'production',
  ) {}
  async savePaymentMethodForSubject(
    subject: string,
    input: z.infer<typeof savePaymentMethodSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const customer = await this.customer(client, subject);
      if (!customer) return null;
      const existing = await client.query<SavedPaymentMethod>(
        `SELECT id,brand,last4,exp_month AS "expMonth",exp_year AS "expYear",status
         FROM customer_payment_methods WHERE customer_profile_id=$1 AND idempotency_key=$2`,
        [customer.profileId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
      const providerProfile = await client.query<{
        id: string;
        provider_customer_reference: string;
      }>(
        `SELECT id,provider_customer_reference FROM customer_payment_provider_profiles
         WHERE customer_profile_id=$1 AND provider='square' AND environment=$2 FOR UPDATE`,
        [customer.profileId, this.environment],
      );
      await client.query('COMMIT');
      const providerCustomerReference =
        providerProfile.rows[0]?.provider_customer_reference ??
        (await this.provider.createCustomer({
          email: customer.email,
          idempotencyKey: `${input.idempotencyKey}:customer`,
          name: input.cardholderName,
          referenceId: customer.profileId,
        }));
      const card = await this.provider.saveCard({
        customerReference: providerCustomerReference,
        idempotencyKey: input.idempotencyKey,
        cardholderName: input.cardholderName,
        sourceId: input.sourceId,
        ...(input.verificationToken ? { verificationToken: input.verificationToken } : {}),
      });
      await client.query('BEGIN');
      const profile = await client.query<{ id: string }>(
        `INSERT INTO customer_payment_provider_profiles (customer_profile_id,provider,environment,provider_customer_reference)
         VALUES ($1,'square',$2,$3)
         ON CONFLICT (customer_profile_id,provider,environment) DO UPDATE SET updated_at=now()
         RETURNING id`,
        [customer.profileId, this.environment, providerCustomerReference],
      );
      const saved = await client.query<SavedPaymentMethod>(
        `INSERT INTO customer_payment_methods (customer_profile_id,provider_profile_id,provider,provider_card_reference,status,brand,last4,exp_month,exp_year,consented_at,idempotency_key)
         VALUES ($1,$2,'square',$3,$4,$5,$6,$7,$8,now(),$9)
         ON CONFLICT (customer_profile_id,idempotency_key) DO UPDATE SET updated_at=now()
         RETURNING id,brand,last4,exp_month AS "expMonth",exp_year AS "expYear",status`,
        [
          customer.profileId,
          profile.rows[0]!.id,
          card.providerCardReference,
          card.status,
          card.brand,
          card.last4,
          card.expMonth,
          card.expYear,
          input.idempotencyKey,
        ],
      );
      await this.audit(
        client,
        customer.userId,
        'customer.payment_method_saved',
        saved.rows[0]!.id,
        correlationId,
        { provider: 'square', status: card.status },
      );
      await client.query('COMMIT');
      return saved.rows[0]!;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async enrollForSubject(
    subject: string,
    input: z.infer<typeof enrollDeviceCareSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const customer = await this.customer(client, subject);
      if (!customer) return null;
      const existing = await client.query<DeviceCareEnrollment>(
        `SELECT id,provider_subscription_reference AS "providerSubscriptionReference",renewal_at AS "renewalAt",status
         FROM customer_subscriptions WHERE customer_profile_id=$1 AND enrollment_idempotency_key=$2`,
        [customer.profileId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
      const card = await client.query<{
        provider_card_reference: string;
        provider_customer_reference: string;
      }>(
        `SELECT cpm.provider_card_reference,cpp.provider_customer_reference FROM customer_payment_methods cpm
         JOIN customer_payment_provider_profiles cpp ON cpp.id=cpm.provider_profile_id
         WHERE cpm.id=$1 AND cpm.customer_profile_id=$2 AND cpm.status='active' AND cpm.provider='square' AND cpp.environment=$3`,
        [input.paymentMethodId, customer.profileId, this.environment],
      );
      const plan = await client.query<{ id: string }>(
        `SELECT spv.id FROM subscription_plan_versions spv JOIN subscription_plans sp ON sp.id=spv.subscription_plan_id
         WHERE sp.key='device-care' AND spv.effective_from<=now() AND (spv.effective_to IS NULL OR spv.effective_to>now())
         ORDER BY spv.version_number DESC LIMIT 1`,
      );
      if (!card.rows[0] || !plan.rows[0]) {
        await client.query('ROLLBACK');
        throw new Error('DEVICE_CARE_CONFIGURATION_UNAVAILABLE');
      }
      await client.query('COMMIT');
      const providerSubscription = await this.provider.createSubscription({
        cardReference: card.rows[0].provider_card_reference,
        customerReference: card.rows[0].provider_customer_reference,
        idempotencyKey: input.idempotencyKey,
      });
      await client.query('BEGIN');
      const result = await client.query<DeviceCareEnrollment>(
        `INSERT INTO customer_subscriptions (customer_profile_id,subscription_plan_version_id,status,provider_subscription_reference,started_at,renewal_at,provider,provider_environment,customer_payment_method_id,enrollment_idempotency_key)
         VALUES ($1,$2,$3,$4,now(),$5,'square',$6,$7,$8)
         ON CONFLICT (customer_profile_id,enrollment_idempotency_key) WHERE enrollment_idempotency_key IS NOT NULL DO NOTHING
         RETURNING id,provider_subscription_reference AS "providerSubscriptionReference",renewal_at AS "renewalAt",status`,
        [
          customer.profileId,
          plan.rows[0]!.id,
          providerSubscription.status,
          providerSubscription.providerSubscriptionReference,
          providerSubscription.renewalAt,
          this.environment,
          input.paymentMethodId,
          input.idempotencyKey,
        ],
      );
      await this.audit(
        client,
        customer.userId,
        'customer.device_care_enrolled',
        result.rows[0]!.id,
        correlationId,
        { provider: 'square', status: result.rows[0]!.status },
      );
      await client.query('COMMIT');
      return result.rows[0]!;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async customer(client: Client, subject: string) {
    const result = await client.query<{ profile_id: string; user_id: string; email: string }>(
      `SELECT cpm.customer_profile_id AS profile_id,i.user_id,u.email FROM identities i JOIN users u ON u.id=i.user_id JOIN customer_profile_memberships cpm ON cpm.user_id=i.user_id JOIN customer_profiles cp ON cp.id=cpm.customer_profile_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND u.status='active' AND cp.status='active' AND cp.archived_at IS NULL ORDER BY cpm.created_at LIMIT 1`,
      [subject],
    );
    const row = result.rows[0];
    return row ? { profileId: row.profile_id, userId: row.user_id, email: row.email } : null;
  }
  private async audit(
    client: Client,
    actorUserId: string,
    action: string,
    targetId: string,
    correlationId: string,
    afterValue: Record<string, unknown>,
  ) {
    const event = createAuditEvent({
      actorUserId,
      action,
      targetType: 'customer_subscription',
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

function mapSubscriptionStatus(
  status: string,
): 'pending' | 'active' | 'past_due' | 'grace' | 'cancelled' {
  const normalized = status.toLowerCase();
  if (normalized === 'active') return 'active';
  if (normalized === 'paused') return 'grace';
  if (normalized === 'canceled' || normalized === 'cancelled' || normalized === 'deactivated')
    return 'cancelled';
  if (normalized === 'pending') return 'pending';
  return 'past_due';
}
