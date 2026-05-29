/**
 * Auth modülü
 *
 * Geçiş stratejisi: Hem **Supabase JWT'lerini kabul et** (HS256, Supabase'in JWT_SECRET'ı ile)
 * hem de **kendi JWT'mizi** çıkar. Cutover sırasında ikisi yan yana çalışır.
 *
 * Login akışı:
 *   POST /auth/v1/token?grant_type=password   { email, password }
 *     → kendi users tablomuzda argon2 kontrol → kendi JWT döner
 *
 * Supabase JWT (eski token'lar): Authorization: Bearer eyJ... → verify et, geçir
 */
import { jwtVerify, SignJWT } from 'jose';
import argon2 from 'argon2';
import { sql } from './db.js';

const ACCESS_TTL = 60 * 60;       // 1 saat
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 gün

const JWT_SECRET = process.env.JWT_SECRET ?? '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? ''; // dual-issuer support

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET >=32 char olmalı');
}

const ourSecret = new TextEncoder().encode(JWT_SECRET);
const supaSecret = SUPABASE_JWT_SECRET ? new TextEncoder().encode(SUPABASE_JWT_SECRET) : null;

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  active: boolean;
}

export async function verifyAnyJWT(token: string): Promise<{ sub: string; email?: string; role?: string; raw: string }> {
  // 1. Önce kendi secret'imizle dene
  try {
    const { payload } = await jwtVerify(token, ourSecret, { algorithms: ['HS256'] });
    return { sub: payload.sub as string, email: payload.email as string, role: payload.role as string, raw: JSON.stringify(payload) };
  } catch {}
  // 2. Supabase secret'i varsa onunla dene (geçiş döneminde)
  if (supaSecret) {
    try {
      const { payload } = await jwtVerify(token, supaSecret, { algorithms: ['HS256'] });
      return {
        sub: payload.sub as string,
        email: payload.email as string,
        role: (payload.role as string) ?? (payload as any).user_metadata?.role,
        raw: JSON.stringify(payload),
      };
    } catch {}
  }
  throw new Error('Geçersiz token');
}

export async function issueAccessToken(user: SessionUser): Promise<string> {
  return new SignJWT({
    sub: user.id,
    email: user.email,
    role: user.role,
    aud: 'authenticated',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL}s`)
    .sign(ourSecret);
}

export async function issueRefreshToken(user: SessionUser): Promise<string> {
  return new SignJWT({ sub: user.id, typ: 'refresh' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TTL}s`)
    .sign(ourSecret);
}

/** Refresh token verify — sadece kendi secret'imizle imzalanmış VE typ='refresh' olmalı.
 *  Access token'la mix kullanılamaz (separation). */
export async function verifyRefreshToken(token: string): Promise<{ sub: string }> {
  const { payload } = await jwtVerify(token, ourSecret, { algorithms: ['HS256'] });
  if (payload.typ !== 'refresh') {
    throw new Error('Bu bir refresh token değil');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Refresh token sub eksik');
  }
  return { sub: payload.sub };
}

export async function lookupUserByEmail(email: string): Promise<{ id: string; email: string; password_hash: string | null; role: string; active: boolean } | null> {
  const rows = await sql`
    SELECT u.id, u.email, u.password_hash, p.role::text AS role, p.active
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    WHERE lower(u.email) = lower(${email})
    LIMIT 1
  `;
  return (rows[0] as any) ?? null;
}

// Transparent Supabase migration kaldırıldı (Faz 4 cleanup, 2026-05-24).
// Eski Supabase password'unu kullanan kullanıcılar artık `/auth/v1/recover`
// ile şifrelerini yenilemeli — backend lokal Argon2 hash bekliyor.

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try { return await argon2.verify(hash, plain); } catch { return false; }
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

/** Bir auth.users satırı oluştur veya güncelle (admin reset link mesajı sonrası kullanılır) */
export async function setUserPassword(userId: string, newPassword: string): Promise<void> {
  const hash = await hashPassword(newPassword);
  await sql`
    INSERT INTO auth.users (id, email, encrypted_password, password_hash)
    VALUES (${userId}, '', '', ${hash})
    ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
  `;
}
