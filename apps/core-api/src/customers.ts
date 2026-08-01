import { Client } from 'pg';
import type { FieldEncryptor } from './encryption.js';

export type CustomerProfile = {
  addresses: Array<{ id: string; label: string | null; value: Record<string, string> }>;
  id: string;
  value: Record<string, string>;
};
export type CustomerRepository = {
  getForSubject(subject: string): Promise<CustomerProfile | null>;
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
}
