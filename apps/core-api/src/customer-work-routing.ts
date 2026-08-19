import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';

export const customerWorkRouteSchema = z.object({
  employeeProfileId: z.uuid().nullable(),
  idempotencyKey: z.uuid(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  reason: z.string().trim().min(3).max(500),
});
export const customerWorkEscalateSchema = z.object({
  idempotencyKey: z.uuid(),
  priority: z.enum(['high', 'urgent']),
  reason: z.string().trim().min(3).max(500),
});
export const customerWorkCompleteSchema = z.object({
  idempotencyKey: z.uuid(),
  reason: z.string().trim().min(3).max(500),
});
export type CustomerWorkType = 'communication_call' | 'repair_job';
export type CustomerWork = {
  id: string;
  workType: CustomerWorkType;
  employeeProfileId: string | null;
  priority: string;
  status: string;
};
export type CustomerWorkRoutingRepository = {
  route(
    subject: string,
    type: CustomerWorkType,
    id: string,
    input: z.infer<typeof customerWorkRouteSchema>,
    correlationId: string,
    companyWide: boolean,
  ): Promise<CustomerWork | null | 'scope_forbidden'>;
  escalate(
    subject: string,
    type: CustomerWorkType,
    id: string,
    input: z.infer<typeof customerWorkEscalateSchema>,
    correlationId: string,
  ): Promise<CustomerWork | null | 'not_owner'>;
  complete(
    subject: string,
    type: CustomerWorkType,
    id: string,
    input: z.infer<typeof customerWorkCompleteSchema>,
    correlationId: string,
  ): Promise<boolean | null | 'not_owner'>;
  listForEmployee(subject: string): Promise<{
    work: CustomerWork[];
    notifications: Array<{
      id: string;
      workType: CustomerWorkType;
      workId: string;
      type: string;
      createdAt: Date;
    }>;
  } | null>;
};
type Employee = { profileId: string; userId: string };
export class PostgresCustomerWorkRoutingRepository implements CustomerWorkRoutingRepository {
  constructor(private readonly databaseUrl: string) {}
  async route(
    subject: string,
    type: CustomerWorkType,
    id: string,
    input: z.infer<typeof customerWorkRouteSchema>,
    correlationId: string,
    companyWide: boolean,
  ) {
    return this.tx(subject, async (c, actor) => {
      const prior = await this.prior<CustomerWork>(c, actor.userId, input.idempotencyKey);
      if (prior) return prior;
      const current = await this.work(c, type, id, true);
      if (!current) return null;
      if (
        input.employeeProfileId &&
        !companyWide &&
        !(await this.inScope(c, actor.profileId, input.employeeProfileId))
      )
        return 'scope_forbidden' as const;
      if (input.employeeProfileId && !(await this.activeEmployee(c, input.employeeProfileId)))
        return null;
      const action = input.employeeProfileId
        ? current.employeeProfileId
          ? 'reassigned'
          : 'routed'
        : 'unassigned';
      await this.updateWork(c, type, id, input.employeeProfileId, input.priority);
      await this.event(
        c,
        type,
        id,
        actor.userId,
        action,
        current.employeeProfileId,
        input.employeeProfileId,
        input.priority,
        input.reason,
        input.idempotencyKey,
        correlationId,
      );
      const result: CustomerWork = {
        id,
        workType: type,
        employeeProfileId: input.employeeProfileId,
        priority: input.priority,
        status: type === 'communication_call' ? 'routed' : 'routed',
      };
      if (input.employeeProfileId)
        await this.notify(c, type, id, input.employeeProfileId, 'routed');
      await this.audit(c, actor.userId, `customer_work.${action}`, type, id, correlationId, {
        employeeProfileId: input.employeeProfileId,
        priority: input.priority,
      });
      return result;
    });
  }
  async escalate(
    subject: string,
    type: CustomerWorkType,
    id: string,
    input: z.infer<typeof customerWorkEscalateSchema>,
    correlationId: string,
  ) {
    return this.tx(subject, async (c, actor) => {
      const prior = await this.prior<CustomerWork>(c, actor.userId, input.idempotencyKey);
      if (prior) return prior;
      const current = await this.work(c, type, id, true);
      if (!current) return null;
      if (current.employeeProfileId !== actor.profileId) return 'not_owner' as const;
      await this.updateWork(c, type, id, current.employeeProfileId, input.priority);
      await this.event(
        c,
        type,
        id,
        actor.userId,
        'escalated',
        current.employeeProfileId,
        current.employeeProfileId,
        input.priority,
        input.reason,
        input.idempotencyKey,
        correlationId,
      );
      const result: {
        id: string;
        workType: CustomerWorkType;
        employeeProfileId: string | null;
        priority: string;
        status: string;
      } = { ...current, priority: input.priority };
      // An escalation is actionable for the employee's manager, not a duplicate alert to the
      // employee who just raised it. An employee without an active manager can still escalate;
      // the immutable event/audit trail remains available to an administrator.
      const managerProfileId = await this.manager(c, actor.profileId);
      if (managerProfileId) await this.notify(c, type, id, managerProfileId, 'escalated');
      await this.audit(c, actor.userId, 'customer_work.escalated', type, id, correlationId, {
        priority: input.priority,
      });
      return result;
    });
  }
  async complete(
    subject: string,
    type: CustomerWorkType,
    id: string,
    input: z.infer<typeof customerWorkCompleteSchema>,
    correlationId: string,
  ) {
    return this.tx(subject, async (c, actor) => {
      const prior = await this.prior<{ completed: boolean }>(c, actor.userId, input.idempotencyKey);
      if (prior) return prior.completed;
      const current = await this.work(c, type, id, true);
      if (!current) return null;
      if (current.employeeProfileId !== actor.profileId) return 'not_owner' as const;
      if (type === 'communication_call')
        await c.query(
          "UPDATE communication_calls SET follow_up_status='completed',updated_at=now() WHERE id=$1",
          [id],
        );
      await this.event(
        c,
        type,
        id,
        actor.userId,
        'completed',
        actor.profileId,
        actor.profileId,
        current.priority,
        input.reason,
        input.idempotencyKey,
        correlationId,
      );
      await c.query(
        "UPDATE customer_work_notifications SET status='completed',completed_at=now() WHERE work_type=$1 AND work_id=$2 AND employee_profile_id=$3 AND status='pending'",
        [type, id, actor.profileId],
      );
      await this.audit(c, actor.userId, 'customer_work.completed', type, id, correlationId, {});
      return true;
    });
  }
  async listForEmployee(subject: string) {
    const c = new Client({ connectionString: this.databaseUrl });
    try {
      await c.connect();
      const e = await this.employee(c, subject);
      if (!e) return null;
      const work = await c.query<CustomerWork>(
        `SELECT id,'communication_call' work_type,assigned_employee_profile_id employee_profile_id,priority,follow_up_status status FROM communication_calls WHERE assigned_employee_profile_id=$1 AND follow_up_status<>'completed' UNION ALL SELECT j.id,'repair_job',j.employee_profile_id,'normal','routed' FROM jobs j JOIN customer_repair_requests r ON r.job_id=j.id WHERE j.employee_profile_id=$1 ORDER BY id`,
        [e.profileId],
      );
      const n = await c.query<{
        id: string;
        work_type: CustomerWorkType;
        work_id: string;
        type: string;
        created_at: Date;
      }>(
        "SELECT id,work_type,work_id,type,created_at FROM customer_work_notifications WHERE employee_profile_id=$1 AND status='pending' ORDER BY created_at DESC",
        [e.profileId],
      );
      return {
        work: work.rows.map((r) => ({
          id: r.id,
          workType: (r as unknown as { work_type: CustomerWorkType }).work_type,
          employeeProfileId: (r as unknown as { employee_profile_id: string | null })
            .employee_profile_id,
          priority: r.priority,
          status: r.status,
        })),
        notifications: n.rows.map((r) => ({
          id: r.id,
          workType: r.work_type,
          workId: r.work_id,
          type: r.type,
          createdAt: r.created_at,
        })),
      };
    } finally {
      await c.end();
    }
  }
  private async tx<T>(subject: string, fn: (c: Client, e: Employee) => Promise<T>) {
    const c = new Client({ connectionString: this.databaseUrl });
    try {
      await c.connect();
      await c.query('BEGIN');
      const e = await this.employee(c, subject);
      if (!e) {
        await c.query('ROLLBACK');
        return null;
      }
      const r = await fn(c, e);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  }
  private async employee(c: Client, s: string) {
    const r = await c.query<{ profile_id: string; user_id: string }>(
      "SELECT ep.id profile_id,i.user_id FROM identities i JOIN employee_profiles ep ON ep.user_id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND ep.employment_status='active' AND ep.archived_at IS NULL",
      [s],
    );
    return r.rows[0] ? { profileId: r.rows[0].profile_id, userId: r.rows[0].user_id } : null;
  }
  private async activeEmployee(c: Client, id: string) {
    return Boolean(
      (
        await c.query(
          "SELECT 1 FROM employee_profiles WHERE id=$1 AND employment_status='active' AND archived_at IS NULL",
          [id],
        )
      ).rows[0],
    );
  }
  private async inScope(c: Client, manager: string, target: string) {
    const r = await c.query(
      `WITH scope AS (SELECT store_id,department_id FROM employee_assignments WHERE employee_profile_id=$1 AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())) SELECT 1 FROM employee_assignments a WHERE a.employee_profile_id=$2 AND a.effective_from<=now() AND (a.effective_to IS NULL OR a.effective_to>now()) AND (a.manager_employee_profile_id=$1 OR EXISTS(SELECT 1 FROM scope s WHERE (s.department_id IS NOT NULL AND s.department_id=a.department_id) OR (s.store_id IS NOT NULL AND s.store_id=a.store_id)))`,
      [manager, target],
    );
    return Boolean(r.rows[0]);
  }
  private async work(
    c: Client,
    t: CustomerWorkType,
    id: string,
    lock = false,
  ): Promise<CustomerWork | null> {
    const sql =
      t === 'communication_call'
        ? `SELECT id,assigned_employee_profile_id employee_profile_id,priority,follow_up_status status FROM communication_calls WHERE id=$1`
        : `SELECT id,employee_profile_id,'normal' priority,'routed' status FROM jobs WHERE id=$1 AND EXISTS(SELECT 1 FROM customer_repair_requests r WHERE r.job_id=jobs.id)`;
    if (lock)
      await c.query(
        t === 'communication_call'
          ? 'SELECT id FROM communication_calls WHERE id=$1 FOR UPDATE'
          : 'SELECT id FROM jobs WHERE id=$1 FOR UPDATE',
        [id],
      );
    const r = await c.query<{
      id: string;
      employee_profile_id: string | null;
      priority: string;
      status: string;
    }>(sql, [id]);
    return r.rows[0]
      ? {
          id: r.rows[0].id,
          workType: t,
          employeeProfileId: r.rows[0].employee_profile_id,
          priority: r.rows[0].priority,
          status: r.rows[0].status,
        }
      : null;
  }
  private async updateWork(
    c: Client,
    t: CustomerWorkType,
    id: string,
    e: string | null,
    p: string,
  ) {
    if (t === 'communication_call')
      await c.query(
        "UPDATE communication_calls SET assigned_employee_profile_id=$2::uuid,claimed_by_employee_profile_id=NULL,priority=$3,follow_up_status=CASE WHEN $2::uuid IS NULL THEN 'required' WHEN follow_up_status='completed' THEN 'required' ELSE 'claimed' END,updated_at=now() WHERE id=$1",
        [id, e, p],
      );
    else await c.query('UPDATE jobs SET employee_profile_id=$2 WHERE id=$1', [id, e]);
  }
  private async event(
    c: Client,
    t: CustomerWorkType,
    id: string,
    u: string,
    a: string,
    prev: string | null,
    e: string | null,
    p: string,
    reason: string,
    key: string,
    corr: string,
  ) {
    await c.query(
      'INSERT INTO customer_work_routing_events (work_type,work_id,actor_user_id,action,previous_employee_profile_id,employee_profile_id,priority,reason,idempotency_key,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        t,
        id,
        u,
        a,
        prev,
        e,
        p,
        reason,
        key,
        z.uuid().safeParse(corr).success ? corr : randomUUID(),
      ],
    );
  }
  private async notify(
    c: Client,
    t: CustomerWorkType,
    id: string,
    e: string,
    type: 'routed' | 'escalated',
  ) {
    await c.query(
      'INSERT INTO customer_work_notifications (work_type,work_id,employee_profile_id,type) VALUES ($1,$2,$3,$4)',
      [t, id, e, type],
    );
  }
  private async manager(c: Client, employeeProfileId: string) {
    const result = await c.query<{ manager_employee_profile_id: string }>(
      `SELECT manager_employee_profile_id
       FROM employee_assignments
       WHERE employee_profile_id=$1
         AND manager_employee_profile_id IS NOT NULL
         AND effective_from<=now()
         AND (effective_to IS NULL OR effective_to>now())
       ORDER BY effective_from DESC
       LIMIT 1`,
      [employeeProfileId],
    );
    return result.rows[0]?.manager_employee_profile_id ?? null;
  }
  private async prior<T>(c: Client, u: string, k: string) {
    const r = await c.query<{
      id: string;
      work_type: CustomerWorkType;
      employee_profile_id: string | null;
      priority: string;
      action: string;
    }>(
      'SELECT work_id::text id,work_type,employee_profile_id,priority,action FROM customer_work_routing_events WHERE actor_user_id=$1 AND idempotency_key=$2',
      [u, k],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.action === 'completed') return { completed: true } as T;
    return {
      id: row.id,
      workType: row.work_type,
      employeeProfileId: row.employee_profile_id,
      priority: row.priority,
      status: row.action === 'completed' ? 'completed' : 'routed',
    } as T;
  }
  private async audit(
    c: Client,
    u: string,
    a: string,
    t: string,
    id: string,
    corr: string,
    after: Record<string, unknown>,
  ) {
    await c.query(
      'INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,after_value) VALUES ($1,$2,$3,$4,$5,$6)',
      [u, a, t, id, z.uuid().safeParse(corr).success ? corr : randomUUID(), after],
    );
  }
}
