/**
 * mail-metrics.ts — Mail provider metrics endpoint
 *
 * Endpoint'ler:
 *   GET  /functions/v1/mail-metrics?window=7d&campaign_id=<uuid>
 *   GET  /functions/v1/mail-health
 *   GET  /functions/v1/mail-events?recipient=...&type=...&limit=100
 *
 * Auth: super_admin/partner (sales rolleri).
 * Frontend: Constantine `Reports` veya `EmailSettings` sayfasında widget.
 */
import type { Context } from 'hono';
import { mailProviderForKind, transactionalProvider, outreachProvider, type MailKind } from './mail/index.js';
import { requireAuth } from './middleware.js';
import type { MetricsWindow, MetricsFilter, EventListFilter, MailEventType } from './mail/types.js';

const VALID_WINDOWS: MetricsWindow[] = ['24h', '7d', '30d', '90d'];
const VALID_KINDS: MailKind[] = ['transactional', 'outreach'];

function parseWindow(raw: string | undefined): MetricsWindow {
  if (!raw) return '7d';
  return VALID_WINDOWS.includes(raw as MetricsWindow) ? (raw as MetricsWindow) : '7d';
}

function parseKind(raw: string | undefined): MailKind {
  if (!raw) return 'transactional';
  return VALID_KINDS.includes(raw as MailKind) ? (raw as MailKind) : 'transactional';
}

export async function handleMailMetrics(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (auth.role !== 'super_admin' && auth.role !== 'partner') {
    return c.json({ error: 'forbidden', message: 'super_admin veya partner gerek' }, 403);
  }

  // GET (query) ya da POST (body) — ikisi de destekli (supabase.functions.invoke POST kullanır)
  let windowRaw: string | undefined;
  let campaignId: string | undefined;
  let tagName: string | undefined;
  let tagValue: string | undefined;
  let kindRaw: string | undefined;

  if (c.req.method === 'POST') {
    const body = await c.req.json().catch(() => ({} as any));
    windowRaw = body?.window;
    campaignId = body?.campaign_id;
    tagName = body?.tag_name;
    tagValue = body?.tag_value;
    kindRaw = body?.kind;
  } else {
    windowRaw = c.req.query('window');
    campaignId = c.req.query('campaign_id') ?? undefined;
    tagName = c.req.query('tag_name');
    tagValue = c.req.query('tag_value');
    kindRaw = c.req.query('kind');
  }

  const window = parseWindow(windowRaw);
  const kind = parseKind(kindRaw);
  const provider = mailProviderForKind(kind);

  const filter: MetricsFilter = {};
  if (campaignId) filter.campaignId = campaignId;
  // kind tag'i otomatik filtre — sender domain ayrımı yerine logical ayrım.
  // (Outreach mail'ler `kind=outreach` tag'i ile gönderilir.)
  if (tagName && tagValue) {
    filter.tag = { name: tagName, value: tagValue };
  } else {
    filter.tag = { name: 'kind', value: kind };
  }

  try {
    const result = await provider.getMetrics(window, filter);
    return c.json({ ...result, kind });
  } catch (e: any) {
    console.error('[mail-metrics] failed:', e?.message);
    return c.json({ error: 'metrics_failed', detail: e?.message ?? 'unknown' }, 500);
  }
}

export async function handleMailHealth(c: Context): Promise<Response> {
  // Default: her iki provider'ı return — frontend tek query ile iki durumu görsün.
  // ?kind=outreach veya ?kind=transactional → sadece o provider
  let kindRaw: string | undefined;
  if (c.req.method === 'POST') {
    const body = await c.req.json().catch(() => ({} as any));
    kindRaw = body?.kind;
  } else {
    kindRaw = c.req.query('kind');
  }

  const checkProvider = async (kind: MailKind) => {
    const provider = mailProviderForKind(kind);
    try {
      const health = await provider.healthCheck();
      return {
        kind,
        provider: provider.name,
        ok: health.ok,
        details: health.details ?? null,
      };
    } catch (e: any) {
      return {
        kind,
        provider: provider.name,
        ok: false,
        details: e?.message ?? 'unknown',
      };
    }
  };

  const checkedAt = new Date().toISOString();

  if (kindRaw) {
    const kind = parseKind(kindRaw);
    const result = await checkProvider(kind);
    return c.json({ ...result, checked_at: checkedAt });
  }

  // Default: ikisini de döndür
  const [transactional, outreach] = await Promise.all([
    checkProvider('transactional'),
    checkProvider('outreach'),
  ]);
  return c.json({
    // Backward-compat: ana ok flag transactional'a göre (mevcut frontend onu okuyor)
    provider: transactional.provider,
    ok: transactional.ok,
    details: transactional.details,
    checked_at: checkedAt,
    // Yeni yapı: her iki provider durumu
    providers: { transactional, outreach },
  });
}

export async function handleMailEvents(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (auth.role !== 'super_admin' && auth.role !== 'partner') {
    return c.json({ error: 'forbidden' }, 403);
  }

  // POST + GET ikisini de destekle (frontend salesSupabase.functions.invoke POST kullanır)
  let messageId: string | undefined;
  let recipient: string | undefined;
  let typeRaw: string | undefined;
  let since: string | undefined;
  let limitRaw: string | number | undefined;
  let kindRaw: string | undefined;

  if (c.req.method === 'POST') {
    const body = await c.req.json().catch(() => ({} as any));
    messageId = body?.messageId ?? body?.message_id;
    recipient = body?.recipient;
    typeRaw = body?.type;
    since = body?.since;
    limitRaw = body?.limit;
    kindRaw = body?.kind;
  } else {
    messageId = c.req.query('message_id') ?? undefined;
    recipient = c.req.query('recipient') ?? undefined;
    typeRaw = c.req.query('type');
    since = c.req.query('since') ?? undefined;
    limitRaw = c.req.query('limit');
    kindRaw = c.req.query('kind');
  }

  const kind = parseKind(kindRaw);
  const provider = mailProviderForKind(kind);

  const filter: EventListFilter = {
    messageId,
    recipient,
    type: (typeRaw as MailEventType) ?? undefined,
    since,
    limit: limitRaw ? Number(limitRaw) : undefined,
  };

  try {
    const events = await provider.listEvents(filter);
    return c.json({ events, count: events.length, kind });
  } catch (e: any) {
    console.error('[mail-events] failed:', e?.message);
    return c.json({ error: 'list_failed', detail: e?.message ?? 'unknown' }, 500);
  }
}
