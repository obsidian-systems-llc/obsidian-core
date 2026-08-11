import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPaymentRepository, type PaymentProvider } from '../../src/payments.js';

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
  let paymentId: string;

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
      "DELETE FROM payment_webhook_events WHERE provider_event_reference='event-payment-test'",
    );
    await client.query(
      "DELETE FROM audit_events WHERE target_type='payment_operation' AND target_id=$1",
      [paymentId],
    );
    await client.query('DELETE FROM payment_refunds WHERE payment_operation_id=$1', [paymentId]);
    await client.query('DELETE FROM payment_operations WHERE id=$1', [paymentId]);
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
});
