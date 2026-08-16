import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';

export const retellWebhookSchema = z.object({
  event: z.string().min(1).max(128),
  call: z.object({
    call_id: z.string().min(1).max(255),
    direction: z.enum(['inbound', 'outbound']).optional(),
    call_status: z.string().min(1).max(64).optional(),
    from_number: z.string().max(64).optional(),
    to_number: z.string().max(64).optional(),
    agent_id: z.string().max(255).optional(),
    start_timestamp: z.number().int().nonnegative().optional(),
    end_timestamp: z.number().int().nonnegative().optional(),
    transcript: z.string().max(1_000_000).optional(),
    call_analysis: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Verifies Retell's current raw-body HMAC signature without exposing provider credentials. */
export function verifyRetellWebhook(input: {
  apiKey: string;
  payload: string;
  signature: string;
  now?: number;
}): boolean {
  const match = /^v=(\d+),d=([a-f0-9]+)$/i.exec(input.signature);
  if (!match) return false;
  const timestampText = match[1];
  const digest = match[2];
  if (!timestampText || !digest) return false;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs((input.now ?? Date.now()) - timestamp) > 300_000)
    return false;
  const expected = createHmac('sha256', input.apiKey)
    .update(input.payload + timestampText)
    .digest();
  const received = Buffer.from(digest, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export type RetellCallRepository = {
  processWebhook(
    event: z.infer<typeof retellWebhookSchema>,
    payload: string,
  ): Promise<'processed' | 'duplicate'>;
  listForEmployee(subject: string): Promise<CommunicationCall[] | null>;
  getForEmployee(subject: string, callId: string): Promise<CommunicationCall | null>;
  listAll(): Promise<CommunicationCall[]>;
  claimForEmployee(
    subject: string,
    callId: string,
  ): Promise<'claimed' | 'unavailable' | 'employee_not_found'>;
  assign(callId: string, employeeProfileId: string | null, actorSubject: string): Promise<boolean>;
  completeFollowUpForEmployee(subject: string, callId: string): Promise<boolean | null>;
};
export type CommunicationCall = {
  assignedEmployeeProfileId: string | null;
  callSummary: string | null;
  direction: string;
  followUpStatus: string;
  fromNumber: string | null;
  id: string;
  providerCallReference: string;
  status: string;
  toNumber: string | null;
  transcript: string | null;
};

/**
 * Core owns the business record; Retell remains the provider record.  The entire
 * provider payload is retained only for operational reconciliation and must not
 * be rendered directly into a client without authorization and sanitization.
 */
export class PostgresRetellCallRepository implements RetellCallRepository {
  constructor(private readonly databaseUrl: string) {}

  async processWebhook(
    event: z.infer<typeof retellWebhookSchema>,
    payload: string,
  ): Promise<'processed' | 'duplicate'> {
    const client = new Client({ connectionString: this.databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      const eventReference = createHash('sha256')
        .update(`${event.event}:${event.call.call_id}:${payload}`)
        .digest('hex');
      const stored = await client.query<{ id: string }>(
        `INSERT INTO communication_webhook_events
         (provider,provider_event_reference,event_type,payload_sha256)
         VALUES ('retell',$1,$2,$3) ON CONFLICT (provider,provider_event_reference) DO NOTHING RETURNING id`,
        [eventReference, event.event, createHash('sha256').update(payload).digest('hex')],
      );
      if (!stored.rows[0]) {
        await client.query('ROLLBACK');
        return 'duplicate';
      }
      const call = event.call;
      const startedAt = call.start_timestamp ? new Date(call.start_timestamp) : null;
      const endedAt = call.end_timestamp ? new Date(call.end_timestamp) : null;
      const durationSeconds =
        startedAt && endedAt
          ? Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))
          : null;
      const analyzed = event.event === 'call_analyzed';
      const analysis = analyzed ? call.call_analysis : undefined;
      const analysisSummary =
        analysis && typeof analysis === 'object' && !Array.isArray(analysis)
          ? (analysis as Record<string, unknown>).call_summary
          : undefined;
      const callSummary =
        typeof analysisSummary === 'string' ? analysisSummary.slice(0, 20_000) : null;
      await client.query(
        `INSERT INTO communication_calls
         (provider,provider_call_reference,direction,status,from_number,to_number,provider_agent_reference,started_at,ended_at,duration_seconds,transcript,call_summary,analysis_data,provider_metadata,raw_provider_data,follow_up_required,follow_up_status)
         VALUES ('retell',$1,COALESCE($2,'unknown'),COALESCE($3,'registered'),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (provider,provider_call_reference) DO UPDATE SET
           direction=COALESCE(NULLIF(EXCLUDED.direction,'unknown'),communication_calls.direction),
           status=EXCLUDED.status, from_number=COALESCE(EXCLUDED.from_number,communication_calls.from_number),
           to_number=COALESCE(EXCLUDED.to_number,communication_calls.to_number),
           provider_agent_reference=COALESCE(EXCLUDED.provider_agent_reference,communication_calls.provider_agent_reference),
           started_at=COALESCE(EXCLUDED.started_at,communication_calls.started_at), ended_at=COALESCE(EXCLUDED.ended_at,communication_calls.ended_at),
           duration_seconds=COALESCE(EXCLUDED.duration_seconds,communication_calls.duration_seconds),
           transcript=COALESCE(EXCLUDED.transcript,communication_calls.transcript),
           call_summary=COALESCE(EXCLUDED.call_summary,communication_calls.call_summary),
           analysis_data=COALESCE(EXCLUDED.analysis_data,communication_calls.analysis_data),
           provider_metadata=EXCLUDED.provider_metadata, raw_provider_data=EXCLUDED.raw_provider_data,
           follow_up_required=communication_calls.follow_up_required OR EXCLUDED.follow_up_required,
           follow_up_status=CASE WHEN communication_calls.follow_up_status='none' AND EXCLUDED.follow_up_required THEN 'required' ELSE communication_calls.follow_up_status END,
           updated_at=now()`,
        [
          call.call_id,
          call.direction ?? null,
          call.call_status ?? null,
          call.from_number ?? null,
          call.to_number ?? null,
          call.agent_id ?? null,
          startedAt,
          endedAt,
          durationSeconds,
          call.transcript ?? null,
          callSummary,
          analyzed ? JSON.stringify(call.call_analysis ?? {}) : null,
          JSON.stringify(call.metadata ?? {}),
          payload,
          analyzed,
          analyzed ? 'required' : 'none',
        ],
      );
      if (analyzed)
        await client.query(
          `INSERT INTO communication_notifications (communication_call_id,type)
           SELECT id,'communication.call_follow_up_required' FROM communication_calls
           WHERE provider='retell' AND provider_call_reference=$1 AND follow_up_required
             AND NOT EXISTS (SELECT 1 FROM communication_notifications n WHERE n.communication_call_id=communication_calls.id AND n.type='communication.call_follow_up_required')`,
          [call.call_id],
        );
      await client.query(
        "UPDATE communication_webhook_events SET status='processed',processed_at=now() WHERE id=$1",
        [stored.rows[0].id],
      );
      await client.query(
        `INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,after_value)
         SELECT NULL,'communication.call_webhook_processed','communication_call',id,$2,$3 FROM communication_calls
         WHERE provider='retell' AND provider_call_reference=$1`,
        [call.call_id, randomUUID(), { event: event.event }],
      );
      await client.query('COMMIT');
      return 'processed';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async listForEmployee(subject: string): Promise<CommunicationCall[] | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const employee = await this.employee(client, subject);
      if (!employee) return null;
      const calls = await client.query<CallRow>(
        `${callSelect} WHERE assigned_employee_profile_id=$1 OR claimed_by_employee_profile_id=$1
         OR (assigned_employee_profile_id IS NULL AND claimed_by_employee_profile_id IS NULL AND follow_up_status='required')
         ORDER BY created_at DESC LIMIT 200`,
        [employee.profileId],
      );
      return calls.rows.map(mapCall);
    } finally {
      await client.end();
    }
  }
  async getForEmployee(subject: string, callId: string): Promise<CommunicationCall | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const employee = await this.employee(client, subject);
      if (!employee) return null;
      const call = await client.query<CallRow>(
        `${callSelect} WHERE id=$1 AND (assigned_employee_profile_id=$2 OR claimed_by_employee_profile_id=$2 OR (assigned_employee_profile_id IS NULL AND claimed_by_employee_profile_id IS NULL AND follow_up_status='required'))`,
        [callId, employee.profileId],
      );
      return call.rows[0] ? mapCall(call.rows[0]) : null;
    } finally {
      await client.end();
    }
  }
  async listAll(): Promise<CommunicationCall[]> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      return (
        await client.query<CallRow>(`${callSelect} ORDER BY created_at DESC LIMIT 500`)
      ).rows.map(mapCall);
    } finally {
      await client.end();
    }
  }
  async claimForEmployee(
    subject: string,
    callId: string,
  ): Promise<'claimed' | 'unavailable' | 'employee_not_found'> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const employee = await this.employee(client, subject);
      if (!employee) {
        await client.query('ROLLBACK');
        return 'employee_not_found';
      }
      const claimed = await client.query<{ id: string }>(
        `UPDATE communication_calls SET assigned_employee_profile_id=$2,claimed_by_employee_profile_id=$2,
         follow_up_status=CASE WHEN follow_up_status='required' THEN 'claimed' ELSE follow_up_status END,updated_at=now()
         WHERE id=$1 AND assigned_employee_profile_id IS NULL AND claimed_by_employee_profile_id IS NULL RETURNING id`,
        [callId, employee.profileId],
      );
      if (!claimed.rows[0]) {
        await client.query('ROLLBACK');
        return 'unavailable';
      }
      await this.audit(client, employee.userId, 'communication.call_claimed', callId, {
        employeeProfileId: employee.profileId,
      });
      await client.query('COMMIT');
      return 'claimed';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async assign(
    callId: string,
    employeeProfileId: string | null,
    actorSubject: string,
  ): Promise<boolean> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actor = await this.user(client, actorSubject);
      if (!actor) {
        await client.query('ROLLBACK');
        return false;
      }
      const result = await client.query<{ id: string }>(
        'UPDATE communication_calls SET assigned_employee_profile_id=$2,claimed_by_employee_profile_id=NULL,updated_at=now() WHERE id=$1 RETURNING id',
        [callId, employeeProfileId],
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }
      await this.audit(client, actor, 'communication.call_assigned', callId, { employeeProfileId });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async completeFollowUpForEmployee(subject: string, callId: string): Promise<boolean | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const employee = await this.employee(client, subject);
      if (!employee) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query<{ id: string }>(
        "UPDATE communication_calls SET follow_up_status='completed',updated_at=now() WHERE id=$1 AND assigned_employee_profile_id=$2 AND follow_up_status IN ('required','claimed') RETURNING id",
        [callId, employee.profileId],
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }
      await this.audit(client, employee.userId, 'communication.follow_up_completed', callId, {});
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async employee(client: Client, subject: string) {
    const result = await client.query<{ profile_id: string; user_id: string }>(
      "SELECT ep.id AS profile_id,ep.user_id FROM identities i JOIN employee_profiles ep ON ep.user_id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND ep.employment_status='active' AND ep.archived_at IS NULL",
      [subject],
    );
    const row = result.rows[0];
    return row ? { profileId: row.profile_id, userId: row.user_id } : null;
  }
  private async user(client: Client, subject: string) {
    const result = await client.query<{ id: string }>(
      "SELECT i.user_id AS id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND u.status='active' AND u.archived_at IS NULL",
      [subject],
    );
    return result.rows[0]?.id ?? null;
  }
  private async audit(
    client: Client,
    actorUserId: string,
    action: string,
    targetId: string,
    afterValue: Record<string, unknown>,
  ) {
    await client.query(
      'INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,after_value) VALUES ($1,$2,$3,$4,$5,$6)',
      [actorUserId, action, 'communication_call', targetId, randomUUID(), afterValue],
    );
  }
}
type CallRow = {
  id: string;
  provider_call_reference: string;
  direction: string;
  status: string;
  from_number: string | null;
  to_number: string | null;
  assigned_employee_profile_id: string | null;
  follow_up_status: string;
  transcript: string | null;
  call_summary: string | null;
};
const callSelect =
  'SELECT id,provider_call_reference,direction,status,from_number,to_number,assigned_employee_profile_id,follow_up_status,transcript,call_summary FROM communication_calls';
function mapCall(row: CallRow): CommunicationCall {
  return {
    id: row.id,
    providerCallReference: row.provider_call_reference,
    direction: row.direction,
    status: row.status,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    assignedEmployeeProfileId: row.assigned_employee_profile_id,
    followUpStatus: row.follow_up_status,
    transcript: row.transcript,
    callSummary: row.call_summary,
  };
}
