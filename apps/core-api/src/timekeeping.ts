import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { createAuditEvent } from './audit.js';

const sourceSchema = z.enum(['web', 'mobile', 'manager', 'import']);
const mobileEventTypeSchema = z.enum(['clock_in', 'clock_out', 'break_start', 'break_end']);
const inputSchema = z.object({
  employeeAssignmentId: z.uuid().nullable().optional(),
  endedAt: z.coerce.date(),
  idempotencyKey: z.uuid(),
  source: sourceSchema,
  startedAt: z.coerce.date(),
});
export const createTimeEntrySchema = inputSchema.refine(
  (value) => value.endedAt > value.startedAt,
  {
    message: 'endedAt must be after startedAt.',
    path: ['endedAt'],
  },
);
export const createTimeCorrectionSchema = inputSchema
  .pick({ endedAt: true, idempotencyKey: true, startedAt: true })
  .extend({ reason: z.string().trim().min(1).max(1000) })
  .refine((value) => value.endedAt > value.startedAt, {
    message: 'endedAt must be after startedAt.',
    path: ['endedAt'],
  });
export const mobileTimeEventSchema = z.object({
  eventType: mobileEventTypeSchema,
  idempotencyKey: z.uuid(),
  jobId: z.uuid().nullable().optional(),
});

export type TimeEntry = {
  correctedAt: Date | null;
  endedAt: Date;
  id: string;
  source: z.infer<typeof sourceSchema>;
  startedAt: Date;
  totalSeconds: number;
};
export type TimekeepingRepository = {
  correctForSubject(
    subject: string,
    timeEntryId: string,
    input: z.infer<typeof createTimeCorrectionSchema>,
    correlationId: string,
  ): Promise<TimeEntry | null>;
  createForSubject(
    subject: string,
    input: z.infer<typeof createTimeEntrySchema>,
  ): Promise<TimeEntry | null>;
  listForSubject(subject: string): Promise<TimeEntry[] | null>;
};
export type MobileTimekeepingState = {
  activeBreakStartedAt: Date | null;
  clockedInAt: Date | null;
};
export type MobileTimekeepingRepository = {
  mobileStateForSubject(subject: string): Promise<MobileTimekeepingState | null>;
  recordMobileEvent(
    subject: string,
    input: z.infer<typeof mobileTimeEventSchema>,
    correlationId: string,
  ): Promise<MobileTimekeepingState | null>;
};
export class MobileTimeEventError extends Error {}
type TimeEntryRow = {
  corrected_at: Date | null;
  ended_at: Date;
  id: string;
  source: z.infer<typeof sourceSchema>;
  started_at: Date;
  total_seconds: string;
};

