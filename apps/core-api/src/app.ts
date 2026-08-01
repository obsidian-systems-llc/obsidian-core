import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthenticationGuard, type TokenVerifier } from './authentication.js';
import { createAuthorizationGuard, type Authorizer } from './authorization.js';
import { checkDatabase } from './health.js';
import type { OrganizationRepository } from './organizations.js';
import type { CustomerRepository } from './customers.js';
import type { EmployeeRepository } from './employees.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: JWTPayload;
  }
}

export type BuildAppOptions = {
  databaseUrl?: string;
  authorizer?: Authorizer;
  organizationRepository?: OrganizationRepository;
  customerRepository?: CustomerRepository;
  employeeRepository?: EmployeeRepository;
  verifyToken?: TokenVerifier;
};

export function buildApp({
  databaseUrl,
  authorizer,
  organizationRepository,
  customerRepository,
  employeeRepository,
  verifyToken,
}: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] } });
  app.addHook('onRequest', async (request, reply) => {
    const correlationId = request.headers['x-correlation-id'] ?? randomUUID();
    reply.header('x-correlation-id', correlationId);
    request.log = request.log.child({ correlationId });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    if (!databaseUrl || !(await checkDatabase(databaseUrl)))
      return reply.code(503).send({ status: 'unavailable' });
    return { status: 'ready' };
  });
  if (verifyToken) {
    const authenticate = createAuthenticationGuard(verifyToken);
    app.get('/v1/identity/me', { preHandler: authenticate }, async (request) => ({
      subject: request.auth?.sub,
    }));
    if (authorizer) {
      app.get(
        '/v1/core-admin/authorization/access',
        {
          preHandler: [
            authenticate,
            createAuthorizationGuard(authorizer, {
              applicationKey: 'core-admin',
              permissionKey: 'authorization.read',
            }),
          ],
        },
        async () => ({ status: 'authorized' }),
      );
      if (organizationRepository) {
        app.get(
          '/v1/core-admin/organization-hierarchy',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'core-admin',
                permissionKey: 'organization.read',
              }),
            ],
          },
          async () => organizationRepository.getHierarchy(),
        );
      }
      if (customerRepository) {
        app.get(
          '/v1/customer-portal/profile',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'customer-portal',
                permissionKey: 'customer.profile.read',
              }),
            ],
          },
          async (request, reply) => {
            const profile = await customerRepository.getForSubject(request.auth!.sub!);
            return (
              profile ??
              reply.code(404).send({
                error: {
                  code: 'CUSTOMER_PROFILE_NOT_FOUND',
                  message: 'Customer profile not found.',
                },
              })
            );
          },
        );
      }
      if (employeeRepository) {
        app.get(
          '/v1/employee-portal/profile',
          {
            preHandler: [
              authenticate,
              createAuthorizationGuard(authorizer, {
                applicationKey: 'employee-portal',
                permissionKey: 'employee.profile.read',
              }),
            ],
          },
          async (request, reply) => {
            const profile = await employeeRepository.getForSubject(request.auth!.sub!);
            return (
              profile ??
              reply.code(404).send({
                error: {
                  code: 'EMPLOYEE_PROFILE_NOT_FOUND',
                  message: 'Employee profile not found.',
                },
              })
            );
          },
        );
      }
    }
  }
  return app;
}
