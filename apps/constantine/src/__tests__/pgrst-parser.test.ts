/**
 * pgrst-parser core unit testleri.
 *
 * Kapsam:
 * - parseQuery: select, filter, order, JSONB path, embedded resource skip
 * - buildSelectSQL, buildCountSQL, buildDeleteSQL, buildPatchSQL
 * - DELETE/PATCH WHERE extraction regression (ORDER BY clause sızıntı bug — fix doğrulama)
 */
import { describe, it, expect } from 'vitest';
import {
  parseQuery,
  buildSelectSQL,
  buildCountSQL,
  buildDeleteSQL,
  buildPatchSQL,
} from '../pgrst-parser.js';

function url(path: string): URL {
  return new URL('http://x' + path);
}
function table(u: URL): string {
  return u.pathname.split('/').pop() ?? '';
}

describe('parseQuery', () => {
  it('parses basic select+eq+order+limit', () => {
    const u = url('/rest/v1/leads?select=id,name&status=eq.new&order=created_at.desc&limit=20');
    const pq = parseQuery(u);
    expect(pq.select).toEqual(['id', 'name']);
    expect(pq.filters).toEqual([{ column: 'status', op: 'eq', value: 'new', not: false }]);
    expect(pq.orders).toEqual([{ column: 'created_at', direction: 'desc', nullsFirst: undefined }]);
    expect(pq.limit).toBe(20);
  });

  it('parses in.() with multiple values', () => {
    const u = url('/rest/v1/leads?status=in.(new,contacted,qualified)');
    const pq = parseQuery(u);
    expect(pq.filters[0]?.op).toBe('in');
    expect(pq.filters[0]?.value).toEqual(['new', 'contacted', 'qualified']);
  });

  it('parses is.null with not prefix', () => {
    const u = url('/rest/v1/leads?last_contacted_at=not.is.null');
    const pq = parseQuery(u);
    expect(pq.filters[0]?.op).toBe('is');
    expect(pq.filters[0]?.value).toBeNull();
    expect(pq.filters[0]?.not).toBe(true);
  });

  it('JSONB path: metadata->>due_at filter + order', () => {
    const u = url('/rest/v1/activity_events?metadata->>due_at=not.is.null&order=metadata->>due_at.asc');
    const pq = parseQuery(u);
    expect(pq.filters[0]?.column).toBe('metadata->>due_at');
    expect(pq.orders[0]?.column).toBe('metadata->>due_at');
    expect(pq.orders[0]?.direction).toBe('asc');
  });

  it('embedded resource: leads!inner(...) bypass-skip from select', () => {
    const u = url('/rest/v1/email_threads?select=id,subject,leads!inner(id,company_name)');
    const pq = parseQuery(u);
    expect(pq.select).toEqual(['id', 'subject']);
  });

  it('nested filter path: email_messages.email_threads.lead_id bypass-skip', () => {
    const u = url('/rest/v1/email_events?select=event_type&email_messages.email_threads.lead_id=eq.abc');
    const pq = parseQuery(u);
    expect(pq.filters).toEqual([]);
  });

  // ---------------------------------------------------------------
  // BUG FIX 2026-06-06 — `or=(...)` PostgREST syntax + double-decode
  // (Leads sayfası "Şirket, kişi, email…" arama kutusu URI malformed
  // hatasıyla 500 dönüyordu. Frontend ?or=(company_name.ilike.%jolly%,
  // primary_contact_name.ilike.%jolly%,...) gönderiyor.)
  // ---------------------------------------------------------------

  it('or=(col.op.val,col.op.val) → orGroups[0] iki ParsedFilter ile', () => {
    const u = url('/rest/v1/leads?or=(company_name.ilike.%25jolly%25,primary_contact_name.ilike.%25jolly%25)');
    const pq = parseQuery(u);
    expect(pq.filters).toEqual([]);
    expect(pq.orGroups).toHaveLength(1);
    expect(pq.orGroups[0]).toEqual([
      { column: 'company_name', op: 'ilike', value: '%jolly%', not: false },
      { column: 'primary_contact_name', op: 'ilike', value: '%jolly%', not: false },
    ]);
  });

  it('or= boş parantez → orGroup boş, regresyon yok', () => {
    const u = url('/rest/v1/leads?or=()');
    const pq = parseQuery(u);
    expect(pq.orGroups).toEqual([]);
  });

  it('or= top-level filter ile birlikte AND ile birleşir', () => {
    const u = url('/rest/v1/leads?status=eq.new&or=(company_name.ilike.%25j%25,city.ilike.%25j%25)');
    const pq = parseQuery(u);
    expect(pq.filters).toEqual([{ column: 'status', op: 'eq', value: 'new', not: false }]);
    expect(pq.orGroups[0]).toHaveLength(2);
  });

  it('ilike.%foo% (decoded %) → URIError yutulur, value raw kalır (double-decode bug fix)', () => {
    // searchParams.get zaten decode etti: "%25foo%25" → "%foo%"
    // İkinci decodeURIComponent("%foo%") URIError atardı; try/catch ile yutuldu.
    const u = url('/rest/v1/leads?company_name=ilike.%25foo%25');
    expect(() => parseQuery(u)).not.toThrow();
    const pq = parseQuery(u);
    expect(pq.filters[0]?.op).toBe('ilike');
    expect(pq.filters[0]?.value).toBe('%foo%');
  });

  it('and=(...) → top-level filter listesine düz katılır', () => {
    const u = url('/rest/v1/leads?and=(status.eq.new,score.gte.50)');
    const pq = parseQuery(u);
    expect(pq.filters).toEqual([
      { column: 'status', op: 'eq', value: 'new', not: false },
      { column: 'score', op: 'gte', value: '50', not: false },
    ]);
    expect(pq.orGroups).toEqual([]);
  });
});

