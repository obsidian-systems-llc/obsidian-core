import { z } from 'zod';
import { Client } from 'pg';
import { createAuditEvent } from './audit.js';

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
  createVersion(
    subject: string,
    input: SubscriptionPlanVersion,
    correlationId: string,
  ): Promise<{ id: string } | null>;
};
export const DEFAULT_DEVICE_PROTECTION_PLAN = {
  amountMinor: 1500n,
  cadence: 'monthly' as const,
  currency: 'USD',
  name: 'Device Protection',
};
export class PostgresSubscriptionPlanRepository implements SubscriptionPlanRepository {
  constructor(private readonly databaseUrl: string) {}
  async createVersion(
    subject: string,
    input: SubscriptionPlanVersion,
    correlationId: string,
  ): Promise<{ id: string } | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.planKey]);
      const user = await client.query<{ id: string }>(
        `SELECT i.user_id AS id FROM identities i JOIN users u ON u.id = i.user_id
         WHERE i.provider = 'auth0' AND i.provider_subject = $1
           AND u.status = 'active' AND u.archived_at IS NULL`,
        [subject],
      );
      const actorUserId = user.rows[0]?.id;
      if (!actorUserId) {
        await client.query('ROLLBACK');
        return null;
      }
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
      const audit = createAuditEvent({
        action: 'subscription_plan_version.created',
        actorUserId,
        afterValue: {
          amountMinor: input.amountMinor.toString(),
          cadence: input.cadence,
          currency: input.currency,
          planKey: input.planKey,
        },
        beforeValue: null,
        correlationId,
        reason: null,
        targetId: version.rows[0]!.id,
        targetType: 'subscription_plan_version',
      });
      await client.query(
        `INSERT INTO audit_events
         (actor_user_id, action, target_type, target_id, correlation_id, reason, before_value, after_value, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          audit.actorUserId,
          audit.action,
          audit.targetType,
          audit.targetId,
          audit.correlationId,
          audit.reason,
          audit.beforeValue,
          audit.afterValue,
          audit.occurredAt,
        ],
      );
      await client.query('COMMIT');
      return { id: version.rows[0]!.id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
}
