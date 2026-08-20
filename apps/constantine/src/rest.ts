/**
 * /rest/v1/:table — PostgREST-uyumlu generic CRUD endpoint
 *
 * Frontend supabase-js çağrıları aynen geçer:
 *   supabase.from('leads').select('*').eq('status', 'new')
 *     → GET /rest/v1/leads?select=*&status=eq.new
 *
 *   supabase.from('leads').insert({ ... })
 *     → POST /rest/v1/leads
 *
 *   supabase.from('leads').update({ ... }).eq('id', X)
 *     → PATCH /rest/v1/leads?id=eq.X
 *
 *   supabase.from('leads').delete().eq('id', X)
 *     → DELETE /rest/v1/leads?id=eq.X
 *
 * Headers:
 *   Prefer: return=representation → INSERT/PATCH RETURNING * döner
 *   Prefer: count=exact            → toplam satır sayısı Content-Range header'da
 *   Range: 0-99                    → pagination
 */
import type { Context } from 'hono';
import { sql, withRequestContext } from './db.js';
import { parseQuery, buildSelectSQL, buildCountSQL, buildInsertSQL, buildPatchSQL, buildDeleteSQL } from './pgrst-parser.js';
import { checkTableAccess, requireAuth } from './middleware.js';

// DİKKAT: buraya SADECE içeriği herkese açık olabilecek tablolar girer.
// `agency_tokens` 2026-08-19'da BURADAN ÇIKARILDI: satırlarının kendisi kimlik
// bilgisiydi (acente portalının tek anahtarı) ve tablo internete auth'suz açıktı —
// `curl .../rest/v1/agency_tokens` 7 token'ı düz metin döndürüyordu, hiçbiri de
// süresi dolmuyordu (expires_at NULL). Token'ları okuyan tek yüzey giriş arkasındaki
// Ayarlar → Acenteler paneli; o `authenticated` olarak okumaya devam ediyor.
const PUBLIC_TABLES_VIEW = new Set([
  'public_boats',
]);

/**
 * Date-aware JSON serializer.
 *
 * postgres-js DATE / TIMESTAMP kolonlarını JS Date object olarak döndürür.
 * JSON.stringify Invalid Date'i `RangeError: Invalid time value` ile fırlatır;
 * tek bir bozuk satır tüm endpoint'i 400'e düşürür. Bu replacer:
 *   - geçerli Date → ISO string
 *   - Invalid Date → null  (sessizce, log gürültüsü yok)
 *   - diğer her şey → değişmeden
 */
function safeStringify(data: unknown): string {
  return JSON.stringify(data, (_k, v) => {
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isFinite(t) ? v.toISOString() : null;
    }
    return v;
  });
}

