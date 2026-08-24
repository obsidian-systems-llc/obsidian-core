import { Client } from 'pg';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type AuthorizationRequirement = {
  applicationKey: string;
  permissionKey: string;
};

export type AuthorizationDecision = AuthorizationRequirement & {
  allowed: boolean;
  userId?: string;
};

export type Authorizer = {
  authorize(subject: string, requirement: AuthorizationRequirement): Promise<AuthorizationDecision>;
};

type AuthorizationRow = {
  has_entitlement: boolean;
  has_permission: boolean;
  user_id: string | null;
};

export class PostgresAuthorizer implements Authorizer {
  constructor(private readonly databaseUrl: string) {}

  async authorize(
    subject: string,
    requirement: AuthorizationRequirement,
  ): Promise<AuthorizationDecision> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const result = await client.query<AuthorizationRow>(
        `WITH identity_user AS (
           SELECT u.id
           FROM identities i
           JOIN users u ON u.id = i.user_id
           WHERE i.provider_subject = $1
             AND u.status = 'active'
             AND u.archived_at IS NULL
         )
         SELECT
           identity_user.id AS user_id,
           EXISTS (
             SELECT 1
             FROM application_entitlements ae
             JOIN applications a ON a.id = ae.application_id
             WHERE ae.user_id = identity_user.id
               AND a.key = $2
               AND a.deactivated_at IS NULL
               AND ae.deactivated_at IS NULL
               AND ae.effective_from <= now()
               AND (ae.effective_to IS NULL OR ae.effective_to > now())
           ) AS has_entitlement,
           EXISTS (
             SELECT 1
             FROM user_roles ur
             JOIN roles r ON r.id = ur.role_id
             JOIN role_permissions rp ON rp.role_id = r.id
             JOIN permissions p ON p.id = rp.permission_id
             JOIN applications a ON a.key = $2
             WHERE ur.user_id = identity_user.id
               AND p.key = $3
               AND r.deactivated_at IS NULL
               AND (r.application_id IS NULL OR r.application_id = a.id)
               AND ur.effective_from <= now()
               AND (ur.effective_to IS NULL OR ur.effective_to > now())
           ) AS has_permission
         FROM identity_user`,
        [subject, requirement.applicationKey, requirement.permissionKey],
      );
      const row = result.rows[0];
      return {
        ...requirement,
        allowed: Boolean(row?.has_entitlement && row.has_permission),
        ...(row?.user_id ? { userId: row.user_id } : {}),
      };
    } finally {
      await client.end();
    }
  }
}

export function createAuthorizationGuard(
  authorizer: Authorizer,
  requirement: AuthorizationRequirement,
) {
  return async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const subject = request.auth?.sub;
    if (!subject) {
      await reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
      });
      return;
    }

    const decision = await authorizer.authorize(subject, requirement);
    if (!decision.allowed) {
      await reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'You are not authorized to perform this action.' },
      });
    }
  };
}
