import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresEmployeeAdministrationRepository } from '../../src/employee-admin.js';
import { loadFieldEncryptor } from '../../src/encryption.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL employee administration', () => {
  const ids = Object.fromEntries(
    [
      'organization',
      'businessUnit',
      'district',
      'store',
      'managerUser',
      'managerProfile',
      'targetUser',
    ].map((key) => [key, randomUUID()]),
  ) as Record<string, string>;
  const subject = `auth0|manager-${ids.managerUser}`;
  const client = new Client({ connectionString: databaseUrl });
  const encryptor = loadFieldEncryptor({
    FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    FIELD_ENCRYPTION_KEY_ID: 'test-key',
  });
  const repository = new PostgresEmployeeAdministrationRepository(databaseUrl!, encryptor);
  let targetProfileId = '';

  beforeAll(async () => {
    await client.connect();
    const suffix = ids.organization.slice(0, 8);
    await client.query('INSERT INTO organizations (id,code,name) VALUES ($1,$2,$3)', [
      ids.organization,
      `ORG-${suffix}`,
      'Admin integration organization',
    ]);
    await client.query(
      'INSERT INTO business_units (id,organization_id,code,name) VALUES ($1,$2,$3,$4)',
      [ids.businessUnit, ids.organization, `BU-${suffix}`, 'Admin integration unit'],
    );
    await client.query(
      'INSERT INTO districts (id,business_unit_id,code,name) VALUES ($1,$2,$3,$4)',
      [ids.district, ids.businessUnit, `DIST-${suffix}`, 'Admin integration district'],
    );
    await client.query('INSERT INTO stores (id,district_id,code,name) VALUES ($1,$2,$3,$4)', [
      ids.store,
      ids.district,
      `STORE-${suffix}`,
      'Admin integration store',
    ]);
    const managerProfile = encryptor.encrypt({ name: 'Synthetic Manager' });
    await client.query('INSERT INTO users (id,email) VALUES ($1,$2),($3,$4)', [
      ids.managerUser,
      `manager-${suffix}@example.invalid`,
      ids.targetUser,
      `target-${suffix}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,'auth0',$2)",
      [ids.managerUser, subject],
    );
    await client.query(
      'INSERT INTO employee_profiles (id,user_id,employee_number,ciphertext,iv,auth_tag,key_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        ids.managerProfile,
        ids.managerUser,
        `MGR-${suffix}`,
        managerProfile.ciphertext,
        managerProfile.iv,
        managerProfile.authTag,
        managerProfile.keyId,
      ],
    );
    await client.query(
      'INSERT INTO employee_assignments (employee_profile_id,store_id) VALUES ($1,$2)',
      [ids.managerProfile, ids.store],
    );
  });

  afterAll(async () => {
    if (targetProfileId)
      await client.query('DELETE FROM employee_assignments WHERE employee_profile_id=$1', [
        targetProfileId,
      ]);
    if (targetProfileId)
      await client.query('DELETE FROM employee_profile_revisions WHERE employee_profile_id=$1', [
        targetProfileId,
      ]);
    if (targetProfileId)
      await client.query('DELETE FROM employee_lifecycle_events WHERE employee_profile_id=$1', [
        targetProfileId,
      ]);
    await client.query('DELETE FROM employee_admin_commands WHERE actor_user_id=$1', [
      ids.managerUser,
    ]);
    await client.query('DELETE FROM audit_events WHERE actor_user_id=$1', [ids.managerUser]);
    if (targetProfileId)
      await client.query('DELETE FROM employee_profiles WHERE id=$1', [targetProfileId]);
    await client.query('DELETE FROM employee_assignments WHERE employee_profile_id=$1', [
      ids.managerProfile,
    ]);
    await client.query('DELETE FROM employee_profiles WHERE id=$1', [ids.managerProfile]);
    await client.query('DELETE FROM identities WHERE user_id=$1', [ids.managerUser]);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [
      [ids.managerUser, ids.targetUser],
    ]);
    await client.query('DELETE FROM stores WHERE id=$1', [ids.store]);
    await client.query('DELETE FROM districts WHERE id=$1', [ids.district]);
    await client.query('DELETE FROM business_units WHERE id=$1', [ids.businessUnit]);
    await client.query('DELETE FROM organizations WHERE id=$1', [ids.organization]);
    await client.end();
  });

  it('preserves encrypted revisions and exposes a manager-scoped employee list', async () => {
    const created = await repository.create(
      subject,
      {
        userId: ids.targetUser,
        employeeNumber: `EMP-${ids.targetUser.slice(0, 8)}`,
        profile: { name: 'Scoped Technician', title: 'Technician' },
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
    );
    expect(created).not.toBeNull();
    if (!created || created === 'conflict') throw new Error('Expected employee creation.');
    targetProfileId = created.id;
    await repository.createAssignment(
      subject,
      { employeeProfileId: targetProfileId, storeId: ids.store, idempotencyKey: randomUUID() },
      randomUUID(),
    );
    const updated = await repository.replaceProfile(
      subject,
      targetProfileId,
      {
        profile: { name: 'Scoped Technician', title: 'Senior Technician' },
        reason: 'Promotion',
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
    );
    expect(updated?.value).toMatchObject({ title: 'Senior Technician' });
    const revisions = await client.query<{ changed_field_names: string[] }>(
      'SELECT changed_field_names FROM employee_profile_revisions WHERE employee_profile_id=$1',
      [targetProfileId],
    );
    expect(revisions.rows[0]?.changed_field_names).toEqual(['title']);
    const managed = await repository.listManaged(subject, { limit: 10, offset: 0 });
    expect(managed.items.map((item) => item.id)).toContain(targetProfileId);
  });
});
