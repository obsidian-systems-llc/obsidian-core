import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import type { FieldEncryptor } from './encryption.js';

const idempotencyKey = z.uuid();
const profile = z
  .record(z.string().max(100), z.string().trim().max(4_000))
  .refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 100,
    'profile must contain between 1 and 100 fields.',
  );
const effectiveRange = z
  .object({
    effectiveFrom: z.coerce.date().optional(),
    effectiveTo: z.coerce.date().nullable().optional(),
  })
  .refine(
    (value) =>
      !value.effectiveTo || !value.effectiveFrom || value.effectiveTo > value.effectiveFrom,
    {
      path: ['effectiveTo'],
      message: 'effectiveTo must be after effectiveFrom.',
    },
  );

export const createEmployeeSchema = z.object({
  employeeNumber: z.string().trim().min(2).max(100),
  idempotencyKey,
  profile,
  startDate: z.coerce.date().optional(),
  userId: z.uuid(),
});
export const replaceEmployeeProfileSchema = z.object({
  idempotencyKey,
  profile,
  reason: z.string().trim().min(3).max(500),
});
export const employeeLifecycleSchema = z.object({
  effectiveAt: z.coerce.date().optional(),
  idempotencyKey,
  reason: z.string().trim().min(3).max(500),
});
export const createEmployeeAssignmentSchema = effectiveRange
  .extend({
    departmentId: z.uuid().nullable().optional(),
    employeeProfileId: z.uuid(),
    idempotencyKey,
    managerEmployeeProfileId: z.uuid().nullable().optional(),
    storeId: z.uuid().nullable().optional(),
  })
  .refine((value) => value.storeId || value.departmentId, {
    message: 'storeId or departmentId is required.',
    path: ['storeId'],
  });
export const endEmployeeAssignmentSchema = z.object({
  effectiveTo: z.coerce.date(),
  idempotencyKey,
  reason: z.string().trim().min(3).max(500),
});
export const employeeManagementPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type AdminEmployee = {
  employeeNumber: string;
  employmentStatus: string;
  id: string;
  startDate: string | null;
  endDate: string | null;
  value: Record<string, string>;
};
export type AdminEmployeeAssignment = {
  departmentId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  id: string;
  managerEmployeeProfileId: string | null;
  storeId: string | null;
};
export type EmployeeAdministrationRepository = {
  getForAdmin(employeeId: string): Promise<AdminEmployee | null>;
  create(
    subject: string,
    input: z.infer<typeof createEmployeeSchema>,
    correlationId: string,
  ): Promise<AdminEmployee | null | 'conflict'>;
  replaceProfile(
    subject: string,
    employeeId: string,
    input: z.infer<typeof replaceEmployeeProfileSchema>,
    correlationId: string,
  ): Promise<AdminEmployee | null>;
  deactivate(
    subject: string,
    employeeId: string,
    input: z.infer<typeof employeeLifecycleSchema>,
    correlationId: string,
  ): Promise<boolean | null>;
  reactivate(
    subject: string,
    employeeId: string,
    input: z.infer<typeof employeeLifecycleSchema>,
    correlationId: string,
  ): Promise<boolean | null>;
  createAssignment(
    subject: string,
    input: z.infer<typeof createEmployeeAssignmentSchema>,
    correlationId: string,
  ): Promise<AdminEmployeeAssignment | null | 'conflict'>;
  endAssignment(
    subject: string,
    assignmentId: string,
    input: z.infer<typeof endEmployeeAssignmentSchema>,
    correlationId: string,
  ): Promise<boolean | null | 'invalid_effective_to'>;
  listManaged(
    subject: string,
    page: z.infer<typeof employeeManagementPageSchema>,
  ): Promise<{ items: AdminEmployee[]; nextOffset: number | null }>;
};

export class EmployeeAdministrationError extends Error {}

type ProfileRow = {
  id: string;
  employee_number: string;
  employment_status: string;
  start_date: string | null;
  end_date: string | null;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_id: string;
};
type AssignmentRow = {
  id: string;
  store_id: string | null;
  department_id: string | null;
  manager_employee_profile_id: string | null;
  effective_from: Date;
  effective_to: Date | null;
};

