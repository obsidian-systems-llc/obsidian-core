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
  });
  afterAll(async () => {
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
      id: profileId,
      value: { name: 'Synthetic Customer' },
      addresses: [{ id: addressId, label: 'home', value: { city: 'Exampleville' } }],
    });
    await expect(repository.getForSubject('auth0|unknown')).resolves.toBeNull();
  });
});
