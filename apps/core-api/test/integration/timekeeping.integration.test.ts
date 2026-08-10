import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFieldEncryptor } from '../../src/encryption.js';
import { PostgresTimekeepingRepository } from '../../src/timekeeping.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL timekeeping repository', () => {
  const userId = randomUUID();
  const profileId = randomUUID();
  const entryKey = randomUUID();
  const correctionKey = randomUUID();
  const subject = `auth0|timekeeper-${userId}`;
  const client = new Client({ connectionString: databaseUrl });
  const repository = new PostgresTimekeepingRepository(databaseUrl!);

  beforeAll(async () => {
    const encryptor = loadFieldEncryptor({
      FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      FIELD_ENCRYPTION_KEY_ID: 'test-key',
    });
    const profile = encryptor.encrypt({ name: 'Synthetic Timekeeper' });
    await client.connect();
    await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `timekeeper-${userId}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1, 'auth0', $2)",
      [userId, subject],
    );
    await client.query(
      `INSERT INTO employee_profiles
       (id, user_id, employee_number, ciphertext, iv, auth_tag, key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        profileId,
        userId,
        `EMP-${profileId.slice(0, 8)}`,
        profile.ciphertext,
        profile.iv,
        profile.authTag,
        profile.keyId,
      ],
    );
  });

  afterAll(async () => {
    try {
      // Test cleanup is deliberately privileged: production application paths cannot disable these triggers.
      await client.query(
        'ALTER TABLE time_entry_corrections DISABLE TRIGGER time_entry_corrections_immutable',
      );
      await client.query('ALTER TABLE time_entries DISABLE TRIGGER time_entries_immutable');
      await client.query(
        'ALTER TABLE mobile_time_events DISABLE TRIGGER mobile_time_events_immutable',
      );
      await client.query('DELETE FROM audit_events WHERE actor_user_id = $1', [userId]);
      await client.query('DELETE FROM mobile_time_events WHERE employee_profile_id = $1', [
        profileId,
      ]);
      await client.query(
        'DELETE FROM time_entry_corrections WHERE time_entry_id IN (SELECT id FROM time_entries WHERE employee_profile_id = $1)',
        [profileId],
      );
      await client.query('DELETE FROM time_entries WHERE employee_profile_id = $1', [profileId]);
      await client.query('DELETE FROM employee_profiles WHERE id = $1', [profileId]);
      await client.query('DELETE FROM identities WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
    } finally {
      await client.query('ALTER TABLE time_entries ENABLE TRIGGER time_entries_immutable');
      await client.query(
        'ALTER TABLE mobile_time_events ENABLE TRIGGER mobile_time_events_immutable',
      );
      await client.query(
        'ALTER TABLE time_entry_corrections ENABLE TRIGGER time_entry_corrections_immutable',
      );
      await client.end();
    }
  });

  it('is idempotent, returns effective corrections, and audits correction records', async () => {
    const input = {
      endedAt: new Date('2026-08-01T17:00:00Z'),
      idempotencyKey: entryKey,
      source: 'web' as const,
      startedAt: new Date('2026-08-01T09:00:00Z'),
    };
    const entry = await repository.createForSubject(subject, input);
    const retry = await repository.createForSubject(subject, input);
    expect(entry).toMatchObject({ totalSeconds: 28800 });
    expect(retry?.id).toBe(entry?.id);

    const corrected = await repository.correctForSubject(
      subject,
      entry!.id,
      {
        endedAt: new Date('2026-08-01T18:00:00Z'),
        idempotencyKey: correctionKey,
        reason: 'Synthetic correction',
        startedAt: new Date('2026-08-01T09:00:00Z'),
      },
      randomUUID(),
    );
    expect(corrected).toMatchObject({ id: entry!.id, totalSeconds: 32400 });
    await expect(
      client.query('UPDATE time_entries SET source = $1 WHERE id = $2', ['mobile', entry!.id]),
    ).rejects.toThrow('immutable');
    await expect(
      client.query('SELECT action FROM audit_events WHERE actor_user_id = $1 AND target_id = $2', [
        userId,
        entry!.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ action: 'time_entry.corrected' }] });
  });

  it('records an append-only, retry-safe mobile clock and break sequence', async () => {
    const clockIn = { eventType: 'clock_in' as const, idempotencyKey: randomUUID() };
    await expect(
      repository.recordMobileEvent(subject, clockIn, randomUUID()),
    ).resolves.toMatchObject({
      activeBreakStartedAt: null,
      clockedInAt: expect.any(Date),
    });
    await expect(
      repository.recordMobileEvent(subject, clockIn, randomUUID()),
    ).resolves.toMatchObject({
      clockedInAt: expect.any(Date),
    });
    await repository.recordMobileEvent(
      subject,
      { eventType: 'break_start', idempotencyKey: randomUUID() },
      randomUUID(),
    );
    await repository.recordMobileEvent(
      subject,
      { eventType: 'break_end', idempotencyKey: randomUUID() },
      randomUUID(),
    );
    await expect(
      repository.recordMobileEvent(
        subject,
        { eventType: 'clock_out', idempotencyKey: randomUUID() },
        randomUUID(),
      ),
    ).resolves.toEqual({ activeBreakStartedAt: null, clockedInAt: null });
    await expect(
      client.query(
        `SELECT event_type FROM mobile_time_events WHERE employee_profile_id = $1 ORDER BY occurred_at, id`,
        [profileId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { event_type: 'clock_in' },
        { event_type: 'break_start' },
        { event_type: 'break_end' },
        { event_type: 'clock_out' },
      ],
    });
    await expect(
      client.query(
        `SELECT action FROM audit_events WHERE actor_user_id = $1 AND action = 'mobile_time.clock_out'`,
        [userId],
      ),
    ).resolves.toMatchObject({ rows: [{ action: 'mobile_time.clock_out' }] });
  });
});
