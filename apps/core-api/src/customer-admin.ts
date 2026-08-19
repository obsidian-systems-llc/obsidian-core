import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import type { FieldEncryptor } from './encryption.js';

const customerValue = z
  .record(z.string().trim().min(1).max(100), z.string().trim().max(4_000))
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 100);
export const createAdminCustomerSchema = z.object({
  idempotencyKey: z.uuid(),
  profile: customerValue,
});
export const updateAdminCustomerSchema = z.object({
  idempotencyKey: z.uuid(),
  profile: customerValue,
  reason: z.string().trim().min(3).max(500),
});
export const repairCustomerAssociationSchema = z.object({
  customerProfileId: z.uuid().nullable(),
  idempotencyKey: z.uuid(),
  reason: z.string().trim().min(3).max(500),
});
export const customerRepairPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminCustomer = { id: string; status: string; value: Record<string, string> };
export type RepairCustomerAssociation = {
  customerProfileId: string | null;
  id: string;
  status: string;
  windowEnd: Date;
  windowStart: Date;
};
export type CustomerPortalRepair = {
  id: string;
  status: string;
  windowEnd: Date;
  windowStart: Date;
};
export type CustomerAdministrationRepository = {
  create(
    subject: string,
    input: z.infer<typeof createAdminCustomerSchema>,
    correlationId: string,
  ): Promise<AdminCustomer | null>;
  get(customerId: string): Promise<AdminCustomer | null>;
  update(
    subject: string,
    customerId: string,
    input: z.infer<typeof updateAdminCustomerSchema>,
    correlationId: string,
  ): Promise<AdminCustomer | null>;
  associateRepair(
    subject: string,
    jobId: string,
    input: z.infer<typeof repairCustomerAssociationSchema>,
    correlationId: string,
  ): Promise<RepairCustomerAssociation | null | 'unchanged'>;
  listPortalRepairs(
    subject: string,
    page: z.infer<typeof customerRepairPageSchema>,
  ): Promise<{ items: CustomerPortalRepair[]; nextOffset: number | null } | null>;
};
type CustomerRow = {
  id: string;
  status: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_id: string;
};
type JobRow = {
  id: string;
  customer_profile_id: string | null;
  status: string;
  window_start: Date;
  window_end: Date;
};

export class PostgresCustomerAdministrationRepository implements CustomerAdministrationRepository {
  constructor(
    private readonly databaseUrl: string,
    private readonly encryptor: FieldEncryptor,
  ) {}

