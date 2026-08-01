import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { createAuditEvent } from './audit.js';

const sourceSchema = z.enum(['web', 'mobile', 'manager', 'import']);
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
type TimeEntryRow = {
  corrected_at: Date | null;
  ended_at: Date;
  id: string;
  source: z.infer<typeof sourceSchema>;
  started_at: Date;
  total_seconds: string;
};

export class PostgresTimekeepingRepository implements TimekeepingRepository {
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

  private readonly listQuery = `SELECT te.id, te.source,
      COALESCE(c.corrected_started_at, te.started_at) AS started_at,
      COALESCE(c.corrected_ended_at, te.ended_at) AS ended_at,
      c.created_at AS corrected_at,
      EXTRACT(EPOCH FROM (COALESCE(c.corrected_ended_at, te.ended_at) - COALESCE(c.corrected_started_at, te.started_at)))::bigint AS total_seconds
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
