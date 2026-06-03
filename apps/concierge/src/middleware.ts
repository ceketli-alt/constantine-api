/**
 * Authn + Authz middleware
 *
 * Authn: Authorization: Bearer <jwt> → verify, ctx'e {sub, role, email} koyar
 * Authz: tablo bazlı role check (RLS karşılığı)
 *
 * Constantine RLS pattern'i (Mert'in migration'larından):
 *   - super_admin: hepsi
 *   - partner: tüm public veriler + admin işlevleri
 *   - accountant: muhasebe (expenses, channel_settlements, bookings read)
 *   - captain: kendine assign edilmiş boat'lara dair okuma + güncelleme
 *   - crew: çok kısıtlı, kendi profile'ı
 *   - anon (login öncesi): sadece açık endpoint'ler (örn agency_tokens public view)
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import { verifyAnyJWT } from './auth.js';

export interface AuthContext {
  userId: string;
  email: string;
  role: string; // super_admin | partner | accountant | captain | crew | anon | service_role
  raw: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth?: AuthContext;
  }
}

export const authnMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization') || c.req.header('authorization');
  // apikey header'ı: Supabase'in "client identification" — yeni format sb_publishable_*
  // ya da eski JWT. JWT ise verify ederiz, değilse sessizce anon olarak devam.
  const apikeyHeader = c.req.header('apikey');

  // Authorization Bearer JWT öncelikli
  const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');

  if (bearerToken) {
    try {
      const claims = await verifyAnyJWT(bearerToken);
      c.set('auth', {
        userId: claims.sub,
        email: claims.email ?? '',
        role: claims.role ?? 'authenticated',
        raw: claims.raw,
      });
      return next();
    } catch (e) {
      // Bearer geçersiz: Supabase JS client login öncesi public endpoint'lere de
      // (recover, signup, token) anon key'i Bearer header'a koyuyor. Bu anon key
      // bizim JWT_SECRET'ımızla imzalı değil → verify fail. 401 atmıyoruz, sessizce
      // anon olarak devam — public route'lar açık kalır, korunan route'lar zaten
      // `requireAuth(c)` ile içeride 401 atar.
    }
  }

  // Bearer yoksa veya geçersizse, apikey JWT formatında ise dene
  if (!c.get('auth') && apikeyHeader && apikeyHeader.startsWith('eyJ')) {
    try {
      const claims = await verifyAnyJWT(apikeyHeader);
      c.set('auth', {
        userId: claims.sub,
        email: claims.email ?? '',
        role: claims.role ?? 'anon',
        raw: claims.raw,
      });
    } catch {
      // Sessizce anon olarak devam — apikey geçersizse 401 atmıyoruz
    }
  }
  // apikey yeni format (sb_publishable_*) ise hiçbir şey yapma, anon devam

  return next();
};

/** Tablo bazlı read/write izinleri — RLS karşılığı.
 *  Şu an basit policy: authenticated → public.* okuyabilir/yazabilir.
 *  anon → sadece public_boats benzeri public view'lara okuma.
 *  Daha sıkı policy migration'lardan port edilebilir.
 */
const ANON_READ_TABLES = new Set(['agency_tokens', 'public_boats']);
const SERVICE_ROLE_ALL = true;

export function checkTableAccess(table: string, op: 'read' | 'write', auth?: AuthContext): { ok: boolean; reason?: string } {
  if (!auth) {
    if (op === 'read' && ANON_READ_TABLES.has(table)) return { ok: true };
    return { ok: false, reason: 'Auth gerek' };
  }
  if (SERVICE_ROLE_ALL && auth.role === 'service_role') return { ok: true };
  // İlk geçiş: authenticated her şeyi yapabilir. Sonra daraltacağız.
  return { ok: true };
}

export function requireAuth(c: Context): AuthContext | null {
  const auth = c.get('auth');
  return auth ?? null;
}
