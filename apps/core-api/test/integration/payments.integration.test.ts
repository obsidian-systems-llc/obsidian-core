import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPaymentRepository, type PaymentProvider } from '../../src/payments.js';
import {
  PostgresDeviceCareRepository,
  type DeviceCareCardProvider,
} from '../../src/device-care.js';
import { PostgresDeviceCareWalletRepository } from '../../src/device-care-wallet.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL payment repository', () => {
  const userId = randomUUID();
  const paymentIdempotencyKey = randomUUID();
  const subject = `auth0|payment-${userId}`;
  const client = new Client({ connectionString: databaseUrl });
  const provider: PaymentProvider = {
    createPayment: async () => ({ providerPaymentId: `square-${userId}`, status: 'completed' }),
    refund: async () => ({ providerRefundId: `refund-${userId}`, status: 'refunded' }),
  };
  const repository = new PostgresPaymentRepository(databaseUrl!, provider);
  const walletRepository = new PostgresDeviceCareWalletRepository(databaseUrl!);
  let paymentId: string;
  let customerProfileId: string;
  let subscriptionId: string;

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO users (id,email) VALUES ($1,$2)', [
      userId,
      `payment-${userId}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,'auth0',$2)",
      [userId, subject],
    );
  });
  afterAll(async () => {
    await client.query(
      "DELETE FROM payment_webhook_events WHERE provider_event_reference IN ('event-payment-test',$1)",
      [`invoice-payment-${userId}`],
    );
    if (subscriptionId)
      await client.query(
        'DELETE FROM device_care_credit_ledger WHERE customer_subscription_id=$1',
        [subscriptionId],
      );
    if (customerProfileId)
      await client.query(
        'DELETE FROM subscription_lifecycle_commands WHERE customer_profile_id=$1',
        [customerProfileId],
      );
    if (subscriptionId)
      await client.query('DELETE FROM customer_subscriptions WHERE id=$1', [subscriptionId]);
    if (customerProfileId)
      await client.query('DELETE FROM customer_email_deliveries WHERE customer_profile_id=$1', [
        customerProfileId,
      ]);
    if (customerProfileId)
      await client.query('DELETE FROM customer_profile_memberships WHERE customer_profile_id=$1', [
        customerProfileId,
      ]);
    if (customerProfileId)
      await client.query('DELETE FROM customer_profiles WHERE id=$1', [customerProfileId]);
    await client.query(
      "DELETE FROM payment_webhook_events WHERE provider_event_reference='event-payment-test'",
    );
    await client.query(
      "DELETE FROM audit_events WHERE target_type='payment_operation' AND target_id=$1",
      [paymentId],
    );
    await client.query('DELETE FROM payment_refunds WHERE payment_operation_id=$1', [paymentId]);
    await client.query('DELETE FROM payment_operations WHERE id=$1', [paymentId]);
    await client.query('DELETE FROM audit_events WHERE actor_user_id=$1', [userId]);
    await client.query('DELETE FROM identities WHERE user_id=$1', [userId]);
    await client.query('DELETE FROM users WHERE id=$1', [userId]);
    await client.end();
  });

  it('persists only safe payment references and returns idempotent requests', async () => {
    const request = {
      amountMinor: 1999n,
      currency: 'USD',
      idempotencyKey: paymentIdempotencyKey,
      paymentMethodReference: 'ephemeral-card-token',
    };
    const created = await repository.createForSubject(subject, request, randomUUID());
    expect(created).toMatchObject({
      amountMinor: '1999',
      providerPaymentReference: `square-${userId}`,
      status: 'completed',
    });
    paymentId = created!.id;
    await expect(repository.createForSubject(subject, request, randomUUID())).resolves.toEqual(
      created,
    );
    const row = await client.query<{ provider_payment_reference: string }>(
      'SELECT provider_payment_reference FROM payment_operations WHERE id=$1',
      [paymentId],
    );
    expect(row.rows[0]).toEqual({ provider_payment_reference: `square-${userId}` });
  });

  it('prevents replaying a signed-provider event from mutating payment twice', async () => {
    const event = {
      event_id: 'event-payment-test',
      type: 'payment.updated',
      data: { object: { payment: { id: `square-${userId}`, status: 'COMPLETED' } } },
    };
    await expect(repository.processSquareWebhook(event, JSON.stringify(event))).resolves.toBe(
      'processed',
    );
    await expect(repository.processSquareWebhook(event, JSON.stringify(event))).resolves.toBe(
      'duplicate',
    );
  });

  it('accrues Device Care credits only once from a paid provider invoice', async () => {
    const profile = await client.query<{ id: string }>(
      `INSERT INTO customer_profiles (ciphertext,iv,auth_tag,key_id)
       VALUES ($1,$2,$3,'test') RETURNING id`,
      [Buffer.from('test'), Buffer.alloc(12), Buffer.alloc(16)],
    );
    customerProfileId = profile.rows[0]!.id;
    await client.query(
      'INSERT INTO customer_profile_memberships (customer_profile_id,user_id) VALUES ($1,$2)',
      [customerProfileId, userId],
    );
    const subscription = await client.query<{ id: string }>(
      `INSERT INTO customer_subscriptions
       (customer_profile_id,subscription_plan_version_id,status,provider,provider_environment,provider_subscription_reference)
       SELECT $1,spv.id,'active','square','sandbox',$2
       FROM subscription_plan_versions spv JOIN subscription_plans sp ON sp.id=spv.subscription_plan_id
       WHERE sp.key='device-care' ORDER BY spv.version_number DESC LIMIT 1 RETURNING id`,
      [customerProfileId, `square-subscription-${userId}`],
    );
    subscriptionId = subscription.rows[0]!.id;
    const event = {
      event_id: `invoice-payment-${userId}`,
      type: 'invoice.payment_made',
      data: {
        object: {
          invoice: {
            id: `invoice-${userId}`,
            subscription_id: `square-subscription-${userId}`,
          },
        },
      },
    };
    await expect(
      repository.processSquareWebhook(event, JSON.stringify(event), 'sandbox'),
    ).resolves.toBe('processed');
    await expect(
      repository.processSquareWebhook(event, JSON.stringify(event), 'sandbox'),
    ).resolves.toBe('duplicate');
    await expect(walletRepository.forSubject(subject)).resolves.toMatchObject({
      availableMinor: '0',
      balanceMinor: '1500',
      membershipActive: true,
      usable: false,
    });
    let cancelledReference: string | undefined;
    let cancellationCalls = 0;
    const legacySquareProvider: DeviceCareCardProvider = {
      cancelSubscription: async (reference) => {
        cancellationCalls += 1;
        cancelledReference = reference;
        return { renewalAt: null };
      },
      createCustomer: async () => 'unused',
      createSubscription: async () => ({
        providerSubscriptionReference: 'unused',
        renewalAt: null,
        status: 'active',
        version: null,
      }),
      disableCard: async () => undefined,
      saveCard: async () => ({
        brand: null,
        expMonth: null,
        expYear: null,
        last4: null,
        providerCardReference: 'unused',
        status: 'active',
      }),
      updateSubscriptionCard: async () => ({ version: null }),
    };
    const currentStripeProvider: DeviceCareCardProvider = {
      ...legacySquareProvider,
      cancelSubscription: async () => {
        throw new Error('The current Stripe adapter must not cancel a stored Square agreement.');
      },
    };
    const deviceCareRepository = new PostgresDeviceCareRepository(
      databaseUrl!,
      currentStripeProvider,
      'production',
      'stripe',
      [{ adapter: legacySquareProvider, environment: 'sandbox', provider: 'square' }],
    );
    const cancellationKey = randomUUID();
    await expect(
      deviceCareRepository.cancelForSubject(
        subject,
        { idempotencyKey: cancellationKey },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ id: subscriptionId, status: 'active' });
    expect(cancelledReference).toBe(`square-subscription-${userId}`);
    expect(cancellationCalls).toBe(1);
    await expect(
      deviceCareRepository.cancelForSubject(
        subject,
        { idempotencyKey: cancellationKey },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ id: subscriptionId });
    expect(cancelledReference).toBe(`square-subscription-${userId}`);
    expect(cancellationCalls).toBe(1);
    await expect(
      client.query<{ event_type: string; environment: string; amount: string }>(
        "SELECT event_type,environment,template_data->>'amountMinor' AS amount FROM customer_email_deliveries WHERE customer_profile_id=$1",
        [customerProfileId],
      ),
    ).resolves.toMatchObject({
      rows: [{ event_type: 'device_care_payment_receipt', environment: 'sandbox', amount: '1500' }],
    });
  });
});
