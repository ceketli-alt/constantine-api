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
    // "(a,b,c)" → ['a','b','c']
    const inner = value.replace(/^\(|\)$/g, '');
    value = inner.split(',').map((s) => decodeURIComponent(s.trim()));
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

export function parseQuery(url: URL): ParsedQuery {
  const sp = url.searchParams;
  const select: string[] = (sp.get('select') ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  const orders: ParsedOrder[] = [];
  const orderRaw = sp.get('order');
  if (orderRaw) {
    for (const part of orderRaw.split(',')) {
      const [column, ...rest] = part.split('.');
      if (!column) continue; // empty fragment guard
      const direction = rest.includes('desc') ? 'desc' : 'asc';
      const nullsFirst = rest.includes('nullsfirst') ? true : rest.includes('nullslast') ? false : undefined;
      orders.push({ column, direction, nullsFirst });
    }
  }
  const limit = sp.get('limit') ? Number(sp.get('limit')) : undefined;
  const offset = sp.get('offset') ? Number(sp.get('offset')) : undefined;

  const filters: ParsedFilter[] = [];
  for (const [key, raw] of sp.entries()) {
    if (RESERVED_KEYS.has(key)) continue;
    const parsed = parseFilterValue(raw);
    filters.push({ column: key, ...parsed });
  }

  return { select, filters, orders, limit, offset };
}

/** ParsedQuery → SELECT SQL fragment (postgres-js sql helper'ı için string + params kullanılmaz, biz inline param tabanlı sql.unsafe yazacağız) */
export function buildSelectSQL(
  table: string,
  pq: ParsedQuery,
  params: unknown[],
): { sqlText: string; params: unknown[] } {
  const safeTable = identifier(table);
  const safeSelect = pq.select.includes('*') ? '*' : pq.select.map(identifier).join(', ');
  let where = '';
  const wheres: string[] = [];

  for (const f of pq.filters) {
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
  if (wheres.length) where = ` WHERE ${wheres.join(' AND ')}`;

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
  const { sqlText } = buildSelectSQL(table, { ...pq, select: ['*'], orders: [], limit: undefined, offset: undefined }, params);
  const countSql = sqlText.replace(/^SELECT \* FROM/, 'SELECT count(*)::bigint AS count FROM');
  return { sqlText: countSql, params };
}

export function buildDeleteSQL(table: string, pq: ParsedQuery, params: unknown[]) {
  const safeTable = identifier(table);
  const { sqlText } = buildSelectSQL(table, { ...pq, select: ['*'], orders: [], limit: undefined, offset: undefined }, params);
  // WHERE kısmını al
  const whereMatch = sqlText.match(/WHERE (.+)$/);
  const where = whereMatch ? ` WHERE ${whereMatch[1]}` : '';
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
  const { sqlText } = buildSelectSQL(table, { ...pq, select: ['*'], orders: [], limit: undefined, offset: undefined }, params);
  const whereMatch = sqlText.match(/WHERE (.+)$/);
  const where = whereMatch ? ` WHERE ${whereMatch[1]}` : '';
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

/** Postgres identifier (sınırlı validation — SQL injection'a karşı) */
function identifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Geçersiz identifier: ${name}`);
  }
  return `"${name}"`;
}
