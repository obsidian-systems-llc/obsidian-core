import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

const auth0Schema = z.object({
  AUTH0_DOMAIN: z.string().min(1),
  AUTH0_AUDIENCE: z.string().min(1),
});

export type Auth0Config = { audience: string; issuer: string };

export function loadAuth0Config(source: NodeJS.ProcessEnv = process.env): Auth0Config {
  const config = auth0Schema.parse(source);
  return {
    audience: config.AUTH0_AUDIENCE,
    issuer: `https://${config.AUTH0_DOMAIN.replace(/^https:\/\//, '')}/`,
  };
}

export function createAuth0TokenVerifier(
  config: Auth0Config,
): (token: string) => Promise<JWTPayload> {
  const keys = createRemoteJWKSet(new URL('.well-known/jwks.json', config.issuer));
  return async (token) =>
    (await jwtVerify(token, keys, { issuer: config.issuer, audience: config.audience })).payload;
}
