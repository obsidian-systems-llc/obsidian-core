import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { postgresCommand } from './postgres-service.mjs';

config({ path: new URL('../../../.env', import.meta.url) });

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required to run migrations.');
const directory = new URL('../migrations/', import.meta.url);
const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
let applied = 0;
execFileSync(postgresCommand('psql'), [
  '--dbname',
  url,
  '--set',
  'ON_ERROR_STOP=1',
  '--command',
  'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
]);
for (const file of files) {
  const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const existing = execFileSync(
    postgresCommand('psql'),
    [
      '--dbname',
      url,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT checksum FROM schema_migrations WHERE id = '${file}'`,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (existing && existing !== checksum) throw new Error(`Migration checksum drift: ${file}`);
  if (!existing) {
    execFileSync(postgresCommand('psql'), [
      '--dbname',
      url,
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      `BEGIN; ${sql} INSERT INTO schema_migrations (id, checksum) VALUES ('${file}', '${checksum}'); COMMIT;`,
    ]);
    applied += 1;
  }
}
console.log(
  `Applied ${applied} new migration(s); verified ${files.length - applied} existing migration(s).`,
);
