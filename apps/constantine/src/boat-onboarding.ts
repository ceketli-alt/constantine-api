/**
 * boat-onboarding — Self-service kaptan onboarding (partner-fleet v4)
 *
 * Akış: admin "Tekneci Davet Et" → tokenli link → kaptan public formdan kendi
 * tekne bilgisi + foto + (Google takvim) girer → 'pending_review' draft boat →
 * admin "Yayınla" → active=true + portal/storefront'larda canlı.
 *
 * Aksiyonlar (?action=):
 *   POST invite        (admin)         → davet token + link üret
 *   GET  validate      (public, token) → token geçerli mi + draft durumu
 *   POST submit        (public, token) → draft boat + owner upsert (active=false)
 *   POST upload-photo  (public, token) → multipart foto → /var/www/storage + boat_photos
 *   POST publish       (admin)         → boat active=true, onboarding_status=published
 *   GET  submissions   (admin)         → bekleyen başvurular listesi
 *
 * Foto: kendi token-gated upload'umuz diske yazar (nginx GET'te serv eder);
 * supabase-storage katmanına bağımlılık yok. Hono root çalışır → /var/www/storage'a yazabilir.
 */
import type { Context } from 'hono';
import crypto from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';

const STORAGE_DIR = process.env.STORAGE_DIR || '/var/www/storage';
const PHOTO_BUCKET = 'boat-photos';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_PHOTOS_PER_BOAT = 15;
const ONBOARDING_BASE_URL = (process.env.ONBOARDING_BASE_URL || 'https://acente.constantineyachts.com').replace(/\/$/, '');

