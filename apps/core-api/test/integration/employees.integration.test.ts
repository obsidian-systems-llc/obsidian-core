import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresEmployeeRepository } from '../../src/employees.js';
import { loadFieldEncryptor } from '../../src/encryption.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL employee repository', () => {
  const userId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const organizationId = randomUUID();
  const businessUnitId = randomUUID();
  const districtId = randomUUID();
  const storeId = randomUUID();
  const departmentId = randomUUID();
  const client = new Client({ connectionString: databaseUrl });
  const subject = `auth0|employee-${userId}`;
  const encryptor = loadFieldEncryptor({
    FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    FIELD_ENCRYPTION_KEY_ID: 'test-key',
  });
  const repository = new PostgresEmployeeRepository(databaseUrl!, encryptor);

  beforeAll(async () => {
    await client.connect();
    const profile = encryptor.encrypt({ jobTitle: 'Technician', name: 'Synthetic Employee' });
    await client.query('INSERT INTO organizations (id, code, name) VALUES ($1, $2, $3)', [
      organizationId,
      `ORG-${organizationId.slice(0, 8)}`,
      'Synthetic Organization',
    ]);
    await client.query(
      'INSERT INTO business_units (id, organization_id, code, name) VALUES ($1, $2, $3, $4)',
      [
        businessUnitId,
        organizationId,
        `BU-${businessUnitId.slice(0, 8)}`,
        'Synthetic Business Unit',
      ],
    );
    await client.query(
      'INSERT INTO districts (id, business_unit_id, code, name) VALUES ($1, $2, $3, $4)',
      [districtId, businessUnitId, `DIST-${districtId.slice(0, 8)}`, 'Synthetic District'],
    );
    await client.query('INSERT INTO stores (id, district_id, code, name) VALUES ($1, $2, $3, $4)', [
      storeId,
      districtId,
      `STORE-${storeId.slice(0, 8)}`,
      'Synthetic Store',
    ]);
    await client.query(
      'INSERT INTO departments (id, store_id, code, name) VALUES ($1, $2, $3, $4)',
      [departmentId, storeId, `DEPT-${departmentId.slice(0, 8)}`, 'Synthetic Department'],
    );
    await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `employee-${userId}@example.invalid`,
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
    await client.query(
      `INSERT INTO employee_assignments (id, employee_profile_id, store_id, department_id)
       VALUES ($1, $2, $3, $4)`,
      [assignmentId, profileId, storeId, departmentId],
    );
  });

  afterAll(async () => {
    await client.query('DELETE FROM employee_assignments WHERE employee_profile_id = $1', [
      profileId,
    ]);
    await client.query('DELETE FROM employee_profiles WHERE id = $1', [profileId]);
    await client.query('DELETE FROM identities WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('DELETE FROM departments WHERE id = $1', [departmentId]);
    await client.query('DELETE FROM stores WHERE id = $1', [storeId]);
    await client.query('DELETE FROM districts WHERE id = $1', [districtId]);
    await client.query('DELETE FROM business_units WHERE id = $1', [businessUnitId]);
    await client.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    await client.end();
  });

  it('returns only the active profile and effective assignments linked to the identity', async () => {
    await expect(repository.getForSubject(subject)).resolves.toMatchObject({
      assignments: [{ departmentId, id: assignmentId, storeId }],
      id: profileId,
      value: { jobTitle: 'Technician' },
    });
    await expect(repository.getForSubject('auth0|unknown')).resolves.toBeNull();
  });
});
