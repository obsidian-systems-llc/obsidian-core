import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import {
  EmailProviderError,
  type ResendEmailConfiguration,
  type TransactionalEmailProvider,
  ResendTransactionalEmailProvider,
} from './customer-email.js';
import type { FieldEncryptor } from './encryption.js';

const idempotencyKey = z.uuid();
const email = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.toLowerCase());
export const createAccountInvitationSchema = z.object({
  email,
  expiresAt: z.coerce.date().optional(),
  idempotencyKey,
  roleId: z.uuid(),
});
export const acceptAccountInvitationSchema = z.object({
  idempotencyKey,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const revokeAccountInvitationSchema = z.object({
  idempotencyKey,
  reason: z.string().trim().min(3).max(500),
});

export type AccountInvitation = {
  id: string;
  applicationKey: string;
  createdAt: Date;
  expiresAt: Date;
  recipientEmail: string;
  roleKey: string;
  roleName: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'accepted' | 'revoked' | 'expired';
};
type InvitationRow = AccountInvitation & {
  accepted_by_user_id: string | null;
  application_id: string;
  role_id: string;
  token_ciphertext: Buffer;
  token_iv: Buffer;
  token_auth_tag: Buffer;
  token_key_id: string;
};
export type AccountInvitationRepository = {
  create(
    subject: string,
    input: z.infer<typeof createAccountInvitationSchema>,
    correlationId: string,
  ): Promise<AccountInvitation | null | 'invalid_expiry'>;
  list(): Promise<AccountInvitation[]>;
  revoke(
    subject: string,
    invitationId: string,
    input: z.infer<typeof revokeAccountInvitationSchema>,
    correlationId: string,
  ): Promise<boolean | null>;
  accept(
    subject: string,
    authenticatedEmail: string | undefined,
    input: z.infer<typeof acceptAccountInvitationSchema>,
    correlationId: string,
  ): Promise<
    { applicationKey: string; roleKey: string; roleName: string } | 'unavailable' | 'email_mismatch'
  >;
  deliverPending(limit?: number): Promise<number>;
};

export class PostgresAccountInvitationRepository implements AccountInvitationRepository {
  constructor(
    private readonly databaseUrl: string,
    private readonly encryptor: FieldEncryptor,
    private readonly configuration: ResendEmailConfiguration,
    private readonly acceptUrl: string,
    private readonly provider: TransactionalEmailProvider = new ResendTransactionalEmailProvider(
      configuration,
    ),
  ) {}

  async create(
    subject: string,
    input: z.infer<typeof createAccountInvitationSchema>,
    correlationId: string,
  ): Promise<AccountInvitation | null | 'invalid_expiry'> {
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    if (expiresAt <= new Date() || expiresAt > new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))
      return 'invalid_expiry';
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actor = await actorForSubject(client, subject);
      if (!actor) return await rollback(client, null);
      const existing = await client.query<{ result: AccountInvitation }>(
        `SELECT result FROM authorization_commands
         WHERE actor_user_id=$1 AND action='account_invitation_created' AND idempotency_key=$2`,
        [actor, input.idempotencyKey],
      );
      if (existing.rows[0]) return await rollback(client, existing.rows[0].result);
      const role = await client.query<{
        id: string;
        application_key: string;
        role_key: string;
        role_name: string;
      }>(
        `SELECT r.id,a.key AS application_key,r.key AS role_key,r.name AS role_name
         FROM roles r JOIN applications a ON a.id=r.application_id
         WHERE r.id=$1 AND r.deactivated_at IS NULL AND a.deactivated_at IS NULL FOR UPDATE`,
        [input.roleId],
      );
      if (!role.rows[0]) return await rollback(client, null);
      if (role.rows[0].application_key === 'core-admin' && role.rows[0].role_key === 'super-admin')
        return await rollback(client, null);
      const access = await client.query(
        `SELECT 1 FROM users u WHERE lower(u.email)=lower($1) AND u.status='active' AND u.archived_at IS NULL
         AND (EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_id=$2 AND ur.effective_from<=now() AND (ur.effective_to IS NULL OR ur.effective_to>now()))
           OR EXISTS (SELECT 1 FROM application_entitlements ae JOIN applications a ON a.id=ae.application_id WHERE ae.user_id=u.id AND a.id=(SELECT application_id FROM roles WHERE id=$2) AND ae.deactivated_at IS NULL AND ae.effective_from<=now() AND (ae.effective_to IS NULL OR ae.effective_to>now())))`,
        [input.email, input.roleId],
      );
      if (access.rows[0]) return await rollback(client, null);
      await client.query(
        `UPDATE account_invitations SET status='revoked',revoked_at=now(),updated_at=now()
         WHERE recipient_email=$1 AND role_id=$2 AND status IN ('queued','sending','sent','failed')`,
        [input.email, input.roleId],
      );
      const token = randomBytes(32).toString('base64url');
      const encrypted = this.encryptor.encrypt({ token });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO account_invitations
           (recipient_email,token_hash,token_ciphertext,token_iv,token_auth_tag,token_key_id,application_id,role_id,created_by_user_id,idempotency_key,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,(SELECT application_id FROM roles WHERE id=$7),$7,$8,$9,$10)
         RETURNING id`,
        [
          input.email,
          tokenHash(token),
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyId,
          input.roleId,
          actor,
          input.idempotencyKey,
          expiresAt,
        ],
      );
      const created = await selectInvitation(client, inserted.rows[0]!.id);
      if (!created) throw new Error('Account invitation could not be created.');
      const result = mapInvitation(created);
      await client.query(
        `INSERT INTO authorization_commands (actor_user_id,action,idempotency_key,target_type,target_id,result)
         VALUES ($1,'account_invitation_created',$2,'account_invitation',$3,$4)`,
        [actor, input.idempotencyKey, result.id, JSON.stringify(result)],
      );
      await audit(
        client,
        actor,
        'authorization.account_invitation_created',
        result.id,
        correlationId,
        {
          applicationKey: result.applicationKey,
          roleKey: result.roleKey,
          recipientEmail: result.recipientEmail,
          expiresAt: result.expiresAt.toISOString(),
        },
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async list(): Promise<AccountInvitation[]> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query(
        `UPDATE account_invitations SET status='expired',updated_at=now()
         WHERE status IN ('queued','sending','sent','failed') AND expires_at<=now()`,
      );
      const result = await client.query<InvitationRow>(
        `SELECT ${invitationSelect} ${invitationFrom} ORDER BY i.created_at DESC LIMIT 250`,
      );
      return result.rows.map(mapInvitation);
    } finally {
      await client.end();
    }
  }

  async revoke(
    subject: string,
    invitationId: string,
    input: z.infer<typeof revokeAccountInvitationSchema>,
    correlationId: string,
  ): Promise<boolean | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actor = await actorForSubject(client, subject);
      if (!actor) return await rollback(client, null);
      const prior = await client.query<{ result: { revoked: boolean } }>(
        `SELECT result FROM authorization_commands WHERE actor_user_id=$1 AND action='account_invitation_revoked' AND idempotency_key=$2`,
        [actor, input.idempotencyKey],
      );
      if (prior.rows[0]) return await rollback(client, prior.rows[0].result.revoked);
      const result = await client.query(
        `UPDATE account_invitations SET status='revoked',revoked_at=now(),updated_at=now()
         WHERE id=$1 AND status IN ('queued','sending','sent','failed') RETURNING id`,
        [invitationId],
      );
      if (!result.rows[0]) return await rollback(client, false);
      await client.query(
        `INSERT INTO authorization_commands (actor_user_id,action,idempotency_key,target_type,target_id,result)
         VALUES ($1,'account_invitation_revoked',$2,'account_invitation',$3,'{"revoked":true}')`,
        [actor, input.idempotencyKey, invitationId],
      );
      await audit(
        client,
        actor,
        'authorization.account_invitation_revoked',
        invitationId,
        correlationId,
        {
          reason: input.reason,
        },
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async accept(
    subject: string,
    authenticatedEmail: string | undefined,
    input: z.infer<typeof acceptAccountInvitationSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const localIdentity = await client.query<{ email: string }>(
        'SELECT u.email FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider_subject=$1',
        [subject],
      );
      const emailResult = email.safeParse(authenticatedEmail ?? localIdentity.rows[0]?.email);
      if (!emailResult.success) return await rollback(client, 'email_mismatch' as const);
      const invitation = await client.query<InvitationRow>(
        `SELECT ${invitationSelect} ${invitationFrom}
         WHERE i.token_hash=$1 FOR UPDATE OF i`,
        [tokenHash(input.token)],
      );
      const current = invitation.rows[0];
      if (!current || current.recipientEmail !== emailResult.data) {
        await client.query('ROLLBACK');
        return 'unavailable' as const;
      }
      const mapped = mapInvitation(current);
      if (mapped.status === 'accepted' && current.accepted_by_user_id) {
        const identity = await client.query<{ user_id: string }>(
          'SELECT user_id FROM identities WHERE provider_subject=$1',
          [subject],
        );
        if (identity.rows[0]?.user_id === current.accepted_by_user_id)
          return await rollback(client, {
            applicationKey: mapped.applicationKey,
            roleKey: mapped.roleKey,
            roleName: mapped.roleName,
          });
        return await rollback(client, 'unavailable' as const);
      }
      if (
        !['queued', 'sending', 'sent', 'failed'].includes(mapped.status) ||
        mapped.expiresAt <= new Date()
      ) {
        if (mapped.expiresAt <= new Date())
          await client.query(
            "UPDATE account_invitations SET status='expired',updated_at=now() WHERE id=$1",
            [mapped.id],
          );
        return await rollback(client, 'unavailable' as const);
      }
      const currentIdentity = await client.query<{ user_id: string }>(
        'SELECT user_id FROM identities WHERE provider_subject=$1 FOR UPDATE',
        [subject],
      );
      const user = await client.query<{ id: string; status: string; archived_at: Date | null }>(
        `INSERT INTO users (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET updated_at=now()
         RETURNING id,status,archived_at`,
        [emailResult.data],
      );
      const userRow = user.rows[0]!;
      if (userRow.status !== 'active' || userRow.archived_at)
        return await rollback(client, 'unavailable' as const);
      if (currentIdentity.rows[0] && currentIdentity.rows[0].user_id !== userRow.id)
        return await rollback(client, 'unavailable' as const);
      if (!currentIdentity.rows[0])
        await client.query(
          'INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,$2,$3)',
          [userRow.id, subject.startsWith('core|') ? 'core' : 'auth0', subject],
        );
      await client.query(
        `INSERT INTO application_entitlements (user_id,application_id)
         SELECT $1,$2 WHERE NOT EXISTS (
           SELECT 1 FROM application_entitlements WHERE user_id=$1 AND application_id=$2
             AND deactivated_at IS NULL AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now()))`,
        [userRow.id, current.application_id],
      );
      await client.query(
        `INSERT INTO user_roles (user_id,role_id)
         SELECT $1,$2 WHERE NOT EXISTS (
           SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2
             AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now()))`,
        [userRow.id, current.role_id],
      );
      await client.query(
        `UPDATE account_invitations SET status='accepted',accepted_by_user_id=$2,accepted_at=now(),
         token_ciphertext='\\x',token_iv='\\x',token_auth_tag='\\x',updated_at=now() WHERE id=$1`,
        [mapped.id, userRow.id],
      );
      await audit(
        client,
        userRow.id,
        'authorization.account_invitation_accepted',
        mapped.id,
        correlationId,
        {
          applicationKey: mapped.applicationKey,
          roleKey: mapped.roleKey,
        },
      );
      await client.query('COMMIT');
      return {
        applicationKey: mapped.applicationKey,
        roleKey: mapped.roleKey,
        roleName: mapped.roleName,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async deliverPending(limit = 20) {
    let delivered = 0;
    for (let index = 0; index < limit; index += 1) {
      const invitation = await this.claimDelivery();
      if (!invitation) break;
      try {
        const token = this.encryptor.decrypt<{ token: string }>({
          ciphertext: invitation.token_ciphertext,
          iv: invitation.token_iv,
          authTag: invitation.token_auth_tag,
          keyId: invitation.token_key_id,
        }).token;
        const link = `${this.acceptUrl}#invite=${encodeURIComponent(token)}`;
        const response = await this.provider.send({
          to: invitation.recipientEmail,
          from: this.configuration.from,
          ...(this.configuration.replyTo ? { replyTo: this.configuration.replyTo } : {}),
          subject: 'You are invited to Obsidian Systems',
          text: `You have been invited to access Obsidian Systems as ${invitation.roleName}. Create or sign in to your account, then accept your invitation: ${link}`,
          html: `<p>You have been invited to access Obsidian Systems as <strong>${escapeHtml(invitation.roleName)}</strong>.</p><p><a href="${escapeHtml(link)}">Create or sign in to your account and accept the invitation</a>.</p>`,
          idempotencyKey: `obsidian-core-invitation-${invitation.id}`,
        });
        await this.finishDelivery(invitation.id, 'sent', response.providerMessageReference, null);
        delivered += 1;
      } catch (error) {
        await this.finishDelivery(
          invitation.id,
          'failed',
          null,
          error instanceof EmailProviderError ? error.code : 'INVITATION_DELIVERY_FAILED',
        );
      }
    }
    return delivered;
  }

  private async claimDelivery() {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const claimed = await client.query<{ id: string }>(
        `WITH next AS (
           SELECT id FROM account_invitations
           WHERE (status IN ('queued','failed') OR (status='sending' AND updated_at<=now()-interval '10 minutes'))
             AND delivery_attempts<5 AND expires_at>now() AND (next_delivery_at IS NULL OR next_delivery_at<=now())
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
         ) UPDATE account_invitations i SET status='sending',delivery_attempts=delivery_attempts+1,updated_at=now()
         FROM next WHERE i.id=next.id RETURNING i.id`,
      );
      const result = claimed.rows[0] ? await selectInvitation(client, claimed.rows[0].id) : null;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async finishDelivery(
    id: string,
    status: 'sent' | 'failed',
    reference: string | null,
    error: string | null,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const updated = await client.query<{ created_by_user_id: string }>(
        `UPDATE account_invitations SET status=$2,provider_message_reference=COALESCE($3,provider_message_reference),
         last_error_code=$4,next_delivery_at=CASE WHEN $2='failed' THEN now()+interval '5 minutes' ELSE NULL END,updated_at=now()
         WHERE id=$1 RETURNING created_by_user_id`,
        [id, status, reference, error],
      );
      if (updated.rows[0])
        await audit(
          client,
          null,
          status === 'sent'
            ? 'authorization.account_invitation_delivered'
            : 'authorization.account_invitation_delivery_failed',
          id,
          randomUUID(),
          { provider: 'resend', ...(error ? { errorCode: error } : {}) },
        );
      await client.query('COMMIT');
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw failure;
    } finally {
      await client.end();
    }
  }
}

