import {
  argon2,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { createAuditEvent } from './audit.js';
import type { FieldEncryptor } from './encryption.js';
import { customerPortalPermissionDefinitions } from './customers.js';
import {
  EmailProviderError,
  ResendTransactionalEmailProvider,
  type ResendEmailConfiguration,
  type TransactionalEmailProvider,
} from './customer-email.js';

const argon2Async = promisify(argon2);
const passwordSchema = z
  .string()
  .min(12)
  .max(1024)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 1024, 'Password is too long.');
const profileSchema = z.record(z.string(), z.string().trim().min(1).max(500));
const idempotencyKey = z.uuid();
const smsPhoneSchema = z.string().trim().regex(/^\+[1-9]\d{7,14}$/);

export const coreCustomerRegistrationSchema = z
  .object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  password: passwordSchema,
  profile: profileSchema,
  smsConsent: z.boolean().default(false),
  smsPhoneNumber: smsPhoneSchema.optional(),
  idempotencyKey,
  })
  .superRefine((value, context) => {
    if (value.smsConsent && !value.smsPhoneNumber)
      context.addIssue({
        code: 'custom',
        path: ['smsPhoneNumber'],
        message: 'An E.164 mobile number is required for SMS consent.',
      });
  });
export const coreWorkforceRegistrationSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  password: passwordSchema,
  invitationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  idempotencyKey,
});
export const coreLegacyLinkSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  password: passwordSchema,
});
export const coreLoginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  password: passwordSchema,
});
export const coreTokenSchema = z.object({ token: z.string().min(32).max(512) });
export const corePasswordResetConfirmSchema = z.object({
  token: z.string().min(32).max(512),
  password: passwordSchema,
});
export const corePasswordResetRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
});
export const coreMfaVerificationSchema = z.object({
  code: z.string().trim().min(6).max(64),
});
export const coreSessionRevokeSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export function createTotpCode(seed: Buffer, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', seed).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const value =
    ((digest[offset]! & 127) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(value % 1_000_000).padStart(6, '0');
}

function base32Encode(value: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits ? `${encoded}${alphabet[(buffer << (5 - bits)) & 31]}` : encoded;
}

export type CoreIdentityConfiguration = {
  audience: string;
  issuer: string;
  signingSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  emailVerificationUrl: string;
  passwordResetUrl: string;
};
export type CoreIdentityTokens = { accessToken: string; refreshToken: string; expiresIn: number };
export type CoreIdentityRepository = {
  registerCustomer(
    input: z.infer<typeof coreCustomerRegistrationSchema>,
    correlationId: string,
  ): Promise<'email_exists' | { profileId: string; verificationRequired: true }>;
  registerWorkforce(
    input: z.infer<typeof coreWorkforceRegistrationSchema>,
    correlationId: string,
  ): Promise<'email_exists' | { verificationRequired: true }>;
  linkLegacyIdentity(
    legacySubject: string,
    input: z.infer<typeof coreLegacyLinkSchema>,
    correlationId: string,
  ): Promise<'identity_not_found' | 'email_mismatch' | 'already_linked' | CoreIdentityTokens>;
  login(
    input: z.infer<typeof coreLoginSchema>,
    correlationId: string,
  ): Promise<'invalid_credentials' | 'email_verification_required' | CoreIdentityTokens>;
  refresh(
    refreshToken: string,
    correlationId: string,
  ): Promise<'invalid_session' | CoreIdentityTokens>;
  logout(refreshToken: string, correlationId: string): Promise<void>;
  listSessions(subject: string): Promise<'identity_not_found' | CoreIdentitySession[]>;
  revokeSession(
    subject: string,
    sessionId: string,
    reason: string,
    correlationId: string,
  ): Promise<'identity_not_found' | 'session_not_found' | true>;
  confirmEmail(token: string, correlationId: string): Promise<'invalid_token' | true>;
  requestPasswordReset(email: string, correlationId: string): Promise<void>;
  confirmPasswordReset(
    input: z.infer<typeof corePasswordResetConfirmSchema>,
    correlationId: string,
  ): Promise<'invalid_token' | true>;
  beginMfaEnrollment(
    subject: string,
    correlationId: string,
  ): Promise<
    'identity_not_found' | { factorId: string; otpauthUri: string; recoveryCodes: string[] }
  >;
  confirmMfaEnrollment(
    subject: string,
    input: z.infer<typeof coreMfaVerificationSchema>,
    correlationId: string,
  ): Promise<'identity_not_found' | 'invalid_code' | true>;
  stepUp(
    subject: string,
    input: z.infer<typeof coreMfaVerificationSchema>,
    correlationId: string,
  ): Promise<
    | 'identity_not_found'
    | 'mfa_not_enrolled'
    | 'invalid_code'
    | { accessToken: string; expiresIn: number }
  >;
};
export type CoreIdentitySession = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  authenticationMethods: string[];
};

