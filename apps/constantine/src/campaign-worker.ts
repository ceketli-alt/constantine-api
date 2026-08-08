/**
 * Campaign worker — in-process background tick.
 *
 * Görevler:
 *  - Her TICK_INTERVAL_MS'de `campaigns WHERE status='running'` çek
 *  - Her kampanya için (per-tick bütçe = min(daily_cap kalanı, BATCH_SIZE)):
 *      * daily_cap remaining = cap - bugün giden TÜM mailler (email_messages, ilk+takip)
 *      * Phase A — vakti gelen takipler (next_followup_at <= now): follow_up_steps'teki
 *        sıradaki template ile, ilk mailin subject'i+alıcısı ile (in-thread) gönder.
 *        Başarılıysa sequence_step++ ve sıradaki next_followup_at kurulur (yoksa NULL).
 *      * Phase B — `campaign_targets WHERE status='queued'` LIMIT kalan bütçe; ilk mail.
 *        status='sent' → trigger ilk takibi (varsa) otomatik zamanlar.
 *      * Sonuç: campaign_targets.status = 'sent' | 'opted_out' | 'failed' | 'replied'
 *      * Resend rate limit (5 req/s) honoring: ardışık SEND_GAP_MS delay
 *  - Ne queued ne bekleyen takip kaldıysa: campaigns.status = 'completed'
 *  - Reply gelince (email-inbound) hedef 'replied' olur → takip durur.
 *
 * sendEmailCore'u çağırırken ctx.userId = campaigns.created_by kullanılır
 * (activity_events.user_id zorunlu). Yoksa fallback super_admin'in id'si.
 */
import { sql } from './db.js';
import { sendEmailCore } from './email-send.js';
import { computeAbWinner, type AbVariantStat } from './ab-winner.js';
import { isWithinSendWindow } from './send-window.js';
import { capForDay } from './cron-warmup-tick.js';

const TICK_INTERVAL_MS = Number(process.env.CAMPAIGN_WORKER_TICK_MS ?? 60_000);
const BATCH_SIZE = Number(process.env.CAMPAIGN_WORKER_BATCH_SIZE ?? 10);
const SEND_GAP_MS = Number(process.env.CAMPAIGN_WORKER_SEND_GAP_MS ?? 250); // 5 req/s'den güvenli aralık
// Gönderim penceresi saat dilimi — kampanya send_window/send_days'i bu tz'de değerlendirilir.
const SEND_TZ = process.env.CAMPAIGN_WORKER_TZ ?? 'Europe/Istanbul';
// Tek bir gönderimin maksimum süresi. Bunu aşarsa asılı kabul edilir (worker donmasın). 90sn cömert (gerçek gönderim <10sn).
const SEND_TIMEOUT_MS = Number(process.env.CAMPAIGN_WORKER_SEND_TIMEOUT_MS ?? 90_000);
// Free-email sağlayıcıları — bunlar ŞİRKET DEĞİL (37 farklı işletme gmail.com kullanabilir). Per-company
// günlük domain limiti (max_per_company_per_day) bunlara UYGULANMAZ; yoksa tek "gmail.com" kümesi tüm
// kampanyayı günde 1'e kısar ve kuyruğun önünü tıkar (2026-06-22 stall: 89 queued'ın 37'si gmail).
const FREEMAIL = new Set<string>([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'hotmail.com.tr',
  'outlook.com', 'outlook.com.tr', 'live.com', 'live.com.tr', 'msn.com', 'windowslive.com',
  'yahoo.com', 'yahoo.com.tr', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.com.tr', 'yandex.ru',
  'proton.me', 'protonmail.com',
]);

let tickHandle: NodeJS.Timeout | null = null;
let running = false;
let skippedTicks = 0; // uzun tick sürerken atlanan dakika-tick sayısı (log özetleme için)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Worker dayanıklılığı (2026-06-19 fix). sendEmailCore'u timeout ile sarar. Altta yatan ağ
 * çağrısı (SMTP relay / Resend HTTP) süresiz asılırsa await ASLA dönmez → for-loop donar →
 * tick bitmez → `running` flag'i true takılı kalır → TÜM worker sessizce ölür. Gözlenen olay:
 * gönderim 10:55'te durdu, 6.5 saat hiç tick yok, hata bile loglanmadı (sessiz asılma).
 * Bu wrapper SEND_TIMEOUT_MS sonra asılan gönderimi reddeder; çağıran döngü bunu sıradan bir
 * "geçici hata" sonucu gibi işleyip SIRADAKİNE geçer, worker yaşamaya devam eder.
 */
