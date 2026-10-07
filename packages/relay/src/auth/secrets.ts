import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Member tokens: 256 random bits. Shown once at init or join; only the hash is stored. */
export function newToken(): string {
  return `tk_${randomBytes(32).toString('base64url')}`;
}

/** Invite codes: shared out of band, so shorter than tokens but still unguessable (128 bits). */
export function newInviteCode(): string {
  return `inv_${randomBytes(16).toString('base64url')}`;
}

// No 0/O or 1/I/L, so a developer can read the code from a notification and type it.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * One-time approval codes: 10 characters from a 31-letter alphabet (about 49 bits),
 * which is far beyond what anyone could guess through the API.
 */
export function newApprovalCode(): string {
  let code = '';
  for (let i = 0; i < 10; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * SHA-256 is enough: every secret here is long and random, so a slow password hash adds nothing.
 * Approval codes are normalised so case and the dash do not matter when typed.
 */
export function hashSecret(secret: string): string {
  const normalised = secret.startsWith('tk_') || secret.startsWith('inv_') ? secret : secret.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return createHash('sha256').update(normalised).digest('hex');
}