export class PostgresEmployeeAdministrationRepository implements EmployeeAdministrationRepository {
  constructor(
    private readonly databaseUrl: string,
    private readonly encryptor: FieldEncryptor,
  ) {}

  async create(
    subject: string,
    input: z.infer<typeof createEmployeeSchema>,
    correlationId: string,
  ) {
    return this.transaction(
      subject,
      input.idempotencyKey,
      'employee_created',
      async (client, actor) => {
        const prior = await this.command<AdminEmployee>(
          client,
          actor,
          'employee_created',
          input.idempotencyKey,
        );
        if (prior) return prior;
        const user = await client.query(
          "SELECT id FROM users WHERE id=$1 AND status='active' AND archived_at IS NULL FOR UPDATE",
          [input.userId],
        );
        if (!user.rows[0]) return null;
        const duplicate = await client.query(
          'SELECT 1 FROM employee_profiles WHERE user_id=$1 OR employee_number=$2',
          [input.userId, input.employeeNumber],
        );
        if (duplicate.rows[0]) return 'conflict' as const;
        const encrypted = this.encryptor.encrypt(input.profile);
        const result = await client.query<ProfileRow>(
          `INSERT INTO employee_profiles (user_id,employee_number,ciphertext,iv,auth_tag,key_id,start_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,employee_number,employment_status,start_date,end_date,ciphertext,iv,auth_tag,key_id`,
          [
            input.userId,
            input.employeeNumber,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.authTag,
            encrypted.keyId,
            input.startDate ?? null,
          ],
        );
        const employee = this.employee(result.rows[0]!);
        await client.query(
          `INSERT INTO employee_lifecycle_events (employee_profile_id,actor_user_id,event_type,effective_at,idempotency_key)
        VALUES ($1,$2,'created',$3,$4)`,
          [employee.id, actor, input.startDate ?? new Date(), input.idempotencyKey],
        );
        await this.storeCommand(
          client,
          actor,
          'employee_created',
          input.idempotencyKey,
          'employee_profile',
          employee.id,
          employee,
        );
        await this.audit(
          client,
          actor,
          'employee.created',
          'employee_profile',
          employee.id,
          correlationId,
          { employeeNumber: employee.employeeNumber },
        );
        return employee;
      },
    );
  }