describe('buildSelectSQL', () => {
  it('produces parameterized SELECT with where + order + limit', () => {
    const pq = parseQuery(url('/rest/v1/leads?select=id,name&status=eq.new&order=created_at.desc&limit=20'));
    const params: unknown[] = [];
    const { sqlText } = buildSelectSQL('leads', pq, params);
    expect(sqlText).toBe('SELECT "id", "name" FROM "leads" WHERE "status" = $1 ORDER BY "created_at" DESC LIMIT 20');
    expect(params).toEqual(['new']);
  });

  it('renders JSONB path identifier correctly', () => {
    const pq = parseQuery(url('/rest/v1/activity_events?metadata->>due_at=not.is.null&order=metadata->>due_at.asc'));
    const params: unknown[] = [];
    const { sqlText } = buildSelectSQL('activity_events', pq, params);
    expect(sqlText).toContain(`"metadata"->>'due_at' IS NULL`);
    expect(sqlText).toContain(`ORDER BY "metadata"->>'due_at' ASC`);
  });

  it('in.() with empty array → FALSE (avoid invalid SQL)', () => {
    const pq = parseQuery(url('/rest/v1/leads?id=in.()'));
    const params: unknown[] = [];
    const { sqlText } = buildSelectSQL('leads', pq, params);
    expect(sqlText).toContain('FALSE');
  });

  it('rejects invalid identifier (SQL injection guard)', () => {
    const pq = parseQuery(url('/rest/v1/leads?select=*'));
    pq.filters.push({ column: 'name"; DROP TABLE leads;--', op: 'eq', value: 'x' });
    const params: unknown[] = [];
    expect(() => buildSelectSQL('leads', pq, params)).toThrow(/Geçersiz identifier/);
  });

  // BUG FIX 2026-06-06: or=(...) → WHERE ... AND (a OR b)
  it('or=(...) → WHERE includes parenthesized OR group with shared params', () => {
    const pq = parseQuery(url('/rest/v1/leads?status=eq.new&or=(company_name.ilike.%25j%25,primary_contact_name.ilike.%25j%25)'));
    const params: unknown[] = [];
    const { sqlText } = buildSelectSQL('leads', pq, params);
    expect(sqlText).toBe(
      'SELECT * FROM "leads" WHERE "status" = $1 AND ("company_name" ILIKE $2 OR "primary_contact_name" ILIKE $3)',
    );
    expect(params).toEqual(['new', '%j%', '%j%']);
  });

  it('or=(...) tek elemanlı → parantez koyma, AND ile katıl', () => {
    const pq = parseQuery(url('/rest/v1/leads?or=(company_name.ilike.%25j%25)'));
    const params: unknown[] = [];
    const { sqlText } = buildSelectSQL('leads', pq, params);
    expect(sqlText).toBe('SELECT * FROM "leads" WHERE "company_name" ILIKE $1');
    expect(params).toEqual(['%j%']);
  });
});

