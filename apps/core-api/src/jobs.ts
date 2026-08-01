import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { createAuditEvent } from './audit.js';

const states = [
  'requested',
  'scheduled',
  'assigned',
  'accepted',
  'en_route',
  'arrived',
  'inspection',
  'quoted',
  'approved',
  'in_progress',
  'payment_due',
  'completed',
  'cancelled',
] as const;
type JobStatus = (typeof states)[number];
const transitions: Record<JobStatus, JobStatus[]> = {
  accepted: ['en_route', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  arrived: ['inspection', 'cancelled'],
  assigned: ['accepted', 'cancelled'],
  cancelled: [],
  completed: [],
  en_route: ['arrived', 'cancelled'],
  in_progress: ['payment_due', 'completed', 'cancelled'],
  inspection: ['quoted', 'in_progress', 'cancelled'],
  payment_due: ['completed', 'cancelled'],
  quoted: ['approved', 'cancelled'],
  requested: ['scheduled', 'cancelled'],
  scheduled: ['assigned', 'cancelled'],
};
export const createJobSchema = z
  .object({
    customerProfileId: z.uuid().nullable().optional(),
    employeeProfileId: z.uuid().nullable().optional(),
    idempotencyKey: z.uuid(),
    quoteId: z.uuid().nullable().optional(),
    windowEnd: z.coerce.date(),
    windowStart: z.coerce.date(),
  })
  .refine((v) => v.windowEnd > v.windowStart, {
    path: ['windowEnd'],
    message: 'windowEnd must be after windowStart.',
  });
export const transitionJobSchema = z.object({
  idempotencyKey: z.uuid(),
  reason: z.string().trim().min(1).max(1000).nullable().optional(),
  toStatus: z.enum(states),
});
export type Job = { id: string; status: JobStatus; windowEnd: Date; windowStart: Date };
export type JobRepository = {
  createForSubject(
    s: string,
    i: z.infer<typeof createJobSchema>,
    correlationId: string,
  ): Promise<Job | null>;
  transitionForSubject(
    s: string,
    id: string,
    i: z.infer<typeof transitionJobSchema>,
    correlationId: string,
  ): Promise<Job | null>;
};
export class JobTransitionError extends Error {}
export class PostgresJobRepository implements JobRepository {
  constructor(private readonly databaseUrl: string) {}
  async createForSubject(
    subject: string,
    input: z.infer<typeof createJobSchema>,
    correlationId: string,
  ): Promise<Job | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const userId = await this.userId(client, subject);
      if (!userId) {
        await client.query('ROLLBACK');
        return null;
      }
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM jobs WHERE created_by_user_id=$1 AND idempotency_key=$2',
        [userId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return await this.get(client, existing.rows[0].id);
      }
      const job = await client.query<{ id: string }>(
        'INSERT INTO jobs (customer_profile_id, quote_id, employee_profile_id, created_by_user_id, idempotency_key) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [
          input.customerProfileId ?? null,
          input.quoteId ?? null,
          input.employeeProfileId ?? null,
          userId,
          input.idempotencyKey,
        ],
      );
      await client.query(
        'INSERT INTO appointments (job_id, window_start, window_end) VALUES ($1,$2,$3)',
        [job.rows[0]!.id, input.windowStart, input.windowEnd],
      );
      const audit = createAuditEvent({
        action: 'job.created',
        actorUserId: userId,
        afterValue: { status: 'requested' },
        beforeValue: null,
        correlationId,
        reason: null,
        targetId: job.rows[0]!.id,
        targetType: 'job',
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
      return await this.get(client, job.rows[0]!.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }
  async transitionForSubject(
    subject: string,
    jobId: string,
    input: z.infer<typeof transitionJobSchema>,
    correlationId: string,
  ): Promise<Job | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const userId = await this.userId(client, subject);
      if (!userId) {
        await client.query('ROLLBACK');
        return null;
      }
      const current = await this.get(client, jobId);
      if (!current) {
        await client.query('ROLLBACK');
        return null;
      }
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM job_transitions WHERE actor_user_id=$1 AND idempotency_key=$2',
        [userId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return await this.get(client, jobId);
      }
      if (!transitions[current.status].includes(input.toStatus))
        throw new JobTransitionError('Transition is not allowed.');
      await client.query(
        'INSERT INTO job_transitions (job_id, from_status, to_status, actor_user_id, reason, idempotency_key, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          jobId,
          current.status,
          input.toStatus,
          userId,
          input.reason ?? null,
          input.idempotencyKey,
          z.uuid().safeParse(correlationId).success ? correlationId : randomUUID(),
        ],
      );
      const audit = createAuditEvent({
        action: 'job.transitioned',
        actorUserId: userId,
        afterValue: { status: input.toStatus },
        beforeValue: { status: current.status },
        correlationId,
        reason: input.reason ?? null,
        targetId: jobId,
        targetType: 'job',
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
      return await this.get(client, jobId);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async userId(client: Client, subject: string) {
    const r = await client.query<{ id: string }>(
      "SELECT i.user_id id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND u.status='active' AND u.archived_at IS NULL",
      [subject],
    );
    return r.rows[0]?.id ?? null;
  }
  private async get(client: Client, id: string): Promise<Job | null> {
    const r = await client.query<{
      id: string;
      status: JobStatus;
      window_end: Date;
      window_start: Date;
    }>(
      `SELECT j.id, COALESCE(t.to_status,j.initial_status) status, a.window_start, a.window_end FROM jobs j JOIN appointments a ON a.job_id=j.id LEFT JOIN LATERAL (SELECT to_status FROM job_transitions WHERE job_id=j.id ORDER BY occurred_at DESC,id DESC LIMIT 1) t ON true WHERE j.id=$1`,
      [id],
    );
    const row = r.rows[0];
    return row
      ? { id: row.id, status: row.status, windowStart: row.window_start, windowEnd: row.window_end }
      : null;
  }
}
