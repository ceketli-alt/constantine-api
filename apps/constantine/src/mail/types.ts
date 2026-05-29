/**
 * MailProvider abstraction — Constantine'in mail katmanı.
 *
 * Felsefe:
 *   - Domain layer (email-send.ts, digest-sender.ts, vb.) HİÇBİR provider'a doğrudan bağlı değil.
 *   - Provider değişimi (Resend → SendGrid → Postmark) sadece adapter swap'i ile yapılır.
 *   - Metrics aggregation provider-agnostic: webhook'lardan dolan `email_events` tablosu kaynak.
 *
 * Mevcut implementation: ResendProvider (`./resend-adapter.ts`).
 * Singleton export: `./index.ts` → `mailProvider`.
 */

// =========================================================
// Send
// =========================================================

export interface SendAttachment {
  filename: string;
  content: string | Buffer; // base64 string veya Buffer
  contentType?: string;
  contentId?: string;       // inline images için
}

export interface SendInput {
  /** "Display Name <email@domain>" formatında. Sadece email de OK. */
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  /** Provider tag'leri — kategorizasyon + filtering için (Resend'de native, diğerlerinde header'a düşer). */
  tags?: Array<{ name: string; value: string }>;
  /** Custom email header'ları — threading (In-Reply-To, References) ve diğer. */
  headers?: Record<string, string>;
  attachments?: SendAttachment[];
}

export interface SendResult {
  ok: boolean;
  /** Provider'ın döndüğü unique message id (örn. Resend `re_xxx`). */
  messageId?: string;
  /** Hata mesajı (ok=false durumunda). */
  error?: string;
  /** HTTP status code (debugging). */
  status?: number;
  /** Provider'ın ham response'u (raw access için, optional). */
  raw?: unknown;
}

// =========================================================
// Metrics
// =========================================================

/** Time window — backend her zaman bu kümeden birini bekler. */
export type MetricsWindow = '24h' | '7d' | '30d' | '90d';

export interface MetricsTotals {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  failed: number;
  /** Toplam unique recipient (bir mailin opened+clicked aynı kişi olabilir). */
  uniqueRecipients?: number;
}

export interface MetricsRates {
  /** delivered / sent */
  deliveryRate: number;
  /** bounced / sent */
  bounceRate: number;
  /** opened / delivered */
  openRate: number;
  /** clicked / delivered */
  clickRate: number;
  /** complained / delivered (spam button) */
  complaintRate: number;
}

export interface MetricsDataPoint {
  /** ISO date "YYYY-MM-DD" — günlük breakdown. */
  date: string;
  sent: number;
  delivered: number;
  bounced: number;
  opened: number;
  clicked: number;
}

export interface MetricsResult {
  provider: string;             // "resend", "db" vs
  window: MetricsWindow;
  windowStart: string;          // ISO timestamp
  windowEnd: string;
  total: MetricsTotals;
  rates: MetricsRates;
  series: MetricsDataPoint[];   // günlük time series
  /** Tag bazlı breakdown — Resend tags ile sınıflandırılmış (örn. "kind=outreach" vs "kind=transactional"). */
  byTag?: Record<string, MetricsTotals>;
}

export interface MetricsFilter {
  /** Belirli bir tag'e göre filtre (örn. `{ name: 'kind', value: 'outreach' }`). */
  tag?: { name: string; value: string };
  /** Belirli kampanyaya göre filtre. */
  campaignId?: string;
}

// =========================================================
// Events (audit + cross-check için)
// =========================================================

export type MailEventType =
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'failed'
  | 'delivery_delayed';

export interface MailEvent {
  id: string;
  messageId: string;
  type: MailEventType;
  recipient: string;
  occurredAt: string;          // ISO timestamp
  metadata?: Record<string, unknown>;
}

export interface EventListFilter {
  messageId?: string;
  recipient?: string;
  type?: MailEventType;
  since?: string;
  limit?: number;
}

// =========================================================
// MailProvider interface
// =========================================================

export interface MailProvider {
  /** Provider tanıtıcısı: "resend", "sendgrid", "postmark", "mailcow-smtp" vs. */
  readonly name: string;

  /** Tek bir mail gönderim. */
  send(input: SendInput): Promise<SendResult>;

  /** Aggregate metrics — DB'deki email_events üzerinden hesaplanır. */
  getMetrics(window: MetricsWindow, filter?: MetricsFilter): Promise<MetricsResult>;

  /** Event log listesi (debugging + audit). */
  listEvents(filter: EventListFilter): Promise<MailEvent[]>;

  /** Sağlık check — API erişimi + key validity. */
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
}