const hashToken = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const newSecret = () => randomBytes(32).toString('base64url');
async function rollback<T>(client: Client, value: T): Promise<T> {
  await client.query('ROLLBACK');
  return value;
}

export function loadCoreIdentityConfiguration(
  source: NodeJS.ProcessEnv = process.env,
): CoreIdentityConfiguration | null {
  if (source.CORE_IDENTITY_ENABLED !== 'true') return null;
  const schema = z.object({
    CORE_IDENTITY_ISSUER: z.string().url(),
    CORE_IDENTITY_AUDIENCE: z.string().url(),
    CORE_IDENTITY_SIGNING_SECRET: z.string().min(43).max(512),
    CORE_IDENTITY_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(900),
    CORE_IDENTITY_REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .max(7_776_000)
      .default(2_592_000),
    CORE_IDENTITY_EMAIL_VERIFICATION_URL: z.string().url(),
    CORE_IDENTITY_PASSWORD_RESET_URL: z.string().url(),
  });
  const result = schema.safeParse(source);
  if (!result.success)
    throw new Error(`Invalid Core identity configuration: ${z.prettifyError(result.error)}`);
  return {
    issuer: result.data.CORE_IDENTITY_ISSUER,
    audience: result.data.CORE_IDENTITY_AUDIENCE,
    signingSecret: result.data.CORE_IDENTITY_SIGNING_SECRET,
    accessTokenTtlSeconds: result.data.CORE_IDENTITY_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: result.data.CORE_IDENTITY_REFRESH_TOKEN_TTL_SECONDS,
    emailVerificationUrl: result.data.CORE_IDENTITY_EMAIL_VERIFICATION_URL,
    passwordResetUrl: result.data.CORE_IDENTITY_PASSWORD_RESET_URL,
  };
}

export function createCoreIdentityTokenVerifier(configuration: CoreIdentityConfiguration) {
  const key = new TextEncoder().encode(configuration.signingSecret);
  return async (token: string): Promise<JWTPayload> =>
    (
      await jwtVerify(token, key, {
        issuer: configuration.issuer,
        audience: configuration.audience,
      })
    ).payload;
}

export function createCompositeTokenVerifier(
  ...verifiers: Array<((token: string) => Promise<JWTPayload>) | undefined>
) {
  const active = verifiers.filter((verifier): verifier is (token: string) => Promise<JWTPayload> =>
    Boolean(verifier),
  );
  return async (token: string) => {
    let failure: unknown;
    for (const verifier of active) {
      try {
        return await verifier(token);
      } catch (error) {
        failure = error;
      }
    }
    throw failure ?? new Error('No identity token verifier is configured.');
  };
}

export class PostgresCoreIdentityRepository implements CoreIdentityRepository {
  constructor(
    private readonly databaseUrl: string,
    private readonly encryptor: FieldEncryptor,
    private readonly configuration: CoreIdentityConfiguration,
  ) {}