  async replaceProfile(
    subject: string,
    employeeId: string,
    input: z.infer<typeof replaceEmployeeProfileSchema>,
    correlationId: string,
  ) {
    return this.transaction(
      subject,
      input.idempotencyKey,
      'employee_profile_replaced',
      async (client, actor) => {
        const prior = await this.command<AdminEmployee>(
          client,
          actor,
          'employee_profile_replaced',
          input.idempotencyKey,
        );
        if (prior) return prior;
        const current = await this.profile(client, employeeId, true);
        if (!current) return null;
        const previousValue = this.encryptor.decrypt<Record<string, string>>({
          ...current,
          authTag: current.auth_tag,
          keyId: current.key_id,
        });
        const encrypted = this.encryptor.encrypt(input.profile);
        const changed = Array.from(
          new Set([...Object.keys(previousValue), ...Object.keys(input.profile)]),
        )
          .filter((key) => previousValue[key] !== input.profile[key])
          .sort();
        await client.query(
          `INSERT INTO employee_profile_revisions (employee_profile_id,actor_user_id,idempotency_key,ciphertext,iv,auth_tag,key_id,changed_field_names,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            employeeId,
            actor,
            input.idempotencyKey,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.authTag,
            encrypted.keyId,
            JSON.stringify(changed),
            input.reason,
          ],
        );
        const updated = await client.query<ProfileRow>(
          'UPDATE employee_profiles SET ciphertext=$2,iv=$3,auth_tag=$4,key_id=$5,updated_at=now() WHERE id=$1 RETURNING id,employee_number,employment_status,start_date,end_date,ciphertext,iv,auth_tag,key_id',
          [employeeId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyId],
        );
        const employee = this.employee(updated.rows[0]!);
        await this.storeCommand(
          client,
          actor,
          'employee_profile_replaced',
          input.idempotencyKey,
          'employee_profile',
          employeeId,
          employee,
        );
        await this.audit(
          client,
          actor,
          'employee.profile_replaced',
          'employee_profile',
          employeeId,
          correlationId,
          { changedFieldNames: changed, reason: input.reason },
        );
        return employee;
      },
    );
  }

  async deactivate(
    subject: string,
    employeeId: string,
    input: z.infer<typeof employeeLifecycleSchema>,
    correlationId: string,
  ) {
    return this.lifecycle(subject, employeeId, input, correlationId, 'deactivated', 'inactive');
  }
  async reactivate(
    subject: string,
    employeeId: string,
    input: z.infer<typeof employeeLifecycleSchema>,
    correlationId: string,
  ) {
    return this.lifecycle(subject, employeeId, input, correlationId, 'reactivated', 'active');
  }

  async createAssignment(
    subject: string,
    input: z.infer<typeof createEmployeeAssignmentSchema>,
    correlationId: string,
  ) {
    return this.transaction(
      subject,
      input.idempotencyKey,
      'employee_assignment_created',
      async (client, actor) => {
        const prior = await this.command<AdminEmployeeAssignment>(
          client,
          actor,
          'employee_assignment_created',
          input.idempotencyKey,
        );
        if (prior) return prior;
        const employee = await client.query(
          "SELECT id FROM employee_profiles WHERE id=$1 AND employment_status='active' AND archived_at IS NULL FOR UPDATE",
          [input.employeeProfileId],
        );
        if (
          !employee.rows[0] ||
          !(await this.validScope(client, input.storeId ?? null, input.departmentId ?? null)) ||
          !(await this.validManager(client, input.managerEmployeeProfileId ?? null))
        )
          return null;
        const from = input.effectiveFrom ?? new Date();
        const to = input.effectiveTo ?? null;
        const overlap = await client.query(
          `SELECT 1 FROM employee_assignments WHERE employee_profile_id=$1 AND store_id IS NOT DISTINCT FROM $2 AND department_id IS NOT DISTINCT FROM $3 AND tstzrange(effective_from,COALESCE(effective_to,'infinity'::timestamptz),'[)') && tstzrange($4,COALESCE($5,'infinity'::timestamptz),'[)')`,
          [input.employeeProfileId, input.storeId ?? null, input.departmentId ?? null, from, to],
        );
        if (overlap.rows[0]) return 'conflict' as const;
        const result = await client.query<AssignmentRow>(
          `INSERT INTO employee_assignments (employee_profile_id,store_id,department_id,manager_employee_profile_id,effective_from,effective_to)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,store_id,department_id,manager_employee_profile_id,effective_from,effective_to`,
          [
            input.employeeProfileId,
            input.storeId ?? null,
            input.departmentId ?? null,
            input.managerEmployeeProfileId ?? null,
            from,
            to,
          ],
        );
        const assignment = mapAssignment(result.rows[0]!);
        await this.storeCommand(
          client,
          actor,
          'employee_assignment_created',
          input.idempotencyKey,
          'employee_assignment',
          assignment.id,
          assignment,
        );
        await this.audit(
          client,
          actor,
          'employee.assignment_created',
          'employee_assignment',
          assignment.id,
          correlationId,
          {
            employeeProfileId: input.employeeProfileId,
            storeId: assignment.storeId,
            departmentId: assignment.departmentId,
            managerEmployeeProfileId: assignment.managerEmployeeProfileId,
          },
        );
        return assignment;
      },
    );
  }

  async endAssignment(
    subject: string,
    assignmentId: string,
    input: z.infer<typeof endEmployeeAssignmentSchema>,
    correlationId: string,
  ) {
    return this.transaction(
      subject,
      input.idempotencyKey,
      'employee_assignment_ended',
      async (client, actor) => {
        const prior = await this.command<{ ended: boolean }>(
          client,
          actor,
          'employee_assignment_ended',
          input.idempotencyKey,
        );
        if (prior) return prior.ended;
        const row = await client.query<AssignmentRow>(
          'SELECT id,store_id,department_id,manager_employee_profile_id,effective_from,effective_to FROM employee_assignments WHERE id=$1 AND effective_to IS NULL FOR UPDATE',
          [assignmentId],
        );
        const assignment = row.rows[0];
        if (!assignment) return null;
        if (input.effectiveTo <= assignment.effective_from) return 'invalid_effective_to' as const;
        await client.query(
          'UPDATE employee_assignments SET effective_to=$2,updated_at=now() WHERE id=$1',
          [assignmentId, input.effectiveTo],
        );
        await this.storeCommand(
          client,
          actor,
          'employee_assignment_ended',
          input.idempotencyKey,
          'employee_assignment',
          assignmentId,
          { ended: true },
        );
        await this.audit(
          client,
          actor,
          'employee.assignment_ended',
          'employee_assignment',
          assignmentId,
          correlationId,
          { effectiveTo: input.effectiveTo.toISOString(), reason: input.reason },
        );
        return true;
      },
    );
  }

  async getForAdmin(employeeId: string): Promise<AdminEmployee | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const row = await this.profile(client, employeeId);
      return row ? this.employee(row) : null;
    } finally {
      await client.end();
    }
  }

  async listManaged(
    subject: string,
    page: z.infer<typeof employeeManagementPageSchema>,
  ): Promise<{ items: AdminEmployee[]; nextOffset: number | null }> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const rows = await client.query<ProfileRow>(
        `WITH manager AS (SELECT ep.id FROM identities i JOIN employee_profiles ep ON ep.user_id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND ep.employment_status='active' AND ep.archived_at IS NULL), scope AS (SELECT store_id,department_id FROM employee_assignments WHERE employee_profile_id IN (SELECT id FROM manager) AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())) SELECT DISTINCT ep.id,ep.employee_number,ep.employment_status,ep.start_date,ep.end_date,ep.ciphertext,ep.iv,ep.auth_tag,ep.key_id FROM employee_profiles ep JOIN employee_assignments ea ON ea.employee_profile_id=ep.id WHERE ep.employment_status='active' AND ep.archived_at IS NULL AND ea.effective_from<=now() AND (ea.effective_to IS NULL OR ea.effective_to>now()) AND (ea.manager_employee_profile_id IN (SELECT id FROM manager) OR EXISTS (SELECT 1 FROM scope s WHERE (s.department_id IS NOT NULL AND s.department_id=ea.department_id) OR (s.store_id IS NOT NULL AND s.store_id=ea.store_id))) ORDER BY ep.employee_number LIMIT $2 OFFSET $3`,
        [subject, page.limit + 1, page.offset],
      );
      const items = rows.rows.slice(0, page.limit).map((row) => this.employee(row));
      return { items, nextOffset: rows.rows.length > page.limit ? page.offset + page.limit : null };
    } finally {
      await client.end();
    }
  }

  private async lifecycle(
    subject: string,
    employeeId: string,
    input: z.infer<typeof employeeLifecycleSchema>,
    correlationId: string,
    eventType: 'deactivated' | 'reactivated',
    status: 'inactive' | 'active',
  ) {
    return this.transaction(
      subject,
      input.idempotencyKey,
      `employee_${eventType}`,
      async (client, actor) => {
        const prior = await this.command<{ changed: boolean }>(
          client,
          actor,
          `employee_${eventType}`,
          input.idempotencyKey,
        );
        if (prior) return prior.changed;
        const current = await this.profile(client, employeeId, true);
        if (!current || current.employment_status === status) return null;
        const at = input.effectiveAt ?? new Date();
        await client.query(
          `UPDATE employee_profiles SET employment_status=$2,end_date=CASE WHEN $2='inactive' THEN $3::date ELSE NULL END,archived_at=CASE WHEN $2='inactive' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,
          [employeeId, status, at],
        );
        if (status === 'inactive')
          await client.query(
            'UPDATE employee_assignments SET effective_to=$2,updated_at=now() WHERE employee_profile_id=$1 AND effective_to IS NULL AND effective_from<$2',
            [employeeId, at],
          );
        await client.query(
          'INSERT INTO employee_lifecycle_events (employee_profile_id,actor_user_id,event_type,effective_at,reason,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)',
          [employeeId, actor, eventType, at, input.reason, input.idempotencyKey],
        );
        await this.storeCommand(
          client,
          actor,
          `employee_${eventType}`,
          input.idempotencyKey,
          'employee_profile',
          employeeId,
          { changed: true },
        );
        await this.audit(
          client,
          actor,
          `employee.${eventType}`,
          'employee_profile',
          employeeId,
          correlationId,
          { effectiveAt: at.toISOString(), reason: input.reason },
        );
        return true;
      },
    );
  }
  private async transaction<T>(
    subject: string,
    key: string,
    action: string,
    work: (client: Client, actor: string) => Promise<T>,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actor = await this.actor(client, subject);
      if (!actor) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await work(client, actor);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async actor(client: Client, subject: string) {
    const result = await client.query<{ id: string }>(
      "SELECT i.user_id id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND u.status='active' AND u.archived_at IS NULL",
      [subject],
    );
    return result.rows[0]?.id ?? null;
  }
  private async profile(client: Client, id: string, lock = false) {
    if (lock) await client.query('SELECT id FROM employee_profiles WHERE id=$1 FOR UPDATE', [id]);
    const result = await client.query<ProfileRow>(
      'SELECT id,employee_number,employment_status,start_date,end_date,ciphertext,iv,auth_tag,key_id FROM employee_profiles WHERE id=$1',
      [id],
    );
    return result.rows[0] ?? null;
  }
  private async validScope(client: Client, storeId: string | null, departmentId: string | null) {
    if (
      storeId &&
      !(
        await client.query('SELECT 1 FROM stores WHERE id=$1 AND deactivated_at IS NULL', [storeId])
      ).rows[0]
    )
      return false;
    if (departmentId) {
      const department = await client.query<{ store_id: string | null }>(
        'SELECT store_id FROM departments WHERE id=$1 AND deactivated_at IS NULL',
        [departmentId],
      );
      if (!department.rows[0] || (storeId && department.rows[0].store_id !== storeId)) return false;
    }
    return true;
  }
  private async validManager(client: Client, id: string | null) {
    return (
      !id ||
      Boolean(
        (
          await client.query(
            "SELECT 1 FROM employee_profiles WHERE id=$1 AND employment_status='active' AND archived_at IS NULL",
            [id],
          )
        ).rows[0],
      )
    );
  }
  private async command<T>(client: Client, actor: string, action: string, key: string) {
    const result = await client.query<{ result: T }>(
      'SELECT result FROM employee_admin_commands WHERE actor_user_id=$1 AND action=$2 AND idempotency_key=$3',
      [actor, action, key],
    );
    return result.rows[0]?.result ?? null;
  }
  private async storeCommand(
    client: Client,
    actor: string,
    action: string,
    key: string,
    targetType: string,
    targetId: string,
    result: unknown,
  ) {
    await client.query(
      'INSERT INTO employee_admin_commands (actor_user_id,action,idempotency_key,target_type,target_id,result) VALUES ($1,$2,$3,$4,$5,$6)',
      [actor, action, key, targetType, targetId, JSON.stringify(result)],
    );
  }
  private async audit(
    client: Client,
    actor: string,
    action: string,
    targetType: string,
    targetId: string,
    correlationId: string,
    afterValue: Record<string, unknown>,
  ) {
    await client.query(
      'INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,after_value) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        actor,
        action,
        targetType,
        targetId,
        z.uuid().safeParse(correlationId).success ? correlationId : randomUUID(),
        afterValue,
      ],
    );
  }
  private employee(row: ProfileRow): AdminEmployee {
    return {
      employeeNumber: row.employee_number,
      employmentStatus: row.employment_status,
      id: row.id,
      startDate: row.start_date,
      endDate: row.end_date,
      value: this.encryptor.decrypt<Record<string, string>>({
        ...row,
        authTag: row.auth_tag,
        keyId: row.key_id,
      }),
    };
  }
}
function mapAssignment(row: AssignmentRow): AdminEmployeeAssignment {
  return {
    id: row.id,
    storeId: row.store_id,
    departmentId: row.department_id,
    managerEmployeeProfileId: row.manager_employee_profile_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}
