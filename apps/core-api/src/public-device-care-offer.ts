import { Client } from 'pg';

export type PublicDeviceCareOffer = {
  plan: {
    amountMinor: string;
    cadence: 'annual' | 'monthly';
    currency: string;
    effectiveFrom: Date;
    key: 'device-care';
    name: string;
  };
  repairCredits: {
    accrualMinor: string;
    capMinor: string;
    unlockMinor: string;
  };
};

export type PublicDeviceCareOfferRepository = {
  getActiveOffer(): Promise<PublicDeviceCareOffer | null>;
};

/**
 * Supplies only public, versioned Device Care terms. Enrollment and payment
 * actions remain behind the authenticated customer-portal boundary.
 */
export class PostgresPublicDeviceCareOfferRepository implements PublicDeviceCareOfferRepository {
  constructor(private readonly databaseUrl: string) {}

  async getActiveOffer(): Promise<PublicDeviceCareOffer | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const result = await client.query<{
        accrual_minor: string;
        amount_minor: string;
        cadence: 'annual' | 'monthly';
        cap_minor: string;
        currency: string;
        effective_from: Date;
        name: string;
        unlock_minor: string;
      }>(
        `SELECT spv.name, spv.currency, spv.amount_minor::text, spv.cadence, spv.effective_from,
                policy.accrual_minor::text, policy.unlock_minor::text, policy.cap_minor::text
           FROM subscription_plans sp
           JOIN subscription_plan_versions spv ON spv.subscription_plan_id=sp.id
           JOIN LATERAL (
             SELECT accrual_minor, unlock_minor, cap_minor
               FROM device_care_membership_policies
              WHERE effective_from<=now() AND (effective_to IS NULL OR effective_to>now())
              ORDER BY version_number DESC
              LIMIT 1
           ) policy ON true
          WHERE sp.key='device-care' AND sp.deactivated_at IS NULL
            AND spv.effective_from<=now() AND (spv.effective_to IS NULL OR spv.effective_to>now())
          ORDER BY spv.version_number DESC
          LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        plan: {
          amountMinor: row.amount_minor,
          cadence: row.cadence,
          currency: row.currency,
          effectiveFrom: row.effective_from,
          key: 'device-care',
          name: row.name,
        },
        repairCredits: {
          accrualMinor: row.accrual_minor,
          capMinor: row.cap_minor,
          unlockMinor: row.unlock_minor,
        },
      };
    } finally {
      await client.end();
    }
  }
}
