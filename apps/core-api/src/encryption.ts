import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedValue = { authTag: Buffer; ciphertext: Buffer; iv: Buffer; keyId: string };

export class FieldEncryptor {
  constructor(
    private readonly key: Buffer,
    private readonly keyId: string,
  ) {}

  encrypt(value: unknown): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return { authTag: cipher.getAuthTag(), ciphertext, iv, keyId: this.keyId };
  }

  decrypt<T>(value: EncryptedValue): T {
    if (value.keyId !== this.keyId) throw new Error('Encrypted value uses an unavailable key.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.iv);
    decipher.setAuthTag(value.authTag);
    return JSON.parse(
      Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8'),
    ) as T;
  }
}

type EncryptionEnvironment = { FIELD_ENCRYPTION_KEY?: string; FIELD_ENCRYPTION_KEY_ID?: string };

export function loadFieldEncryptor(source: EncryptionEnvironment = process.env): FieldEncryptor {
  const keyId = source.FIELD_ENCRYPTION_KEY_ID;
  const encodedKey = source.FIELD_ENCRYPTION_KEY;
  if (!keyId || !encodedKey) throw new Error('Field encryption configuration is required.');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32)
    throw new Error('FIELD_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return new FieldEncryptor(key, keyId);
}
