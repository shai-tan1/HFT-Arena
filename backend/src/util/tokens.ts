/**
 * backend/src/util/tokens.ts — access tokens.
 *
 * Short-lived JWTs, no refresh rotation yet. The refresh side is already
 * modelled in db/schema_02_gameplay.sql (`user_sessions` stores a sha256 of the
 * token, never the token) — that table exists so revocation is possible when
 * this moves past a single process, and this file is the piece that grows into
 * it. Until then a stolen token expires on its own in an hour.
 */

import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET ?? 'dev-only-change-me';
const TTL = '1h';

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

export interface Claims {
  sub: string;
  handle: string;
  guest: boolean;
}

export function issueToken(claims: Claims): string {
  return jwt.sign(claims, SECRET, { expiresIn: TTL });
}

export function verifyToken(token: string): Claims | null {
  try {
    return jwt.verify(token, SECRET) as Claims;
  } catch {
    return null;
  }
}
