/**
 * Ortak auth modülü — argon2 hash + JWT (HS256).
 * Her app kendi JWT_SECRET'ını .env'den okur.
 */
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export interface JwtPayload {
  sub: string;        // user id
  email?: string;
  role?: string;
  tenant?: string;    // multi-tenant için (constantine)
  [k: string]: unknown;
}

export async function signAccessToken(payload: JwtPayload, secret: string, ttlSec = 900): Promise<string> {
  const enc = new TextEncoder().encode(secret);
  return new SignJWT(payload as any)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(enc);
}

export async function signRefreshToken(payload: JwtPayload, secret: string, ttlSec = 60 * 60 * 24 * 30): Promise<string> {
  const enc = new TextEncoder().encode(secret);
  return new SignJWT({ ...payload, typ: 'refresh' } as any)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(enc);
}

export async function verifyToken<T extends JwtPayload = JwtPayload>(token: string, secret: string): Promise<T> {
  const enc = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, enc, { algorithms: ['HS256'] });
  return payload as T;
}
