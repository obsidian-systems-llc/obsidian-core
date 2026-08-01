import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresQuoteRepository } from '../../src/quotes.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL quote repository', () => {
  const userId = randomUUID();
  const catalogItemId = randomUUID();
  const catalogVersionId = randomUUID();
  const subject = `auth0|quote-${userId}`;
  const client = new Client({ connectionString: databaseUrl });
  const repository = new PostgresQuoteRepository(databaseUrl!);

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `quote-${userId}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1, 'auth0', $2)",
      [userId, subject],
    );
    await client.query('INSERT INTO catalog_items (id, key, kind) VALUES ($1, $2, $3)', [
      catalogItemId,
      `synthetic-service-${catalogItemId.slice(0, 8)}`,
      'service',
    ]);
    await client.query(
      `INSERT INTO catalog_item_versions
       (id, catalog_item_id, version_number, name, currency, unit_amount_minor)
       VALUES ($1, $2, 1, 'Synthetic Service', 'USD', 1999)`,
      [catalogVersionId, catalogItemId],
    );
  });

  afterAll(async () => {
    try {
      // Integration fixtures require privileged cleanup; application paths cannot disable history triggers.
      await client.query('ALTER TABLE quote_line_items DISABLE TRIGGER quote_line_items_immutable');
      await client.query(
        'ALTER TABLE catalog_item_versions DISABLE TRIGGER catalog_item_versions_immutable',
      );
      await client.query(
        'DELETE FROM quote_line_items WHERE quote_id IN (SELECT id FROM quotes WHERE created_by_user_id = $1)',
        [userId],
      );
      await client.query('DELETE FROM quotes WHERE created_by_user_id = $1', [userId]);
      await client.query('DELETE FROM catalog_item_versions WHERE catalog_item_id = $1', [
        catalogItemId,
      ]);
      await client.query('DELETE FROM catalog_items WHERE id = $1', [catalogItemId]);
      await client.query('DELETE FROM audit_events WHERE actor_user_id = $1', [userId]);
      await client.query('DELETE FROM identities WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
    } finally {
      await client.query(
        'ALTER TABLE catalog_item_versions ENABLE TRIGGER catalog_item_versions_immutable',
      );
      await client.query('ALTER TABLE quote_line_items ENABLE TRIGGER quote_line_items_immutable');
      await client.end();
    }
  });

  it('snapshots a catalog price, retries idempotently, and preserves the quote after a new version', async () => {
    const key = `synthetic-service-${catalogItemId.slice(0, 8)}`;
    const input = {
      idempotencyKey: randomUUID(),
      items: [{ catalogItemKey: key, quantity: 2 }],
    };
    const quote = await repository.createForSubject(subject, input);
    const retry = await repository.createForSubject(subject, input);
    expect(quote).toMatchObject({ totalAmountMinor: '3998', items: [{ unitAmountMinor: '1999' }] });
    expect(retry?.id).toBe(quote?.id);
    await expect(
      client.query(
        "SELECT action, after_value FROM audit_events WHERE actor_user_id=$1 AND action='quote.created'",
        [userId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      client.query('UPDATE catalog_item_versions SET name = $1 WHERE id = $2', [
        'Modified Service',
        catalogVersionId,
      ]),
    ).rejects.toThrow('immutable');
    await client.query(
      `INSERT INTO catalog_item_versions
       (catalog_item_id, version_number, name, currency, unit_amount_minor, effective_from)
       VALUES ($1, 2, 'Synthetic Service Revised', 'USD', 2999, now())`,
      [catalogItemId],
    );
    expect(await repository.createForSubject(subject, input)).toMatchObject({
      id: quote?.id,
      totalAmountMinor: '3998',
    });
  });
});
