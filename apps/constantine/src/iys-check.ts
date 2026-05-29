/**
 * /functions/v1/iys-check — İYS (İleti Yönetim Sistemi) opt-out kontrolü
 *
 * Stub mode: IYS_STUB_MODE=true (default) → tüm adresler `allowed`.
 * Real mode: IYS_MARKA_KODU + IYS_API_KEY + IYS_STUB_MODE=false → gerçek API.
 *
 * Cache: `iys_checks` tablosu, 30 gün TTL (DB defaults).
 *
 * Request:
 *   { phones?: string[], emails?: string[], health?: boolean }
 *
 * Response:
 *   { results: { phones: { ... }, emails: { ... } } }
 */
import type { Context } from 'hono';
import { sql } from './db.js';

const IYS_STUB_MODE = (process.env.IYS_STUB_MODE ?? 'true') === 'true';
const IYS_MARKA_KODU = process.env.IYS_MARKA_KODU || '';
const IYS_API_KEY = process.env.IYS_API_KEY || '';
const IYS_API_BASE = process.env.IYS_API_BASE || 'https://api.iys.org.tr';

interface CheckResult {
  allowed: string[];
  checked_at: string;
  from_cache: boolean;
  stub?: boolean;
}

interface CheckRequest {
  phones?: string[];
  emails?: string[];
  health?: boolean;
}

function parseAllowed(result: string): string[] {
  return result.split(',').filter(Boolean);
}

async function fetchIysSingle(kind: 'phone' | 'email', identifier: string): Promise<CheckResult> {
  const now = new Date().toISOString();
  if (IYS_STUB_MODE || !IYS_MARKA_KODU || !IYS_API_KEY) {
    return {
      allowed: kind === 'phone' ? ['MESAJ', 'ARAMA'] : ['EPOSTA'],
      checked_at: now,
      from_cache: false,
      stub: true,
    };
  }
  try {
    const res = await fetch(`${IYS_API_BASE}/sps/${IYS_MARKA_KODU}/consents/check`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${IYS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: kind === 'phone' ? 'ARAMA' : 'EPOSTA',
        recipient: identifier,
      }),
    });
    if (!res.ok) {
      console.warn(`[iys-check] API ${res.status}:`, await res.text());
      return { allowed: [], checked_at: now, from_cache: false };
    }
    const data: any = await res.json();
    return {
      allowed: data.status === 'ONAY'
        ? (kind === 'phone' ? ['MESAJ', 'ARAMA'] : ['EPOSTA'])
        : [],
      checked_at: now,
      from_cache: false,
    };
  } catch (e: any) {
    console.error('[iys-check] API hatası:', e?.message);
    return { allowed: [], checked_at: now, from_cache: false };
  }
}

export interface IysCheckResults {
  results: {
    phones: Record<string, CheckResult>;
    emails: Record<string, CheckResult>;
  };
}

/**
 * Pure check runner — wp-send gibi in-process tüketenler için.
 * Body parsing yapmaz, doğrudan input alır + IysCheckResults döner.
 * handleIysCheck bunu sarar.
 */
export async function performIysCheck(input: CheckRequest): Promise<IysCheckResults> {
  const phones = input.phones ?? [];
  const emails = input.emails ?? [];
  if (phones.length === 0 && emails.length === 0) {
    return { results: { phones: {}, emails: {} } };
  }

  const nowIso = new Date().toISOString();
  const cacheMap = new Map<string, any>();

  if (phones.length > 0) {
    const rows = await sql`
      SELECT * FROM iys_checks
      WHERE phone = ANY(${phones as any})
        AND expires_at > ${nowIso}
      ORDER BY checked_at DESC
    `;
    for (const r of rows) {
      if (r.phone && !cacheMap.has(r.phone)) cacheMap.set(r.phone, r);
    }
  }
  if (emails.length > 0) {
    const rows = await sql`
      SELECT * FROM iys_checks
      WHERE email = ANY(${emails as any})
        AND expires_at > ${nowIso}
      ORDER BY checked_at DESC
    `;
    for (const r of rows) {
      if (r.email && !cacheMap.has(r.email)) cacheMap.set(r.email, r);
    }
  }

  const phoneResults: Record<string, CheckResult> = {};
  const emailResults: Record<string, CheckResult> = {};

  for (const phone of phones) {
    if (cacheMap.has(phone)) {
      const cached = cacheMap.get(phone);
      phoneResults[phone] = {
        allowed: parseAllowed(cached.result),
        checked_at: cached.checked_at?.toISOString?.() ?? cached.checked_at,
        from_cache: true,
      };
    } else {
      const result = await fetchIysSingle('phone', phone);
      phoneResults[phone] = result;
      try {
        await sql`
          INSERT INTO iys_checks (phone, result, raw_response)
          VALUES (${phone}, ${result.allowed.join(',')}, ${sql.json({ stub: result.stub ?? false })})
        `;
      } catch (e: any) {
        console.warn('[iys-check] cache insert (phone) skipped:', e.message);
      }
    }
  }

  for (const email of emails) {
    if (cacheMap.has(email)) {
      const cached = cacheMap.get(email);
      emailResults[email] = {
        allowed: parseAllowed(cached.result),
        checked_at: cached.checked_at?.toISOString?.() ?? cached.checked_at,
        from_cache: true,
      };
    } else {
      const result = await fetchIysSingle('email', email);
      emailResults[email] = result;
      try {
        await sql`
          INSERT INTO iys_checks (email, result, raw_response)
          VALUES (${email}, ${result.allowed.join(',')}, ${sql.json({ stub: result.stub ?? false })})
        `;
      } catch (e: any) {
        console.warn('[iys-check] cache insert (email) skipped:', e.message);
      }
    }
  }

  return { results: { phones: phoneResults, emails: emailResults } };
}

export async function handleIysCheck(c: Context): Promise<Response> {
  let body: CheckRequest;
  try {
    body = await c.req.json() as CheckRequest;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (body.health) {
    return c.json({
      configured: !!IYS_MARKA_KODU && !!IYS_API_KEY,
      stub_mode: IYS_STUB_MODE,
      marka_kodu_set: !!IYS_MARKA_KODU,
      api_key_set: !!IYS_API_KEY,
    });
  }

  const result = await performIysCheck(body);
  return c.json(result);
}
