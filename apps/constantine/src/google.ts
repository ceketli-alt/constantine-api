/**
 * Google OAuth + Calendar API helpers
 * Mert'in Deno _shared/google.ts'sinin Node port'u.
 */
import { sql } from './db.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar';

export function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: getEnv('GOOGLE_CLIENT_ID'),
    client_secret: getEnv('GOOGLE_CLIENT_SECRET'),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`refresh failed: ${r.status} ${err}`);
  }
  return await r.json() as GoogleTokenResponse;
}

export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: getEnv('GOOGLE_CLIENT_ID'),
    client_secret: getEnv('GOOGLE_CLIENT_SECRET'),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`token exchange failed: ${r.status} ${err}`);
  }
  return await r.json() as GoogleTokenResponse;
}

export async function getAccessTokenForBoat(boatId: string): Promise<string> {
  const rows = await sql`
    SELECT refresh_token, access_token, access_token_expires_at
    FROM boat_google_credentials
    WHERE boat_id = ${boatId}
  `;
  const cred = rows[0];
  if (!cred) throw new Error('Bu tekne için Google bağlantısı yok');
  const now = Date.now();
  const exp = cred.access_token_expires_at ? new Date(cred.access_token_expires_at).getTime() : 0;
  if (cred.access_token && exp - now > 60_000) return cred.access_token;

  const fresh = await refreshAccessToken(cred.refresh_token);
  const newExp = new Date(now + fresh.expires_in * 1000).toISOString();
  await sql`
    UPDATE boat_google_credentials
    SET access_token = ${fresh.access_token},
        access_token_expires_at = ${newExp},
        updated_at = now()
    WHERE boat_id = ${boatId}
  `;
  return fresh.access_token;
}

export async function fetchGoogleUserInfo(accessToken: string): Promise<{ email: string; name?: string }> {
  const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error('userinfo failed');
  return await r.json() as { email: string; name?: string };
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  status?: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
}

export async function listCalendarEvents(opts: {
  accessToken: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
}): Promise<CalendarEvent[]> {
  const url = new URL(`${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events`);
  url.searchParams.set('timeMin', opts.timeMin);
  url.searchParams.set('timeMax', opts.timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '250');
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${opts.accessToken}` } });
  if (!r.ok) throw new Error(`events.list failed: ${r.status} ${await r.text()}`);
  const json = await r.json() as { items?: CalendarEvent[] };
  return json.items ?? [];
}

/**
 * freeBusy.query — takvimin dolu aralıklarını döner (event detayı YOK).
 * "Yalnızca müsait/meşgul" paylaşımıyla bile çalışır; partner tekne sync'i bunu kullanır.
 */
export async function freeBusyQuery(opts: {
  accessToken: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
  timeZone?: string;
}): Promise<Array<{ start: string; end: string }>> {
  const r = await fetch(`${GOOGLE_CALENDAR_BASE}/freeBusy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      timeZone: opts.timeZone ?? 'Europe/Istanbul',
      items: [{ id: opts.calendarId }],
    }),
  });
  if (!r.ok) throw new Error(`freeBusy failed: ${r.status} ${await r.text()}`);
  const json = await r.json() as {
    calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>;
  };
  // 'primary' isteğinde yanıt key'i gerçek takvim ID'siyle dönebilir
  const cal = json.calendars?.[opts.calendarId] ?? Object.values(json.calendars ?? {})[0];
  if (cal?.errors?.length) throw new Error(`freeBusy calendar error: ${JSON.stringify(cal.errors)}`);
  return cal?.busy ?? [];
}

export interface NewCalendarEvent {
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  colorId?: string;
}

export async function createCalendarEvent(opts: { accessToken: string; calendarId: string; event: NewCalendarEvent }) {
  const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.event),
  });
  if (!r.ok) throw new Error(`events.insert failed: ${r.status} ${await r.text()}`);
  return await r.json() as { id: string; htmlLink: string };
}

export async function updateCalendarEvent(opts: { accessToken: string; calendarId: string; eventId: string; event: Partial<NewCalendarEvent> }) {
  const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${opts.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.event),
  });
  if (!r.ok) throw new Error(`events.update failed: ${r.status} ${await r.text()}`);
}

export async function deleteCalendarEvent(opts: { accessToken: string; calendarId: string; eventId: string }) {
  const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  });
  if (!r.ok && r.status !== 410) throw new Error(`events.delete failed: ${r.status} ${await r.text()}`);
}