export class PostgresTimekeepingRepository
  implements TimekeepingRepository, MobileTimekeepingRepository
{
  constructor(private readonly databaseUrl: string) {}

  async listForSubject(subject: string): Promise<TimeEntry[] | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const profileId = await this.getEmployeeProfileId(client, subject);
      if (!profileId) return null;
      const result = await client.query<TimeEntryRow>(this.listQuery, [profileId]);
      return result.rows.map(mapTimeEntry);
    } finally {
      await client.end();
    }
  }

  async createForSubject(
    subject: string,
    input: z.infer<typeof createTimeEntrySchema>,
  ): Promise<TimeEntry | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const profileId = await this.getEmployeeProfileId(client, subject);
      if (!profileId) return null;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO time_entries
         (employee_profile_id, employee_assignment_id, started_at, ended_at, source, idempotency_key)
         SELECT $1, $2, $3, $4, $5, $6
         WHERE $2::uuid IS NULL OR EXISTS (
           SELECT 1 FROM employee_assignments
           WHERE id = $2 AND employee_profile_id = $1
         )
         ON CONFLICT (employee_profile_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          profileId,
          input.employeeAssignmentId ?? null,
          input.startedAt,
          input.endedAt,
          input.source,
          input.idempotencyKey,
        ],
      );
      const timeEntryId =
        inserted.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            'SELECT id FROM time_entries WHERE employee_profile_id = $1 AND idempotency_key = $2',
            [profileId, input.idempotencyKey],
          )
        ).rows[0]?.id;
      if (!timeEntryId) return null;
      const result = await client.query<TimeEntryRow>(`${this.listQuery} AND te.id = $2`, [
        profileId,
        timeEntryId,
      ]);
      return result.rows[0] ? mapTimeEntry(result.rows[0]) : null;
    } finally {
      await client.end();
    }
  }

  async mobileStateForSubject(subject: string): Promise<MobileTimekeepingState | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const profileId = await this.getEmployeeProfileId(client, subject);
      return profileId ? await this.mobileState(client, profileId) : null;
    } finally {
      await client.end();
    }
  }

  async recordMobileEvent(
    subject: string,
    input: z.infer<typeof mobileTimeEventSchema>,
    correlationId: string,
  ): Promise<MobileTimekeepingState | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const identity = await client.query<{ employee_profile_id: string; user_id: string }>(
        `SELECT ep.id AS employee_profile_id, i.user_id
         FROM identities i JOIN employee_profiles ep ON ep.user_id = i.user_id
         WHERE i.provider = 'auth0' AND i.provider_subject = $1
           AND ep.employment_status = 'active' AND ep.archived_at IS NULL`,
        [subject],
      );
      const actor = identity.rows[0];
      if (!actor) {
        await client.query('ROLLBACK');
        return null;
      }
      if (input.jobId) {
        const assigned = await client.query(
          'SELECT 1 FROM jobs WHERE id = $1 AND employee_profile_id = $2',
          [input.jobId, actor.employee_profile_id],
        );
        if (!assigned.rows[0]) throw new MobileTimeEventError('Job is not assigned to employee.');
      }
      const existing = await client.query<{ event_type: z.infer<typeof mobileEventTypeSchema> }>(
        'SELECT event_type FROM mobile_time_events WHERE employee_profile_id = $1 AND idempotency_key = $2',
        [actor.employee_profile_id, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].event_type !== input.eventType)
          throw new MobileTimeEventError('Idempotency key is already bound to a different event.');
        await client.query('COMMIT');
        return await this.mobileState(client, actor.employee_profile_id);
      }
      const state = await this.mobileState(client, actor.employee_profile_id);
      if (!this.isValidMobileEvent(state, input.eventType))
        throw new MobileTimeEventError('Event is not valid in the current timekeeping state.');
      const inserted = await client.query<{ id: string; occurred_at: Date }>(
        `INSERT INTO mobile_time_events
         (employee_profile_id, job_id, event_type, idempotency_key, correlation_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, occurred_at`,
        [
          actor.employee_profile_id,
          input.jobId ?? null,
          input.eventType,
          input.idempotencyKey,
          z.uuid().safeParse(correlationId).success ? correlationId : randomUUID(),
        ],
      );
      if (input.eventType === 'clock_out')
        await this.createCompletedMobileEntry(
          client,
          actor.employee_profile_id,
          input,
          inserted.rows[0]!.occurred_at,
        );
      const audit = createAuditEvent({
        action: `mobile_time.${input.eventType}`,
        actorUserId: actor.user_id,
        afterValue: { mobileTimeEventId: inserted.rows[0]!.id },
        beforeValue: null,
        correlationId: z.uuid().safeParse(correlationId).success ? correlationId : randomUUID(),
        reason: null,
        targetId: inserted.rows[0]!.id,
        targetType: 'mobile_time_event',
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
      return await this.mobileState(client, actor.employee_profile_id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async correctForSubject(
    subject: string,
    timeEntryId: string,
    input: z.infer<typeof createTimeCorrectionSchema>,
    correlationId: string,
  ): Promise<TimeEntry | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const identity = await client.query<{ employee_profile_id: string; user_id: string }>(
        `SELECT ep.id AS employee_profile_id, i.user_id
         FROM identities i JOIN employee_profiles ep ON ep.user_id = i.user_id
         WHERE i.provider = 'auth0' AND i.provider_subject = $1
           AND ep.employment_status = 'active' AND ep.archived_at IS NULL`,
        [subject],
      );
      const actor = identity.rows[0];
      if (!actor) {
        await client.query('ROLLBACK');
        return null;
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO time_entry_corrections
         (time_entry_id, corrected_started_at, corrected_ended_at, reason, actor_user_id, idempotency_key)
         SELECT $1, $2, $3, $4, $5, $6
         WHERE EXISTS (SELECT 1 FROM time_entries WHERE id = $1 AND employee_profile_id = $7)
         ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          timeEntryId,
          input.startedAt,
          input.endedAt,
          input.reason,
          actor.user_id,
          input.idempotencyKey,
          actor.employee_profile_id,
        ],
      );
      const correctionId =
        inserted.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            'SELECT id FROM time_entry_corrections WHERE actor_user_id = $1 AND idempotency_key = $2',
            [actor.user_id, input.idempotencyKey],
          )
        ).rows[0]?.id;
      if (!correctionId) {
        await client.query('ROLLBACK');
        return null;
      }
      const audit = createAuditEvent({
        action: 'time_entry.corrected',
        actorUserId: actor.user_id,
        afterValue: { correctionId },
        beforeValue: null,
        correlationId: z.uuid().safeParse(correlationId).success ? correlationId : randomUUID(),
        reason: input.reason,
        targetId: timeEntryId,
        targetType: 'time_entry',
      });
      await client.query(
        `INSERT INTO audit_events
         (actor_user_id, action, target_type, target_id, correlation_id, reason, before_value, after_value, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
      const result = await client.query<TimeEntryRow>(`${this.listQuery} AND te.id = $2`, [
        actor.employee_profile_id,
        timeEntryId,
      ]);
      return result.rows[0] ? mapTimeEntry(result.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }

  private async getEmployeeProfileId(client: Client, subject: string): Promise<string | null> {
    const result = await client.query<{ id: string }>(
      `SELECT ep.id FROM identities i JOIN employee_profiles ep ON ep.user_id = i.user_id
       WHERE i.provider = 'auth0' AND i.provider_subject = $1
         AND ep.employment_status = 'active' AND ep.archived_at IS NULL`,
      [subject],
    );
    return result.rows[0]?.id ?? null;
  }

  private async mobileState(
    client: Client,
    employeeProfileId: string,
  ): Promise<MobileTimekeepingState> {
    const events = await client.query<{
      event_type: z.infer<typeof mobileEventTypeSchema>;
      occurred_at: Date;
    }>(
      `SELECT event_type, occurred_at FROM mobile_time_events
       WHERE employee_profile_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [employeeProfileId],
    );
    const latest = events.rows[0];
    if (!latest || latest.event_type === 'clock_out')
      return { activeBreakStartedAt: null, clockedInAt: null };
    const clockIn = await client.query<{ occurred_at: Date }>(
      `SELECT occurred_at FROM mobile_time_events WHERE employee_profile_id = $1
       AND event_type = 'clock_in' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [employeeProfileId],
    );
    return {
      activeBreakStartedAt: latest.event_type === 'break_start' ? latest.occurred_at : null,
      clockedInAt: clockIn.rows[0]?.occurred_at ?? null,
    };
  }

  private isValidMobileEvent(
    state: MobileTimekeepingState,
    eventType: z.infer<typeof mobileEventTypeSchema>,
  ): boolean {
    if (eventType === 'clock_in') return state.clockedInAt === null;
    if (eventType === 'clock_out')
      return state.clockedInAt !== null && state.activeBreakStartedAt === null;
    if (eventType === 'break_start')
      return state.clockedInAt !== null && state.activeBreakStartedAt === null;
    return state.activeBreakStartedAt !== null;
  }

  private async createCompletedMobileEntry(
    client: Client,
    employeeProfileId: string,
    input: z.infer<typeof mobileTimeEventSchema>,
    endedAt: Date,
  ): Promise<void> {
    const clockIn = await client.query<{ occurred_at: Date; job_id: string | null }>(
      `SELECT occurred_at, job_id FROM mobile_time_events
       WHERE employee_profile_id = $1 AND event_type = 'clock_in'
       ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [employeeProfileId],
    );
    const startedAt = clockIn.rows[0]?.occurred_at;
    if (!startedAt) throw new MobileTimeEventError('Clock-in event is missing.');
    const breaks = await client.query<{ seconds: string }>(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended.occurred_at - started.occurred_at))), 0)::bigint AS seconds
       FROM mobile_time_events started
       JOIN LATERAL (
         SELECT occurred_at FROM mobile_time_events
         WHERE employee_profile_id = started.employee_profile_id AND event_type = 'break_end'
           AND occurred_at > started.occurred_at
         ORDER BY occurred_at ASC, id ASC LIMIT 1
       ) ended ON true
       WHERE started.employee_profile_id = $1 AND started.event_type = 'break_start'
         AND started.occurred_at >= $2 AND started.occurred_at < $3`,
      [employeeProfileId, startedAt, endedAt],
    );
    await client.query(
      `INSERT INTO time_entries
       (employee_profile_id, job_id, started_at, ended_at, unpaid_break_seconds, source, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'mobile', $6)`,
      [
        employeeProfileId,
        input.jobId ?? clockIn.rows[0]?.job_id ?? null,
        startedAt,
        endedAt,
        breaks.rows[0]?.seconds ?? '0',
        input.idempotencyKey,
      ],
    );
  }

  private readonly listQuery = `SELECT te.id, te.source,
      COALESCE(c.corrected_started_at, te.started_at) AS started_at,
      COALESCE(c.corrected_ended_at, te.ended_at) AS ended_at,
      c.created_at AS corrected_at,
      (EXTRACT(EPOCH FROM (COALESCE(c.corrected_ended_at, te.ended_at) - COALESCE(c.corrected_started_at, te.started_at)))::bigint - te.unpaid_break_seconds) AS total_seconds
    FROM time_entries te
    LEFT JOIN LATERAL (
      SELECT corrected_started_at, corrected_ended_at, created_at
      FROM time_entry_corrections WHERE time_entry_id = te.id ORDER BY created_at DESC, id DESC LIMIT 1
    ) c ON true
    WHERE te.employee_profile_id = $1`;
}

function mapTimeEntry(row: TimeEntryRow): TimeEntry {
  return {
    correctedAt: row.corrected_at,
    endedAt: row.ended_at,
    id: row.id,
    source: row.source,
    startedAt: row.started_at,
    totalSeconds: Number(row.total_seconds),
  };
}
