import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

config({ path: new URL('../../../.env', import.meta.url) });

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required to run migrations.');
const directory = new URL('../migrations/', import.meta.url);
const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
const client = new pg.Client({ connectionString: url });
let applied = 0;
try {
  await client.connect();
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const file of files) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('SELECT checksum FROM schema_migrations WHERE id=$1', [
      file,
    ]);
    if (existing.rows[0] && existing.rows[0].checksum !== checksum)
      throw new Error(`Migration checksum drift: ${file}`);
    if (existing.rows[0]) continue;
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id,checksum) VALUES ($1,$2)', [
        file,
        checksum,
      ]);
      await client.query('COMMIT');
      applied += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
  console.log(
    `Applied ${applied} new migration(s); verified ${files.length - applied} existing migration(s).`,
  );
} finally {
  await client.end().catch(() => undefined);
}