function apiPublicUrl(): string {
  return (process.env.API_PUBLIC_URL || 'https://api.constantineyachts.com').replace(/\/$/, '');
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// ============================================================
// Auth + token helpers
// ============================================================

async function requireAdmin(c: Context): Promise<string | null> {
  const auth = requireAuth(c);
  if (!auth?.userId) return null;
  const rows = await sql<Array<{ role: string }>>`
    SELECT role::text AS role FROM profiles WHERE id = ${auth.userId} LIMIT 1
  `;
  return rows[0]?.role === 'super_admin' ? auth.userId : null;
}

interface InviteRow {
  id: string;
  token: string;
  boat_id: string | null;
  status: string;
  expires_at: string;
}

async function getInvite(token: string | null): Promise<InviteRow | null> {
  if (!token || typeof token !== 'string' || token.length < 16 || token.length > 64) return null;
  const rows = await sql<InviteRow[]>`
    SELECT id, token, boat_id, status, expires_at::text AS expires_at
    FROM boat_onboarding_invites WHERE token = ${token} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Kaptanın form doldurabileceği durum: bulundu + süresi geçmemiş + henüz yayınlanmamış. */
function inviteUsable(inv: InviteRow): boolean {
  if (inv.status === 'published' || inv.status === 'expired') return false;
  return new Date(inv.expires_at).getTime() >= Date.now();
}

// ============================================================
// Handlers
// ============================================================

async function handleInvite(c: Context) {
  const adminId = await requireAdmin(c);
  if (!adminId) return { status: 403, body: { error: 'forbidden' } };

  let body: any = {};
  try { body = await c.req.json(); } catch { /* label opsiyonel */ }
  const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 120) || null : null;

  const token = crypto.randomBytes(18).toString('base64url'); // ~24 char URL-safe
  const rows = await sql<Array<{ token: string; expires_at: string }>>`
    INSERT INTO boat_onboarding_invites (token, label, created_by)
    VALUES (${token}, ${label}, ${adminId}::uuid)
    RETURNING token, expires_at::text AS expires_at
  `;
  const inv = rows[0]!;
  return {
    status: 200,
    body: { token: inv.token, url: `${ONBOARDING_BASE_URL}/tekne-basvuru/${inv.token}`, expires_at: inv.expires_at },
  };
}

async function handleValidate(token: string | null) {
  const inv = await getInvite(token);
  if (!inv) return { status: 200, body: { valid: false, reason: 'not_found' } };
  if (inv.status === 'published') return { status: 200, body: { valid: false, reason: 'already_published' } };
  if (!inviteUsable(inv)) return { status: 200, body: { valid: false, reason: 'expired' } };

  // Draft tekne varsa formu prefill için döndür
  let boat: any = null;
  if (inv.boat_id) {
    const rows = await sql<Array<any>>`
      SELECT b.id, b.name, b.capacity, b.short_description, b.image_url,
             b.google_calendar_connected,
             o.name AS contact_name, o.phone AS contact_phone, o.email AS contact_email,
             (SELECT count(*)::int FROM boat_photos p WHERE p.boat_id = b.id) AS photo_count
      FROM boats b LEFT JOIN boat_owners o ON o.id = b.owner_id
      WHERE b.id = ${inv.boat_id}
    `;
    boat = rows[0] ?? null;
  }
  return { status: 200, body: { valid: true, status: inv.status, boat_id: inv.boat_id, boat } };
}

interface SubmitBody {
  name?: unknown;
  capacity?: unknown;
  short_description?: unknown;
  contact_name?: unknown;
  contact_phone?: unknown;
  contact_email?: unknown;
  consent?: unknown;
}

async function handleSubmit(token: string | null, raw: unknown) {
  const inv = await getInvite(token);
  if (!inv) return { status: 401, body: { error: 'invalid_token' } };
  if (!inviteUsable(inv)) return { status: 410, body: { error: 'token_expired_or_used' } };
  if (!raw || typeof raw !== 'object') return { status: 400, body: { error: 'body required' } };
  const b = raw as SubmitBody;

  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  if (!name) return { status: 400, body: { error: 'name required' } };
  const capacity = Number(b.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) {
    return { status: 400, body: { error: 'capacity must be 1-500' } };
  }
  const desc = typeof b.short_description === 'string' ? b.short_description.trim().slice(0, 600) || null : null;
  const contactName = typeof b.contact_name === 'string' ? b.contact_name.trim().slice(0, 200) : '';
  if (!contactName) return { status: 400, body: { error: 'contact_name required' } };
  const contactPhone = typeof b.contact_phone === 'string' ? b.contact_phone.trim().slice(0, 80) || null : null;
  const contactEmail = typeof b.contact_email === 'string' ? b.contact_email.trim().slice(0, 200) || null : null;
  if (!contactPhone && !contactEmail) {
    return { status: 400, body: { error: 'contact_phone or contact_email required' } };
  }
  if (b.consent !== true) return { status: 400, body: { error: 'consent required' } };

  // Mevcut draft varsa güncelle, yoksa yarat (idempotent — form adımları arası tekrar çağrılabilir)
  let boatId = inv.boat_id;
  if (boatId) {
    await sql.begin(async (tx) => {
      const ownerRows = await tx<Array<{ owner_id: string | null }>>`
        SELECT owner_id FROM boats WHERE id = ${boatId}
      `;
      const ownerId = ownerRows[0]?.owner_id;
      if (ownerId) {
        await tx`
          UPDATE boat_owners SET name = ${contactName}, phone = ${contactPhone}, email = ${contactEmail}
          WHERE id = ${ownerId}
        `;
      }
      await tx`
        UPDATE boats SET name = ${name}, capacity = ${capacity}, short_description = ${desc}
        WHERE id = ${boatId}
      `;
    });
  } else {
    await sql.begin(async (tx) => {
      const ownerRows = await tx<Array<{ id: string }>>`
        INSERT INTO boat_owners (name, phone, email, active)
        VALUES (${contactName}, ${contactPhone}, ${contactEmail}, true)
        RETURNING id
      `;
      const ownerId = ownerRows[0]!.id;
      const boatRows = await tx<Array<{ id: string }>>`
        INSERT INTO boats (name, capacity, short_description, agency_only, active, onboarding_status, owner_id, default_duration_hours)
        VALUES (${name}, ${capacity}, ${desc}, true, false, 'pending_review', ${ownerId}::uuid, 2)
        RETURNING id
      `;
      boatId = boatRows[0]!.id;
      await tx`
        UPDATE boat_onboarding_invites
        SET boat_id = ${boatId}::uuid, status = 'submitted', submitted_at = now()
        WHERE id = ${inv.id}
      `;
    });
  }

  return { status: 200, body: { ok: true, boat_id: boatId } };
}

async function handleUploadPhoto(c: Context, token: string | null) {
  const inv = await getInvite(token);
  if (!inv) return { status: 401, body: { error: 'invalid_token' } };
  if (!inviteUsable(inv)) return { status: 410, body: { error: 'token_expired_or_used' } };
  if (!inv.boat_id) return { status: 400, body: { error: 'submit boat info first' } };
  const boatId = inv.boat_id;

  const countRows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM boat_photos WHERE boat_id = ${boatId}
  `;
  if ((countRows[0]?.n ?? 0) >= MAX_PHOTOS_PER_BOAT) {
    return { status: 400, body: { error: `max ${MAX_PHOTOS_PER_BOAT} photos` } };
  }

  let parsed: Record<string, unknown>;
  try { parsed = await c.req.parseBody(); } catch { return { status: 400, body: { error: 'multipart body required' } }; }
  const file = parsed['file'];
  if (!file || typeof file === 'string' || typeof (file as File).arrayBuffer !== 'function') {
    return { status: 400, body: { error: 'file field required' } };
  }
  const f = file as File;
  const ext = EXT_BY_MIME[f.type];
  if (!ext) return { status: 400, body: { error: 'only jpg/png/webp images' } };
  if (f.size > MAX_PHOTO_BYTES) return { status: 400, body: { error: 'max 10MB' } };

  const fname = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const dir = path.join(STORAGE_DIR, PHOTO_BUCKET, boatId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fname), Buffer.from(await f.arrayBuffer()));

  const url = `${apiPublicUrl()}/storage/v1/object/public/${PHOTO_BUCKET}/${boatId}/${fname}`;
  const orderRows = await sql<Array<{ next: number }>>`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM boat_photos WHERE boat_id = ${boatId}
  `;
  await sql`
    INSERT INTO boat_photos (boat_id, url, sort_order)
    VALUES (${boatId}::uuid, ${url}, ${orderRows[0]?.next ?? 0})
  `;
  // İlk foto → kapak
  await sql`UPDATE boats SET image_url = ${url} WHERE id = ${boatId} AND (image_url IS NULL OR image_url = '')`;

  return { status: 200, body: { ok: true, url } };
}

