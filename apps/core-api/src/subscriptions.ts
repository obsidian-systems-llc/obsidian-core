import { z } from 'zod';
import { Client } from 'pg';

export const subscriptionPlanVersionSchema = z.object({
  amountMinor: z.coerce.bigint().nonnegative(),
  cadence: z.enum(['monthly', 'annual']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  effectiveFrom: z.coerce.date(),
  name: z.string().trim().min(1).max(200),
  planKey: z.string().trim().min(1).max(100),
  providerPlanReference: z.string().trim().min(1).max(500).nullable().optional(),
});
export type SubscriptionPlanVersion = z.infer<typeof subscriptionPlanVersionSchema>;
export type SubscriptionPlanRepository = {
  createVersion(input: SubscriptionPlanVersion): Promise<{ id: string }>;
};
export const DEFAULT_DEVICE_PROTECTION_PLAN = {
  amountMinor: 1500n,
  cadence: 'monthly' as const,
  currency: 'USD',
  name: 'Device Protection',
};
export class PostgresSubscriptionPlanRepository implements SubscriptionPlanRepository {
  constructor(private readonly databaseUrl: string) {}
  async createVersion(input: SubscriptionPlanVersion): Promise<{ id: string }> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const plan = await client.query<{ id: string }>(
        'INSERT INTO subscription_plans (key) VALUES ($1) ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id',
        [input.planKey],
      );
      const version = await client.query<{ id: string }>(
        'INSERT INTO subscription_plan_versions (subscription_plan_id, version_number, name, currency, amount_minor, cadence, provider_plan_reference, effective_from) SELECT $1, COALESCE(MAX(version_number),0)+1,$2,$3,$4,$5,$6,$7 FROM subscription_plan_versions WHERE subscription_plan_id=$1 RETURNING id',
        [
          plan.rows[0]!.id,
          input.name,
          input.currency,
          input.amountMinor.toString(),
          input.cadence,
          input.providerPlanReference ?? null,
          input.effectiveFrom,
        ],
      );
      return { id: version.rows[0]!.id };
    } finally {
      await client.end();
    }
  }
}
