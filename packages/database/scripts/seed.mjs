import { config } from 'dotenv';
import { Client } from 'pg';

config({ path: new URL('../../../.env', import.meta.url) });

const databaseUrl = process.env.DATABASE_URL;
const email = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL;
const subject = process.env.BOOTSTRAP_SUPER_ADMIN_AUTH0_SUBJECT;

if (!databaseUrl) throw new Error('DATABASE_URL is required.');
if (process.env.BOOTSTRAP_SUPER_ADMIN !== 'true') {
  throw new Error('Set BOOTSTRAP_SUPER_ADMIN=true to run the privileged bootstrap seed.');
}
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error('BOOTSTRAP_SUPER_ADMIN_EMAIL must be a valid email address.');
}
if (!subject || !subject.startsWith('auth0|')) {
  throw new Error('BOOTSTRAP_SUPER_ADMIN_AUTH0_SUBJECT must be an Auth0 user ID.');
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query('BEGIN');
  const userResult = await client.query(
    `INSERT INTO users (email, status, archived_at)
     VALUES ($1, 'active', NULL)
     ON CONFLICT (email) DO UPDATE SET status = 'active', archived_at = NULL
     RETURNING id`,
    [email],
  );
  const userId = userResult.rows[0]?.id;
  if (!userId) throw new Error('Unable to resolve the bootstrap user.');

  const identity = await client.query(
    `SELECT user_id FROM identities WHERE provider = 'auth0' AND provider_subject = $1`,
    [subject],
  );
  if (identity.rows[0] && identity.rows[0].user_id !== userId) {
    throw new Error('The Auth0 subject is already mapped to a different Core user.');
  }
  if (!identity.rows[0]) {
    await client.query(
      `INSERT INTO identities (user_id, provider, provider_subject) VALUES ($1, 'auth0', $2)`,
      [userId, subject],
    );
  }

  const application = await client.query(
    `INSERT INTO applications (key, name) VALUES ('core-admin', 'Obsidian Core Admin')
     ON CONFLICT (key) DO UPDATE SET deactivated_at = NULL
     RETURNING id`,
  );
  const applicationId = application.rows[0]?.id;
  if (!applicationId) throw new Error('Unable to resolve the Core Admin application.');
  const permissionIds = [];
  for (const permissionDefinition of [
    ['authorization.read', 'Read authorization'],
    ['authorization.manage', 'Manage authorization'],
    ['organization.read', 'Read organization hierarchy'],
  ]) {
    const permission = await client.query(
      `INSERT INTO permissions (key, name) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      permissionDefinition,
    );
    const permissionId = permission.rows[0]?.id;
    if (!permissionId) throw new Error('Unable to resolve a bootstrap permission.');
    permissionIds.push(permissionId);
  }
  const role = await client.query(
    `INSERT INTO roles (application_id, key, name, deactivated_at)
     VALUES ($1, 'super-admin', 'Super Admin', NULL)
     ON CONFLICT (application_id, key) DO UPDATE SET deactivated_at = NULL
     RETURNING id`,
    [applicationId],
  );
  const roleId = role.rows[0]?.id;
  if (!roleId) throw new Error('Unable to resolve the Super Admin role.');

  for (const permissionId of permissionIds) {
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES ($1, $2) ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [roleId, permissionId],
    );
  }
  await client.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, $2
     WHERE NOT EXISTS (
       SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 AND organization_id IS NULL
     )`,
    [userId, roleId],
  );
  await client.query(
    `INSERT INTO application_entitlements (user_id, application_id)
     SELECT $1, $2
     WHERE NOT EXISTS (
       SELECT 1 FROM application_entitlements
       WHERE user_id = $1 AND application_id = $2 AND deactivated_at IS NULL
         AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
     )`,
    [userId, applicationId],
  );
  await client.query(
    `INSERT INTO audit_events (actor_user_id, action, target_type, target_id, after_value)
     VALUES ($1, 'authorization.bootstrap', 'user', $1, $2::jsonb)`,
    [userId, JSON.stringify({ application: 'core-admin', role: 'super-admin' })],
  );
  await client.query('COMMIT');
  console.log('Bootstrap Super Admin access seeded.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
