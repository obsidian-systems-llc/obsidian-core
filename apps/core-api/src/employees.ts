import { Client } from 'pg';
import type { FieldEncryptor } from './encryption.js';

export type EmployeeAssignment = {
  departmentId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  id: string;
  managerEmployeeProfileId: string | null;
  storeId: string | null;
};
export type EmployeeProfile = {
  assignments: EmployeeAssignment[];
  id: string;
  value: Record<string, string>;
};
export type EmployeeRepository = {
  getForSubject(subject: string): Promise<EmployeeProfile | null>;
};
type EncryptedRow = {
  auth_tag: Buffer;
  ciphertext: Buffer;
  id: string;
  iv: Buffer;
  key_id: string;
};
type AssignmentRow = {
  department_id: string | null;
  effective_from: Date;
  effective_to: Date | null;
  id: string;
  manager_employee_profile_id: string | null;
  store_id: string | null;
};

export class PostgresEmployeeRepository implements EmployeeRepository {
  constructor(
    private readonly databaseUrl: string,
    private readonly encryptor: FieldEncryptor,
  ) {}

  async getForSubject(subject: string): Promise<EmployeeProfile | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const profiles = await client.query<EncryptedRow>(
        `SELECT ep.id, ep.ciphertext, ep.iv, ep.auth_tag, ep.key_id
         FROM identities i JOIN employee_profiles ep ON ep.user_id = i.user_id
         WHERE i.provider = 'auth0' AND i.provider_subject = $1
           AND ep.employment_status = 'active' AND ep.archived_at IS NULL`,
        [subject],
      );
      const profile = profiles.rows[0];
      if (!profile) return null;
      const assignments = await client.query<AssignmentRow>(
        `SELECT id, store_id, department_id, manager_employee_profile_id, effective_from, effective_to
         FROM employee_assignments
         WHERE employee_profile_id = $1 AND effective_from <= now()
           AND (effective_to IS NULL OR effective_to > now())
         ORDER BY effective_from DESC`,
        [profile.id],
      );
      return {
        assignments: assignments.rows.map((assignment) => ({
          departmentId: assignment.department_id,
          effectiveFrom: assignment.effective_from,
          effectiveTo: assignment.effective_to,
          id: assignment.id,
          managerEmployeeProfileId: assignment.manager_employee_profile_id,
          storeId: assignment.store_id,
        })),
        id: profile.id,
        value: this.encryptor.decrypt<Record<string, string>>({
          ...profile,
          authTag: profile.auth_tag,
          keyId: profile.key_id,
        }),
      };
    } finally {
      await client.end();
    }
  }
}
