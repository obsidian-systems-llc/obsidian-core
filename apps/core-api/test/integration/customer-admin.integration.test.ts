import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresCustomerAdministrationRepository } from '../../src/customer-admin.js';
import { loadFieldEncryptor } from '../../src/encryption.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL customer and repair administration', () => {
  const ids = { actor: randomUUID(), customer: randomUUID(), job: randomUUID() };
  const subject = `auth0|customer-admin-${ids.actor}`;
  const client = new Client({ connectionString: databaseUrl });
  const encryptor = loadFieldEncryptor({
    FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    FIELD_ENCRYPTION_KEY_ID: 'test-key',
  });
  const repository = new PostgresCustomerAdministrationRepository(databaseUrl!, encryptor);

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO users (id,email) VALUES ($1,$2)', [
      ids.actor,
      `customer-admin-${ids.actor}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,'auth0',$2)",
      [ids.actor, subject],
    );
    const customer = encryptor.encrypt({ name: 'Synthetic Customer' });
    await client.query(
      'INSERT INTO customer_profiles (id,ciphertext,iv,auth_tag,key_id) VALUES ($1,$2,$3,$4,$5)',
      [ids.customer, customer.ciphertext, customer.iv, customer.authTag, customer.keyId],
    );
    await client.query(
      'INSERT INTO jobs (id,created_by_user_id,idempotency_key) VALUES ($1,$2,$3)',
      [ids.job, ids.actor, randomUUID()],
    );
    await client.query(
      'INSERT INTO appointments (job_id,window_start,window_end) VALUES ($1,$2,$3)',
      [ids.job, new Date('2026-09-01T12:00:00Z'), new Date('2026-09-01T13:00:00Z')],
    );
  });
  afterAll(async () => {
    await client.query('DELETE FROM audit_events WHERE actor_user_id=$1', [ids.actor]);
    await client.query('DELETE FROM job_customer_association_events WHERE job_id=$1', [ids.job]);
    await client.query('DELETE FROM customer_administration_commands WHERE actor_user_id=$1', [
      ids.actor,
    ]);
    await client.query('DELETE FROM appointments WHERE job_id=$1', [ids.job]);
    await client.query('DELETE FROM jobs WHERE id=$1', [ids.job]);
    await client.query('DELETE FROM customer_profile_revisions WHERE customer_profile_id=$1', [
      ids.customer,
    ]);
    await client.query('DELETE FROM customer_profiles WHERE id=$1', [ids.customer]);
    await client.query('DELETE FROM identities WHERE user_id=$1', [ids.actor]);
    await client.query('DELETE FROM users WHERE id=$1', [ids.actor]);
    await client.end();
  });
  it('links a repair through an immutable association event and preserves encrypted revisions', async () => {
    const linked = await repository.associateRepair(
      subject,
      ids.job,
      {
        customerProfileId: ids.customer,
        reason: 'Verified ownership',
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
    );
    expect(linked).toMatchObject({ customerProfileId: ids.customer });
    const updated = await repository.update(
      subject,
      ids.customer,
      {
        profile: { name: 'Synthetic Customer', phone: '555-0100' },
        reason: 'Customer provided phone',
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
    );
    expect(updated?.value).toMatchObject({ phone: '555-0100' });
    const events = await client.query<{ action: string; customer_profile_id: string }>(
      'SELECT action,customer_profile_id FROM job_customer_association_events WHERE job_id=$1',
      [ids.job],
    );
    expect(events.rows).toEqual([{ action: 'linked', customer_profile_id: ids.customer }]);
    const revisions = await client.query(
      'SELECT id FROM customer_profile_revisions WHERE customer_profile_id=$1',
      [ids.customer],
    );
    expect(revisions.rowCount).toBe(1);
  });
});
