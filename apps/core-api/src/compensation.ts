import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { createAuditEvent } from './audit.js';

export function calculateCommissionMinor(input: {
  eligibleRevenueMinor: bigint;
  commissionRateBasisPoints: number;
  attributionBasisPoints: number;
}): bigint {
  return (
    (input.eligibleRevenueMinor *
      BigInt(input.commissionRateBasisPoints) *
      BigInt(input.attributionBasisPoints)) /
    100000000n
  );
}
export const DEFAULT_COMPENSATION = { commissionRateBasisPoints: 1000, hourlyRateMinor: 2000 };
export const assignCompensationSchema = z
  .object({
    employeeProfileId: z.uuid(),
    compensationPlanVersionId: z.uuid(),
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date().nullable().optional(),
  })
  .refine((v) => !v.effectiveTo || v.effectiveTo > v.effectiveFrom, {
    path: ['effectiveTo'],
    message: 'effectiveTo must be after effectiveFrom.',
  });
export const createCommissionSchema = z.object({
  employeeProfileId: z.uuid(),
  compensationPlanVersionId: z.uuid(),
  sourceQuoteId: z.uuid().nullable().optional(),
  eligibleRevenueMinor: z.coerce.bigint().nonnegative(),
  attributionBasisPoints: z.coerce.number().int().min(1).max(10000),
});
export const commissionEventSchema = z.object({
  status: z.enum(['earned', 'approved', 'disputed', 'reversed', 'cancelled']),
  reason: z.string().trim().min(1).max(1000),
});
export type CompensationRepository = {
  assign(
    s: string,
    i: z.infer<typeof assignCompensationSchema>,
    c: string,
  ): Promise<{ id: string } | null>;
  createCommission(
    s: string,
    i: z.infer<typeof createCommissionSchema>,
    c: string,
  ): Promise<{ id: string; amountMinor: string } | null>;
  addCommissionEvent(
    s: string,
    id: string,
    i: z.infer<typeof commissionEventSchema>,
    c: string,
  ): Promise<{ id: string; status: string } | null>;
  earnings(
    s: string,
  ): Promise<{ estimatedCommissionMinor: string; pendingCommissionMinor: string } | null>;
};
export class PostgresCompensationRepository implements CompensationRepository {
  constructor(private readonly databaseUrl: string) {}
  async assign(
    subject: string,
    input: z.infer<typeof assignCompensationSchema>,
    correlationId: string,
  ) {
    return this.actor(subject, correlationId, async (c, a) => {
      const r = await c.query<{ id: string }>(
        'INSERT INTO employee_compensation_assignments (employee_profile_id,compensation_plan_version_id,effective_from,effective_to) VALUES ($1,$2,$3,$4) RETURNING id',
        [
          input.employeeProfileId,
          input.compensationPlanVersionId,
          input.effectiveFrom,
          input.effectiveTo ?? null,
        ],
      );
      await this.audit(
        c,
        a,
        'compensation_assignment.created',
        'employee_compensation_assignment',
        r.rows[0]!.id,
        correlationId,
        null,
        { employeeProfileId: input.employeeProfileId },
      );
      return r.rows[0]!;
    });
  }
  async createCommission(
    subject: string,
    input: z.infer<typeof createCommissionSchema>,
    correlationId: string,
  ) {
    return this.actor(subject, correlationId, async (c, a) => {
      const p = await c.query<{ commission_rate_basis_points: number }>(
        'SELECT commission_rate_basis_points FROM compensation_plan_versions WHERE id=$1',
        [input.compensationPlanVersionId],
      );
      if (!p.rows[0]) return null;
      const amount = calculateCommissionMinor({
        eligibleRevenueMinor: input.eligibleRevenueMinor,
        commissionRateBasisPoints: p.rows[0].commission_rate_basis_points,
        attributionBasisPoints: input.attributionBasisPoints,
      });
      const r = await c.query<{ id: string }>(
        'INSERT INTO commission_entries (employee_profile_id,source_quote_id,compensation_plan_version_id,attribution_basis_points,eligible_revenue_minor,commission_rate_basis_points,amount_minor) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [
          input.employeeProfileId,
          input.sourceQuoteId ?? null,
          input.compensationPlanVersionId,
          input.attributionBasisPoints,
          input.eligibleRevenueMinor.toString(),
          p.rows[0].commission_rate_basis_points,
          amount.toString(),
        ],
      );
      await c.query(
        'INSERT INTO commission_entry_events (commission_entry_id,status,actor_user_id,correlation_id) VALUES ($1,$2,$3,$4)',
        [r.rows[0]!.id, 'pending', a, this.correlation(correlationId)],
      );
      await this.audit(
        c,
        a,
        'commission.created',
        'commission_entry',
        r.rows[0]!.id,
        correlationId,
        null,
        { amountMinor: amount.toString() },
      );
      return { id: r.rows[0]!.id, amountMinor: amount.toString() };
    });
  }
  async addCommissionEvent(
    subject: string,
    id: string,
    input: z.infer<typeof commissionEventSchema>,
    correlationId: string,
  ) {
    return this.actor(subject, correlationId, async (c, a) => {
      const exists = await c.query('SELECT 1 FROM commission_entries WHERE id=$1', [id]);
      if (!exists.rowCount) return null;
      await c.query(
        'INSERT INTO commission_entry_events (commission_entry_id,status,reason,actor_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5)',
        [id, input.status, input.reason, a, this.correlation(correlationId)],
      );
      await this.audit(
        c,
        a,
        'commission.event_created',
        'commission_entry',
        id,
        correlationId,
        input.reason,
        { status: input.status },
      );
      return { id, status: input.status };
    });
  }
  async earnings(subject: string) {
    const c = new Client({ connectionString: this.databaseUrl });
    try {
      await c.connect();
      const r = await c.query<{ estimated: string; pending: string }>(
        `SELECT COALESCE(sum(ce.amount_minor) FILTER (WHERE e.status IN ('pending','earned','approved')),0)::text estimated,COALESCE(sum(ce.amount_minor) FILTER (WHERE e.status='pending'),0)::text pending FROM commission_entries ce JOIN LATERAL (SELECT status FROM commission_entry_events WHERE commission_entry_id=ce.id ORDER BY created_at DESC,id DESC LIMIT 1) e ON true JOIN employee_profiles ep ON ep.id=ce.employee_profile_id JOIN identities i ON i.user_id=ep.user_id WHERE i.provider='auth0' AND i.provider_subject=$1`,
        [subject],
      );
      return {
        estimatedCommissionMinor: r.rows[0]!.estimated,
        pendingCommissionMinor: r.rows[0]!.pending,
      };
    } finally {
      await c.end();
    }
  }
  private async actor<T>(
    s: string,
    correlationId: string,
    fn: (c: Client, a: string) => Promise<T | null>,
  ) {
    const c = new Client({ connectionString: this.databaseUrl });
    try {
      await c.connect();
      await c.query('BEGIN');
      const r = await c.query<{ id: string }>(
        "SELECT i.user_id id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND u.status='active'",
        [s],
      );
      if (!r.rows[0]) {
        await c.query('ROLLBACK');
        return null;
      }
      const out = await fn(c, r.rows[0].id);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  }
  private correlation(value: string) {
    return z.uuid().safeParse(value).success ? value : randomUUID();
  }
  private async audit(
    c: Client,
    a: string,
    action: string,
    type: string,
    id: string,
    correlationId: string,
    reason: string | null,
    afterValue: Record<string, string>,
  ) {
    const e = createAuditEvent({
      actorUserId: a,
      action,
      targetType: type,
      targetId: id,
      correlationId: this.correlation(correlationId),
      reason,
      beforeValue: null,
      afterValue,
    });
    await c.query(
      'INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,reason,before_value,after_value,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        e.actorUserId,
        e.action,
        e.targetType,
        e.targetId,
        e.correlationId,
        e.reason,
        e.beforeValue,
        e.afterValue,
        e.occurredAt,
      ],
    );
  }
}
