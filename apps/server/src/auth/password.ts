/**
 * argon2id password helpers — V2-001-T4
 *
 * These are wired into BetterAuth's emailAndPassword.password options so that
 * all locally-hashed passwords use argon2id instead of BetterAuth's default
 * scrypt hasher.
 */

import argon2 from 'argon2';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(args: {
  password: string;
  hash: string;
}): Promise<boolean> {
  try {
    return await argon2.verify(args.hash, args.password);
  } catch {
    return false;
  }
}
