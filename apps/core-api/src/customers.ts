import { Client } from 'pg';
import { z } from 'zod';
import type { FieldEncryptor } from './encryption.js';
import { createAuditEvent } from './audit.js';

export type CustomerProfile = {
  addresses: Array<{ id: string; label: string | null; value: Record<string, string> }>;
  id: string;
  value: Record<string, string>;
};
export type CustomerRepository = {
  getForSubject(subject: string): Promise<CustomerProfile | null>;
  registerForSubject?(
    subject: string,
    input: CustomerRegistration,
    correlationId: string,
  ): Promise<CustomerProfile>;
  addAddressForSubject?(
    subject: string,
    input: CustomerAddressInput,
    correlationId: string,
  ): Promise<{ id: string; label: string | null; value: Record<string, string> } | null>;
  addDeviceForSubject?(
    subject: string,
    input: CustomerDeviceInput,
    correlationId: string,
  ): Promise<{ id: string; status: string; value: Record<string, string> } | null>;
  portalOverviewForSubject?(
    subject: string,
    page?: CustomerPortalPage,
  ): Promise<CustomerPortalOverview | null>;
  updateForSubject?(
    subject: string,
    input: CustomerProfileUpdate,
    correlationId: string,
  ): Promise<CustomerProfile | null>;
  closeAccountForSubject?(
    subject: string,
    input: CustomerAccountClosureInput,
    correlationId: string,
  ): Promise<CustomerAccountClosure | null | 'active_subscription'>;
};
const customerValueSchema = z.record(z.string(), z.string().trim().min(1).max(500));
export const customerRegistrationSchema = z.object({
  email: z.string().trim().email().max(320),
  idempotencyKey: z.uuid(),
  profile: customerValueSchema,
});
export type CustomerRegistration = z.infer<typeof customerRegistrationSchema>;
export const customerProfileUpdateSchema = z.object({
  idempotencyKey: z.uuid(),
  profile: customerValueSchema,
});
export type CustomerProfileUpdate = z.infer<typeof customerProfileUpdateSchema>;
export const customerAccountClosureSchema = z.object({
  confirmation: z.literal('CLOSE_MY_ACCOUNT'),
  idempotencyKey: z.uuid(),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type CustomerAccountClosureInput = z.infer<typeof customerAccountClosureSchema>;
export type CustomerAccountClosure = { closedAt: Date; status: 'closed' };
export const customerAddressSchema = z.object({
  idempotencyKey: z.uuid(),
  label: z.string().trim().min(1).max(100).nullable().optional(),
  value: customerValueSchema,
});
export type CustomerAddressInput = z.infer<typeof customerAddressSchema>;
export const customerDeviceSchema = z.object({
  idempotencyKey: z.uuid(),
  value: customerValueSchema,
});
export type CustomerDeviceInput = z.infer<typeof customerDeviceSchema>;
export type CustomerPortalPage = { limit: number; offset: number };
export const customerPortalPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type CustomerPortalOverview = CustomerProfile & {
  devices: Array<{ id: string; status: string; value: Record<string, string> }>;
  jobs: Array<{ id: string; status: string; windowEnd: Date; windowStart: Date }>;
  quotes: Array<{ currency: string; id: string; status: string; totalAmountMinor: string }>;
  subscriptions: Array<{
    cadence: string;
    id: string;
    name: string;
    renewalAt: Date | null;
    status: string;
  }>;
  page: CustomerPortalPage & { nextOffset: number | null };
};
type EncryptedRow = {
  auth_tag: Buffer;
  ciphertext: Buffer;
  id: string;
  iv: Buffer;
  key_id: string;
  label: string | null;
};

export const customerPortalPermissionDefinitions = [
  ['customer.profile.read', 'Read own customer profile'],
  ['customer.profile.write', 'Manage own customer profile'],
  ['customer.portal.read', 'Read own customer portal'],
  ['repair-request.create', 'Create own repair requests'],
  ['payment-method.read', 'Read own saved payment methods'],
  ['payment-method.manage', 'Manage own saved payment methods'],
  ['subscription.enroll', 'Enroll in available subscriptions'],
  ['subscription.cancel', 'Cancel own subscriptions'],
  ['customer.account.close', 'Close own customer account'],
] as const;

export class PostgresCustomerRepository implements CustomerRepository {
  constructor(
    private readonly databaseUrl: string,
    private readonly encryptor: FieldEncryptor,
  ) {}
  async getForSubject(subject: string): Promise<CustomerProfile | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const profile = await client.query<EncryptedRow>(
        `SELECT cp.id, cp.ciphertext, cp.iv, cp.auth_tag, cp.key_id, NULL::text AS label
         FROM identities i JOIN customer_profile_memberships cpm ON cpm.user_id = i.user_id
         JOIN customer_profiles cp ON cp.id = cpm.customer_profile_id
         WHERE i.provider = 'auth0' AND i.provider_subject = $1 AND cp.status = 'active'
         ORDER BY cpm.created_at LIMIT 1`,
        [subject],
      );
      const row = profile.rows[0];
      if (!row) return null;
      const addresses = await client.query<EncryptedRow>(
        `SELECT ca.id, ca.ciphertext, ca.iv, ca.auth_tag, ca.key_id, cpa.label
         FROM customer_profile_addresses cpa JOIN customer_addresses ca ON ca.id = cpa.customer_address_id
         WHERE cpa.customer_profile_id = $1 AND cpa.deactivated_at IS NULL ORDER BY cpa.created_at`,
        [row.id],
      );
      return {
        id: row.id,
        value: this.encryptor.decrypt<Record<string, string>>({
          ...row,
          authTag: row.auth_tag,
          keyId: row.key_id,
        }),
        addresses: addresses.rows.map((address) => ({
          id: address.id,
          label: address.label,
          value: this.encryptor.decrypt<Record<string, string>>({
            ...address,
            authTag: address.auth_tag,
            keyId: address.key_id,
          }),
        })),
      };
    } finally {
      await client.end();
    }
  }
  async registerForSubject(
    subject: string,
    input: CustomerRegistration,
    correlationId: string,
  ): Promise<CustomerProfile> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const identity = await client.query<{ user_id: string }>(
        "SELECT user_id FROM identities WHERE provider='auth0' AND provider_subject=$1 FOR UPDATE",
        [subject],
      );
      if (identity.rows[0]) {
        await this.ensurePortalAccess(client, identity.rows[0].user_id);
        await client.query('COMMIT');
        const existing = await this.getForSubject(subject);
        if (existing) return existing;
        throw new Error('IDENTITY_ALREADY_LINKED');
      }
      const email = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email)=lower($1) FOR UPDATE',
        [input.email],
      );
      if (email.rows[0]) throw new Error('EMAIL_ALREADY_LINKED');
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id",
        [input.email],
      );
      const userId = user.rows[0]!.id;
      await client.query(
        "INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,'auth0',$2)",
        [userId, subject],
      );
      const encrypted = this.encryptor.encrypt(input.profile);
      const profile = await client.query<{ id: string }>(
        'INSERT INTO customer_profiles (ciphertext,iv,auth_tag,key_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyId],
      );
      await client.query(
        'INSERT INTO customer_profile_memberships (customer_profile_id,user_id) VALUES ($1,$2)',
        [profile.rows[0]!.id, userId],
      );
      await this.syncPhoneLookups(client, profile.rows[0]!.id, input.profile);
      await this.ensurePortalAccess(client, userId);
      await this.audit(client, userId, 'customer.registered', profile.rows[0]!.id, correlationId, {
        profileFields: Object.keys(input.profile).sort(),
      });
      await client.query('COMMIT');
      return { addresses: [], id: profile.rows[0]!.id, value: input.profile };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async addAddressForSubject(
    subject: string,
    input: CustomerAddressInput,
    correlationId: string,
  ): Promise<{ id: string; label: string | null; value: Record<string, string> } | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const owner = await this.owner(client, subject);
      if (!owner) {
        await client.query('ROLLBACK');
        return null;
      }
      const existing = await client.query<{
        id: string;
        label: string | null;
        ciphertext: Buffer;
        iv: Buffer;
        auth_tag: Buffer;
        key_id: string;
      }>(
        `SELECT ca.id,cpa.label,ca.ciphertext,ca.iv,ca.auth_tag,ca.key_id FROM customer_profile_addresses cpa
         JOIN customer_addresses ca ON ca.id=cpa.customer_address_id
         WHERE cpa.customer_profile_id=$1 AND cpa.idempotency_key=$2`,
        [owner.profileId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        const row = existing.rows[0];
        return { id: row.id, label: row.label, value: this.decrypt(row) };
      }
      const encrypted = this.encryptor.encrypt(input.value);
      const address = await client.query<{ id: string }>(
        'INSERT INTO customer_addresses (ciphertext,iv,auth_tag,key_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyId],
      );
      await client.query(
        'INSERT INTO customer_profile_addresses (customer_profile_id,customer_address_id,label,idempotency_key) VALUES ($1,$2,$3,$4)',
        [owner.profileId, address.rows[0]!.id, input.label ?? null, input.idempotencyKey],
      );
      await this.audit(
        client,
        owner.userId,
        'customer.address_added',
        address.rows[0]!.id,
        correlationId,
        { label: input.label ?? null },
      );
      await client.query('COMMIT');
      return { id: address.rows[0]!.id, label: input.label ?? null, value: input.value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async updateForSubject(
    subject: string,
    input: CustomerProfileUpdate,
    correlationId: string,
  ): Promise<CustomerProfile | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const owner = await this.owner(client, subject);
      if (!owner) {
        await client.query('ROLLBACK');
        return null;
      }
      const existing = await client.query<EncryptedRow>(
        `SELECT id,ciphertext,iv,auth_tag,key_id,NULL::text AS label FROM customer_profile_revisions
         WHERE customer_profile_id=$1 AND idempotency_key=$2`,
        [owner.profileId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return this.getForSubject(subject);
      }
      const current = await client.query<EncryptedRow>(
        `SELECT id,ciphertext,iv,auth_tag,key_id,NULL::text AS label FROM customer_profiles
         WHERE id=$1 AND status='active' AND archived_at IS NULL FOR UPDATE`,
        [owner.profileId],
      );
      const currentRow = current.rows[0];
      if (!currentRow) {
        await client.query('ROLLBACK');
        return null;
      }
      const beforeValue = this.decrypt(currentRow);
      const encrypted = this.encryptor.encrypt(input.profile);
      await client.query(
        `UPDATE customer_profiles SET ciphertext=$2,iv=$3,auth_tag=$4,key_id=$5,updated_at=now() WHERE id=$1`,
        [owner.profileId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyId],
      );
      await client.query<EncryptedRow>(
        `INSERT INTO customer_profile_revisions (customer_profile_id,actor_user_id,ciphertext,iv,auth_tag,key_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id,ciphertext,iv,auth_tag,key_id,NULL::text AS label`,
        [
          owner.profileId,
          owner.userId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyId,
          input.idempotencyKey,
        ],
      );
      await this.syncPhoneLookups(client, owner.profileId, input.profile);
      const changedFields = Array.from(
        new Set([...Object.keys(beforeValue), ...Object.keys(input.profile)]),
      )
        .filter((key) => beforeValue[key] !== input.profile[key])
        .sort();
      await this.audit(
        client,
        owner.userId,
        'customer.profile_updated',
        owner.profileId,
        correlationId,
        {
          changedFields,
        },
      );
      await client.query('COMMIT');
      return this.getForSubject(subject);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async closeAccountForSubject(
    subject: string,
    input: CustomerAccountClosureInput,
    correlationId: string,
  ): Promise<CustomerAccountClosure | null | 'active_subscription'> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const owner = await this.owner(client, subject);
      if (!owner) {
        const closed = await client.query<{ closed_at: Date }>(
          `SELECT cac.closed_at FROM identities i JOIN customer_profile_memberships cpm ON cpm.user_id=i.user_id
           JOIN customer_account_closures cac ON cac.customer_profile_id=cpm.customer_profile_id
           WHERE i.provider='auth0' AND i.provider_subject=$1 ORDER BY cac.closed_at DESC LIMIT 1`,
          [subject],
        );
        await client.query('COMMIT');
        return closed.rows[0] ? { closedAt: closed.rows[0].closed_at, status: 'closed' } : null;
      }
      const existing = await client.query<{ closed_at: Date }>(
        `SELECT closed_at FROM customer_account_closures WHERE customer_profile_id=$1 AND idempotency_key=$2`,
        [owner.profileId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { closedAt: existing.rows[0].closed_at, status: 'closed' };
      }
      const activeSubscriptions = await client.query<{ id: string }>(
        `SELECT id FROM customer_subscriptions WHERE customer_profile_id=$1
         AND status IN ('pending','active','past_due','grace') LIMIT 1 FOR UPDATE`,
        [owner.profileId],
      );
      if (activeSubscriptions.rows[0]) {
        await client.query('ROLLBACK');
        return 'active_subscription';
      }
      const closure = await client.query<{ closed_at: Date }>(
        `INSERT INTO customer_account_closures (customer_profile_id,actor_user_id,idempotency_key,reason)
         VALUES ($1,$2,$3,$4) RETURNING closed_at`,
        [owner.profileId, owner.userId, input.idempotencyKey, input.reason ?? null],
      );
      await client.query(
        `UPDATE customer_profiles SET status='archived',archived_at=now(),updated_at=now() WHERE id=$1`,
        [owner.profileId],
      );
      await client.query(
        `UPDATE customer_addresses ca SET archived_at=now(),updated_at=now()
         FROM customer_profile_addresses cpa WHERE cpa.customer_address_id=ca.id AND cpa.customer_profile_id=$1
         AND cpa.deactivated_at IS NULL`,
        [owner.profileId],
      );
      await client.query(
        `UPDATE customer_devices SET archived_at=now(),updated_at=now()
         WHERE customer_profile_id=$1 AND archived_at IS NULL`,
        [owner.profileId],
      );
      await client.query(
        `UPDATE customer_payment_methods SET status='inactive',is_primary=false,deactivated_at=now(),updated_at=now()
         WHERE customer_profile_id=$1 AND deactivated_at IS NULL`,
        [owner.profileId],
      );
      await client.query(
        `UPDATE application_entitlements ae SET deactivated_at=now(),updated_at=now()
         FROM applications a WHERE ae.application_id=a.id AND ae.user_id=$1 AND a.key='customer-portal'
         AND ae.deactivated_at IS NULL`,
        [owner.userId],
      );
      await client.query(
        `UPDATE user_roles ur SET effective_to=now(),updated_at=now()
         FROM roles r JOIN applications a ON a.id=r.application_id
         WHERE ur.user_id=$1 AND ur.role_id=r.id AND a.key='customer-portal' AND ur.effective_to IS NULL`,
        [owner.userId],
      );
      await this.audit(
        client,
        owner.userId,
        'customer.account_closed',
        owner.profileId,
        correlationId,
        {
          reasonProvided: Boolean(input.reason),
        },
      );
      await client.query('COMMIT');
      return { closedAt: closure.rows[0]!.closed_at, status: 'closed' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async addDeviceForSubject(
    subject: string,
    input: CustomerDeviceInput,
    correlationId: string,
  ): Promise<{ id: string; status: string; value: Record<string, string> } | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const owner = await this.owner(client, subject);
      if (!owner) {
        await client.query('ROLLBACK');
        return null;
      }
      const existing = await client.query<EncryptedRow & { status: string }>(
        'SELECT id,status,ciphertext,iv,auth_tag,key_id,NULL::text AS label FROM customer_devices WHERE customer_profile_id=$1 AND idempotency_key=$2',
        [owner.profileId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        const row = existing.rows[0];
        return { id: row.id, status: row.status, value: this.decrypt(row) };
      }
      const encrypted = this.encryptor.encrypt(input.value);
      const device = await client.query<{ id: string }>(
        'INSERT INTO customer_devices (customer_profile_id,ciphertext,iv,auth_tag,key_id,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [
          owner.profileId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyId,
          input.idempotencyKey,
        ],
      );
      await this.audit(
        client,
        owner.userId,
        'customer.device_added',
        device.rows[0]!.id,
        correlationId,
        { status: 'active' },
      );
      await client.query('COMMIT');
      return { id: device.rows[0]!.id, status: 'active', value: input.value };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async portalOverviewForSubject(
    subject: string,
    page: CustomerPortalPage = { limit: 50, offset: 0 },
  ): Promise<CustomerPortalOverview | null> {
    const profile = await this.getForSubject(subject);
    if (!profile) return null;
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const devices = await client.query<EncryptedRow & { status: string }>(
        `SELECT id, status, ciphertext, iv, auth_tag, key_id, NULL::text AS label
           FROM customer_devices WHERE customer_profile_id=$1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [profile.id, page.limit, page.offset],
      );
      const quotes = await client.query<{
        currency: string;
        id: string;
        status: string;
        total_amount_minor: string;
      }>(
        `SELECT id, status, currency, total_amount_minor FROM quotes WHERE customer_profile_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [profile.id, page.limit, page.offset],
      );
      const jobs = await client.query<{
        id: string;
        status: string;
        window_end: Date;
        window_start: Date;
      }>(
        `SELECT j.id, COALESCE(t.to_status,j.initial_status) status,a.window_start,a.window_end FROM jobs j
           JOIN appointments a ON a.job_id=j.id LEFT JOIN LATERAL (SELECT to_status FROM job_transitions WHERE job_id=j.id ORDER BY occurred_at DESC,id DESC LIMIT 1) t ON true
           WHERE j.customer_profile_id=$1 ORDER BY a.window_start DESC,j.id DESC LIMIT $2 OFFSET $3`,
        [profile.id, page.limit, page.offset],
      );
      const subscriptions = await client.query<{
        cadence: string;
        id: string;
        name: string;
        renewal_at: Date | null;
        status: string;
      }>(
        `SELECT cs.id,cs.status,cs.renewal_at,spv.name,spv.cadence FROM customer_subscriptions cs
           JOIN subscription_plan_versions spv ON spv.id=cs.subscription_plan_version_id
           WHERE cs.customer_profile_id=$1 ORDER BY cs.created_at DESC,cs.id DESC LIMIT $2 OFFSET $3`,
        [profile.id, page.limit, page.offset],
      );
      return {
        ...profile,
        page: {
          ...page,
          nextOffset: [devices, quotes, jobs, subscriptions].some(
            (result) => result.rowCount === page.limit,
          )
            ? page.offset + page.limit
            : null,
        },
        devices: devices.rows.map((device) => ({
          id: device.id,
          status: device.status,
          value: this.encryptor.decrypt<Record<string, string>>({
            ...device,
            authTag: device.auth_tag,
            keyId: device.key_id,
          }),
        })),
        jobs: jobs.rows.map((job) => ({
          id: job.id,
          status: job.status,
          windowEnd: job.window_end,
          windowStart: job.window_start,
        })),
        quotes: quotes.rows.map((quote) => ({
          id: quote.id,
          status: quote.status,
          currency: quote.currency,
          totalAmountMinor: quote.total_amount_minor,
        })),
        subscriptions: subscriptions.rows.map((subscription) => ({
          id: subscription.id,
          status: subscription.status,
          renewalAt: subscription.renewal_at,
          name: subscription.name,
          cadence: subscription.cadence,
        })),
      };
    } finally {
      await client.end();
    }
  }
  private decrypt(row: { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_id: string }) {
    return this.encryptor.decrypt<Record<string, string>>({
      authTag: row.auth_tag,
      ciphertext: row.ciphertext,
      iv: row.iv,
      keyId: row.key_id,
    });
  }
  private async owner(client: Client, subject: string) {
    const result = await client.query<{ profile_id: string; user_id: string }>(
      `SELECT cpm.customer_profile_id AS profile_id,i.user_id FROM identities i
       JOIN customer_profile_memberships cpm ON cpm.user_id=i.user_id
       JOIN customer_profiles cp ON cp.id=cpm.customer_profile_id
       WHERE i.provider='auth0' AND i.provider_subject=$1 AND cp.status='active' AND cp.archived_at IS NULL
       ORDER BY cpm.created_at LIMIT 1`,
      [subject],
    );
    const row = result.rows[0];
    return row ? { profileId: row.profile_id, userId: row.user_id } : null;
  }
  private async ensurePortalAccess(client: Client, userId: string): Promise<void> {
    const application = await client.query<{ id: string }>(
      `INSERT INTO applications (key,name) VALUES ('customer-portal','Obsidian Customer Portal')
       ON CONFLICT (key) DO UPDATE SET deactivated_at=NULL RETURNING id`,
    );
    const applicationId = application.rows[0]!.id;
    const role = await client.query<{ id: string }>(
      `INSERT INTO roles (application_id,key,name,deactivated_at) VALUES ($1,'customer-self-service','Customer Self-Service',NULL)
       ON CONFLICT (application_id,key) DO UPDATE SET deactivated_at=NULL RETURNING id`,
      [applicationId],
    );
    for (const [key, name] of customerPortalPermissionDefinitions) {
      const permission = await client.query<{ id: string }>(
        `INSERT INTO permissions (key,name) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [key, name],
      );
      await client.query(
        'INSERT INTO role_permissions (role_id,permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [role.rows[0]!.id, permission.rows[0]!.id],
      );
    }
    await client.query(
      `INSERT INTO user_roles (user_id,role_id) SELECT $1,$2 WHERE NOT EXISTS
       (SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2 AND organization_id IS NULL AND effective_to IS NULL)`,
      [userId, role.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO application_entitlements (user_id,application_id) SELECT $1,$2 WHERE NOT EXISTS
       (SELECT 1 FROM application_entitlements WHERE user_id=$1 AND application_id=$2 AND deactivated_at IS NULL AND effective_to IS NULL)`,
      [userId, applicationId],
    );
  }
  private async syncPhoneLookups(
    client: Client,
    customerProfileId: string,
    profile: Record<string, string>,
  ): Promise<void> {
    const hashes = Array.from(
      new Set(
        Object.entries(profile)
          .filter(([key]) => /(?:phone|mobile|telephone|cell)/i.test(key))
          .map(([, value]) => normalizePhone(value))
          .filter((value): value is string => value !== null)
          .map((value) => this.encryptor.fingerprint('customer-phone-v1', value)),
      ),
    );
    await client.query('DELETE FROM customer_contact_phone_lookups WHERE customer_profile_id=$1', [
      customerProfileId,
    ]);
    for (const valueHash of hashes)
      await client.query(
        'INSERT INTO customer_contact_phone_lookups (customer_profile_id,value_hash) VALUES ($1,$2)',
        [customerProfileId, valueHash],
      );
  }
  private async audit(
    client: Client,
    actorUserId: string,
    action: string,
    targetId: string,
    correlationId: string,
    afterValue: Record<string, unknown>,
  ): Promise<void> {
    const event = createAuditEvent({
      actorUserId,
      action,
      targetType: 'customer',
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

function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}
