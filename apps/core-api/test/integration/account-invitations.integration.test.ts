import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAccountInvitationRepository } from '../../src/account-invitations.js';
import { PostgresAuthorizer } from '../../src/authorization.js';
import { loadFieldEncryptor } from '../../src/encryption.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL workforce account invitations', () => {
  const actorId = randomUUID();
  const applicationId = randomUUID();
  const permissionId = randomUUID();
  const roleId = randomUUID();
  const client = new Client({ connectionString: databaseUrl });
  const actorSubject = `auth0|inviter-${actorId}`;
  const invitedEmail = `invite-${actorId}@example.invalid`;
  const invitedSubject = `auth0|invitee-${actorId}`;
  const encryptor = loadFieldEncryptor({
    FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    FIELD_ENCRYPTION_KEY_ID: 'test-key',
  });
  const repository = new PostgresAccountInvitationRepository(
    databaseUrl!,
    encryptor,
    {
      apiKey: 're_test',
      from: 'Obsidian Systems <receipts@updates.obsidian-systems.tech>',
      sendSandbox: false,
    },
    'https://admin.example.test/invitations/accept',
    { send: async () => ({ providerMessageReference: 'email-invitation-test' }) },
  );

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO users (id,email) VALUES ($1,$2)', [
      actorId,
      `inviter-${actorId}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,'auth0',$2)",
      [actorId, actorSubject],
    );
    await client.query('INSERT INTO applications (id,key,name) VALUES ($1,$2,$3)', [
      applicationId,
      `invite-app-${applicationId}`,
      'Invitation Test App',
    ]);
    await client.query('INSERT INTO permissions (id,key,name) VALUES ($1,$2,$3)', [
      permissionId,
      `invite.read.${permissionId}`,
      'Invitation test permission',
    ]);
    await client.query('INSERT INTO roles (id,application_id,key,name) VALUES ($1,$2,$3,$4)', [
      roleId,
      applicationId,
      `executive-${roleId.slice(0, 8)}`,
      'Executive',
    ]);
    await client.query('INSERT INTO role_permissions (role_id,permission_id) VALUES ($1,$2)', [
      roleId,
      permissionId,
    ]);
  });
  afterAll(async () => {
    await client.query(
      "DELETE FROM audit_events WHERE target_type='account_invitation' AND target_id IN (SELECT id FROM account_invitations WHERE created_by_user_id=$1)",
      [actorId],
    );
    await client.query('DELETE FROM authorization_commands WHERE actor_user_id=$1', [actorId]);
    await client.query('DELETE FROM account_invitations WHERE created_by_user_id=$1', [actorId]);
    const invitee = await client.query<{ id: string }>('SELECT id FROM users WHERE email=$1', [
      invitedEmail,
    ]);
    if (invitee.rows[0]) {
      await client.query('DELETE FROM application_entitlements WHERE user_id=$1', [
        invitee.rows[0].id,
      ]);
      await client.query('DELETE FROM user_roles WHERE user_id=$1', [invitee.rows[0].id]);
      await client.query('DELETE FROM identities WHERE user_id=$1', [invitee.rows[0].id]);
      await client.query('DELETE FROM users WHERE id=$1', [invitee.rows[0].id]);
    }
    await client.query('DELETE FROM role_permissions WHERE role_id=$1', [roleId]);
    await client.query('DELETE FROM roles WHERE id=$1', [roleId]);
    await client.query('DELETE FROM permissions WHERE id=$1', [permissionId]);
    await client.query('DELETE FROM applications WHERE id=$1', [applicationId]);
    await client.query('DELETE FROM identities WHERE user_id=$1', [actorId]);
    await client.query('DELETE FROM users WHERE id=$1', [actorId]);
    await client.end();
  });

  async function tokenFor(invitationId: string) {
    const row = await client.query<{
      token_ciphertext: Buffer;
      token_iv: Buffer;
      token_auth_tag: Buffer;
      token_key_id: string;
    }>(
      'SELECT token_ciphertext,token_iv,token_auth_tag,token_key_id FROM account_invitations WHERE id=$1',
      [invitationId],
    );
    return encryptor.decrypt<{ token: string }>({
      ciphertext: row.rows[0]!.token_ciphertext,
      iv: row.rows[0]!.token_iv,
      authTag: row.rows[0]!.token_auth_tag,
      keyId: row.rows[0]!.token_key_id,
    }).token;
  }

  it('issues and delivers an invitation without exposing the token in the result', async () => {
    const invitation = await repository.create(
      actorSubject,
      { email: invitedEmail, roleId, idempotencyKey: randomUUID() },
      randomUUID(),
    );
    expect(invitation).toMatchObject({ recipientEmail: invitedEmail, status: 'queued' });
    expect(invitation).not.toHaveProperty('token');
    await expect(repository.deliverPending()).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      client.query(
        'SELECT status,provider_message_reference FROM account_invitations WHERE id=$1',
        [invitation!.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: 'sent', provider_message_reference: 'email-invitation-test' }],
    });
  });

  it('requires the invited Auth0 email and grants access exactly once after acceptance', async () => {
    const invitation = (await repository.list()).find(
      (entry) => entry.recipientEmail === invitedEmail,
    )!;
    const token = await tokenFor(invitation.id);
    await expect(
      repository.accept(
        invitedSubject,
        'wrong@example.invalid',
        { token, idempotencyKey: randomUUID() },
        randomUUID(),
      ),
    ).resolves.toBe('unavailable');
    await expect(
      repository.accept(
        invitedSubject,
        invitedEmail,
        { token, idempotencyKey: randomUUID() },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ roleName: 'Executive' });
    await expect(
      repository.accept(
        invitedSubject,
        invitedEmail,
        { token, idempotencyKey: randomUUID() },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ roleName: 'Executive' });
    const authorizer = new PostgresAuthorizer(databaseUrl!);
    await expect(
      authorizer.authorize(invitedSubject, {
        applicationKey: `invite-app-${applicationId}`,
        permissionKey: `invite.read.${permissionId}`,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('rejects invalid expiry and allows an authorized inviter to revoke an unclaimed invitation', async () => {
    await expect(
      repository.create(
        actorSubject,
        {
          email: `expired-${actorId}@example.invalid`,
          roleId,
          idempotencyKey: randomUUID(),
          expiresAt: new Date(Date.now() - 1),
        },
        randomUUID(),
      ),
    ).resolves.toBe('invalid_expiry');
    const invitation = await repository.create(
      actorSubject,
      { email: `revoke-${actorId}@example.invalid`, roleId, idempotencyKey: randomUUID() },
      randomUUID(),
    );
    await expect(
      repository.revoke(
        actorSubject,
        invitation!.id,
        { idempotencyKey: randomUUID(), reason: 'Role no longer needed.' },
        randomUUID(),
      ),
    ).resolves.toBe(true);
    const deliveryFailure = await repository.create(
      actorSubject,
      {
        email: `delivery-failure-${actorId}@example.invalid`,
        roleId,
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
    );
    const failingRepository = new PostgresAccountInvitationRepository(
      databaseUrl!,
      encryptor,
      {
        apiKey: 're_test',
        from: 'Obsidian Systems <receipts@updates.obsidian-systems.tech>',
        sendSandbox: false,
      },
      'https://admin.example.test/invitations/accept',
      { send: async () => Promise.reject(new Error('provider unavailable')) },
    );
    await expect(failingRepository.deliverPending()).resolves.toBe(0);
    await expect(
      client.query(
        'SELECT status,last_error_code,next_delivery_at IS NOT NULL AS retry_scheduled FROM account_invitations WHERE id=$1',
        [deliveryFailure!.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: 'failed',
          last_error_code: 'INVITATION_DELIVERY_FAILED',
          retry_scheduled: true,
        },
      ],
    });
  });
});