  async create(
    subject: string,
    input: z.infer<typeof createAdminCustomerSchema>,
    correlationId: string,
  ) {
    return this.transact(subject, async (client, actor) => {
      const prior = await this.command<AdminCustomer>(
        client,
        actor,
        'customer_created',
        input.idempotencyKey,
      );
      if (prior) return prior;
      const encrypted = this.encryptor.encrypt(input.profile);
      const result = await client.query<CustomerRow>(
        'INSERT INTO customer_profiles (ciphertext,iv,auth_tag,key_id) VALUES ($1,$2,$3,$4) RETURNING id,status,ciphertext,iv,auth_tag,key_id',
        [encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyId],
      );
      const customer = this.customer(result.rows[0]!);
      await this.storeCommand(
        client,
        actor,
        'customer_created',
        input.idempotencyKey,
        'customer_profile',
        customer.id,
        customer,
      );
      await this.audit(
        client,
        actor,
        'customer.created',
        'customer_profile',
        customer.id,
        correlationId,
        { status: customer.status },
      );
      return customer;
    });
  }
  async get(customerId: string) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const row = await this.customerRow(client, customerId);
      return row ? this.customer(row) : null;
    } finally {
      await client.end();
    }
  }
  async update(
    subject: string,
    customerId: string,
    input: z.infer<typeof updateAdminCustomerSchema>,
    correlationId: string,
  ) {
    return this.transact(subject, async (client, actor) => {
      const prior = await this.command<AdminCustomer>(
        client,
        actor,
        'customer_updated',
        input.idempotencyKey,
      );
      if (prior) return prior;
      const current = await this.customerRow(client, customerId, true);
      if (!current || current.status !== 'active') return null;
      const previous = this.decrypt(current);
      const encrypted = this.encryptor.encrypt(input.profile);
      const changedFieldNames = Array.from(
        new Set([...Object.keys(previous), ...Object.keys(input.profile)]),
      )
        .filter((key) => previous[key] !== input.profile[key])
        .sort();
      await client.query(
        'INSERT INTO customer_profile_revisions (customer_profile_id,actor_user_id,ciphertext,iv,auth_tag,key_id,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          customerId,
          actor,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyId,
          input.idempotencyKey,
        ],
      );
      const updated = await client.query<CustomerRow>(
        'UPDATE customer_profiles SET ciphertext=$2,iv=$3,auth_tag=$4,key_id=$5,updated_at=now() WHERE id=$1 RETURNING id,status,ciphertext,iv,auth_tag,key_id',
        [customerId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyId],
      );
      const customer = this.customer(updated.rows[0]!);
      await this.storeCommand(
        client,
        actor,
        'customer_updated',
        input.idempotencyKey,
        'customer_profile',
        customerId,
        customer,
      );
      await this.audit(
        client,
        actor,
        'customer.updated',
        'customer_profile',
        customerId,
        correlationId,
        { changedFieldNames, reason: input.reason },
      );
      return customer;
    });
  }
  async associateRepair(
    subject: string,
    jobId: string,
    input: z.infer<typeof repairCustomerAssociationSchema>,
    correlationId: string,
  ) {
    return this.transact(subject, async (client, actor) => {
      const prior = await this.command<RepairCustomerAssociation>(
        client,
        actor,
        'repair_customer_associated',
        input.idempotencyKey,
      );
      if (prior) return prior;
      const job = await this.job(client, jobId, true);
      if (!job) return null;
      if (input.customerProfileId) {
        const customer = await client.query(
          "SELECT 1 FROM customer_profiles WHERE id=$1 AND status='active' AND archived_at IS NULL",
          [input.customerProfileId],
        );
        if (!customer.rows[0]) return null;
      }
      if (job.customer_profile_id === input.customerProfileId) return 'unchanged' as const;
      const action = input.customerProfileId
        ? job.customer_profile_id
          ? 'relinked'
          : 'linked'
        : 'removed';
      await client.query('UPDATE jobs SET customer_profile_id=$2 WHERE id=$1', [
        jobId,
        input.customerProfileId,
      ]);
      await client.query(
        'INSERT INTO job_customer_association_events (job_id,actor_user_id,action,previous_customer_profile_id,customer_profile_id,reason,idempotency_key,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          jobId,
          actor,
          action,
          job.customer_profile_id,
          input.customerProfileId,
          input.reason,
          input.idempotencyKey,
          this.correlation(correlationId),
        ],
      );
      const result: RepairCustomerAssociation = {
        id: job.id,
        customerProfileId: input.customerProfileId,
        status: job.status,
        windowStart: job.window_start,
        windowEnd: job.window_end,
      };
      await this.storeCommand(
        client,
        actor,
        'repair_customer_associated',
        input.idempotencyKey,
        'job',
        jobId,
        result,
      );
      await this.audit(client, actor, `repair.customer_${action}`, 'job', jobId, correlationId, {
        previousCustomerProfileId: job.customer_profile_id,
        customerProfileId: input.customerProfileId,
        reason: input.reason,
      });
      return result;
    });
  }
  async listPortalRepairs(subject: string, page: z.infer<typeof customerRepairPageSchema>) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const customer = await client.query<{ profile_id: string }>(
        `SELECT cpm.customer_profile_id profile_id FROM identities i JOIN customer_profile_memberships cpm ON cpm.user_id=i.user_id JOIN customer_profiles cp ON cp.id=cpm.customer_profile_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND cp.status='active' AND cp.archived_at IS NULL ORDER BY cpm.created_at LIMIT 1`,
        [subject],
      );
      const profileId = customer.rows[0]?.profile_id;
      if (!profileId) return null;
      const rows = await client.query<JobRow>(
        `SELECT j.id,j.customer_profile_id,COALESCE(t.to_status,j.initial_status) status,a.window_start,a.window_end FROM jobs j JOIN appointments a ON a.job_id=j.id LEFT JOIN LATERAL (SELECT to_status FROM job_transitions WHERE job_id=j.id ORDER BY occurred_at DESC,id DESC LIMIT 1) t ON true WHERE j.customer_profile_id=$1 ORDER BY a.window_start DESC,j.id DESC LIMIT $2 OFFSET $3`,
        [profileId, page.limit + 1, page.offset],
      );
      const items = rows.rows.slice(0, page.limit).map((row) => ({
        id: row.id,
        status: row.status,
        windowStart: row.window_start,
        windowEnd: row.window_end,
      }));
      return { items, nextOffset: rows.rows.length > page.limit ? page.offset + page.limit : null };
    } finally {
      await client.end();
    }
  }
  private async transact<T>(subject: string, work: (client: Client, actor: string) => Promise<T>) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actor = await this.actor(client, subject);
      if (!actor) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await work(client, actor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async actor(client: Client, subject: string) {
    const result = await client.query<{ id: string }>(
      "SELECT i.user_id id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND u.status='active' AND u.archived_at IS NULL",
      [subject],
    );
    return result.rows[0]?.id ?? null;
  }
  private async command<T>(client: Client, actor: string, action: string, key: string) {
    const result = await client.query<{ result: T }>(
      'SELECT result FROM customer_administration_commands WHERE actor_user_id=$1 AND action=$2 AND idempotency_key=$3',
      [actor, action, key],
    );
    return result.rows[0]?.result ?? null;
  }
  private async storeCommand(
    client: Client,
    actor: string,
    action: string,
    key: string,
    targetType: string,
    targetId: string,
    result: unknown,
  ) {
    await client.query(
      'INSERT INTO customer_administration_commands (actor_user_id,action,idempotency_key,target_type,target_id,result) VALUES ($1,$2,$3,$4,$5,$6)',
      [actor, action, key, targetType, targetId, JSON.stringify(result)],
    );
  }
  private async customerRow(client: Client, id: string, lock = false) {
    if (lock) await client.query('SELECT id FROM customer_profiles WHERE id=$1 FOR UPDATE', [id]);
    const result = await client.query<CustomerRow>(
      'SELECT id,status,ciphertext,iv,auth_tag,key_id FROM customer_profiles WHERE id=$1',
      [id],
    );
    return result.rows[0] ?? null;
  }
  private async job(client: Client, id: string, lock = false) {
    if (lock) await client.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [id]);
    const result = await client.query<JobRow>(
      `SELECT j.id,j.customer_profile_id,COALESCE(t.to_status,j.initial_status) status,a.window_start,a.window_end FROM jobs j JOIN appointments a ON a.job_id=j.id LEFT JOIN LATERAL (SELECT to_status FROM job_transitions WHERE job_id=j.id ORDER BY occurred_at DESC,id DESC LIMIT 1) t ON true WHERE j.id=$1`,
      [id],
    );
    return result.rows[0] ?? null;
  }
  private decrypt(row: CustomerRow) {
    return this.encryptor.decrypt<Record<string, string>>({
      ...row,
      authTag: row.auth_tag,
      keyId: row.key_id,
    });
  }
  private customer(row: CustomerRow): AdminCustomer {
    return { id: row.id, status: row.status, value: this.decrypt(row) };
  }
  private correlation(value: string) {
    return z.uuid().safeParse(value).success ? value : randomUUID();
  }
  private async audit(
    client: Client,
    actor: string,
    action: string,
    targetType: string,
    targetId: string,
    correlationId: string,
    afterValue: Record<string, unknown>,
  ) {
    await client.query(
      'INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,after_value) VALUES ($1,$2,$3,$4,$5,$6)',
      [actor, action, targetType, targetId, this.correlation(correlationId), afterValue],
    );
  }
}
