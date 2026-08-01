import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrganizationRepository } from '../../src/organizations.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL organization repository', () => {
  const organizationId = randomUUID();
  const businessUnitId = randomUUID();
  const districtId = randomUUID();
  const storeId = randomUUID();
  const departmentId = randomUUID();
  const client = new Client({ connectionString: databaseUrl });
  const suffix = organizationId.slice(0, 8).toUpperCase();
  const repository = new PostgresOrganizationRepository(databaseUrl!);

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO organizations (id, code, name) VALUES ($1, $2, $3)', [
      organizationId,
      `ORG-${suffix}`,
      'Organization test',
    ]);
    await client.query(
      'INSERT INTO business_units (id, organization_id, code, name) VALUES ($1, $2, $3, $4)',
      [businessUnitId, organizationId, `BU-${suffix}`, 'Business unit test'],
    );
    await client.query(
      'INSERT INTO districts (id, business_unit_id, code, name) VALUES ($1, $2, $3, $4)',
      [districtId, businessUnitId, `DIST-${suffix}`, 'District test'],
    );
    await client.query('INSERT INTO stores (id, district_id, code, name) VALUES ($1, $2, $3, $4)', [
      storeId,
      districtId,
      `STORE-${suffix}`,
      'Store test',
    ]);
    await client.query(
      'INSERT INTO departments (id, store_id, code, name) VALUES ($1, $2, $3, $4)',
      [departmentId, storeId, `DEPT-${suffix}`, 'Department test'],
    );
  });

  afterAll(async () => {
    await client.query('DELETE FROM departments WHERE id = $1', [departmentId]);
    await client.query('DELETE FROM stores WHERE id = $1', [storeId]);
    await client.query('DELETE FROM districts WHERE id = $1', [districtId]);
    await client.query('DELETE FROM business_units WHERE id = $1', [businessUnitId]);
    await client.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    await client.end();
  });

  it('returns active organizational records in their parent hierarchy', async () => {
    const result = await repository.getHierarchy();
    const organization = result.organizations.find((item) => item.id === organizationId);
    expect(organization?.businessUnits[0]?.districts[0]?.stores[0]?.departments).toEqual([
      { id: departmentId, code: `DEPT-${suffix}`, name: 'Department test', storeId },
    ]);
  });
});
