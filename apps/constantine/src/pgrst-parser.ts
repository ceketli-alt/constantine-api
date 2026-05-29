/**
 * PostgREST-uyumlu query parser
 *
 * Supabase frontend bu URL'leri üretir:
 *   GET /rest/v1/leads?select=id,name,score&status=eq.new&order=created_at.desc&limit=20
 *   GET /rest/v1/bookings?id=in.(uuid1,uuid2)&select=*,boat:boats(*)
 *   POST /rest/v1/leads   (body: row or rows)
 *   PATCH /rest/v1/leads?id=eq.X   (body: partial)
 *   DELETE /rest/v1/leads?id=eq.X
 *
 * Bu modül URL query string'i SQL fragment + parametrelere çevirir.
 * Drop-in PostgREST replacement için yeterli subset.
 */

export type Operator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'in' | 'is' | 'not.is' | 'not.eq'
  | 'fts' | 'plfts' | 'phfts' | 'wfts'
  | 'cs' | 'cd' | 'ov';

export interface ParsedFilter {
  column: string;
  op: Operator | string;
  value: unknown;
  not?: boolean;
}

export interface ParsedOrder {
  column: string;
  direction: 'asc' | 'desc';
  nullsFirst?: boolean;
}

export interface ParsedQuery {
  select: string[];                  // ['*'] veya ['id', 'name', 'score']
  filters: ParsedFilter[];
  orders: ParsedOrder[];
  limit?: number;
  offset?: number;
  countMode?: 'exact' | 'planned' | 'estimated';
}

/** PostgREST filter value parse:
 *   "eq.foo"           → { op: 'eq', value: 'foo' }
 *   "in.(1,2,3)"       → { op: 'in', value: [1,2,3] }
 *   "is.null"          → { op: 'is', value: null }
 *   "not.eq.foo"       → { op: 'eq', not: true, value: 'foo' }
 *   "ilike.*term*"     → { op: 'ilike', value: '%term%' }
 */
function parseFilterValue(raw: string): { op: string; value: unknown; not?: boolean } {
  let not = false;
  if (raw.startsWith('not.')) {
    not = true;
    raw = raw.slice(4);
  }
  const dotIdx = raw.indexOf('.');
  if (dotIdx === -1) return { op: 'eq', value: raw, not };
  const op = raw.slice(0, dotIdx);
  let value: unknown = raw.slice(dotIdx + 1);
  if (op === 'in' && typeof value === 'string') {
    // "(a,b,c)" → ['a','b','c']; "()" → [] (boş in → FALSE WHERE)
    const inner = value.replace(/^\(|\)$/g, '');
    value = inner ? inner.split(',').map((s) => decodeURIComponent(s.trim())) : [];
  } else if (op === 'is' && typeof value === 'string') {
    if (value === 'null') value = null;
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
  } else if ((op === 'like' || op === 'ilike') && typeof value === 'string') {
    value = value.replaceAll('*', '%');
  } else if (typeof value === 'string') {
    value = decodeURIComponent(value);
    // PostgREST behavior: eq/neq/gt/gte/lt/lte için 'true'/'false'/'null' literal'larını cast et
    // (Supabase JS .eq('active', true) → ?active=eq.true gönderir, biz boolean'a çevirmeli)
    if (op === 'eq' || op === 'neq' || op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (value === 'true')  value = true;
      else if (value === 'false') value = false;
      else if (value === 'null')  value = null;
    }
  }
  return { op, value, not };
}

const RESERVED_KEYS = new Set(['select', 'order', 'limit', 'offset']);

/** Parantez-aware comma split — embedded resource'ları parçalamaz.
 *  "id,name,leads!inner(id,name)" → ["id", "name", "leads!inner(id,name)"]
 */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Embedded resource detector: "leads(id,name)" veya "leads!inner(id,name)"
 *  PostgREST nested select; pgrst-parser şu an JOIN üretmiyor — outer select'ten atılır,
 *  filter/order'da görünürse de bypass edilir (degraded mode). TODO: full implementation.
 */
