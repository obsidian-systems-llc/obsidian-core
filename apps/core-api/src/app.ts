import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthenticationGuard, type TokenVerifier } from './authentication.js';
import { checkDatabase } from './health.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: JWTPayload;
  }
}

export type BuildAppOptions = {
  databaseUrl?: string;
  verifyToken?: TokenVerifier;
};

export function buildApp({ databaseUrl, verifyToken }: BuildAppOptions = {}): FastifyInstance {
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
    app.get(
      '/v1/identity/me',
      { preHandler: createAuthenticationGuard(verifyToken) },
      async (request) => ({
        subject: request.auth?.sub,
      }),
    );
  }
  return app;
}
