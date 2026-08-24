import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PostgresCoreIdentityRepository,
  type CoreIdentityConfiguration,
} from '../../src/core-identity.js';
import { loadFieldEncryptor } from '../../src/encryption.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL Core identity lifecycle', () => {
  const client = new Client({ connectionString: databaseUrl });
  const suffix = randomUUID();
  const email = `core-identity-${suffix}@example.invalid`;
  let userId: string | undefined;
  let customerProfileId: string | undefined;
  let connected = false;
  const identity: CoreIdentityConfiguration = {
    issuer: 'https://api.example.test',
    audience: 'https://api.example.test',
    signingSecret: 'a'.repeat(43),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    emailVerificationUrl: 'https://portal.example.test/verify-email',
    passwordResetUrl: 'https://portal.example.test/reset-password',
  };
  const repository = new PostgresCoreIdentityRepository(
    databaseUrl!,
    loadFieldEncryptor({
      FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      FIELD_ENCRYPTION_KEY_ID: 'test-key',
    }),
    identity,
  );

  afterAll(async () => {
    if (!connected) {
      await client.connect();
      connected = true;
    }
    if (userId) {
      await client.query('DELETE FROM audit_events WHERE actor_user_id=$1', [userId]);
      await client.query('DELETE FROM core_identity_email_deliveries WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM core_identity_one_time_tokens WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM core_identity_password_credentials WHERE user_id=$1', [
        userId,
      ]);
      await client.query('DELETE FROM application_entitlements WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM user_roles WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM customer_profile_memberships WHERE user_id=$1', [userId]);
      if (customerProfileId)
        await client.query('DELETE FROM customer_profiles WHERE id=$1', [customerProfileId]);
      await client.query('DELETE FROM identities WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM users WHERE id=$1', [userId]);
    }
    await client.end();
  });

  it('persists an Argon2id account, rotates a session, and permits self-revocation', async () => {
    const registered = await repository.registerCustomer(
      {
        email,
        password: 'a synthetic secure password',
        profile: { firstName: 'Synthetic', lastName: 'Identity' },
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
    );
    expect(registered).toMatchObject({ verificationRequired: true });
    customerProfileId = (registered as { profileId: string }).profileId;
    await client.connect();
    connected = true;
    const user = await client.query<{ user_id: string }>(
      'SELECT user_id FROM customer_profile_memberships WHERE customer_profile_id=$1',
      [customerProfileId],
    );
    userId = user.rows[0]!.user_id;
    await client.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [userId]);
    const loggedIn = await repository.login(
      { email, password: 'a synthetic secure password' },
      randomUUID(),
    );
    expect(loggedIn).not.toBe('invalid_credentials');
    expect(loggedIn).not.toBe('email_verification_required');
    const tokens = loggedIn as { refreshToken: string };
    const refreshed = await repository.refresh(tokens.refreshToken, randomUUID());
    expect(refreshed).not.toBe('invalid_session');
    const sessions = await repository.listSessions(`core|${userId}`);
    expect(Array.isArray(sessions)).toBe(true);
    const revoked = await repository.revokeSession(
      `core|${userId}`,
      (sessions as Array<{ id: string }>)[0]!.id,
      'Synthetic integration test cleanup.',
      randomUUID(),
    );
    expect(revoked).toBe(true);
  });
});
