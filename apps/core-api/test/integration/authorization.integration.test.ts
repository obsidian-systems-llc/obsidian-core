import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAuthorizer } from '../../src/authorization.js';

config({ path: new URL('../../../../.env', import.meta.url) });

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL authorization repository', () => {
  const userId = randomUUID();
  const applicationId = randomUUID();
  const permissionId = randomUUID();
  const roleId = randomUUID();
  const client = new Client({ connectionString: databaseUrl });
  const subject = `auth0|core-005-${userId}`;
  const requirement = { applicationKey: `core-005-${applicationId}`, permissionKey: 'test.read' };
  const authorizer = new PostgresAuthorizer(databaseUrl!);

  beforeAll(async () => {
    await client.connect();
    await client.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      userId,
      `core-005-${userId}@example.invalid`,
    ]);
    await client.query(
      "INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1, 'auth0', $2)",
      [userId, subject],
    );
    await client.query('INSERT INTO applications (id, key, name) VALUES ($1, $2, $3)', [
      applicationId,
      requirement.applicationKey,
      'CORE-005 Test App',
    ]);
    await client.query('INSERT INTO permissions (id, key, name) VALUES ($1, $2, $3)', [
      permissionId,
      requirement.permissionKey,
      'Test read',
    ]);
    await client.query(
      "INSERT INTO roles (id, application_id, key, name) VALUES ($1, $2, 'test-role', 'Test role')",
      [roleId, applicationId],
    );
    await client.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [
      roleId,
      permissionId,
    ]);
    await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [
      userId,
      roleId,
    ]);
    await client.query(
      'INSERT INTO application_entitlements (user_id, application_id) VALUES ($1, $2)',
      [userId, applicationId],
    );
  });

  afterAll(async () => {
    await client.query('DELETE FROM application_entitlements WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    await client.query('DELETE FROM identities WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM roles WHERE id = $1', [roleId]);
    await client.query('DELETE FROM permissions WHERE id = $1', [permissionId]);
    await client.query('DELETE FROM applications WHERE id = $1', [applicationId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.end();
  });

  it('allows a current user with both an application entitlement and permission', async () => {
    await expect(authorizer.authorize(subject, requirement)).resolves.toMatchObject({
      allowed: true,
      userId,
    });
  });

  it('denies a user without an active entitlement', async () => {
    await client.query('DELETE FROM application_entitlements WHERE user_id = $1', [userId]);
    await expect(authorizer.authorize(subject, requirement)).resolves.toMatchObject({
      allowed: false,
    });
    await client.query(
      'INSERT INTO application_entitlements (user_id, application_id) VALUES ($1, $2)',
      [userId, applicationId],
    );
  });

  it('denies a user without the required permission', async () => {
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
    await expect(authorizer.authorize(subject, requirement)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('denies an unknown Auth0 identity by default', async () => {
    await expect(
      authorizer.authorize('auth0|integration-test-unknown-identity', {
        applicationKey: 'core-admin',
        permissionKey: 'authorization.read',
      }),
    ).resolves.toMatchObject({ allowed: false });
  });
});
