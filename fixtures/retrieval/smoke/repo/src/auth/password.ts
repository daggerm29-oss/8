import { createHash } from 'node:crypto';

export function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(salt + password).digest('hex');
}

export function verifyPassword(password: string, salt: string, expected: string): boolean {
  return hashPassword(password, salt) === expected;
}
