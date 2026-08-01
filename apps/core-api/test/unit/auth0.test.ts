import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuth0TokenVerifier, loadAuth0Config } from '../../src/auth0.js';

const config = loadAuth0Config({
  AUTH0_DOMAIN: 'tenant.example.auth0.com',
  AUTH0_AUDIENCE: 'https://api.obsidian-systems.tech',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Auth0 token verifier', () => {
  it('verifies an RS256 token against the provider JWKS, issuer, and audience', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = 'RS256';
    publicJwk.kid = 'test-signing-key';
    publicJwk.use = 'sig';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [publicJwk] }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const token = await new SignJWT({ scope: 'read:identity' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject('auth0|user-123')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(createAuth0TokenVerifier(config)(token)).resolves.toMatchObject({
      sub: 'auth0|user-123',
    });
  });

  it('rejects a token for a different audience', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = 'RS256';
    publicJwk.kid = 'test-signing-key';
    publicJwk.use = 'sig';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ keys: [publicJwk] })));
    const token = await new SignJWT()
      .setProtectedHeader({ alg: 'RS256', kid: 'test-signing-key' })
      .setIssuer(config.issuer)
      .setAudience('https://wrong.example')
      .setSubject('auth0|user-123')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(createAuth0TokenVerifier(config)(token)).rejects.toThrow('unexpected "aud"');
  });
});