const invitationSelect = `i.id,i.recipient_email AS "recipientEmail",a.key AS "applicationKey",
  r.key AS "roleKey",r.name AS "roleName",i.status,i.created_at AS "createdAt",i.expires_at AS "expiresAt",
  i.token_ciphertext,i.token_iv,i.token_auth_tag,i.token_key_id,i.application_id,i.role_id,i.accepted_by_user_id`;
const invitationFrom = `FROM account_invitations i
  JOIN applications a ON a.id=i.application_id
  JOIN roles r ON r.id=i.role_id`;
async function selectInvitation(client: Client, id: string) {
  const result = await client.query<InvitationRow>(
    `SELECT ${invitationSelect} ${invitationFrom} WHERE i.id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}
function mapInvitation(row: InvitationRow): AccountInvitation {
  return {
    id: row.id,
    applicationKey: row.applicationKey,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    recipientEmail: row.recipientEmail,
    roleKey: row.roleKey,
    roleName: row.roleName,
    status: row.status as AccountInvitation['status'],
  };
}
function tokenHash(token: string) {
  return createHash('sha256').update(token).digest();
}
async function actorForSubject(client: Client, subject: string) {
  const result = await client.query<{ id: string }>(
    "SELECT i.user_id AS id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND u.status='active' AND u.archived_at IS NULL",
    [subject],
  );
  return result.rows[0]?.id ?? null;
}
async function rollback<T>(client: Client, result: T) {
  await client.query('ROLLBACK');
  return result;
}
async function audit(
  client: Client,
  actor: string | null,
  action: string,
  targetId: string,
  correlationId: string,
  afterValue: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,after_value)
     VALUES ($1,$2,'account_invitation',$3,$4,$5)`,
    [actor, action, targetId, correlationId, JSON.stringify(afterValue)],
  );
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}
