import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';

const idempotency = z.uuid();
const effectiveRange = z
  .object({
    effectiveFrom: z.coerce.date().optional(),
    effectiveTo: z.coerce.date().nullable().optional(),
  })
  .refine(
    (value) =>
      !value.effectiveTo || !value.effectiveFrom || value.effectiveTo > value.effectiveFrom,
    { path: ['effectiveTo'], message: 'effectiveTo must be after effectiveFrom.' },
  );

export const createRoleSchema = z.object({
  applicationKey: z.string().trim().min(1).max(100),
  idempotencyKey: idempotency,
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,98}$/),
  name: z.string().trim().min(2).max(200),
  permissionKeys: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
});
export const replaceRolePermissionsSchema = z.object({
  idempotencyKey: idempotency,
  permissionKeys: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  reason: z.string().trim().min(3).max(500),
});
export const assignRoleSchema = effectiveRange.extend({
  idempotencyKey: idempotency,
  organizationId: z.uuid().nullable().optional(),
  roleId: z.uuid(),
  userId: z.uuid(),
});
export const grantEntitlementSchema = effectiveRange.extend({
  applicationKey: z.string().trim().min(1).max(100),
  idempotencyKey: idempotency,
  userId: z.uuid(),
});
export const revokeAuthorizationSchema = z.object({
  idempotencyKey: idempotency,
  reason: z.string().trim().min(3).max(500),
});

export type AuthorizationAdminRepository = {
  listRoles(): Promise<AuthorizationRole[]>;
  createRole(
    subject: string,
    input: z.infer<typeof createRoleSchema>,
    correlationId: string,
  ): Promise<AuthorizationRole | null>;
  replaceRolePermissions(
    subject: string,
    roleId: string,
    input: z.infer<typeof replaceRolePermissionsSchema>,
    correlationId: string,
  ): Promise<AuthorizationRole | null | 'protected'>;
  assignRole(
    subject: string,
    input: z.infer<typeof assignRoleSchema>,
    correlationId: string,
  ): Promise<AuthorizationAssignment | null | 'self_assignment'>;
  grantEntitlement(
    subject: string,
    input: z.infer<typeof grantEntitlementSchema>,
    correlationId: string,
  ): Promise<AuthorizationEntitlement | null | 'self_assignment'>;
  revokeRoleAssignment(
    subject: string,
    assignmentId: string,
    input: z.infer<typeof revokeAuthorizationSchema>,
    correlationId: string,
  ): Promise<boolean | null | 'self_assignment'>;
  revokeEntitlement(
    subject: string,
    entitlementId: string,
    input: z.infer<typeof revokeAuthorizationSchema>,
    correlationId: string,
  ): Promise<boolean | null | 'self_assignment'>;
};
export type AuthorizationRole = {
  id: string;
  applicationKey: string;
  key: string;
  name: string;
  permissionKeys: string[];
};
export type AuthorizationAssignment = {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  roleId: string;
  userId: string;
};
export type AuthorizationEntitlement = {
  id: string;
  applicationKey: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  userId: string;
};
export class AuthorizationAdministrationError extends Error {}

export class PostgresAuthorizationAdminRepository implements AuthorizationAdminRepository {
  constructor(private readonly databaseUrl: string) {}

