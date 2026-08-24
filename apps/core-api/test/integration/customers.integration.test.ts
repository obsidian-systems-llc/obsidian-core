import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresCustomerRepository } from '../../src/customers.js';
import { loadFieldEncryptor } from '../../src/encryption.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL customer repository', () => {
  const userId = randomUUID();
  const profileId = randomUUID();
  const addressId = randomUUID();
  const deviceId = randomUUID();
  const client = new Client({ connectionString: databaseUrl });
  const subject = `auth0|customer-${userId}`;
  const encryptor = loadFieldEncryptor({
    FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    FIELD_ENCRYPTION_KEY_ID: 'test-key',
  });
  const repository = new PostgresCustomerRepository(databaseUrl!, encryptor);
  beforeAll(async () => {
    await client.connect();
    const profile = encryptor.encrypt({ name: 'Synthetic Customer' });
    const address = encryptor.encrypt({ city: 'Exampleville', line1: '100 Test Way' });
    const device = encryptor.encrypt({ serialNumber: 'SYNTHETIC-DEVICE', type: 'phone' });
    await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `customer-${userId}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1, 'auth0', $2)",
      [userId, subject],
    );
    await client.query(
      'INSERT INTO customer_profiles (id, ciphertext, iv, auth_tag, key_id) VALUES ($1, $2, $3, $4, $5)',
      [profileId, profile.ciphertext, profile.iv, profile.authTag, profile.keyId],
    );
    await client.query(
      'INSERT INTO customer_profile_memberships (customer_profile_id, user_id) VALUES ($1, $2)',
      [profileId, userId],
    );
    await client.query(
      'INSERT INTO customer_addresses (id, ciphertext, iv, auth_tag, key_id) VALUES ($1, $2, $3, $4, $5)',
      [addressId, address.ciphertext, address.iv, address.authTag, address.keyId],
    );
    await client.query(
      "INSERT INTO customer_profile_addresses (customer_profile_id, customer_address_id, label) VALUES ($1, $2, 'home')",
      [profileId, addressId],
    );
    await client.query(
      'INSERT INTO customer_devices (id, customer_profile_id, ciphertext, iv, auth_tag, key_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [deviceId, profileId, device.ciphertext, device.iv, device.authTag, device.keyId],
    );
  });
  afterAll(async () => {
    await client.query('DELETE FROM audit_events WHERE actor_user_id = $1', [userId]);
    await client.query('DELETE FROM customer_email_deliveries WHERE customer_profile_id = $1', [
      profileId,
    ]);
    await client.query('DELETE FROM customer_account_closures WHERE customer_profile_id = $1', [
      profileId,
    ]);
    await client.query('DELETE FROM customer_profile_revisions WHERE customer_profile_id = $1', [
      profileId,
    ]);
    await client.query('DELETE FROM customer_devices WHERE customer_profile_id = $1', [profileId]);
    await client.query('DELETE FROM customer_profile_addresses WHERE customer_profile_id = $1', [
      profileId,
    ]);
    await client.query('DELETE FROM customer_profile_memberships WHERE customer_profile_id = $1', [
      profileId,
    ]);
    await client.query('DELETE FROM customer_addresses WHERE id = $1', [addressId]);
    await client.query('DELETE FROM customer_profiles WHERE id = $1', [profileId]);
    await client.query('DELETE FROM identities WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.end();
  });
  it('returns only the profile and addresses linked to the authenticated identity', async () => {
    await expect(repository.getForSubject(subject)).resolves.toMatchObject({
      email: `customer-${userId}@example.invalid`,
      id: profileId,
      value: { name: 'Synthetic Customer' },
      addresses: [{ id: addressId, label: 'home', value: { city: 'Exampleville' } }],
    });
    await expect(repository.getForSubject('auth0|unknown')).resolves.toBeNull();
  });
  it('returns an encrypted device only through the owning customer portal overview', async () => {
    await expect(repository.portalOverviewForSubject(subject)).resolves.toMatchObject({
      email: `customer-${userId}@example.invalid`,
      id: profileId,
      devices: [{ id: deviceId, status: 'active', value: { type: 'phone' } }],
      jobs: [],
      quotes: [],
      subscriptions: [],
    });
    await expect(repository.portalOverviewForSubject('auth0|unrelated')).resolves.toBeNull();
  });
  it('replaces a customer profile idempotently while preserving an encrypted revision', async () => {
    const update = {
      idempotencyKey: randomUUID(),
      profile: { name: 'Updated Synthetic Customer', phone: '555-0100' },
    };
    await expect(repository.updateForSubject(subject, update, randomUUID())).resolves.toMatchObject(
      {
        id: profileId,
        value: update.profile,
      },
    );
    await expect(repository.updateForSubject(subject, update, randomUUID())).resolves.toMatchObject(
      {
        value: update.profile,
      },
    );
    await expect(
      client.query(
        'SELECT count(*)::int AS count FROM customer_profile_revisions WHERE customer_profile_id=$1',
        [profileId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      client.query<{ count: number; recipient_email: string; event_type: string }>(
        'SELECT count(*)::int AS count, max(recipient_email) AS recipient_email, max(event_type) AS event_type FROM customer_email_deliveries WHERE customer_profile_id=$1',
        [profileId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          count: 1,
          recipient_email: `customer-${userId}@example.invalid`,
          event_type: 'profile_updated',
        },
      ],
    });
  });
  it('archives and deauthorizes a customer account after explicit closure', async () => {
    const closed = await repository.closeAccountForSubject(
      subject,
      { confirmation: 'CLOSE_MY_ACCOUNT', idempotencyKey: randomUUID() },
      randomUUID(),
    );
    expect(closed).toMatchObject({ status: 'closed' });
    await expect(repository.getForSubject(subject)).resolves.toBeNull();
    await expect(
      client.query<{ status: string }>('SELECT status FROM customer_profiles WHERE id=$1', [
        profileId,
      ]),
    ).resolves.toMatchObject({ rows: [{ status: 'archived' }] });
  });
});
