import type { JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type TokenVerifier = (token: string) => Promise<JWTPayload>;

export function createAuthenticationGuard(verifyToken: TokenVerifier) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === 'string' ? authorization.match(/^Bearer (.+)$/i)?.[1] : undefined;

    if (!token) {
      await reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
      });
      return;
    }

    try {
      request.auth = await verifyToken(token);
    } catch {
      await reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
      });
    }
  };
}
