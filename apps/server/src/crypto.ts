import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

function deriveKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error('Secret must be at least 32 bytes');
  return createHash('sha256').update(secret).digest();
}

/** Returns base64(nonce || ciphertext || authTag). */
export function encrypt(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString('base64');
}

export function decrypt(encoded: string, secret: string): string {
  const key = deriveKey(secret);
  const buf = Buffer.from(encoded, 'base64');
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
