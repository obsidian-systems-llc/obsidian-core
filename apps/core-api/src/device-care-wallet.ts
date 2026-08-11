import { Client } from 'pg';

export type DeviceCareWallet = {
  availableMinor: string;
  balanceMinor: string;
  discounts: { accessoriesBasisPoints: number; repairsBasisPoints: number };
  maxStatus: boolean;
  membershipActive: boolean;
  usable: boolean;
};

export class PostgresDeviceCareWalletRepository {
  constructor(private readonly databaseUrl: string) {}
  async forSubject(subject: string): Promise<DeviceCareWallet | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const row = await client.query<{
        active: boolean;
        balance: string;
        cap: string;
        unlock: string;
      }>(
        `WITH customer AS (
           SELECT cp.id FROM identities i JOIN customer_profile_memberships cpm ON cpm.user_id=i.user_id
           JOIN customer_profiles cp ON cp.id=cpm.customer_profile_id
           WHERE i.provider='auth0' AND i.provider_subject=$1 AND cp.status='active' AND cp.archived_at IS NULL LIMIT 1
         ), policy AS (
           SELECT unlock_minor,cap_minor FROM device_care_membership_policies WHERE effective_from<=now()
           AND (effective_to IS NULL OR effective_to>now()) ORDER BY version_number DESC LIMIT 1
         ), ledger AS (
           SELECT COALESCE(SUM(l.amount_minor),0)::text AS balance FROM device_care_credit_ledger l
           JOIN customer_subscriptions cs ON cs.id=l.customer_subscription_id JOIN customer c ON c.id=cs.customer_profile_id
         ) SELECT EXISTS(SELECT 1 FROM customer) AS active,
           COALESCE((SELECT balance FROM ledger),'0') AS balance,
           COALESCE((SELECT cap_minor::text FROM policy),'35000') AS cap,
           COALESCE((SELECT unlock_minor::text FROM policy),'6000') AS unlock`,
        [subject],
      );
      const value = row.rows[0];
      if (!value?.active) return null;
      const balance = BigInt(value.balance);
      const cap = BigInt(value.cap);
      const unlock = BigInt(value.unlock);
      const active =
        (
          await client.query<{ exists: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM customer_subscriptions cs JOIN customer_profile_memberships cpm ON cpm.customer_profile_id=cs.customer_profile_id
         JOIN identities i ON i.user_id=cpm.user_id WHERE i.provider='auth0' AND i.provider_subject=$1
         AND cs.status='active') AS exists`,
            [subject],
          )
        ).rows[0]?.exists ?? false;
      const capped = balance > cap ? cap : balance < 0n ? 0n : balance;
      const maxStatus = active && capped >= cap;
      return {
        availableMinor: active && capped >= unlock ? capped.toString() : '0',
        balanceMinor: capped.toString(),
        discounts: active
          ? { accessoriesBasisPoints: maxStatus ? 2000 : 1500, repairsBasisPoints: 1000 }
          : { accessoriesBasisPoints: 0, repairsBasisPoints: 0 },
        maxStatus,
        membershipActive: active,
        usable: active && capped >= unlock,
      };
    } finally {
      await client.end();
    }
  }
}