  async listRoles(): Promise<AuthorizationRole[]> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const result = await client.query<RoleRow>(
        `${roleSelect} WHERE r.deactivated_at IS NULL ORDER BY a.key,r.key`,
      );
      return rowsToRoles(result.rows);
    } finally {
      await client.end();
    }
  }

  async createRole(
    subject: string,
    input: z.infer<typeof createRoleSchema>,
    correlationId: string,
  ): Promise<AuthorizationRole | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actor = await this.actor(client, subject);
      if (!actor) return this.rollback(client, null);
      const previous = await this.command<RoleResult>(
        client,
        actor,
        'role_created',
        input.idempotencyKey,
      );
      if (previous) return this.rollback(client, previous.role);
      const application = await client.query<{ id: string }>(
        'SELECT id FROM applications WHERE key=$1 AND deactivated_at IS NULL FOR UPDATE',
        [input.applicationKey],
      );
      if (!application.rows[0])
        throw new AuthorizationAdministrationError('Application is unavailable.');
      const permissions = await this.permissions(client, input.permissionKeys);
      const role = await client.query<{ id: string }>(
        `INSERT INTO roles (application_id,key,name) VALUES ($1,$2,$3)
         ON CONFLICT (application_id,key) DO UPDATE SET name=EXCLUDED.name,deactivated_at=NULL RETURNING id`,
        [application.rows[0].id, input.key, input.name],
      );
      const roleId = role.rows[0]?.id;
      if (!roleId) throw new AuthorizationAdministrationError('Role could not be created.');
      await this.replacePermissions(client, roleId, permissions);
      const created = await this.role(client, roleId);
      if (!created) throw new AuthorizationAdministrationError('Role could not be created.');
      await this.storeCommand(
        client,
        actor,
        'role_created',
        input.idempotencyKey,
        'role',
        created.id,
        { role: created },
      );
      await this.audit(
        client,
        actor,
        'authorization.role_created',
        'role',
        created.id,
        correlationId,
        { applicationKey: created.applicationKey, key: created.key },
      );
      await client.query('COMMIT');
      return created;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async replaceRolePermissions(
    subject: string,
    roleId: string,
    input: z.infer<typeof replaceRolePermissionsSchema>,
    correlationId: string,
  ): Promise<AuthorizationRole | null | 'protected'> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actor = await this.actor(client, subject);
      if (!actor) return this.rollback(client, null);
      const command = await this.command<RoleResult>(
        client,
        actor,
        'role_permissions_replaced',
        input.idempotencyKey,
      );
      if (command) return this.rollback(client, command.role);
      const current = await this.role(client, roleId, true);
      if (!current) return this.rollback(client, null);
      if (current.applicationKey === 'core-admin' && current.key === 'super-admin')
        return this.rollback(client, 'protected');
      const permissions = await this.permissions(client, input.permissionKeys);
      await client.query(
        `INSERT INTO authorization_role_permission_revisions (role_id,actor_user_id,idempotency_key,before_permission_keys,after_permission_keys,reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          roleId,
          actor,
          input.idempotencyKey,
          JSON.stringify(current.permissionKeys),
          JSON.stringify(input.permissionKeys.slice().sort()),
          input.reason,
        ],
      );
      await this.replacePermissions(client, roleId, permissions);
      const updated = await this.role(client, roleId);
      if (!updated) throw new AuthorizationAdministrationError('Role could not be updated.');
      await this.storeCommand(
        client,
        actor,
        'role_permissions_replaced',
        input.idempotencyKey,
        'role',
        roleId,
        { role: updated },
      );
      await this.audit(
        client,
        actor,
        'authorization.role_permissions_replaced',
        'role',
        roleId,
        correlationId,
        { reason: input.reason, permissionCount: updated.permissionKeys.length },
      );
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async assignRole(
    subject: string,
    input: z.infer<typeof assignRoleSchema>,
    correlationId: string,
  ): Promise<AuthorizationAssignment | null | 'self_assignment'> {
    return (await this.withAssignment(
      subject,
      input,
      correlationId,
      'role_assigned',
      async (client, actor) => {
        if (actor === input.userId) return 'self_assignment';
        const role = await client.query(
          'SELECT 1 FROM roles WHERE id=$1 AND deactivated_at IS NULL',
          [input.roleId],
        );
        const user = await client.query(
          "SELECT 1 FROM users WHERE id=$1 AND status='active' AND archived_at IS NULL",
          [input.userId],
        );
        if (!role.rows[0] || !user.rows[0]) return null;
        const result = await client.query<AssignmentRow>(
          `INSERT INTO user_roles (user_id,role_id,organization_id,effective_from,effective_to) VALUES ($1,$2,$3,$4,$5) RETURNING id,user_id,role_id,effective_from,effective_to`,
          [
            input.userId,
            input.roleId,
            input.organizationId ?? null,
            input.effectiveFrom ?? new Date(),
            input.effectiveTo ?? null,
          ],
        );
        const assignment = mapAssignment(result.rows[0]!);
        await this.audit(
          client,
          actor,
          'authorization.role_assigned',
          'user_role',
          assignment.id,
          correlationId,
          { roleId: assignment.roleId, userId: assignment.userId },
        );
        return assignment;
      },
    )) as AuthorizationAssignment | null | 'self_assignment';
  }

  async grantEntitlement(
    subject: string,
    input: z.infer<typeof grantEntitlementSchema>,
    correlationId: string,
  ): Promise<AuthorizationEntitlement | null | 'self_assignment'> {
    return (await this.withAssignment(
      subject,
      input,
      correlationId,
      'entitlement_granted',
      async (client, actor) => {
        if (actor === input.userId) return 'self_assignment';
        const application = await client.query<{ id: string }>(
          'SELECT id FROM applications WHERE key=$1 AND deactivated_at IS NULL',
          [input.applicationKey],
        );
        const user = await client.query(
          "SELECT 1 FROM users WHERE id=$1 AND status='active' AND archived_at IS NULL",
          [input.userId],
        );
        if (!application.rows[0] || !user.rows[0]) return null;
        const result = await client.query<EntitlementRow>(
          `INSERT INTO application_entitlements (user_id,application_id,effective_from,effective_to) VALUES ($1,$2,$3,$4) RETURNING id,user_id,effective_from,effective_to`,
          [
            input.userId,
            application.rows[0].id,
            input.effectiveFrom ?? new Date(),
            input.effectiveTo ?? null,
          ],
        );
        const entitlement = {
          ...mapEntitlement(result.rows[0]!),
          applicationKey: input.applicationKey,
        };
        await this.audit(
          client,
          actor,
          'authorization.entitlement_granted',
          'application_entitlement',
          entitlement.id,
          correlationId,
          { applicationKey: input.applicationKey, userId: entitlement.userId },
        );
        return entitlement;
      },
    )) as AuthorizationEntitlement | null | 'self_assignment';
  }

  async revokeRoleAssignment(
    subject: string,
    assignmentId: string,
    input: z.infer<typeof revokeAuthorizationSchema>,
    correlationId: string,
  ): Promise<boolean | null | 'self_assignment'> {
    return this.revoke(
      subject,
      assignmentId,
      input,
      correlationId,
      'role_assignment_revoked',
      'user_roles',
      'user_role',
    );
  }
  async revokeEntitlement(
    subject: string,
    entitlementId: string,
    input: z.infer<typeof revokeAuthorizationSchema>,
    correlationId: string,
  ): Promise<boolean | null | 'self_assignment'> {
    return this.revoke(
      subject,
      entitlementId,
      input,
      correlationId,
      'entitlement_revoked',
      'application_entitlements',
      'application_entitlement',
    );
  }

  private async withAssignment<T extends { idempotencyKey: string }>(
    subject: string,
    input: T,
    correlationId: string,
    action: string,
    work: (
      client: Client,
      actor: string,
    ) => Promise<AuthorizationAssignment | AuthorizationEntitlement | null | 'self_assignment'>,
  ): Promise<AuthorizationAssignment | AuthorizationEntitlement | null | 'self_assignment'> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actor = await this.actor(client, subject);
      if (!actor) return this.rollback(client, null);
      const prior = await this.command<AuthorizationAssignment | AuthorizationEntitlement>(
        client,
        actor,
        action,
        input.idempotencyKey,
      );
      if (prior) return this.rollback(client, prior);
      const result = await work(client, actor);
      if (!result || result === 'self_assignment') return this.rollback(client, result);
      await this.storeCommand(
        client,
        actor,
        action,
        input.idempotencyKey,
        action,
        result.id,
        result,
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async revoke(
    subject: string,
    id: string,
    input: z.infer<typeof revokeAuthorizationSchema>,
    correlationId: string,
    action: string,
    table: 'user_roles' | 'application_entitlements',
    targetType: string,
  ): Promise<boolean | null | 'self_assignment'> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actor = await this.actor(client, subject);
      if (!actor) return this.rollback(client, null);
      const prior = await this.command<{ revoked: boolean }>(
        client,
        actor,
        action,
        input.idempotencyKey,
      );
      if (prior) return this.rollback(client, prior.revoked);
      const row = await client.query<{ user_id: string }>(
        `SELECT user_id FROM ${table} WHERE id=$1 AND effective_to IS NULL FOR UPDATE`,
        [id],
      );
      if (!row.rows[0]) return this.rollback(client, false);
      if (row.rows[0].user_id === actor) return this.rollback(client, 'self_assignment');
      const result = await client.query(
        `UPDATE ${table} SET effective_to=now(),updated_at=now() WHERE id=$1 AND effective_to IS NULL`,
        [id],
      );
      if (!result.rowCount) return this.rollback(client, false);
      await this.storeCommand(client, actor, action, input.idempotencyKey, targetType, id, {
        revoked: true,
      });
      await this.audit(client, actor, `authorization.${action}`, targetType, id, correlationId, {
        reason: input.reason,
      });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async actor(client: Client, subject: string) {
    const r = await client.query<{ id: string }>(
      "SELECT i.user_id id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND u.status='active' AND u.archived_at IS NULL",
      [subject],
    );
    return r.rows[0]?.id ?? null;
  }
  private async permissions(client: Client, keys: string[]) {
    const unique = Array.from(new Set(keys)).sort();
    const r = await client.query<{ id: string; key: string }>(
      'SELECT id,key FROM permissions WHERE key=ANY($1::text[])',
      [unique],
    );
    if (r.rows.length !== unique.length)
      throw new AuthorizationAdministrationError('One or more permissions are unavailable.');
    return r.rows;
  }
  private async replacePermissions(
    client: Client,
    roleId: string,
    permissions: Array<{ id: string }>,
  ) {
    await client.query('DELETE FROM role_permissions WHERE role_id=$1', [roleId]);
    for (const permission of permissions)
      await client.query('INSERT INTO role_permissions (role_id,permission_id) VALUES ($1,$2)', [
        roleId,
        permission.id,
      ]);
  }
  private async role(client: Client, id: string, lock = false) {
    if (lock) await client.query('SELECT id FROM roles WHERE id=$1 FOR UPDATE', [id]);
    const r = await client.query<RoleRow>(`${roleSelect} WHERE r.id=$1`, [id]);
    return rowsToRoles(r.rows)[0] ?? null;
  }
  private async command<T>(client: Client, actor: string, action: string, key: string) {
    const r = await client.query<{ result: T }>(
      'SELECT result FROM authorization_commands WHERE actor_user_id=$1 AND action=$2 AND idempotency_key=$3',
      [actor, action, key],
    );
    return r.rows[0]?.result ?? null;
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
      'INSERT INTO authorization_commands (actor_user_id,action,idempotency_key,target_type,target_id,result) VALUES ($1,$2,$3,$4,$5,$6)',
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
  private async rollback<T>(client: Client, value: T): Promise<T> {
    await client.query('ROLLBACK');
    return value;
  }
}

type RoleRow = {
  id: string;
  application_key: string;
  key: string;
  name: string;
  permission_key: string | null;
};
type AssignmentRow = {
  id: string;
  user_id: string;
  role_id: string;
  effective_from: Date;
  effective_to: Date | null;
};
type EntitlementRow = {
  id: string;
  user_id: string;
  effective_from: Date;
  effective_to: Date | null;
};
type RoleResult = { role: AuthorizationRole };
const roleSelect = `SELECT r.id,a.key application_key,r.key,r.name,p.key permission_key FROM roles r JOIN applications a ON a.id=r.application_id LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id`;
function rowsToRoles(rows: RoleRow[]): AuthorizationRole[] {
  const roles = new Map<string, AuthorizationRole>();
  for (const row of rows) {
    const role = roles.get(row.id) ?? {
      id: row.id,
      applicationKey: row.application_key,
      key: row.key,
      name: row.name,
      permissionKeys: [],
    };
    if (row.permission_key) role.permissionKeys.push(row.permission_key);
    roles.set(row.id, role);
  }
  return [...roles.values()].map((role) => ({
    ...role,
    permissionKeys: role.permissionKeys.sort(),
  }));
}
function mapAssignment(row: AssignmentRow): AuthorizationAssignment {
  return {
    id: row.id,
    userId: row.user_id,
    roleId: row.role_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}
function mapEntitlement(row: EntitlementRow): Omit<AuthorizationEntitlement, 'applicationKey'> {
  return {
    id: row.id,
    userId: row.user_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}
