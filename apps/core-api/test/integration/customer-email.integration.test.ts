import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EmailProviderError,
  PostgresCustomerEmailOutbox,
  type TransactionalEmailProvider,
} from '../../src/customer-email.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL customer email outbox', () => {
  const userId = randomUUID();
  const profileId = randomUUID();
  const client = new Client({ connectionString: databaseUrl });
  const configuration = {
    apiKey: 're_test',
    from: 'Obsidian Systems <receipts@updates.obsidian-systems.tech>',
    sendSandbox: false,
  };

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO users (id,email) VALUES ($1,$2)', [
      userId,
      `email-${userId}@example.invalid`,
    ]);
    await client.query(
      'INSERT INTO customer_profiles (id,ciphertext,iv,auth_tag,key_id) VALUES ($1,$2,$3,$4,$5)',
      [profileId, Buffer.from('test'), Buffer.alloc(12), Buffer.alloc(16), 'test'],
    );
  });
  afterAll(async () => {
    await client.query(
      'DELETE FROM audit_events WHERE target_type=$1 AND target_id IN (SELECT id FROM customer_email_deliveries WHERE customer_profile_id=$2)',
      ['customer_email_delivery', profileId],
    );
    await client.query('DELETE FROM customer_email_deliveries WHERE customer_profile_id=$1', [
      profileId,
    ]);
    await client.query('DELETE FROM customer_profiles WHERE id=$1', [profileId]);
    await client.query('DELETE FROM users WHERE id=$1', [userId]);
    await client.end();
  });

  async function enqueue(environment: 'sandbox' | 'production' = 'production') {
    const delivery = await client.query<{ id: string }>(
      `INSERT INTO customer_email_deliveries
       (customer_profile_id,recipient_user_id,recipient_email,event_type,event_key,environment,template_data)
       VALUES ($1,$2,$3,'device_care_payment_receipt',$4,$5,$6) RETURNING id`,
      [
        profileId,
        userId,
        `email-${userId}@example.invalid`,
        randomUUID(),
        environment,
        { amountMinor: '1500', currency: 'USD', providerInvoiceReference: 'invoice-test' },
      ],
    );
    return delivery.rows[0]!.id;
  }

  it('sends a claimed production delivery once and records its provider reference', async () => {
    const id = await enqueue();
    const provider: TransactionalEmailProvider = {
      send: async () => ({ providerMessageReference: 'email-provider-1' }),
    };
    const outbox = new PostgresCustomerEmailOutbox(databaseUrl!, configuration, provider);
    await expect(outbox.deliverPending()).resolves.toBe(1);
    await expect(
      client.query(
        'SELECT status,attempts,provider_message_reference FROM customer_email_deliveries WHERE id=$1',
        [id],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: 'sent', attempts: 1, provider_message_reference: 'email-provider-1' }],
    });
  });

  it('records a retryable provider failure without losing the durable delivery', async () => {
    const id = await enqueue();
    const provider: TransactionalEmailProvider = {
      send: async () => {
        throw new EmailProviderError('RESEND_DELIVERY_REJECTED');
      },
    };
    const outbox = new PostgresCustomerEmailOutbox(databaseUrl!, configuration, provider);
    await expect(outbox.deliverPending()).resolves.toBe(0);
    await expect(
      client.query(
        'SELECT status,attempts,last_error_code,next_attempt_at IS NOT NULL AS retry_scheduled FROM customer_email_deliveries WHERE id=$1',
        [id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: 'failed',
          attempts: 1,
          last_error_code: 'RESEND_DELIVERY_REJECTED',
          retry_scheduled: true,
        },
      ],
    });
  });

  it('does not send sandbox receipts unless sandbox delivery is explicitly enabled', async () => {
    const id = await enqueue('sandbox');
    const provider: TransactionalEmailProvider = {
      send: async () => ({ providerMessageReference: 'must-not-send' }),
    };
    const outbox = new PostgresCustomerEmailOutbox(databaseUrl!, configuration, provider);
    await expect(outbox.deliverPending()).resolves.toBeGreaterThanOrEqual(0);
    await expect(
      client.query('SELECT status,attempts FROM customer_email_deliveries WHERE id=$1', [id]),
    ).resolves.toMatchObject({ rows: [{ status: 'queued', attempts: 0 }] });
  });
});