  async registerCustomer(
    input: z.infer<typeof coreCustomerRegistrationSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const duplicate = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email)=lower($1) FOR UPDATE',
        [input.email],
      );
      if (duplicate.rows[0]) {
        await client.query('ROLLBACK');
        return 'email_exists' as const;
      }
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id",
        [input.email],
      );
      const userId = user.rows[0]!.id;
      const subject = `core|${userId}`;
      await client.query(
        "INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,'core',$2)",
        [userId, subject],
      );
      await this.savePassword(client, userId, input.password);
      const encrypted = this.encryptor.encrypt(input.profile);
      const profile = await client.query<{ id: string }>(
        'INSERT INTO customer_profiles (ciphertext,iv,auth_tag,key_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyId],
      );
      await client.query(
        'INSERT INTO customer_profile_memberships (customer_profile_id,user_id) VALUES ($1,$2)',
        [profile.rows[0]!.id, userId],
      );
      if (input.smsConsent) {
        const phone = this.encryptor.encrypt({ phoneNumber: input.smsPhoneNumber! });
        await client.query(
          `INSERT INTO customer_sms_consents
            (customer_profile_id,user_id,status,source,consent_text_version,ciphertext,iv,auth_tag,key_id)
           VALUES ($1,$2,'opted_in','customer_registration','v1',$3,$4,$5,$6)`,
          [
            profile.rows[0]!.id,
            userId,
            phone.ciphertext,
            phone.iv,
            phone.authTag,
            phone.keyId,
          ],
        );
      }
      await this.ensurePortalAccess(client, userId);
      await this.issueOneTimeToken(client, userId, input.email, 'email_verification');
      await this.audit(
        client,
        userId,
        'identity.customer_registered',
        'customer',
        profile.rows[0]!.id,
        correlationId,
        { profileFields: Object.keys(input.profile).sort(), smsConsent: input.smsConsent },
      );
      await client.query('COMMIT');
      return { profileId: profile.rows[0]!.id, verificationRequired: true as const };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async registerWorkforce(
    input: z.infer<typeof coreWorkforceRegistrationSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const duplicate = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email)=lower($1) FOR UPDATE',
        [input.email],
      );
      if (duplicate.rows[0]) return await rollback(client, 'email_exists' as const);
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (email,status) VALUES ($1,'active') RETURNING id",
        [input.email],
      );
      const userId = user.rows[0]!.id;
      await client.query(
        "INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,'core',$2)",
        [userId, `core|${userId}`],
      );
      await this.savePassword(client, userId, input.password);
      await this.issueOneTimeToken(client, userId, input.email, 'email_verification');
      await this.audit(
        client,
        userId,
        'identity.workforce_registered',
        'account_invitation',
        null,
        correlationId,
        {},
      );
      await client.query('COMMIT');
      return { verificationRequired: true as const };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async linkLegacyIdentity(
    legacySubject: string,
    input: z.infer<typeof coreLegacyLinkSchema>,
    correlationId: string,
  ) {
    if (legacySubject.startsWith('core|')) return 'already_linked' as const;
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const identity = await client.query<{ user_id: string; email: string }>(
        `SELECT i.user_id,u.email FROM identities i JOIN users u ON u.id=i.user_id
         WHERE i.provider_subject=$1 AND i.provider<>'core' AND u.status='active' AND u.archived_at IS NULL FOR UPDATE`,
        [legacySubject],
      );
      const current = identity.rows[0];
      if (!current) return await rollback(client, 'identity_not_found' as const);
      if (current.email.toLowerCase() !== input.email)
        return await rollback(client, 'email_mismatch' as const);
      const existingCore = await client.query<{ user_id: string }>(
        "SELECT user_id FROM identities WHERE provider='core' AND user_id=$1 FOR UPDATE",
        [current.user_id],
      );
      if (existingCore.rows[0]) return await rollback(client, 'already_linked' as const);
      await client.query(
        "INSERT INTO identities (user_id,provider,provider_subject) VALUES ($1,'core',$2)",
        [current.user_id, `core|${current.user_id}`],
      );
      await this.savePassword(client, current.user_id, input.password);
      await client.query(
        'UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=$1',
        [current.user_id],
      );
      const tokens = await this.createSession(client, current.user_id, ['legacy_link', 'pwd']);
      await this.audit(
        client,
        current.user_id,
        'identity.legacy_linked',
        'user',
        current.user_id,
        correlationId,
        {},
      );
      await client.query('COMMIT');
      return tokens;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async login(input: z.infer<typeof coreLoginSchema>, correlationId: string) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const row = await client.query<CredentialRow>(
        `SELECT u.id,u.email,u.email_verified_at,c.password_hash,c.password_salt,c.memory_kib,c.iterations,c.parallelism,c.failed_attempts,c.locked_until FROM users u JOIN core_identity_password_credentials c ON c.user_id=u.id WHERE lower(u.email)=lower($1) AND u.status='active' AND u.archived_at IS NULL FOR UPDATE`,
        [input.email],
      );
      const account = row.rows[0];
      if (
        !account ||
        (account.locked_until && account.locked_until > new Date()) ||
        !(await this.passwordMatches(input.password, account))
      ) {
        if (account)
          await client.query(
            "UPDATE core_identity_password_credentials SET failed_attempts=failed_attempts+1,locked_until=CASE WHEN failed_attempts+1>=10 THEN now()+interval '15 minutes' ELSE locked_until END,updated_at=now() WHERE user_id=$1",
            [account.id],
          );
        await client.query('COMMIT');
        return 'invalid_credentials' as const;
      }
      await client.query(
        'UPDATE core_identity_password_credentials SET failed_attempts=0,locked_until=NULL,updated_at=now() WHERE user_id=$1',
        [account.id],
      );
      if (!account.email_verified_at) {
        await client.query('COMMIT');
        return 'email_verification_required' as const;
      }
      const tokens = await this.createSession(client, account.id, ['pwd']);
      await this.audit(
        client,
        account.id,
        'identity.login_succeeded',
        'session',
        null,
        correlationId,
        { method: 'password' },
      );
      await client.query('COMMIT');
      return tokens;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async refresh(refreshToken: string, correlationId: string) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const session = await client.query<{
        id: string;
        user_id: string;
        family_id: string;
        authentication_methods: string[];
      }>(
        "SELECT id,user_id,family_id,authentication_methods FROM sessions WHERE token_hash=encode($1::bytea,'hex') AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
        [hashToken(refreshToken)],
      );
      const active = session.rows[0];
      if (!active) {
        await client.query('ROLLBACK');
        return 'invalid_session' as const;
      }
      await client.query(
        "UPDATE sessions SET revoked_at=now(),revoked_reason='rotated',last_used_at=now(),updated_at=now() WHERE id=$1",
        [active.id],
      );
      const tokens = await this.createSession(
        client,
        active.user_id,
        active.authentication_methods,
        active.family_id,
        active.id,
      );
      await this.audit(
        client,
        active.user_id,
        'identity.session_refreshed',
        'session',
        active.id,
        correlationId,
        {},
      );
      await client.query('COMMIT');
      return tokens;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async logout(refreshToken: string, correlationId: string) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const session = await client.query<{ id: string; user_id: string }>(
        "UPDATE sessions SET revoked_at=now(),revoked_reason='logout',updated_at=now() WHERE token_hash=encode($1::bytea,'hex') AND revoked_at IS NULL RETURNING id,user_id",
        [hashToken(refreshToken)],
      );
      if (session.rows[0])
        await this.audit(
          client,
          session.rows[0].user_id,
          'identity.logout',
          'session',
          session.rows[0].id,
          correlationId,
          {},
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async listSessions(subject: string) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const userId = await this.coreUserId(client, subject);
      if (!userId) return 'identity_not_found' as const;
      const result = await client.query<{
        id: string;
        created_at: Date;
        expires_at: Date;
        last_used_at: Date | null;
        authentication_methods: string[];
      }>(
        'SELECT id,created_at,expires_at,last_used_at,authentication_methods FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC',
        [userId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        authenticationMethods: row.authentication_methods,
      }));
    } finally {
      await client.end();
    }
  }

  async revokeSession(subject: string, sessionId: string, reason: string, correlationId: string) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const userId = await this.coreUserId(client, subject, true);
      if (!userId) return await rollback(client, 'identity_not_found' as const);
      const result = await client.query<{ id: string }>(
        "UPDATE sessions SET revoked_at=now(),revoked_reason='user_revoked',updated_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id",
        [sessionId, userId],
      );
      if (!result.rows[0]) return await rollback(client, 'session_not_found' as const);
      await this.audit(
        client,
        userId,
        'identity.session_revoked',
        'session',
        sessionId,
        correlationId,
        { reason },
      );
      await client.query('COMMIT');
      return true as const;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async confirmEmail(token: string, correlationId: string) {
    return this.consumeToken(token, 'email_verification', correlationId, async (client, userId) => {
      await client.query(
        'UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=$1',
        [userId],
      );
      await this.audit(
        client,
        userId,
        'identity.email_verified',
        'user',
        userId,
        correlationId,
        {},
      );
    });
  }
  async requestPasswordReset(email: string, correlationId: string) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const user = await client.query<{ id: string; email: string }>(
        "SELECT id,email FROM users WHERE lower(email)=lower($1) AND status='active' AND archived_at IS NULL",
        [email],
      );
      if (user.rows[0]) {
        await this.issueOneTimeToken(client, user.rows[0].id, user.rows[0].email, 'password_reset');
        await this.audit(
          client,
          user.rows[0].id,
          'identity.password_reset_requested',
          'user',
          user.rows[0].id,
          correlationId,
          {},
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  async confirmPasswordReset(
    input: z.infer<typeof corePasswordResetConfirmSchema>,
    correlationId: string,
  ) {
    return this.consumeToken(
      input.token,
      'password_reset',
      correlationId,
      async (client, userId) => {
        await this.savePassword(client, userId, input.password);
        await client.query(
          "UPDATE sessions SET revoked_at=now(),revoked_reason='password_reset',updated_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
          [userId],
        );
        await this.audit(
          client,
          userId,
          'identity.password_reset_completed',
          'user',
          userId,
          correlationId,
          {},
        );
      },
    );
  }

  async beginMfaEnrollment(subject: string, correlationId: string) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const userId = await this.coreUserId(client, subject, true);
      if (!userId) return await rollback(client, 'identity_not_found' as const);
      const seed = randomBytes(20);
      const encrypted = this.encryptor.encrypt(seed.toString('base64'));
      const factor = await client.query<{ id: string }>(
        `INSERT INTO core_identity_mfa_factors (user_id,factor_type,ciphertext,iv,auth_tag,key_id,verified_at,deactivated_at,updated_at)
         VALUES ($1,'totp',$2,$3,$4,$5,NULL,NULL,now())
         ON CONFLICT (user_id,factor_type) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,key_id=EXCLUDED.key_id,verified_at=NULL,deactivated_at=NULL,updated_at=now()
         RETURNING id`,
        [userId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyId],
      );
      const factorId = factor.rows[0]!.id;
      await client.query('DELETE FROM core_identity_mfa_recovery_codes WHERE factor_id=$1', [
        factorId,
      ]);
      const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(8).toString('hex'));
      for (const code of recoveryCodes)
        await client.query(
          'INSERT INTO core_identity_mfa_recovery_codes (factor_id,code_hash) VALUES ($1,$2)',
          [factorId, hashToken(code)],
        );
      await this.audit(
        client,
        userId,
        'identity.mfa_enrollment_started',
        'mfa_factor',
        factorId,
        correlationId,
        {},
      );
      await client.query('COMMIT');
      return {
        factorId,
        otpauthUri: `otpauth://totp/${encodeURIComponent(`Obsidian Systems:${subject}`)}?secret=${base32Encode(seed)}&issuer=${encodeURIComponent('Obsidian Systems')}&algorithm=SHA1&digits=6&period=30`,
        recoveryCodes,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async confirmMfaEnrollment(
    subject: string,
    input: z.infer<typeof coreMfaVerificationSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const userId = await this.coreUserId(client, subject, true);
      if (!userId) return await rollback(client, 'identity_not_found' as const);
      const factor = await this.activeFactor(client, userId, false);
      if (!factor || !this.verifyTotp(factor, input.code))
        return await rollback(client, 'invalid_code' as const);
      await client.query(
        'UPDATE core_identity_mfa_factors SET verified_at=now(),updated_at=now() WHERE id=$1',
        [factor.id],
      );
      await this.audit(
        client,
        userId,
        'identity.mfa_enrollment_verified',
        'mfa_factor',
        factor.id,
        correlationId,
        {},
      );
      await client.query('COMMIT');
      return true as const;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async stepUp(
    subject: string,
    input: z.infer<typeof coreMfaVerificationSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const userId = await this.coreUserId(client, subject, true);
      if (!userId) return await rollback(client, 'identity_not_found' as const);
      const factor = await this.activeFactor(client, userId, true);
      if (!factor) return await rollback(client, 'mfa_not_enrolled' as const);
      const matchedTotp = this.verifyTotp(factor, input.code);
      const matchedRecovery = matchedTotp
        ? false
        : await this.consumeRecoveryCode(client, factor.id, input.code);
      if (!matchedTotp && !matchedRecovery) return await rollback(client, 'invalid_code' as const);
      const token = await this.createAccessToken(userId, ['pwd', 'mfa'], 300);
      await this.audit(client, userId, 'identity.mfa_step_up', 'session', null, correlationId, {
        recoveryCode: matchedRecovery,
      });
      await client.query('COMMIT');
      return token;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  private async consumeToken(
    token: string,
    purpose: 'email_verification' | 'password_reset',
    correlationId: string,
    action: (client: Client, userId: string) => Promise<void>,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const row = await client.query<{ id: string; user_id: string }>(
        'SELECT id,user_id FROM core_identity_one_time_tokens WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
        [hashToken(token), purpose],
      );
      if (!row.rows[0]) {
        await client.query('ROLLBACK');
        return 'invalid_token' as const;
      }
      await client.query('UPDATE core_identity_one_time_tokens SET consumed_at=now() WHERE id=$1', [
        row.rows[0].id,
      ]);
      await action(client, row.rows[0].user_id);
      await client.query('COMMIT');
      return true as const;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async savePassword(client: Client, userId: string, password: string) {
    const salt = randomBytes(16);
    const hash = (await argon2Async('argon2id', {
      message: Buffer.from(password),
      nonce: salt,
      parallelism: 1,
      tagLength: 32,
      memory: 19 * 1024,
      passes: 2,
    })) as Buffer;
    await client.query(
      `INSERT INTO core_identity_password_credentials (user_id,password_hash,password_salt,memory_kib,iterations,parallelism,password_changed_at,failed_attempts,locked_until,updated_at) VALUES ($1,$2,$3,$4,$5,$6,now(),0,NULL,now()) ON CONFLICT (user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,password_salt=EXCLUDED.password_salt,memory_kib=EXCLUDED.memory_kib,iterations=EXCLUDED.iterations,parallelism=EXCLUDED.parallelism,password_changed_at=now(),failed_attempts=0,locked_until=NULL,updated_at=now()`,
      [userId, hash, salt, 19 * 1024, 2, 1],
    );
  }
  private async passwordMatches(password: string, row: CredentialRow) {
    const candidate = (await argon2Async('argon2id', {
      message: Buffer.from(password),
      nonce: row.password_salt,
      parallelism: row.parallelism,
      tagLength: row.password_hash.length,
      memory: row.memory_kib,
      passes: row.iterations,
    })) as Buffer;
    return (
      candidate.length === row.password_hash.length && timingSafeEqual(candidate, row.password_hash)
    );
  }
  private async createSession(
    client: Client,
    userId: string,
    methods: string[],
    familyId: string = randomUUID(),
    replacedSessionId?: string,
  ): Promise<CoreIdentityTokens> {
    const refreshToken = newSecret();
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO sessions (user_id,token_hash,expires_at,family_id,replaced_by_session_id,authentication_methods,last_used_at) VALUES ($1,encode($2::bytea,'hex'),now()+($3::text || ' seconds')::interval,$4,NULL,$5,now()) RETURNING id",
      [
        userId,
        hashToken(refreshToken),
        String(this.configuration.refreshTokenTtlSeconds),
        familyId,
        methods,
      ],
    );
    if (replacedSessionId)
      await client.query('UPDATE sessions SET replaced_by_session_id=$2 WHERE id=$1', [
        replacedSessionId,
        inserted.rows[0]!.id,
      ]);
    const access = await this.createAccessToken(
      userId,
      methods,
      this.configuration.accessTokenTtlSeconds,
      inserted.rows[0]!.id,
    );
    return { ...access, refreshToken };
  }
  private async createAccessToken(
    userId: string,
    methods: string[],
    ttlSeconds: number,
    sessionId?: string,
  ) {
    const accessToken = await new SignJWT({
      ...(sessionId ? { sid: sessionId } : {}),
      amr: methods,
      auth_time: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(this.configuration.issuer)
      .setAudience(this.configuration.audience)
      .setSubject(`core|${userId}`)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(new TextEncoder().encode(this.configuration.signingSecret));
    return { accessToken, expiresIn: ttlSeconds };
  }
  private async coreUserId(client: Client, subject: string, forUpdate = false) {
    const result = await client.query<{ user_id: string }>(
      `SELECT user_id FROM identities WHERE provider='core' AND provider_subject=$1${forUpdate ? ' FOR UPDATE' : ''}`,
      [subject],
    );
    return result.rows[0]?.user_id;
  }
  private async activeFactor(client: Client, userId: string, verified: boolean) {
    const result = await client.query<MfaFactorRow>(
      `SELECT id,ciphertext,iv,auth_tag,key_id FROM core_identity_mfa_factors WHERE user_id=$1 AND factor_type='totp' AND deactivated_at IS NULL${verified ? ' AND verified_at IS NOT NULL' : ''} FOR UPDATE`,
      [userId],
    );
    return result.rows[0];
  }
  private verifyTotp(factor: MfaFactorRow, code: string) {
    if (!/^\d{6}$/.test(code)) return false;
    const seed = Buffer.from(
      this.encryptor.decrypt<string>({
        ciphertext: factor.ciphertext,
        iv: factor.iv,
        authTag: factor.auth_tag,
        keyId: factor.key_id,
      }),
      'base64',
    );
    return [-30_000, 0, 30_000].some((offset) =>
      timingSafeEqual(Buffer.from(createTotpCode(seed, Date.now() + offset)), Buffer.from(code)),
    );
  }
  private async consumeRecoveryCode(client: Client, factorId: string, code: string) {
    const result = await client.query<{ id: string }>(
      'UPDATE core_identity_mfa_recovery_codes SET used_at=now() WHERE factor_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id',
      [factorId, hashToken(code)],
    );
    return Boolean(result.rows[0]);
  }
  private async issueOneTimeToken(
    client: Client,
    userId: string,
    email: string,
    purpose: 'email_verification' | 'password_reset',
  ) {
    await client.query(
      'INSERT INTO core_identity_email_deliveries (user_id,recipient_email,purpose,event_key) VALUES ($1,$2,$3,$4)',
      [userId, email, purpose, `${purpose}:${userId}:${randomUUID()}`],
    );
  }
  private async ensurePortalAccess(client: Client, userId: string) {
    const application = await client.query<{ id: string }>(
      "INSERT INTO applications (key,name) VALUES ('customer-portal','Obsidian Customer Portal') ON CONFLICT (key) DO UPDATE SET deactivated_at=NULL RETURNING id",
    );
    const applicationId = application.rows[0]!.id;
    const role = await client.query<{ id: string }>(
      "INSERT INTO roles (application_id,key,name,deactivated_at) VALUES ($1,'customer-self-service','Customer Self-Service',NULL) ON CONFLICT (application_id,key) DO UPDATE SET deactivated_at=NULL RETURNING id",
      [applicationId],
    );
    for (const [key, name] of customerPortalPermissionDefinitions) {
      const permission = await client.query<{ id: string }>(
        'INSERT INTO permissions (key,name) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name RETURNING id',
        [key, name],
      );
      await client.query(
        'INSERT INTO role_permissions (role_id,permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [role.rows[0]!.id, permission.rows[0]!.id],
      );
    }
    await client.query(
      'INSERT INTO user_roles (user_id,role_id) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2 AND organization_id IS NULL AND effective_to IS NULL)',
      [userId, role.rows[0]!.id],
    );
    await client.query(
      'INSERT INTO application_entitlements (user_id,application_id) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM application_entitlements WHERE user_id=$1 AND application_id=$2 AND deactivated_at IS NULL AND effective_to IS NULL)',
      [userId, applicationId],
    );
  }
  private async audit(
    client: Client,
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    correlationId: string,
    afterValue: Record<string, unknown>,
  ) {
    const event = createAuditEvent({
      actorUserId,
      action,
      targetType,
      targetId,
      correlationId,
      reason: null,
      beforeValue: null,
      afterValue,
    });
    await client.query(
      'INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,reason,before_value,after_value,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        event.actorUserId,
        event.action,
        event.targetType,
        event.targetId,
        event.correlationId,
        event.reason,
        event.beforeValue,
        event.afterValue,
        event.occurredAt,
      ],
    );
  }
}
type CredentialRow = {
  id: string;
  email: string;
  email_verified_at: Date | null;
  password_hash: Buffer;
  password_salt: Buffer;
  memory_kib: number;
  iterations: number;
  parallelism: number;
  failed_attempts: number;
  locked_until: Date | null;
};
type MfaFactorRow = {
  id: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_id: string;
};

type PendingEmail = {
  id: string;
  user_id: string;
  purpose: 'email_verification' | 'password_reset';
  recipient_email: string;
};

/** Delivers identity emails from a durable, retryable Core outbox. */
export class PostgresCoreIdentityEmailOutbox {
  constructor(
    private readonly databaseUrl: string,
    private readonly identity: CoreIdentityConfiguration,
    private readonly email: ResendEmailConfiguration,
    private readonly provider: TransactionalEmailProvider = new ResendTransactionalEmailProvider(
      email,
    ),
  ) {}
  async deliverPending(limit = 20) {
    let delivered = 0;
    for (let index = 0; index < limit; index += 1) {
      const row = await this.claim();
      if (!row) break;
      try {
        const token = await this.createDeliveryToken(row.user_id, row.purpose);
        const url = new URL(
          row.purpose === 'email_verification'
            ? this.identity.emailVerificationUrl
            : this.identity.passwordResetUrl,
        );
        url.searchParams.set('token', token);
        const reset = row.purpose === 'password_reset';
        const subject = reset
          ? 'Reset your Obsidian Systems password'
          : 'Verify your Obsidian Systems email';
        const action = reset ? 'Reset password' : 'Verify email';
        await this.provider
          .send({
            to: row.recipient_email,
            from: this.email.from,
            ...(this.email.replyTo ? { replyTo: this.email.replyTo } : {}),
            subject,
            text: `${action}: ${url.toString()}\n\nThis link expires in 30 minutes. If you did not request this, you can ignore this email.`,
            html: `<p>${action} for your Obsidian Systems account.</p><p><a href="${escapeHtml(url.toString())}">${action}</a></p><p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>`,
            idempotencyKey: `obsidian-core-identity-email-${row.id}`,
          })
          .then((sent) => this.finish(row.id, sent.providerMessageReference));
        delivered += 1;
      } catch (error) {
        await this.fail(
          row.id,
          error instanceof EmailProviderError ? error.code : 'IDENTITY_EMAIL_DELIVERY_FAILED',
        );
      }
    }
    return delivered;
  }
  private async claim() {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const result = await client.query<PendingEmail>(
        `WITH next AS (SELECT id FROM core_identity_email_deliveries WHERE (status IN ('queued','failed') OR (status='sending' AND updated_at<=now()-interval '10 minutes')) AND attempts<5 AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE core_identity_email_deliveries d SET status='sending',attempts=attempts+1,updated_at=now() FROM next WHERE d.id=next.id RETURNING d.id,d.user_id,d.purpose,d.recipient_email`,
      );
      await client.query('COMMIT');
      return result.rows[0] ?? null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async finish(id: string, providerMessageReference: string) {
    await this.update(id, 'sent', providerMessageReference, null);
  }
  private async fail(id: string, code: string) {
    await this.update(id, 'failed', null, code.slice(0, 100));
  }
  private async update(
    id: string,
    status: 'sent' | 'failed',
    providerMessageReference: string | null,
    lastErrorCode: string | null,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query(
        `UPDATE core_identity_email_deliveries SET status=$2,provider_message_reference=COALESCE($3,provider_message_reference),last_error_code=$4,sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END,next_attempt_at=CASE WHEN $2='failed' THEN now()+interval '5 minutes' ELSE NULL END,updated_at=now() WHERE id=$1`,
        [id, status, providerMessageReference, lastErrorCode],
      );
    } finally {
      await client.end();
    }
  }
  private async createDeliveryToken(
    userId: string,
    purpose: 'email_verification' | 'password_reset',
  ) {
    const token = newSecret();
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      await client.query(
        'UPDATE core_identity_one_time_tokens SET consumed_at=now() WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL',
        [userId, purpose],
      );
      await client.query(
        "INSERT INTO core_identity_one_time_tokens (user_id,purpose,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '30 minutes')",
        [userId, purpose, hashToken(token)],
      );
      await client.query('COMMIT');
      return token;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
}
function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
