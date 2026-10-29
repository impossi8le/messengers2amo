import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type TokenCipher = {
  encrypt: (plaintext: string) => string;
  decrypt: (blob: string) => string;
};

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM envelope for CRM credentials. The key material is hashed to a
 * fixed 32-byte key, so short configuration values cannot silently weaken the
 * cipher. Only the encrypted envelope is ever written to the database.
 */
export function createTokenCipher(keyMaterial: string): TokenCipher {
  if (typeof keyMaterial !== 'string' || keyMaterial.length < 16) {
    throw new Error('invalid_token_key');
  }
  const key = createHash('sha256').update(keyMaterial, 'utf8').digest();
  return {
    encrypt(plaintext: string): string {
      if (typeof plaintext !== 'string') throw new Error('invalid_plaintext');
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
    },
    decrypt(blob: string): string {
      if (typeof blob !== 'string') throw new Error('invalid_credential_envelope');
      const parts = blob.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('invalid_credential_envelope');
      const [, ivPart, tagPart, dataPart] = parts;
      if (!ivPart || !tagPart || !dataPart) throw new Error('invalid_credential_envelope');
      const iv = Buffer.from(ivPart, 'base64url');
      const tag = Buffer.from(tagPart, 'base64url');
      const data = Buffer.from(dataPart, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('invalid_credential_envelope');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}