async function handlePublish(c: Context, raw: unknown) {
  const adminId = await requireAdmin(c);
  if (!adminId) return { status: 403, body: { error: 'forbidden' } };
  const b = (raw ?? {}) as { boat_id?: unknown };
  if (typeof b.boat_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.boat_id)) {
    return { status: 400, body: { error: 'invalid boat_id' } };
  }
  const rows = await sql<Array<{ onboarding_status: string | null }>>`
    SELECT onboarding_status FROM boats WHERE id = ${b.boat_id}
  `;
  if (!rows[0]) return { status: 404, body: { error: 'boat not found' } };
  if (rows[0].onboarding_status !== 'pending_review') {
    return { status: 400, body: { error: 'boat not in pending_review' } };
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE boats SET active = true, onboarding_status = 'published' WHERE id = ${b.boat_id as string}`;
    await tx`UPDATE boat_onboarding_invites SET status = 'published' WHERE boat_id = ${b.boat_id as string}::uuid`;
  });
  return { status: 200, body: { ok: true } };
}

async function handleSubmissions(c: Context) {
  const adminId = await requireAdmin(c);
  if (!adminId) return { status: 403, body: { error: 'forbidden' } };
  const rows = await sql<Array<any>>`
    SELECT b.id, b.name, b.capacity, b.short_description, b.image_url,
           b.google_calendar_connected,
           o.name AS owner_name, o.phone AS owner_phone, o.email AS owner_email,
           (SELECT count(*)::int FROM boat_photos p WHERE p.boat_id = b.id) AS photo_count,
           i.label, i.submitted_at::text AS submitted_at
    FROM boats b
    LEFT JOIN boat_owners o ON o.id = b.owner_id
    LEFT JOIN boat_onboarding_invites i ON i.boat_id = b.id
    WHERE b.onboarding_status = 'pending_review'
    ORDER BY i.submitted_at DESC NULLS LAST
  `;
  return { status: 200, body: { submissions: rows } };
}

// ============================================================
// Router
// ============================================================

export async function handleBoatOnboarding(c: Context): Promise<Response> {
  c.header('X-Robots-Tag', 'noindex, nofollow');
  const action = c.req.query('action') ?? '';
  const token = c.req.query('token') ?? null;
  const method = c.req.method;

  try {
    switch (action) {
      case 'invite': {
        if (method !== 'POST') return c.json({ error: 'POST required' }, 405);
        const r = await handleInvite(c);
        return c.json(r.body, r.status as any);
      }
      case 'validate': {
        const r = await handleValidate(token);
        return c.json(r.body, r.status as any);
      }
      case 'submit': {
        if (method !== 'POST') return c.json({ error: 'POST required' }, 405);
        let body: unknown;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON' }, 400); }
        const r = await handleSubmit(token, body);
        return c.json(r.body, r.status as any);
      }
      case 'upload-photo': {
        if (method !== 'POST') return c.json({ error: 'POST required' }, 405);
        const r = await handleUploadPhoto(c, token);
        return c.json(r.body, r.status as any);
      }
      case 'publish': {
        if (method !== 'POST') return c.json({ error: 'POST required' }, 405);
        let body: unknown;
        try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON' }, 400); }
        const r = await handlePublish(c, body);
        return c.json(r.body, r.status as any);
      }
      case 'submissions': {
        const r = await handleSubmissions(c);
        return c.json(r.body, r.status as any);
      }
      default:
        return c.json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e: any) {
    console.error('[boat-onboarding] unhandled:', e);
    return c.json({ error: 'internal_error', message: e?.message }, 500);
  }
}