export async function handleRest(c: Context, method: string, table: string): Promise<Response> {
  const auth = c.get('auth');
  const op: 'read' | 'write' = method === 'GET' ? 'read' : 'write';
  const access = checkTableAccess(table, op, auth);
  if (!access.ok) return c.json({ message: access.reason ?? 'Yetki yok', code: 'forbidden' }, 403);

  const url = new URL(c.req.url);
  const pq = parseQuery(url);

  // pagination header'ları
  const rangeHeader = c.req.header('Range');
  if (rangeHeader) {
    const m = rangeHeader.match(/^(\d+)-(\d+)$/);
    if (m) {
      pq.offset = pq.offset ?? Number(m[1]);
      pq.limit = pq.limit ?? Number(m[2]) - Number(m[1]) + 1;
    }
  }
  const prefer = (c.req.header('Prefer') ?? '').toLowerCase();
  const returnRepresentation = prefer.includes('return=representation');
  const countExact = prefer.includes('count=exact');

  const ctx = {
    userId: auth?.userId,
    role: auth?.role ?? 'anon',
    email: auth?.email,
    jwt: auth?.raw,
  };

  // NOT (2026-08-19): aşağıdaki tüm `.unsafe(...)` çağrıları `{ simple: false }` taşır.
  // postgres.js protokolü şöyle seçiyor: `simple = 'simple' in options ? options.simple
  // : args.length === 0` — yani PARAMETRESİZ bir sorgu otomatik olarak *simple protocol*
  // ile gidiyordu ve o protokol ZİNCİRLENMİŞ komutlara ("...; DROP ...") izin verir.
  // Asıl açık pgrst-parser'daki `is` dalıydı ve orada kapatıldı; bu ikinci katman,
  // ileride benzer bir enterpolasyon hatası olursa tek bir istekte birden fazla
  // komut çalıştırılmasını PROTOKOL düzeyinde imkânsız kılar.
  try {
    if (method === 'GET' || method === 'HEAD') {
      return await withRequestContext(ctx, async (tx) => {
        const params: unknown[] = [];
        const { sqlText } = buildSelectSQL(table, pq, params);
        const rows = await (tx as any).unsafe(sqlText, params, { simple: false });
        let total: number | undefined;
        if (countExact) {
          const cparams: unknown[] = [];
          const { sqlText: countText } = buildCountSQL(table, pq, cparams);
          const cres = await (tx as any).unsafe(countText, cparams, { simple: false });
          total = Number(cres[0]?.count ?? 0);
        }
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (total !== undefined) {
          const from = pq.offset ?? 0;
          const to = from + rows.length - 1;
          headers['Content-Range'] = `${from}-${to < from ? from - 1 : to}/${total}`;
        }
        if (method === 'HEAD') return new Response(null, { status: 200, headers });
        // PostgREST .single() / .maybeSingle() support
        const accept = c.req.header('accept') || c.req.header('Accept') || '';
        if (accept.includes('application/vnd.pgrst.object+json')) {
          if (rows.length === 1) return new Response(safeStringify(rows[0]), { status: 200, headers });
          if (rows.length === 0) return new Response(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'Results contain 0 rows' }), { status: 406, headers });
          return new Response(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'Results contain ' + rows.length + ' rows' }), { status: 406, headers });
        }
        return new Response(safeStringify(rows), { status: 200, headers });
      });
    }

    if (method === 'POST') {
      const body = await c.req.json();
      const rows = Array.isArray(body) ? body : [body];
      return await withRequestContext(ctx, async (tx) => {
        const params: unknown[] = [];
        const { sqlText } = buildInsertSQL(table, rows, params, prefer.includes('resolution=ignore-duplicates') ? 'ignore' : undefined);
        const inserted = await (tx as any).unsafe(sqlText, params, { simple: false });
        // PostgREST: INSERT → 201 Created. Body null değil; representation yoksa boş array konvansiyonu.
        // Not: 201 null-body status değil, '' yerine null da kabul olur ama '[]' supabase-js client
        // .single()/array beklentilerine daha az sürpriz.
        if (!returnRepresentation) {
          return new Response('', { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        // .single() çağrıları için Accept: application/vnd.pgrst.object+json — tek nesne dön
        const accept = c.req.header('accept') || c.req.header('Accept') || '';
        if (accept.includes('application/vnd.pgrst.object+json')) {
          if (inserted.length === 1) {
            return new Response(safeStringify(inserted[0]), { status: 201, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'Results contain ' + inserted.length + ' rows' }), { status: 406, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(safeStringify(inserted), { status: 201, headers: { 'Content-Type': 'application/json' } });
      });
    }

    if (method === 'PATCH') {
      const body = await c.req.json();
      return await withRequestContext(ctx, async (tx) => {
        const params: unknown[] = [];
        const { sqlText } = buildPatchSQL(table, pq, body, params);
        const updated = await (tx as any).unsafe(sqlText, params, { simple: false });
        // Fetch spec: 204 No Content MUST have null body. '' bile undici Response constructor'da
        // TypeError atar. representation yoksa null body + 204 dön.
        if (!returnRepresentation) {
          return new Response(null, { status: 204 });
        }
        const accept = c.req.header('accept') || c.req.header('Accept') || '';
        if (accept.includes('application/vnd.pgrst.object+json')) {
          if (updated.length === 1) {
            return new Response(safeStringify(updated[0]), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'Results contain ' + updated.length + ' rows' }), { status: 406, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(safeStringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    }

    if (method === 'DELETE') {
      return await withRequestContext(ctx, async (tx) => {
        const params: unknown[] = [];
        const { sqlText } = buildDeleteSQL(table, pq, params);
        const deleted = await (tx as any).unsafe(sqlText, params, { simple: false });
        if (!returnRepresentation) {
          return new Response(null, { status: 204 });
        }
        const accept = c.req.header('accept') || c.req.header('Accept') || '';
        if (accept.includes('application/vnd.pgrst.object+json')) {
          if (deleted.length === 1) {
            return new Response(safeStringify(deleted[0]), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'Results contain ' + deleted.length + ' rows' }), { status: 406, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(safeStringify(deleted), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    }

    return c.json({ message: `Method ${method} desteklenmiyor`, code: 'method_not_allowed' }, 405);
  } catch (e: any) {
    console.error(`[rest] ${method} ${table}:`, e.message);
    return c.json({ message: e.message, code: 'rest_error' }, 400);
  }
}
