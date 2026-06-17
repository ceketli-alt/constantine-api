/**
 * agency-concierge — Doğal dil "concierge" arama katmanı (partner-fleet v3.3)
 *
 * Misafir serbest metin yazar ("yarın akşam 8 kişiyle 3 saatlik Boğaz turu");
 * Claude Haiku metni YAPISAL parametreye çevirir (parse). Müsaitlik HER ZAMAN
 * deterministik handleSearch ile hesaplanır — LLM ASLA müsaitlik uydurmaz.
 * Sonuçlar tekrar Haiku'ya verilip kısa, sıcak bir cümleyle anlatılır (narrate,
 * best-effort). Kart listesi deterministik kalır; narration sadece üst katman —
 * mesaj yanlış olsa bile altta gerçek müsaitlik durur.
 *
 * Bu modülün DB bağımlılığı YOK — saf LLM katmanı (icebreaker.ts deseni). Router
 * (agency-panel.ts) parse → handleSearch → narrate akışını bağlar. normalizeParse
 * saf/test edilebilir: Haiku çıktısını doğrular, sınırlar, güvenli default uygular.
 */
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CONCIERGE_MODEL =
  process.env.ANTHROPIC_DRAFT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

/** Default'lar — LLM bir değer vermezse (intent=search). Kapasite ASLA filtrelemez. */
export const CONCIERGE_DEFAULT_START = '14:00';
export const CONCIERGE_DEFAULT_DURATION = 4;
const SEARCH_HORIZON_DAYS = 60;

export function conciergeConfigured(): boolean {
  return Boolean(ANTHROPIC_API_KEY);
}

const LANG_NAMES: Record<string, string> = {
  tr: 'Turkish', en: 'English', ar: 'Arabic', ru: 'Russian', de: 'German',
  fr: 'French', es: 'Spanish', it: 'Italian', zh: 'Chinese', ja: 'Japanese',
  fa: 'Persian', pt: 'Portuguese',
};

function langName(lang: string): string {
  return LANG_NAMES[lang] || "the user's language";
}

// ============================================================
// Parse — serbest metin → yapısal arama parametreleri
// ============================================================

export interface ParsedQuery {
  date: string | null;        // YYYY-MM-DD (TODAY'e göre çözülmüş, mutlak)
  start_time: string | null;  // HH:MM (24s) — intent=search ise default uygulanır
  duration_hours: number | null;
  guests: number | null;      // sadece talebe taşınır; sonucu FİLTRELEMEZ
}

export interface ParseOutcome {
  intent: 'search' | 'unclear';
  parsed: ParsedQuery;
  /** Misafir dilinde kısa not: netleştirme isteği (unclear) veya varsayım ("akşam=19:00"). */
  message: string | null;
}

export function buildParseSystemPrompt(todayStr: string, lang: string): string {
  const ln = langName(lang);
  return `You are the booking assistant for Constantine Yachts (private yacht charters on the Bosphorus, Istanbul).
Convert the guest's free-text request into structured search parameters. Do NOT chat — only extract.

TODAY is ${todayStr} (ISO date, Europe/Istanbul). Resolve every relative date against TODAY:
- "today"/"bugün" → ${todayStr}; "tomorrow"/"yarın" → the next day; "this weekend" → the coming Saturday.
- Weekday names ("Saturday"/"cumartesi") → the NEXT occurrence (today counts if it matches).
- Absolute dates in any format ("15 June", "06/15", "15.06", "haziran 20") → YYYY-MM-DD. Pick the nearest FUTURE occurrence; if no year is given, choose the year that keeps the date within the next ${SEARCH_HORIZON_DAYS} days.

TIME — map fuzzy expressions to a 24h HH:MM, valid range 06:00–23:00:
morning/sabah→10:00 · noon/öğle→12:00 · afternoon/öğleden sonra→14:00 · evening/akşam→19:00 · sunset/gün batımı→18:00 · night/gece→21:00.
If the guest gives a clock time, use it. If no time at all → null.

DURATION — extract hours as a number (range 0.5–12): "3 saat"→3, "half day"→4, "full day"→8. If none → null.
GUESTS — head count if mentioned ("8 kişi"→8). This NEVER filters results, just captured. If none → null.

Decide "intent":
- "search": the guest expressed at least a resolvable DATE. Fill "date"; fill start_time/duration/guests if present else null.
- "unclear": no resolvable date, OR greeting / off-topic / nonsense / abuse. Keep all fields null and write a short, friendly reply in ${ln} asking for the date (and ideally time + duration).

If intent="search" AND you inferred a fuzzy time the guest did not state precisely, put a SHORT note in "message" in ${ln} (e.g. "Akşam'ı 19:00 olarak aldım."). Otherwise "message": null.

Output ONLY JSON, no markdown:
{ "intent": "search"|"unclear", "date": "YYYY-MM-DD"|null, "start_time": "HH:MM"|null, "duration_hours": number|null, "guests": number|null, "message": string|null }`;
}

