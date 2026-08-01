import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresReportingRepository } from '../../src/reporting.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL reporting scope', () => {
  const ids = Object.fromEntries(
    [
      'application',
      'businessUnit',
      'district',
      'organization',
      'permission',
      'role',
      'store',
      'user',
    ].map((name) => [name, randomUUID()]),
  ) as Record<string, string>;
  const subject = `auth0|reporting-${ids.user}`;
  const suffix = ids.organization.slice(0, 8).toUpperCase();
  const client = new Client({ connectionString: databaseUrl });
  const repository = new PostgresReportingRepository(databaseUrl!);

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO organizations (id, code, name) VALUES ($1,$2,$3)', [
      ids.organization,
      `ORG-${suffix}`,
      'Reporting organization',
    ]);
    await client.query(
      'INSERT INTO business_units (id, organization_id, code, name) VALUES ($1,$2,$3,$4)',
      [ids.businessUnit, ids.organization, `BU-${suffix}`, 'Reporting business unit'],
    );
    await client.query(
      'INSERT INTO districts (id, business_unit_id, code, name) VALUES ($1,$2,$3,$4)',
      [ids.district, ids.businessUnit, `DIST-${suffix}`, 'Reporting district'],
    );
    await client.query('INSERT INTO stores (id, district_id, code, name) VALUES ($1,$2,$3,$4)', [
      ids.store,
      ids.district,
      `STORE-${suffix}`,
      'Reporting store',
    ]);
    await client.query('INSERT INTO users (id, email) VALUES ($1,$2)', [
      ids.user,
      `reporting-${ids.user}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1,'auth0',$2)",
      [ids.user, subject],
    );
    await client.query('INSERT INTO applications (id, key, name) VALUES ($1,$2,$3)', [
      ids.application,
      `reporting-${suffix}`,
      'Reporting test',
    ]);
    await client.query('INSERT INTO roles (id, application_id, key, name) VALUES ($1,$2,$3,$4)', [
      ids.role,
      ids.application,
      `reporting-role-${suffix}`,
      'Reporting role',
    ]);
    await client.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key='reporting.read'",
      [ids.role],
    );
    await client.query(
      'INSERT INTO user_roles (user_id, role_id, organization_id) VALUES ($1,$2,$3)',
      [ids.user, ids.role, ids.organization],
    );
    await client.query(
      'INSERT INTO daily_operating_aggregates (aggregation_date, scope_type, organization_id, net_sales_minor, source_status) VALUES ($1,$2,$3,$4,$5)',
      ['2026-08-01', 'company', ids.organization, 100, 'estimated'],
    );
    await client.query(
      'INSERT INTO daily_operating_aggregates (aggregation_date, scope_type, district_id, net_sales_minor, source_status) VALUES ($1,$2,$3,$4,$5)',
      ['2026-08-01', 'district', ids.district, 200, 'estimated'],
    );
    await client.query(
      'INSERT INTO daily_operating_aggregates (aggregation_date, scope_type, store_id, net_sales_minor, source_status) VALUES ($1,$2,$3,$4,$5)',
      ['2026-08-01', 'store', ids.store, 300, 'estimated'],
    );
  });

  afterAll(async () => {
    await client.query(
      'DELETE FROM daily_operating_aggregates WHERE organization_id=$1 OR district_id=$2 OR store_id=$3',
      [ids.organization, ids.district, ids.store],
    );
    await client.query('DELETE FROM user_roles WHERE user_id=$1', [ids.user]);
    await client.query('DELETE FROM role_permissions WHERE role_id=$1', [ids.role]);
    await client.query('DELETE FROM identities WHERE user_id=$1', [ids.user]);
    await client.query('DELETE FROM roles WHERE id=$1', [ids.role]);
    await client.query('DELETE FROM applications WHERE id=$1', [ids.application]);
    await client.query('DELETE FROM users WHERE id=$1', [ids.user]);
    await client.query('DELETE FROM stores WHERE id=$1', [ids.store]);
    await client.query('DELETE FROM districts WHERE id=$1', [ids.district]);
    await client.query('DELETE FROM business_units WHERE id=$1', [ids.businessUnit]);
    await client.query('DELETE FROM organizations WHERE id=$1', [ids.organization]);
    await client.end();
  });

  it('returns company, district, and store rows for the authorized organization hierarchy', async () => {
    await expect(repository.listForSubject(subject)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopeType: 'company', netSalesMinor: '100' }),
        expect.objectContaining({ scopeType: 'district', netSalesMinor: '200' }),
        expect.objectContaining({ scopeType: 'store', netSalesMinor: '300' }),
      ]),
    );
  });
});
