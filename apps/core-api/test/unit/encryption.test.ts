import { describe, expect, it } from 'vitest';
import { loadFieldEncryptor } from '../../src/encryption.js';
const encryptor = loadFieldEncryptor({
  FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  FIELD_ENCRYPTION_KEY_ID: 'test-key',
});
describe('field encryption', () => {
  it('encrypts and decrypts without plaintext in ciphertext', () => {
    const encrypted = encryptor.encrypt({ line1: '123 Example Street' });
    expect(encrypted.ciphertext.toString()).not.toContain('Example');
    expect(encryptor.decrypt(encrypted)).toEqual({ line1: '123 Example Street' });
  });
  it('rejects a value encrypted under another key id', () =>
    expect(() =>
      encryptor.decrypt({ ...encryptor.encrypt({ value: 'x' }), keyId: 'other' }),
    ).toThrow('unavailable'));
});