async function sendWithTimeout(
  input: Parameters<typeof sendEmailCore>[0],
  ctx: Parameters<typeof sendEmailCore>[1],
  label: string,
): Promise<Awaited<ReturnType<typeof sendEmailCore>>> {
  let timer: NodeJS.Timeout | undefined;
  const p = sendEmailCore(input, ctx);
  p.catch(() => {}); // timeout race'i kazanırsa orijinal promise'in geç reddi unhandled kalmasın
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`send_timeout ${SEND_TIMEOUT_MS}ms`)), SEND_TIMEOUT_MS);
      }),
    ]);
  } catch (e: any) {
    console.error(`[worker] send timeout/err (${label}): ${e?.message}`);
    return { success: false, error: `send_timeout: ${e?.message ?? 'unknown'}` } as Awaited<
      ReturnType<typeof sendEmailCore>
    >;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * G3 — gönderimler arası bekleme (ms). Resend rate-limit gap'i (SEND_GAP_MS, 5 req/s) TABAN;
 * kampanya min_gap_seconds + [0, random_gap_seconds) jitter bunun ÜSTÜNE eklenir (insansı patern).
 * Test edilebilirlik için rng enjekte edilebilir.
 */
export function computeSendGapMs(
  campaign: { min_gap_seconds?: number | null; random_gap_seconds?: number | null },
  rng: () => number = Math.random,
): number {
  const minMs = Math.max(0, campaign.min_gap_seconds ?? 0) * 1000;
  const randSec = Math.max(0, campaign.random_gap_seconds ?? 0);
  const jitterMs = randSec > 0 ? Math.floor(rng() * randSec * 1000) : 0;
  return Math.max(SEND_GAP_MS, minMs + jitterMs);
}

async function resolveFallbackUserId(): Promise<string | null> {
  const rows = await sql`
    SELECT id
    FROM profiles
    WHERE role = 'super_admin' AND active = true
    ORDER BY created_at
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

interface FollowUpStep {
  template_id: string;
  delay_days: number;
}

interface CampaignRow {
  id: string;
  template_id: string | null;
  sender_email: string | null;
  sender_pool: string[] | null;
  daily_cap: number | null;
  segment_filter: any;
  created_by: string | null;
  follow_up_steps: FollowUpStep[] | null;
  ab_test_enabled: boolean | null;
  ab_winner_variant: string | null;
  ab_winning_metric: string | null;  // 'auto' | 'reply' | 'open' (G — Faz 2 metrik seçimi)
  send_window_start: string | null; // Postgres `time` → "HH:MM:SS" string
  send_window_end: string | null;   // Postgres `time` → "HH:MM:SS" string
  send_days: number[] | null;       // integer[], ISO dow 1=Pzt … 7=Paz
  warmup_enabled: boolean | null;   // true → campaign_warmup_state cap ramp + auto-pause uygulanır
  // Faz 1 — gönderim gerçekçiliği + throttling (0006)
  min_gap_seconds: number | null;        // G3 insansı gönderim aralığı (min)
  random_gap_seconds: number | null;     // G3 rastgele ek süre (jitter)
  max_new_leads_per_day: number | null;  // G4 günlük yeni lead (initial) limiti — null=limitsiz
  prioritize_new_leads: boolean | null;  // G4 true → Phase B (initials) Phase A'dan önce
  send_text_only: boolean | null;        // G7 tüm mailler text-only
  first_email_text_only: boolean | null; // G7 sadece ilk mail text-only
  max_per_company_per_day: number | null;// G8 domain başına günlük limit — null=limitsiz
  stop_company_on_reply: boolean | null;  // G8 (email-inbound'da kullanılır; tutarlılık için burada da)
}

/** target.variant veya kazanan → geçerli 'a'|'b' ya da undefined. */
function normVariant(v: unknown): 'a' | 'b' | undefined {
  return v === 'a' || v === 'b' ? v : undefined;
}

/**
 * Takip maili konusu: orijinal konuyu "Re: " ile öne ekle (varsa tekrar etme).
 * → alıcının kutusunda yanıt gibi görünür + Gmail/Outlook aynı thread'de toplar
 * (normalize edilmiş subject eşleşmesi). RFC In-Reply-To header'ı Resend kendi
 * Message-ID'sini ürettiği için güvenilir değil; subject-bazlı threading kullanıyoruz.
 */
function reSubject(subject: string | null | undefined): string | undefined {
  const s = (subject ?? '').trim();
  if (!s) return undefined;
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** UUID → [0, mod) deterministik index (ilk 8 hex hane). */
function hashToIndex(uuid: string, mod: number): number {
  if (mod <= 1) return 0;
  const hex = String(uuid).replace(/[^0-9a-f]/gi, '').slice(0, 8);
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n % mod : 0;
}

/**
 * Bir lead için gönderici adresi seç. sender_pool doluysa lead_id hash'ine göre
 * STICKY seçim (lead'in tüm sequence'i aynı adresten); değilse tek sender_email.
 */
function pickSender(campaign: CampaignRow, leadId: string): string | undefined {
  const pool = Array.isArray(campaign.sender_pool)
    ? campaign.sender_pool.filter((s) => typeof s === 'string' && s.includes('@'))
    : [];
  if (pool.length > 0) return pool[hashToIndex(leadId, pool.length)];
  return campaign.sender_email ?? undefined;
}

/**
 * A/B otomatik kazanan — yeterli örneklem varsa kazananı belirler ve campaigns'e yazar.
 * Belirlendikten sonra KALAN tüm ilk gönderimler kazanan varyantla gider (in-memory'de de
 * güncellenir → aynı tick'te etkili). Sadece ab_test_enabled + winner henüz NULL iken çalışır.
 */
async function maybeResolveAbWinner(campaign: CampaignRow): Promise<void> {
  if (!campaign.ab_test_enabled || campaign.ab_winner_variant) return;

  const rows = await sql`
    SELECT ct.variant,
      count(*) FILTER (WHERE ct.status IN ('sent','replied'))::int AS sent,
      count(*) FILTER (WHERE ct.status = 'replied')::int AS replied,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM email_messages em
        JOIN email_threads et ON et.id = em.thread_id
        WHERE em.campaign_id = ct.campaign_id AND et.lead_id = ct.lead_id
          AND em.direction = 'outbound' AND em.opened_at IS NOT NULL
      ))::int AS opened
    FROM campaign_targets ct
    WHERE ct.campaign_id = ${campaign.id} AND ct.variant IN ('a', 'b')
    GROUP BY ct.variant
  `;

  const stat: Record<'a' | 'b', AbVariantStat> = {
    a: { variant: 'a', sent: 0, opened: 0, replied: 0 },
    b: { variant: 'b', sent: 0, opened: 0, replied: 0 },
  };
  for (const r of rows) {
    const v = normVariant(r.variant);
    if (v) stat[v] = { variant: v, sent: r.sent ?? 0, opened: r.opened ?? 0, replied: r.replied ?? 0 };
  }

  const metricOpt = (campaign.ab_winning_metric === 'reply' || campaign.ab_winning_metric === 'open')
    ? campaign.ab_winning_metric
    : 'auto';
  const decision = computeAbWinner(stat.a, stat.b, { metric: metricOpt });
  if (!decision.winner) return;

  await sql`
    UPDATE campaigns SET ab_winner_variant = ${decision.winner}
    WHERE id = ${campaign.id} AND ab_winner_variant IS NULL
  `;
  campaign.ab_winner_variant = decision.winner; // bu tick'teki gönderimler kazananı kullanır

  try {
    const adminRows = await sql`SELECT id FROM profiles WHERE role='super_admin' AND active=true ORDER BY created_at LIMIT 1`;
    const adminId = campaign.created_by ?? adminRows[0]?.id;
    if (adminId) {
      const meta = {
        winner: decision.winner,
        metric: decision.metric,
        auto: true,
        stats: {
          a: { sent: stat.a.sent, opened: stat.a.opened, replied: stat.a.replied },
          b: { sent: stat.b.sent, opened: stat.b.opened, replied: stat.b.replied },
        },
      };
      await sql`
        INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
        VALUES (${adminId}::uuid, 'ab_test_resolved', 'standard', 0, 'campaign', ${campaign.id}::uuid, ${sql.json(meta)})
      `;
    }
  } catch (e: any) {
    console.warn('[worker] ab_test_resolved log skipped:', e.message);
  }
  console.log(`[worker] campaign ${campaign.id} A/B winner=${decision.winner} (metric=${decision.metric})`);
}

interface TargetRow {
  id: string;
  lead_id: string;
  variant: string | null;
  // Per-target override (Agent Day 2026-06-04 follow-up için 2026-06-08'de eklendi).
  // Doluysa template render atlanır, sendEmailCore raw subject+body kullanır.
  subject_override: string | null;
  body_text_override: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Bir hedef için ilk gönderimdeki subject + recipient'i bul (aynı thread + alıcı).
 * Takip maili aynı subject ile gider → Gmail/Outlook aynı thread'de gruplar.
 */
async function fetchOriginalSend(
  campaignId: string,
  leadId: string,
): Promise<{ subject: string | null; to_email: string | null }> {
  const rows = await sql`
    SELECT em.subject, em.to_email
    FROM email_messages em
    JOIN email_threads et ON et.id = em.thread_id
    WHERE em.campaign_id = ${campaignId}
      AND et.lead_id = ${leadId}
      AND em.direction = 'outbound'
    ORDER BY em.sent_at DESC NULLS LAST
    LIMIT 1
  `;
  return { subject: rows[0]?.subject ?? null, to_email: rows[0]?.to_email ?? null };
}

/**
 * Phase A — vakti gelen takipleri gönder (next_followup_at <= now).
 * Takipler önceliklidir: zaman-hassas + lead zaten engaged.
 * Dönen değer: kalan gönderim bütçesi (Phase B'ye devredilir).
 */
async function processFollowUps(
  campaign: CampaignRow,
  steps: FollowUpStep[],
  budgetIn: number,
  ctxUserId: string,
): Promise<number> {
  let budget = budgetIn;
  const due: Array<{ id: string; lead_id: string; sequence_step: number; variant: string | null }> = await sql`
    SELECT id, lead_id, sequence_step, variant
    FROM campaign_targets
    WHERE campaign_id = ${campaign.id}
      AND status = 'sent'
      AND next_followup_at IS NOT NULL
      AND next_followup_at <= now()
    ORDER BY next_followup_at
    LIMIT ${budget}
  `;

  for (const t of due) {
    if (budget <= 0) break;
    const nextStep = (t.sequence_step ?? 0) + 1; // gönderilecek takip (1-based)
    const stepCfg = steps[nextStep - 1];          // steps array 0-based
    if (!stepCfg || !stepCfg.template_id) {
      // Tanımlı adım kalmadı → takibi kapat
      await sql`UPDATE campaign_targets SET next_followup_at = NULL WHERE id = ${t.id}`;
      continue;
    }

    const orig = await fetchOriginalSend(campaign.id, t.lead_id);

    const result = await sendWithTimeout(
      {
        lead_id: t.lead_id,
        template_id: stepCfg.template_id,
        sender_email: pickSender(campaign, t.lead_id),    // sticky: ilk maille aynı adres
        campaign_id: campaign.id,
        override_to_email: orig.to_email ?? undefined,   // aynı alıcı
        subject_override: reSubject(orig.subject),        // "Re: <orijinal konu>" → yanıt gibi, aynı thread
        sequence_step: nextStep,
        variant: normVariant(t.variant),                  // takip de aynı varyant (B template varsa)
        text_only: campaign.send_text_only === true,      // G7 (first_email_text_only sadece step 0 için)
      },
      { userId: ctxUserId, role: 'super_admin' },
      `followup ${t.id} step ${nextStep}`,
    );

    if (result.success || result.deduped) {
      const hasMore = steps.length > nextStep; // bu adımdan SONRA adım var mı
      const nextAt = hasMore
        ? new Date(Date.now() + Math.max(0, steps[nextStep]!.delay_days ?? 3) * DAY_MS).toISOString()
        : null;
      await sql`
        UPDATE campaign_targets
        SET sequence_step = ${nextStep}, next_followup_at = ${nextAt}
        WHERE id = ${t.id}
      `;
      if (result.success) {
        budget--; // deduped = gerçek gönderim değil, bütçe yeme
        await sleep(computeSendGapMs(campaign));
      }
    } else if (result.blocked) {
      await sql`
        UPDATE campaign_targets
        SET status = 'opted_out', next_followup_at = NULL, error = ${result.error ?? 'opted_out'}
        WHERE id = ${t.id}
      `;
    } else {
      // Geçici hata — 1 saat sonra tekrar dene (aynı tick'te sonsuz döngü olmasın)
      await sql`
        UPDATE campaign_targets
        SET next_followup_at = now() + interval '1 hour', error = ${result.error ?? 'unknown'}
        WHERE id = ${t.id}
      `;
      console.warn(`[worker] followup target ${t.id} (step ${nextStep}) failed: ${result.error}`);
      await sleep(computeSendGapMs(campaign));
    }
  }
  return budget;
}

/**
 * Phase B — yeni ilk mailler (queued targets). status='sent' olunca trigger
 * (trg_schedule_first_followup) ilk takibi otomatik zamanlar.
 */
async function processInitials(
  campaign: CampaignRow,
  targetRole: string | null,
  budget: number,
  ctxUserId: string,
): Promise<number> {
  // scheduled_at (opsiyonel) doluysa erkenden gönderme: VIP batch'lerde lead başına
  // elden zaman ataması için (Agent Day 2026-06-04 follow-up, 10-12 Haz 30 dk aralıkla).
  // NULL bırakılırsa eski davranış (FIFO + throttle aralığı) korunur.
  const queuedRows: Array<TargetRow & { primary_contact_email: string | null; source_meta: any }> = await sql`
    SELECT ct.id, ct.lead_id, ct.variant, ct.subject_override, ct.body_text_override,
           l.primary_contact_email, l.source_meta
    FROM campaign_targets ct
    JOIN leads l ON l.id = ct.lead_id
    WHERE ct.campaign_id = ${campaign.id}
      AND ct.status = 'queued'
      AND (ct.scheduled_at IS NULL OR ct.scheduled_at <= now())
    ORDER BY COALESCE(ct.scheduled_at, ct.created_at)
    LIMIT ${budget}
  `;
  if (queuedRows.length === 0) return 0;

  // G8 — domain başına günlük limit: bugün her domain'e giden sayıyı önceden çek (in-memory tally).
  const maxPerCompany = campaign.max_per_company_per_day ?? null;
  const domainCount = new Map<string, number>();
  if (maxPerCompany != null && maxPerCompany > 0) {
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const dc: Array<{ domain: string; n: number }> = await sql`
      SELECT lower(split_part(to_email, '@', 2)) AS domain, count(*)::int AS n
      FROM email_messages
      WHERE campaign_id = ${campaign.id} AND direction = 'outbound' AND sent_at >= ${dayStart.toISOString()}
      GROUP BY 1
    `;
    for (const r of dc) if (r.domain) domainCount.set(r.domain, Number(r.n));
  }

  let sentCount = 0;
  for (const target of queuedRows) {
    let overrideTo: string | undefined;
    if (targetRole) {
      const sm = (target.source_meta ?? {}) as Record<string, unknown>;
      const byRole = (sm.emails_by_role ?? {}) as Record<string, string[]>;
      const arr = byRole[targetRole];
      if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'string') {
        overrideTo = arr[0];
      }
      // Lead bu rol için email taşımıyorsa fallback primary email — ek aksiyon yok
    }

    // G8 — alıcı domain'i günlük kapasiteyi doldurduysa bu lead'i ATLA (queued kalır, ertesi tick/gün denenir)
    const recipient = (overrideTo ?? target.primary_contact_email ?? '').toLowerCase();
    const domain = recipient.includes('@') ? recipient.split('@')[1]! : '';
    // Free-email (gmail/hotmail/yahoo...) ŞİRKET DEĞİL → per-company limitinden MUAF (yoksa kuyruk tıkanır).
    if (
      maxPerCompany != null && maxPerCompany > 0 && domain &&
      !FREEMAIL.has(domain) && (domainCount.get(domain) ?? 0) >= maxPerCompany
    ) {
      continue;
    }

    // Per-target override: doluysa template render atlanır, raw subject+body kullanılır.
    // Agent Day 2026-06-04 follow-up gibi her lead'in farklı kişiselleştirilmiş içeriği
    // olduğu VIP batch'lerde kullanılır.
    const hasOverride = !!(target.body_text_override && target.body_text_override.trim());
    const result = await sendWithTimeout(
      {
        lead_id: target.lead_id,
        template_id: hasOverride ? undefined : (campaign.template_id ?? undefined),
        subject: hasOverride ? (target.subject_override ?? undefined) : undefined,
        body_text: hasOverride ? (target.body_text_override ?? undefined) : undefined,
        sender_email: pickSender(campaign, target.lead_id),
        campaign_id: campaign.id,
        override_to_email: overrideTo,
        sequence_step: 0,
        // A/B: kazanan belirlendiyse herkese kazanan; yoksa target'a atanan varyant
        variant: normVariant(campaign.ab_winner_variant ?? target.variant),
        text_only: campaign.send_text_only === true || campaign.first_email_text_only === true, // G7
      },
      { userId: ctxUserId, role: 'super_admin' },
      `init ${target.id}`,
    );

    if (result.success) {
      sentCount++;
      if (domain && !FREEMAIL.has(domain)) domainCount.set(domain, (domainCount.get(domain) ?? 0) + 1); // G8 tally (free-email hariç)
      // status='sent' → trigger next_followup_at'i (follow_up_steps varsa) kurar
      await sql`
        UPDATE campaign_targets
        SET status = 'sent', sent_at = now()
        WHERE id = ${target.id}
      `;
    } else if (result.blocked) {
      await sql`
        UPDATE campaign_targets
        SET status = 'opted_out', error = ${result.error ?? 'opted_out'}
        WHERE id = ${target.id}
      `;
    } else {
      await sql`
        UPDATE campaign_targets
        SET status = 'failed', error = ${result.error ?? 'unknown'}
        WHERE id = ${target.id}
      `;
      console.warn(`[worker] target ${target.id} failed: ${result.error}`);
    }

    // Resend rate limit (5 req/s) tabanı + G3 insansı gap/jitter
    await sleep(computeSendGapMs(campaign));
  }
  return sentCount;
}

async function processCampaign(campaign: CampaignRow, fallbackUserId: string | null): Promise<void> {
  // Gönderim penceresi: iş saatleri + hafta içi (TR saati) dışındaki tick'lerde gönderme.
  // Deliverability — gece/hafta sonu gönderim spam sinyali. (daily_cap'ten önce: pencere
  // dışındaysa boş yere sayım sorgusu da atılmaz.)
  if (!isWithinSendWindow(new Date(), campaign.send_window_start, campaign.send_window_end, campaign.send_days, SEND_TZ)) {
    return;
  }

  // ── Warmup state: bounce/complaint auto-pause + volume ramp ──
  // campaign_warmup_state cron-warmup-tick (günlük 00:05 UTC) tarafından yönetilir:
  // current_cap'i gün gün ramp'ler ve bounce/complaint eşiği aşılırsa paused_until set eder.
  // Worker bu satırı OKUYARAK gerçek gönderimi bu kararlara bağlar (yoksa yalnız daily_cap).
  // Satır warmup_enabled email kampanyalarında trg_init_warmup ile açılır; defensive olarak
  // (eski kampanya / sonradan toggle / silinmiş satır) burada da seed ederiz.
  const warmupEnabled = campaign.warmup_enabled !== false;
  let warmupCap: number | null = null;
  if (warmupEnabled) {
    await sql`
      INSERT INTO campaign_warmup_state (campaign_id, warmup_day, current_cap)
      VALUES (${campaign.id}, 1, ${capForDay(1)})
      ON CONFLICT (campaign_id) DO NOTHING
    `;
    const wsRows = await sql`
      SELECT current_cap, paused_until
      FROM campaign_warmup_state
      WHERE campaign_id = ${campaign.id}
    `;
    const ws = wsRows[0];
    if (ws) {
      // Bounce/complaint auto-pause: pause penceresi geçene kadar HİÇ gönderme.
      // (paused_until cron tarafından set edilir; geçince worker kendiliğinden devam eder —
      //  cron'un kolonu temizlemesini beklemeden, over-pause olmaz.)
      if (ws.paused_until && new Date(ws.paused_until).getTime() > Date.now()) {
        return;
      }
      warmupCap = ws.current_cap != null ? Number(ws.current_cap) : null;
    }
  }

  // daily cap remaining: bugün bu kampanyadan giden TÜM mailler (ilk + takip).
  // email_messages'tan sayılır — bir hedef sequence boyunca birden çok mail üretebilir.
  // Efektif cap: warmup açıksa min(daily_cap, current_cap) → ramp daily_cap tavanını aşmaz
  // ama gün gün otomatik artar. daily_cap 0/null (limitsiz) ise warmup cap'i tek başına kullanılır.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const sentTodayRows = await sql`
    SELECT count(*)::int AS n
    FROM email_messages
    WHERE campaign_id = ${campaign.id}
      AND direction = 'outbound'
      AND sent_at >= ${todayStart.toISOString()}
  `;
  const sentToday: number = sentTodayRows[0]?.n ?? 0;
  const dailyCap = campaign.daily_cap ?? 0;
  const effectiveCap = warmupCap != null
    ? (dailyCap > 0 ? Math.min(dailyCap, warmupCap) : warmupCap)
    : dailyCap;
  const remaining = effectiveCap > 0 ? Math.max(0, effectiveCap - sentToday) : Number.MAX_SAFE_INTEGER;
  if (remaining <= 0) {
    return; // bugünlük cap dolu, ertesi gün
  }

  const ctxUserId = campaign.created_by ?? fallbackUserId;
  if (!ctxUserId) {
    console.error(`[worker] campaign ${campaign.id}: no created_by + no super_admin fallback`);
    return;
  }

  // A/B otomatik kazanan — yeterli örneklem varsa kazananı belirle (bu tick'te etkili olur)
  await maybeResolveAbWinner(campaign);

  // Per-tick toplam gönderim bütçesi (takip + ilk birlikte): cap kalanı ∧ BATCH_SIZE
  let budget = Math.min(remaining, BATCH_SIZE);

  const steps = Array.isArray(campaign.follow_up_steps) ? campaign.follow_up_steps : [];
  const segmentFilter = (campaign.segment_filter ?? {}) as Record<string, unknown>;
  const targetRole = typeof segmentFilter.target_role === 'string' && segmentFilter.target_role.length > 0
    ? segmentFilter.target_role
    : null;

  // G4 — yeni lead (initial) günlük limiti: bugün giden ilk mailleri (sequence_step=0) say, kalan kotayı bul.
  let newLeadsRemaining = Number.MAX_SAFE_INTEGER;
  if (campaign.max_new_leads_per_day != null && campaign.max_new_leads_per_day >= 0) {
    const initRows = await sql`
      SELECT count(*)::int AS n FROM email_messages
      WHERE campaign_id = ${campaign.id} AND direction = 'outbound'
        AND sequence_step = 0 AND sent_at >= ${todayStart.toISOString()}
    `;
    newLeadsRemaining = Math.max(0, campaign.max_new_leads_per_day - (initRows[0]?.n ?? 0));
  }

  let followUpSent = 0;
  let initialSent = 0;

  // Phase A — vakti gelen takipler (processFollowUps yalnız result.success'te bütçe düşürür → gerçek adet).
  const runFollowUps = async () => {
    if (budget > 0 && steps.length > 0) {
      const before = budget;
      budget = await processFollowUps(campaign, steps, budget, ctxUserId);
      followUpSent += before - budget;
    }
  };
  // Phase B — yeni ilk mailler (kalan bütçe ∧ yeni-lead kotası).
  const runInitials = async () => {
    const initBudget = Math.min(budget, newLeadsRemaining);
    if (initBudget > 0) {
      const sent = await processInitials(campaign, targetRole, initBudget, ctxUserId);
      initialSent += sent;
      budget -= sent;
    }
  };

  // G4 — prioritize_new_leads: true ise yeni lead'ler önce (Phase B → A); default takipler önce.
  if (campaign.prioritize_new_leads) {
    await runInitials();
    await runFollowUps();
  } else {
    await runFollowUps();
    await runInitials();
  }

  // Warmup denominator: bu tick'te GERÇEKTEN giden mailleri sent_today'e ekle.
  // cron-warmup-tick bounce oranını (bounce_count_24h / sent_today) bununla hesaplar;
  // worker yazmazsa sent_today hep 0 kalır → oran hep 0 → bounce auto-pause hiç tetiklenmez.
  // (v_warmup_overview dashboard badge'i de bu kolonu gösterir.)
  const sentThisTick = followUpSent + initialSent;
  if (warmupEnabled && sentThisTick > 0) {
    await sql`
      UPDATE campaign_warmup_state
      SET sent_today = sent_today + ${sentThisTick}, updated_at = now()
      WHERE campaign_id = ${campaign.id}
    `;
  }

  // Tamamlanma: ne queued ne de bekleyen takip kaldıysa completed.
  const pendingRows = await sql`
    SELECT count(*)::int AS n
    FROM campaign_targets
    WHERE campaign_id = ${campaign.id}
      AND (status = 'queued' OR (status = 'sent' AND next_followup_at IS NOT NULL))
  `;
  if ((pendingRows[0]?.n ?? 0) === 0) {
    await sql`
      UPDATE campaigns
      SET status = 'completed', completed_at = now()
      WHERE id = ${campaign.id} AND status = 'running'
    `;
    console.log(`[worker] campaign ${campaign.id} completed`);
  }
}

async function tick(): Promise<void> {
  if (running) {
    // Pacing'li tick saatler sürebilir (insansı gönderim araları) — her dakika ayrı
    // satır basmak error logu boğuyordu (561 satır/gün; 2026-08-03 healthcheck'inde
    // gerçek hataları aramayı zorlaştırdı). İlk atlamada ve ~30 dk'da bir özetle.
    skippedTicks++;
    if (skippedTicks === 1 || skippedTicks % 30 === 0) {
      console.warn(`[worker] previous tick still running, skipping (${skippedTicks} dk'dır sürüyor)`);
    }
    return;
  }
  if (skippedTicks > 0) {
    console.log(`[worker] uzun tick bitti (${skippedTicks} dk boyunca atlanan tick'ler normale döndü)`);
    skippedTicks = 0;
  }
  running = true;
  try {
    const campaignRows: CampaignRow[] = await sql`
      SELECT id, template_id, sender_email, sender_pool, daily_cap, segment_filter, created_by,
             follow_up_steps, ab_test_enabled, ab_winner_variant, ab_winning_metric,
             send_window_start, send_window_end, send_days, warmup_enabled,
             min_gap_seconds, random_gap_seconds, max_new_leads_per_day, prioritize_new_leads,
             send_text_only, first_email_text_only, max_per_company_per_day, stop_company_on_reply
      FROM campaigns
      WHERE status = 'running' AND channel = 'email' AND cron_paused = false
      ORDER BY started_at NULLS LAST, created_at
    `;
    if (campaignRows.length === 0) {
      return;
    }

    const fallbackUserId = await resolveFallbackUserId();
    for (const c of campaignRows) {
      try {
        await processCampaign(c, fallbackUserId);
      } catch (e: any) {
        console.error(`[worker] campaign ${c.id} tick error:`, e?.message);
      }
    }
  } catch (e: any) {
    console.error('[worker] tick error:', e?.message);
  } finally {
    running = false;
  }
}

export function startCampaignWorker(): void {
  if (tickHandle) {
    console.warn('[worker] already started');
    return;
  }
  console.log(`[worker] starting (tick=${TICK_INTERVAL_MS}ms, batch=${BATCH_SIZE}, gap=${SEND_GAP_MS}ms)`);
  // İlk tick'i biraz geciktir (startup'ta DB hazır olsun)
  setTimeout(() => {
    tick().catch((e) => console.error('[worker] first tick:', e?.message));
    tickHandle = setInterval(() => {
      tick().catch((e) => console.error('[worker] tick:', e?.message));
    }, TICK_INTERVAL_MS);
  }, 5_000);
}

export function stopCampaignWorker(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
    console.log('[worker] stopped');
  }
}
