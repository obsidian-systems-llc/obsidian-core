import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresJobRepository } from '../../src/jobs.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL job repository', () => {
  const userId = randomUUID();
  const subject = `auth0|job-${userId}`;
  const client = new Client({ connectionString: databaseUrl });
  const repository = new PostgresJobRepository(databaseUrl!);
  let jobId: string | undefined;

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO users (id, email) VALUES ($1,$2)', [
      userId,
      `job-${userId}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1,'auth0',$2)",
      [userId, subject],
    );
  });

  afterAll(async () => {
    await client.query('ALTER TABLE job_transitions DISABLE TRIGGER job_transitions_immutable');
    try {
      if (jobId) {
        await client.query('DELETE FROM audit_events WHERE target_id=$1', [jobId]);
        await client.query('DELETE FROM job_transitions WHERE job_id=$1', [jobId]);
        await client.query('DELETE FROM appointments WHERE job_id=$1', [jobId]);
        await client.query('DELETE FROM jobs WHERE id=$1', [jobId]);
      }
      await client.query('DELETE FROM identities WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM users WHERE id=$1', [userId]);
    } finally {
      await client.query('ALTER TABLE job_transitions ENABLE TRIGGER job_transitions_immutable');
      await client.end();
    }
  });

  it('creates and transitions a job with auditable safe status metadata', async () => {
    const created = await repository.createForSubject(
      subject,
      {
        idempotencyKey: randomUUID(),
        windowEnd: new Date('2026-08-01T10:00:00.000Z'),
        windowStart: new Date('2026-08-01T09:00:00.000Z'),
      },
      randomUUID(),
    );
    jobId = created?.id;
    expect(created).toMatchObject({ status: 'requested' });
    await expect(
      repository.transitionForSubject(
        subject,
        jobId!,
        { idempotencyKey: randomUUID(), reason: 'Scheduled by test', toStatus: 'scheduled' },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ status: 'scheduled' });
    await expect(
      client.query(
        'SELECT action, before_value, after_value FROM audit_events WHERE target_id=$1 ORDER BY created_at',
        [jobId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { action: 'job.created', before_value: null, after_value: { status: 'requested' } },
        {
          action: 'job.transitioned',
          before_value: { status: 'requested' },
          after_value: { status: 'scheduled' },
        },
      ],
    });
  });
});