const EMBED_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(?:!(?:inner|left))?\s*\(/;
function isEmbedded(col: string): boolean {
  return EMBED_RE.test(col);
}

/** "email_messages.email_threads.lead_id" gibi nested filter path */
function isNestedPath(col: string): boolean {
  return col.includes('.');
}

export function parseQuery(url: URL): ParsedQuery {
  const sp = url.searchParams;
  const rawSelect = sp.get('select') ?? '*';
  const allSelect = splitTopLevel(rawSelect);
  const select: string[] = [];
  for (const s of allSelect) {
    if (isEmbedded(s)) {
      // TODO: full embedded resource support (JOIN + nested response shape)
      continue;
    }
    select.push(s);
  }
  if (select.length === 0) select.push('*');

  const orders: ParsedOrder[] = [];
  const orderRaw = sp.get('order');
  if (orderRaw) {
    for (const part of orderRaw.split(',')) {
      // JSONB path operatörü "." içermez, ama nested resource path içerir
      // ("foo.bar.desc"). Split son token "asc"/"desc"/nullsfirst/nullslast.
      const tokens = part.split('.');
      const directionTokens = new Set(['asc', 'desc', 'nullsfirst', 'nullslast']);
      let cutIdx = tokens.length;
      while (cutIdx > 0 && directionTokens.has(tokens[cutIdx - 1]!)) cutIdx--;
      const column = tokens.slice(0, cutIdx).join('.');
      const rest = tokens.slice(cutIdx);
      const direction = rest.includes('desc') ? 'desc' : 'asc';
      const nullsFirst = rest.includes('nullsfirst') ? true : rest.includes('nullslast') ? false : undefined;
      if (isNestedPath(column) && !column.match(/->>?|#>>?/)) {
        // nested resource order (e.g. "leads.name") — degraded skip
        continue;
      }
      orders.push({ column, direction, nullsFirst });
    }
  }
  const limit = sp.get('limit') ? Number(sp.get('limit')) : undefined;
  const offset = sp.get('offset') ? Number(sp.get('offset')) : undefined;

  const filters: ParsedFilter[] = [];
  for (const [key, raw] of sp.entries()) {
    if (RESERVED_KEYS.has(key)) continue;
    if (isNestedPath(key) && !key.match(/->>?|#>>?/)) {
      // nested resource filter (e.g. "leads.name") — degraded skip
      continue;
    }
    const parsed = parseFilterValue(raw);
    filters.push({ column: key, ...parsed });
  }

  return { select, filters, orders, limit, offset };
}

/** Filter listesi → WHERE clause + params (mutates params).
 *  Boş filter'da boş string döner (WHERE eklenmez). */
function buildWhereClause(filters: ParsedFilter[], params: unknown[]): string {
  const wheres: string[] = [];
  for (const f of filters) {
    const col = identifier(f.column);
    let frag = '';
    switch (f.op) {
      case 'eq': frag = `${col} = $${params.push(f.value)}`; break;
      case 'neq': frag = `${col} <> $${params.push(f.value)}`; break;
      case 'gt': frag = `${col} > $${params.push(f.value)}`; break;
      case 'gte': frag = `${col} >= $${params.push(f.value)}`; break;
      case 'lt': frag = `${col} < $${params.push(f.value)}`; break;
      case 'lte': frag = `${col} <= $${params.push(f.value)}`; break;
      case 'like': frag = `${col} LIKE $${params.push(f.value)}`; break;
      case 'ilike': frag = `${col} ILIKE $${params.push(f.value)}`; break;
      case 'is':
        if (f.value === null) frag = `${col} IS NULL`;
        else frag = `${col} IS ${f.value}`;
        break;
      case 'in':
        if (Array.isArray(f.value)) {
          if (f.value.length === 0) { frag = 'FALSE'; break; }
          const placeholders = f.value.map((v) => `$${params.push(v)}`).join(', ');
          frag = `${col} IN (${placeholders})`;
        } else {
          frag = `${col} IN ($${params.push(f.value)})`;
        }
        break;
      case 'cs':  // contains (jsonb @> / array @>)
        frag = `${col} @> $${params.push(typeof f.value === 'string' ? JSON.parse(f.value) : f.value)}`;
        break;
      case 'cd':  // contained
        frag = `${col} <@ $${params.push(typeof f.value === 'string' ? JSON.parse(f.value) : f.value)}`;
        break;
      case 'fts':
        frag = `to_tsvector('simple', ${col}) @@ plainto_tsquery('simple', $${params.push(f.value)})`;
        break;
      default:
        // Bilinmeyen op'lar 422 hatası yerine eşitlik gibi davransın (defensive)
        frag = `${col} = $${params.push(f.value)}`;
    }
    if (f.not) frag = `NOT (${frag})`;
    wheres.push(frag);
  }
  return wheres.length ? ` WHERE ${wheres.join(' AND ')}` : '';
}

/** ParsedQuery → SELECT SQL fragment */
export function buildSelectSQL(
  table: string,
  pq: ParsedQuery,
  params: unknown[],
): { sqlText: string; params: unknown[] } {
  const safeTable = identifier(table);
  const safeSelect = pq.select.includes('*') ? '*' : pq.select.map(identifier).join(', ');
  const where = buildWhereClause(pq.filters, params);

  let orderBy = '';
  if (pq.orders.length) {
    orderBy = ' ORDER BY ' + pq.orders.map((o) => {
      const dir = o.direction.toUpperCase();
      const nf = o.nullsFirst === true ? ' NULLS FIRST' : o.nullsFirst === false ? ' NULLS LAST' : '';
      return `${identifier(o.column)} ${dir}${nf}`;
    }).join(', ');
  }

  let limitOffset = '';
  if (pq.limit !== undefined) limitOffset += ` LIMIT ${Math.max(0, Math.min(10000, pq.limit))}`;
  if (pq.offset !== undefined) limitOffset += ` OFFSET ${Math.max(0, pq.offset)}`;

  return {
    sqlText: `SELECT ${safeSelect} FROM ${safeTable}${where}${orderBy}${limitOffset}`,
    params,
  };
}

export function buildCountSQL(table: string, pq: ParsedQuery, params: unknown[]) {
  const safeTable = identifier(table);
  const where = buildWhereClause(pq.filters, params);
  return {
    sqlText: `SELECT count(*)::bigint AS count FROM ${safeTable}${where}`,
    params,
  };
}

export function buildDeleteSQL(table: string, pq: ParsedQuery, params: unknown[]) {
  const safeTable = identifier(table);
  const where = buildWhereClause(pq.filters, params);
  if (!where) throw new Error('DELETE without WHERE refused');
  return { sqlText: `DELETE FROM ${safeTable}${where} RETURNING *`, params };
}

export function buildPatchSQL(
  table: string,
  pq: ParsedQuery,
  payload: Record<string, unknown>,
  params: unknown[],
) {
  const safeTable = identifier(table);
  const setFrags: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    setFrags.push(`${identifier(k)} = $${params.push(v)}`);
  }
  if (!setFrags.length) throw new Error('Empty PATCH body');
  const where = buildWhereClause(pq.filters, params);
  if (!where) throw new Error('PATCH without WHERE refused');
  return { sqlText: `UPDATE ${safeTable} SET ${setFrags.join(', ')}${where} RETURNING *`, params };
}

export function buildInsertSQL(
  table: string,
  rows: Record<string, unknown>[],
  params: unknown[],
  onConflict?: 'ignore' | 'merge',
) {
  if (!rows.length) throw new Error('Empty INSERT');
  const safeTable = identifier(table);
  const cols = Array.from(
    rows.reduce((s, r) => {
      for (const k of Object.keys(r)) s.add(k);
      return s;
    }, new Set<string>()),
  );
  const colList = cols.map(identifier).join(', ');
  const valuesFrags: string[] = [];
  for (const r of rows) {
    const vfrag = cols.map((c) => (c in r ? `$${params.push(r[c])}` : 'DEFAULT')).join(', ');
    valuesFrags.push(`(${vfrag})`);
  }
  let conflict = '';
  if (onConflict === 'ignore') conflict = ' ON CONFLICT DO NOTHING';
  // 'merge' upsert için açık çağrı (PUT)
  return {
    sqlText: `INSERT INTO ${safeTable} (${colList}) VALUES ${valuesFrags.join(', ')}${conflict} RETURNING *`,
    params,
  };
}

/** Postgres identifier (sınırlı validation — SQL injection'a karşı)
 *  JSONB path operatörlerini de destekler:
 *    metadata->>due_at      → "metadata"->>'due_at'   (text)
 *    metadata->config       → "metadata"->'config'    (jsonb)
 *    metadata#>>{a,b}       → "metadata"#>>'{a,b}'    (text path)
 *    metadata#>{a,b}        → "metadata"#>'{a,b}'     (jsonb path)
 */
function identifier(name: string): string {
  // JSONB single-key accessor: col->>key or col->key
  const singleMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(->>|->)([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (singleMatch) {
    const [, col, op, key] = singleMatch;
    return `"${col}"${op}'${key}'`;
  }
  // JSONB path accessor: col#>>{a,b,c} or col#>{a,b,c}
  const pathMatch = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(#>>|#>)(\{[a-zA-Z_0-9, -]+\})$/);
  if (pathMatch) {
    const [, col, op, path] = pathMatch;
    return `"${col}"${op}'${path}'`;
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Geçersiz identifier: ${name}`);
  }
  return `"${name}"`;
}
