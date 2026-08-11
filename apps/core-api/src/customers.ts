import { Client } from 'pg';
import { z } from 'zod';
import type { FieldEncryptor } from './encryption.js';

export type CustomerProfile = {
  addresses: Array<{ id: string; label: string | null; value: Record<string, string> }>;
  id: string;
  value: Record<string, string>;
};
export type CustomerRepository = {
  getForSubject(subject: string): Promise<CustomerProfile | null>;
  portalOverviewForSubject?(
    subject: string,
    page?: CustomerPortalPage,
  ): Promise<CustomerPortalOverview | null>;
};
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
}
