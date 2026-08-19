import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresCustomerWorkRoutingRepository } from '../../src/customer-work-routing.js';
import { loadFieldEncryptor } from '../../src/encryption.js';

config({ path: new URL('../../../../.env', import.meta.url) });
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL customer-work routing', () => {
  const ids = Object.fromEntries(
    [
      'organization',
      'unit',
      'district',
      'store',
      'managerUser',
      'manager',
      'technicianUser',
      'technician',
      'call',
    ].map((key) => [key, randomUUID()]),
  ) as Record<string, string>;
  const managerSubject = `auth0|routing-manager-${ids.managerUser}`;
  const technicianSubject = `auth0|routing-technician-${ids.technicianUser}`;
  const client = new Client({ connectionString: databaseUrl });
  const repository = new PostgresCustomerWorkRoutingRepository(databaseUrl!);
  const encryptor = loadFieldEncryptor({
    FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    FIELD_ENCRYPTION_KEY_ID: 'test-key',
  });

  beforeAll(async () => {
    await client.connect();
    const suffix = ids.organization.slice(0, 8);
    await client.query('INSERT INTO organizations (id,code,name) VALUES ($1,$2,$3)', [
      ids.organization,
      `ORG-${suffix}`,
      'Synthetic routing organization',
    ]);
    await client.query(
      'INSERT INTO business_units (id,organization_id,code,name) VALUES ($1,$2,$3,$4)',
      [ids.unit, ids.organization, `BU-${suffix}`, 'Synthetic routing business unit'],
    );
    await client.query(
      'INSERT INTO districts (id,business_unit_id,code,name) VALUES ($1,$2,$3,$4)',
      [ids.district, ids.unit, `D-${suffix}`, 'Synthetic routing district'],
    );
    await client.query('INSERT INTO stores (id,district_id,code,name) VALUES ($1,$2,$3,$4)', [
      ids.store,
      ids.district,
      `S-${suffix}`,
      'Synthetic routing store',
    ]);
    await client.query('INSERT INTO users (id,email) VALUES ($1,$2),($3,$4)', [
      ids.managerUser,
      `routing-manager-${suffix}@example.invalid`,
      ids.technicianUser,
      `routing-technician-${suffix}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,'auth0',$2),($3,'auth0',$4)",
      [ids.managerUser, managerSubject, ids.technicianUser, technicianSubject],
    );
    for (const [profileId, userId, employeeNumber] of [
      [ids.manager, ids.managerUser, 'MGR'],
      [ids.technician, ids.technicianUser, 'TECH'],
    ] as const) {
      const encrypted = encryptor.encrypt({ synthetic: employeeNumber });
      await client.query(
        'INSERT INTO employee_profiles (id,user_id,employee_number,ciphertext,iv,auth_tag,key_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          profileId,
          userId,
          `${employeeNumber}-${suffix}`,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyId,
        ],
      );
    }
    await client.query(
      'INSERT INTO employee_assignments (employee_profile_id,store_id) VALUES ($1,$2)',
      [ids.manager, ids.store],
    );
    await client.query(
      'INSERT INTO employee_assignments (employee_profile_id,store_id,manager_employee_profile_id) VALUES ($1,$2,$3)',
      [ids.technician, ids.store, ids.manager],
    );
    await client.query(
      "INSERT INTO communication_calls (id,provider,provider_call_reference,direction,status,follow_up_required,follow_up_status) VALUES ($1,'retell',$2,'inbound','ended',true,'required')",
      [ids.call, `synthetic-routing-${suffix}`],
    );
  });

  afterAll(async () => {
    await client.query('DELETE FROM audit_events WHERE actor_user_id=ANY($1::uuid[])', [
      [ids.managerUser, ids.technicianUser],
    ]);
    await client.query('DELETE FROM customer_work_notifications WHERE work_id=$1', [ids.call]);
    await client.query('DELETE FROM customer_work_routing_events WHERE work_id=$1', [ids.call]);
    await client.query('DELETE FROM communication_calls WHERE id=$1', [ids.call]);
    await client.query(
      'DELETE FROM employee_assignments WHERE employee_profile_id=ANY($1::uuid[])',
      [[ids.manager, ids.technician]],
    );
    await client.query('DELETE FROM employee_profiles WHERE id=ANY($1::uuid[])', [
      [ids.manager, ids.technician],
    ]);
    await client.query('DELETE FROM identities WHERE user_id=ANY($1::uuid[])', [
      [ids.managerUser, ids.technicianUser],
    ]);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [
      [ids.managerUser, ids.technicianUser],
    ]);
    await client.query('DELETE FROM stores WHERE id=$1', [ids.store]);
    await client.query('DELETE FROM districts WHERE id=$1', [ids.district]);
    await client.query('DELETE FROM business_units WHERE id=$1', [ids.unit]);
    await client.query('DELETE FROM organizations WHERE id=$1', [ids.organization]);
    await client.end();
  });

  it('routes scoped work, alerts the manager on escalation, and safely retries completion', async () => {
    const routed = await repository.route(
      managerSubject,
      'communication_call',
      ids.call,
      {
        employeeProfileId: ids.technician,
        priority: 'high',
        reason: 'Assign the shared-store technician',
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
      false,
    );
    expect(routed).toMatchObject({ employeeProfileId: ids.technician, priority: 'high' });
    const technicianInbox = await repository.listForEmployee(technicianSubject);
    expect(technicianInbox?.work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ids.call, workType: 'communication_call' }),
      ]),
    );

    const escalated = await repository.escalate(
      technicianSubject,
      'communication_call',
      ids.call,
      {
        priority: 'urgent',
        reason: 'Customer needs same-day assistance',
        idempotencyKey: randomUUID(),
      },
      randomUUID(),
    );
    expect(escalated).toMatchObject({ priority: 'urgent' });
    const escalation = await client.query(
      "SELECT employee_profile_id,type FROM customer_work_notifications WHERE work_id=$1 AND type='escalated'",
      [ids.call],
    );
    expect(escalation.rows).toEqual([{ employee_profile_id: ids.manager, type: 'escalated' }]);

    const completionKey = randomUUID();
    await expect(
      repository.complete(
        technicianSubject,
        'communication_call',
        ids.call,
        { reason: 'Follow-up completed with customer', idempotencyKey: completionKey },
        randomUUID(),
      ),
    ).resolves.toBe(true);
    await expect(
      repository.complete(
        technicianSubject,
        'communication_call',
        ids.call,
        { reason: 'Follow-up completed with customer', idempotencyKey: completionKey },
        randomUUID(),
      ),
    ).resolves.toBe(true);
    const audit = await client.query(
      "SELECT action FROM audit_events WHERE actor_user_id=$1 AND target_id=$2 AND action='customer_work.completed'",
      [ids.technicianUser, ids.call],
    );
    expect(audit.rowCount).toBe(1);
  });
});