describe('buildCountSQL', () => {
  it('produces SELECT count(*) with WHERE', () => {
    const pq = parseQuery(url('/rest/v1/leads?status=eq.new'));
    const params: unknown[] = [];
    const { sqlText } = buildCountSQL('leads', pq, params);
    expect(sqlText).toBe('SELECT count(*)::bigint AS count FROM "leads" WHERE "status" = $1');
  });
});

describe('buildDeleteSQL', () => {
  it('DELETE with WHERE → safe SQL', () => {
    const pq = parseQuery(url('/rest/v1/leads?id=eq.abc-123'));
    const params: unknown[] = [];
    const { sqlText } = buildDeleteSQL('leads', pq, params);
    expect(sqlText).toBe('DELETE FROM "leads" WHERE "id" = $1 RETURNING *');
  });

  it('DELETE with ORDER BY in URL → WHERE should NOT include ORDER BY (regression fix)', () => {
    // Bu önceden regex bug nedeniyle "DELETE ... WHERE id = $1 ORDER BY ..." üretiyor, syntax error.
    const pq = parseQuery(url('/rest/v1/leads?id=eq.abc&order=name.asc'));
    const params: unknown[] = [];
    const { sqlText } = buildDeleteSQL('leads', pq, params);
    expect(sqlText).toBe('DELETE FROM "leads" WHERE "id" = $1 RETURNING *');
    expect(sqlText).not.toContain('ORDER BY');
  });

  it('DELETE without WHERE → throws (safety guard)', () => {
    const pq = parseQuery(url('/rest/v1/leads?order=name.asc'));
    const params: unknown[] = [];
    expect(() => buildDeleteSQL('leads', pq, params)).toThrow(/DELETE without WHERE/);
  });
});

describe('buildPatchSQL', () => {
  it('UPDATE with WHERE → safe SQL', () => {
    const pq = parseQuery(url('/rest/v1/leads?id=eq.abc'));
    const params: unknown[] = [];
    const { sqlText } = buildPatchSQL('leads', pq, { score: 50 }, params);
    expect(sqlText).toBe('UPDATE "leads" SET "score" = $1 WHERE "id" = $2 RETURNING *');
  });

  it('UPDATE with ORDER BY in URL → WHERE clean (regression fix)', () => {
    const pq = parseQuery(url('/rest/v1/leads?id=eq.abc&order=name.asc'));
    const params: unknown[] = [];
    const { sqlText } = buildPatchSQL('leads', pq, { temperature: 'hot' }, params);
    expect(sqlText).toBe('UPDATE "leads" SET "temperature" = $1 WHERE "id" = $2 RETURNING *');
    expect(sqlText).not.toContain('ORDER BY');
  });

  it('UPDATE empty payload → throws', () => {
    const pq = parseQuery(url('/rest/v1/leads?id=eq.abc'));
    const params: unknown[] = [];
    expect(() => buildPatchSQL('leads', pq, {}, params)).toThrow(/Empty PATCH/);
  });
});
