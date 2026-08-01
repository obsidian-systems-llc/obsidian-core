import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthenticationGuard, type TokenVerifier } from './authentication.js';
import { createAuthorizationGuard, type Authorizer } from './authorization.js';
import { checkDatabase } from './health.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: JWTPayload;
  }
}

export type BuildAppOptions = {
  databaseUrl?: string;
  authorizer?: Authorizer;
  verifyToken?: TokenVerifier;
};

export function buildApp({
  databaseUrl,
  authorizer,
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
    }
  }
  return app;
}