/** Gün farkı (UTC midnight) — TODAY..target ufuk kontrolü için. */
function dayDiff(todayStr: string, targetStr: string): number | null {
  const a = Date.parse(`${todayStr}T00:00:00Z`);
  const b = Date.parse(`${targetStr}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Haiku çıktısını DOĞRULA + güvenli default uygula (saf, test edilebilir).
 * - date: YYYY-MM-DD, geçmiş değil, ≤ +SEARCH_HORIZON_DAYS gün. Aksi halde unclear.
 * - start_time: HH:MM ve 06–23. Geçersiz/eksikse intent=search'te default (14:00).
 * - duration: 0.5–12 clamp; eksikse default (4).
 * - guests: ≥1 round; aksi halde null. ASLA filtre değil.
 */
export function normalizeParse(raw: unknown, todayStr: string): ParseOutcome {
  const out: ParseOutcome = {
    intent: 'unclear',
    parsed: { date: null, start_time: null, duration_hours: null, guests: null },
    message: null,
  };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;

  out.message =
    typeof r.message === 'string' && r.message.trim() ? r.message.trim().slice(0, 300) : null;

  // date doğrula
  let date: string | null = null;
  if (typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
    const diff = dayDiff(todayStr, r.date);
    if (diff !== null && diff >= 0 && diff <= SEARCH_HORIZON_DAYS) date = r.date;
  }

  // intent=search yalnızca geçerli tarihle; aksi halde unclear (message netleştirme ister)
  if (r.intent !== 'search' || !date) {
    out.intent = 'unclear';
    out.parsed.date = date; // varsa echo
    return out;
  }

  // start_time doğrula → default
  let start: string | null = null;
  if (typeof r.start_time === 'string' && /^\d{2}:\d{2}$/.test(r.start_time)) {
    const h = Number(r.start_time.slice(0, 2));
    if (h >= 6 && h <= 23) start = r.start_time;
  }

  // duration clamp → default
  let dur: number | null = null;
  if (typeof r.duration_hours === 'number' && Number.isFinite(r.duration_hours)) {
    dur = Math.min(12, Math.max(0.5, r.duration_hours));
  }

  // guests (filtre değil)
  let guests: number | null = null;
  if (typeof r.guests === 'number' && Number.isFinite(r.guests) && r.guests >= 1) {
    guests = Math.min(500, Math.round(r.guests));
  }

  out.intent = 'search';
  out.parsed = {
    date,
    start_time: start ?? CONCIERGE_DEFAULT_START,
    duration_hours: dur ?? CONCIERGE_DEFAULT_DURATION,
    guests,
  };
  return out;
}

function extractJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

/** Serbest metni parse et (Haiku). Hata fırlatabilir — çağıran yakalar. */
export async function parseConciergeQuery(
  q: string,
  todayStr: string,
  lang: string,
): Promise<ParseOutcome> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: CONCIERGE_MODEL,
    max_tokens: 300,
    temperature: 0.1,
    system: buildParseSystemPrompt(todayStr, lang),
    messages: [{ role: 'user', content: q.slice(0, 280) }],
  });
  const block = response.content.find((b) => b.type === 'text');
  const text = block && 'text' in block ? block.text.trim() : '';
  return normalizeParse(extractJson(text), todayStr);
}

// ============================================================
// Narrate — gerçek sonuçları kısa cümleyle anlat (best-effort)
// ============================================================

export interface NarrateInput {
  lang: string;
  query: { date: string; start_time: string; duration_hours: number; guests: number | null };
  exact: string[];                                          // tam müsait tekne adları
  near: Array<{ name: string; from: string; to: string }>; // yakın saatte müsait
  noneCount: number;                                        // o gün dolu tekne sayısı
  featured: string | null;                                 // sonuçtaki en öncelikli müsait tekne
}

export function buildNarrateSystemPrompt(lang: string): string {
  const ln = langName(lang);
  return `You are a warm, concise concierge for Constantine Yachts (private yacht charters on the Bosphorus, Istanbul).
Write a 1–2 sentence reply in ${ln} describing the REAL search results provided.

RULES:
- Describe ONLY the results given. NEVER invent boats, times, prices, or availability. Use only the boat names provided.
- State how many boats are fully available at the requested time, and (if any) how many are available at a nearby time.
- If a "featured_boat" is given and it is available, you may highlight it by name.
- If nothing is available, say so kindly and suggest trying another time.
- No greeting, no sign-off, no prices, no markdown. Keep it under 40 words.

Output ONLY JSON: { "message": "<reply>" }`;
}

/** Sonuçları doğal dille anlat. Başarısızsa null döner (çağıran template fallback yapar). */
export async function narrateConciergeResults(input: NarrateInput): Promise<string | null> {
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: CONCIERGE_MODEL,
      max_tokens: 200,
      temperature: 0.4,
      system: buildNarrateSystemPrompt(input.lang),
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            request: input.query,
            fully_available: input.exact.slice(0, 6),
            nearby_time: input.near.slice(0, 6),
            unavailable_count: input.noneCount,
            featured_boat: input.featured,
          }),
        },
      ],
    });
    const block = response.content.find((b) => b.type === 'text');
    const text = block && 'text' in block ? block.text.trim() : '';
    const parsed = extractJson(text) as Record<string, unknown>;
    const msg = typeof parsed.message === 'string' ? parsed.message.trim().slice(0, 400) : '';
    return msg || null;
  } catch (e: any) {
    console.warn('[agency-concierge] narrate failed:', e?.message);
    return null;
  }
}
