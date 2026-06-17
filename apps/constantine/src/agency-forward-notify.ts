/**
 * agency-forward-notify — POST /functions/v1/agency-forward-notify
 *
 * Admin partner talebini "Partner'a yönlendir" derken tekneciye (boat_owners)
 * handoff maili gönderir: tarih/saat/kişi + hangi acente üzerinden geldi.
 * Komisyon/owner ekonomisi maile KOYULMAZ (tekneci-facing).
 *
 * Auth: super_admin / partner. Owner email yoksa graceful skip.
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';
import { sendEmail } from './resend-send.js';

export async function handleAgencyForwardNotify(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);

  const prof = await sql`SELECT role::text AS role FROM profiles WHERE id = ${auth.userId}`;
  const role = prof[0]?.role;
  if (role !== 'super_admin' && role !== 'partner') {
    return c.json({ error: 'forbidden' }, 403);
  }

  let body: { request_id?: unknown };
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid JSON' }, 400); }

  const requestId = typeof body.request_id === 'string' ? body.request_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
    return c.json({ error: 'invalid request_id' }, 400);
  }

  const rows = await sql`
    SELECT r.date, r.start_time::text AS start_time, r.duration_hours, r.guest_count,
           r.guest_name, r.notes,
           b.name AS boat_name,
           o.name AS owner_name, o.email AS owner_email,
           ag.name AS agency_name
    FROM agency_requests r
    JOIN boats b ON b.id = r.boat_id
    LEFT JOIN boat_owners o ON o.id = b.owner_id
    LEFT JOIN agencies ag ON ag.id = r.agency_id
    WHERE r.id = ${requestId}
  `;
  const row = rows[0];
  if (!row) return c.json({ error: 'request not found' }, 404);
  if (!row.owner_email) {
    return c.json({ skipped: 'owner_email_missing', owner_name: row.owner_name ?? null });
  }

  const dateStr = String(row.date).slice(0, 10);
  const startStr = String(row.start_time).slice(0, 5);
  const dur = Number(row.duration_hours);

  const subject = `Tekne talebi — ${row.boat_name} · ${dateStr} ${startStr}`;
  const text = [
    `Merhaba ${row.owner_name ?? ''},`.trim(),
    ``,
    `${row.boat_name} için bir rezervasyon talebi geldi (${row.agency_name ?? 'acente'} üzerinden):`,
    ``,
    `Tarih: ${dateStr}`,
    `Saat: ${startStr} · ${dur} saat`,
    `Kişi: ${row.guest_count}`,
    row.guest_name ? `Misafir: ${row.guest_name}` : '',
    row.notes ? `Not: ${row.notes}` : '',
    ``,
    `Müsait misin? En kısa sürede dönüş yapabilirsen koordine ederiz.`,
    ``,
    `— Constantine Yachts`,
  ].filter(Boolean).join('\n');

  const result = await sendEmail({ to: row.owner_email, subject, text });
  if (result.status === 'failed') {
    return c.json({ error: 'email_failed', detail: result.error }, 502);
  }
  return c.json({ ok: true, sent_to: row.owner_email });
}
