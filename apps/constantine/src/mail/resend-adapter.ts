/**
 * Resend adapter — `MailProvider` implementation for resend.com.
 *
 * - send(): POST /emails → Resend API
 * - getMetrics(): email_events tablosundan aggregate (Resend dedicated metrics endpoint'i YOK)
 * - listEvents(): email_events tablosundan filtre + paginate
 * - healthCheck(): GET /domains (lightweight ping)
 *
 * Replace-safety:
 *   Gelecekte SendGrid/Postmark/Mailgun istenirse → src/mail/sendgrid-adapter.ts yazılır,
 *   `index.ts`'te swap, geri kalan kod (email-send.ts, digest-sender.ts) HİÇ değişmez.
 */
import { sql } from '../db.js';
import type {
  EventListFilter,
  MailEvent,
  MailEventType,
  MailProvider,
  MetricsDataPoint,
  MetricsFilter,
  MetricsResult,
  MetricsRates,
  MetricsTotals,
  MetricsWindow,
  SendInput,
  SendResult,
} from './types.js';

const WINDOW_HOURS: Record<MetricsWindow, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  '90d': 24 * 90,
};

export class ResendProvider implements MailProvider {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.resend.com',
  ) {}

  // =========================================================
  // send
  // =========================================================
  async send(input: SendInput): Promise<SendResult> {
    if (!this.apiKey) {
      return { ok: false, error: 'RESEND_API_KEY env eksik' };
    }

    const payload: Record<string, unknown> = {
      from: input.from,
      to: Array.isArray(input.to) ? input.to : [input.to],
      subject: input.subject,
    };
    if (input.html) payload.html = input.html;
    if (input.text) payload.text = input.text;
    if (input.replyTo) payload.reply_to = input.replyTo;
    if (input.cc?.length) payload.cc = input.cc;
    if (input.bcc?.length) payload.bcc = input.bcc;
    if (input.tags?.length) payload.tags = input.tags;
    if (input.headers && Object.keys(input.headers).length > 0) payload.headers = input.headers;
    if (input.attachments?.length) {
      payload.attachments = input.attachments.map((a) => ({
        filename: a.filename,
        content: typeof a.content === 'string' ? a.content : a.content.toString('base64'),
        content_type: a.contentType,
        content_id: a.contentId,
      }));
    }

    try {
      const res = await fetch(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        return {
          ok: false,
          error: `Resend ${res.status}: ${JSON.stringify(data)}`,
          status: res.status,
          raw: data,
        };
      }
      return {
        ok: true,
        messageId: (data as any)?.id,
        status: res.status,
        raw: data,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  // =========================================================
  // getMetrics — email_events + email_messages tablolarından aggregate
  //
  // Şema:
  //   email_events(id, message_id FK→email_messages.id, event_type, occurred_at, raw_payload)
  //   email_messages(id, direction, sent_at, campaign_id, ...)
  //
  // - "sent" sayısı: email_messages.sent_at filtre (event_type='sent' webhook'tan gelmiyor)
  // - "delivered/bounced/opened/clicked/complained/failed": email_events üzerinden DISTINCT message_id
  // =========================================================
  async getMetrics(window: MetricsWindow, filter?: MetricsFilter): Promise<MetricsResult> {
    const hours = WINDOW_HOURS[window];
    const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const nowIso = new Date().toISOString();

    // 1. Sent count — email_messages.sent_at
    const sentRows = await sql<Array<{ cnt: string }>>`
      SELECT COUNT(*) AS cnt
      FROM email_messages
      WHERE direction = 'outbound'
        AND sent_at >= ${sinceIso}
        ${filter?.campaignId ? sql`AND campaign_id = ${filter.campaignId}` : sql``}
    `;
    const sentCount = Number(sentRows[0]?.cnt ?? 0);

    // 2. Diğer event sayıları — email_events JOIN email_messages
    const eventRows = filter?.campaignId
      ? await sql<Array<{ event_type: string; unique_msgs: string }>>`
          SELECT e.event_type::text AS event_type, COUNT(DISTINCT e.message_id) AS unique_msgs
          FROM email_events e
          JOIN email_messages m ON m.id = e.message_id
          WHERE e.occurred_at >= ${sinceIso}
            AND m.campaign_id = ${filter.campaignId}
          GROUP BY e.event_type
        `
      : await sql<Array<{ event_type: string; unique_msgs: string }>>`
          SELECT event_type::text AS event_type, COUNT(DISTINCT message_id) AS unique_msgs
          FROM email_events
          WHERE occurred_at >= ${sinceIso}
          GROUP BY event_type
        `;

    const total: MetricsTotals = {
      sent: sentCount,
      delivered: 0,
      bounced: 0,
      complained: 0,
      opened: 0,
      clicked: 0,
      failed: 0,
    };
    for (const row of eventRows) {
      const n = Number(row.unique_msgs ?? 0);
      switch (row.event_type) {
        case 'delivered': total.delivered = n; break;
        case 'bounced': total.bounced = n; break;
        case 'complained': total.complained = n; break;
        case 'opened': total.opened = n; break;
        case 'clicked': total.clicked = n; break;
        case 'failed': total.failed = n; break;
      }
    }

    const safe = (num: number, denom: number) => (denom > 0 ? Math.round((num / denom) * 10000) / 100 : 0);
    const rates: MetricsRates = {
      deliveryRate: safe(total.delivered, total.sent),
      bounceRate: safe(total.bounced, total.sent),
      openRate: safe(total.opened, total.delivered),
      clickRate: safe(total.clicked, total.delivered),
      complaintRate: safe(total.complained, total.delivered),
    };

    // 3. Time series — günlük breakdown (sent + diğer event'ler)
    const seriesMap = new Map<string, MetricsDataPoint>();

    const sentSeries = filter?.campaignId
      ? await sql<Array<{ day: string; cnt: string }>>`
          SELECT TO_CHAR(DATE_TRUNC('day', sent_at), 'YYYY-MM-DD') AS day, COUNT(*) AS cnt
          FROM email_messages
          WHERE direction = 'outbound' AND sent_at >= ${sinceIso}
            AND campaign_id = ${filter.campaignId}
          GROUP BY 1 ORDER BY 1
        `
      : await sql<Array<{ day: string; cnt: string }>>`
          SELECT TO_CHAR(DATE_TRUNC('day', sent_at), 'YYYY-MM-DD') AS day, COUNT(*) AS cnt
          FROM email_messages
          WHERE direction = 'outbound' AND sent_at >= ${sinceIso}
          GROUP BY 1 ORDER BY 1
        `;
    for (const r of sentSeries) {
      const cur = seriesMap.get(r.day) ?? { date: r.day, sent: 0, delivered: 0, bounced: 0, opened: 0, clicked: 0 };
      cur.sent = Number(r.cnt ?? 0);
      seriesMap.set(r.day, cur);
    }

    const eventSeries = filter?.campaignId
      ? await sql<Array<{ day: string; event_type: string; unique_msgs: string }>>`
          SELECT TO_CHAR(DATE_TRUNC('day', e.occurred_at), 'YYYY-MM-DD') AS day,
                 e.event_type::text AS event_type,
                 COUNT(DISTINCT e.message_id) AS unique_msgs
          FROM email_events e
          JOIN email_messages m ON m.id = e.message_id
          WHERE e.occurred_at >= ${sinceIso}
            AND m.campaign_id = ${filter.campaignId}
          GROUP BY 1, 2 ORDER BY 1
        `
      : await sql<Array<{ day: string; event_type: string; unique_msgs: string }>>`
          SELECT TO_CHAR(DATE_TRUNC('day', occurred_at), 'YYYY-MM-DD') AS day,
                 event_type::text AS event_type,
                 COUNT(DISTINCT message_id) AS unique_msgs
          FROM email_events
          WHERE occurred_at >= ${sinceIso}
          GROUP BY 1, 2 ORDER BY 1
        `;
    for (const r of eventSeries) {
      const cur = seriesMap.get(r.day) ?? { date: r.day, sent: 0, delivered: 0, bounced: 0, opened: 0, clicked: 0 };
      const n = Number(r.unique_msgs ?? 0);
      switch (r.event_type) {
        case 'delivered': cur.delivered = n; break;
        case 'bounced': cur.bounced = n; break;
        case 'opened': cur.opened = n; break;
        case 'clicked': cur.clicked = n; break;
      }
      seriesMap.set(r.day, cur);
    }

    const series = Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    return {
      provider: this.name,
      window,
      windowStart: sinceIso,
      windowEnd: nowIso,
      total,
      rates,
      series,
    };
  }

  // =========================================================
  // listEvents — debugging + audit
  //   email_events.message_id → email_messages.id (uuid)
  //   resend_message_id email_messages tablosunda
  // =========================================================
  async listEvents(filter: EventListFilter): Promise<MailEvent[]> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = filter.messageId
      ? await sql<Array<any>>`
          SELECT e.id, m.resend_message_id, e.event_type::text AS event_type,
                 m.to_email AS recipient, e.occurred_at, e.raw_payload
          FROM email_events e
          JOIN email_messages m ON m.id = e.message_id
          WHERE (m.resend_message_id = ${filter.messageId} OR e.message_id::text = ${filter.messageId})
          ${filter.recipient ? sql`AND m.to_email = ${filter.recipient}` : sql``}
          ${filter.type ? sql`AND e.event_type::text = ${filter.type}` : sql``}
          ${filter.since ? sql`AND e.occurred_at >= ${filter.since}` : sql``}
          ORDER BY e.occurred_at DESC
          LIMIT ${limit}
        `
      : await sql<Array<any>>`
          SELECT e.id, m.resend_message_id, e.event_type::text AS event_type,
                 m.to_email AS recipient, e.occurred_at, e.raw_payload
          FROM email_events e
          JOIN email_messages m ON m.id = e.message_id
          WHERE 1=1
          ${filter.recipient ? sql`AND m.to_email = ${filter.recipient}` : sql``}
          ${filter.type ? sql`AND e.event_type::text = ${filter.type}` : sql``}
          ${filter.since ? sql`AND e.occurred_at >= ${filter.since}` : sql``}
          ORDER BY e.occurred_at DESC
          LIMIT ${limit}
        `;

    return rows.map((r: any) => ({
      id: r.id,
      messageId: r.resend_message_id ?? '',
      type: this.normalizeEventType(r.event_type),
      recipient: r.recipient ?? '',
      occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
      metadata: r.raw_payload ?? undefined,
    }));
  }

  private normalizeEventType(raw: string): MailEventType {
    const stripped = raw.replace(/^email\./, '');
    if (['sent', 'delivered', 'bounced', 'complained', 'opened', 'clicked', 'failed', 'delivery_delayed'].includes(stripped)) {
      return stripped as MailEventType;
    }
    return 'failed';
  }

  // =========================================================
  // healthCheck — lightweight Resend API ping
  // =========================================================
  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (!this.apiKey) {
      return { ok: false, details: 'RESEND_API_KEY env eksik' };
    }
    try {
      const res = await fetch(`${this.baseUrl}/domains`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (res.ok) {
        return { ok: true, details: `Resend ${res.status}` };
      }
      const body = await res.text();
      // Send-only / restricted key özel durumu: 401 "restricted_api_key" → key valid,
      // domain endpoint'e yetki yok ama send çalışır. Sağlık ok kabul et.
      if (res.status === 401 && body.includes('restricted_api_key')) {
        return { ok: true, details: 'send-only key (restricted, send-emails scope only)' };
      }
      return { ok: false, details: `Resend ${res.status}: ${body.slice(0, 200)}` };
    } catch (e: any) {
      return { ok: false, details: String(e?.message ?? e) };
    }
  }
}
