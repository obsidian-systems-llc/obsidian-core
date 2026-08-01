import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSubscriptionPlanRepository } from '../../src/subscriptions.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL subscription plan repository', () => {
  const userId = randomUUID();
  const subject = `auth0|subscription-${userId}`;
  const planKey = `synthetic-plan-${userId.slice(0, 8)}`;
  const client = new Client({ connectionString: databaseUrl });
  const repository = new PostgresSubscriptionPlanRepository(databaseUrl!);

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO users (id, email) VALUES ($1,$2)', [
      userId,
      `subscription-${userId}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1,'auth0',$2)",
      [userId, subject],
    );
  });

  afterAll(async () => {
    await client.query(
      'ALTER TABLE subscription_plan_versions DISABLE TRIGGER subscription_plan_versions_immutable',
    );
    try {
      await client.query('DELETE FROM audit_events WHERE actor_user_id=$1', [userId]);
      await client.query(
        'DELETE FROM subscription_plan_versions WHERE subscription_plan_id IN (SELECT id FROM subscription_plans WHERE key=$1)',
        [planKey],
      );
      await client.query('DELETE FROM subscription_plans WHERE key=$1', [planKey]);
      await client.query('DELETE FROM identities WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM users WHERE id=$1', [userId]);
    } finally {
      await client.query(
        'ALTER TABLE subscription_plan_versions ENABLE TRIGGER subscription_plan_versions_immutable',
      );
      await client.end();
    }
  });

  it('serializes concurrent plan versions and records safe audit events', async () => {
    const makeInput = (name: string) => ({
      amountMinor: 1500n,
      cadence: 'monthly' as const,
      currency: 'USD',
      effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
      name,
      planKey,
    });
    const [first, second] = await Promise.all([
      repository.createVersion(subject, makeInput('Synthetic Plan A'), randomUUID()),
      repository.createVersion(subject, makeInput('Synthetic Plan B'), randomUUID()),
    ]);
    expect(first?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      client.query(
        'SELECT version_number FROM subscription_plan_versions WHERE subscription_plan_id IN (SELECT id FROM subscription_plans WHERE key=$1) ORDER BY version_number',
        [planKey],
      ),
    ).resolves.toMatchObject({ rows: [{ version_number: 1 }, { version_number: 2 }] });
    await expect(
      client.query(
        "SELECT action, after_value FROM audit_events WHERE actor_user_id=$1 AND action='subscription_plan_version.created'",
        [userId],
      ),
    ).resolves.toMatchObject({ rowCount: 2 });
  });
});
