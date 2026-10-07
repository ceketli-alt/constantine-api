/**
 * Postgres client — postgres-js, session_replication_role işi için sade.
 */
import postgres from 'postgres';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) throw new Error('DATABASE_URL tanımsız');

export const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
  types: {
    // Supabase davranışı: numeric/decimal/bigint → JS number (frontend matematik için)
    numeric: { to: 1700, from: [1700, 700, 701], serialize: (x: number) => String(x), parse: (x: string) => parseFloat(x) },
    bigint:  { to: 20,   from: [20],             serialize: (x: number) => String(x), parse: (x: string) => parseInt(x, 10) },
    // DATE (OID 1082) → düz 'YYYY-MM-DD' string, PostgREST ile birebir. postgres-js varsayılanı
    // DATE'i JS Date'e çeviriyor, REST katmanı da onu '2026-09-15T00:00:00.000Z' diye basıyordu:
    // tarayıcının <input type="date">'i bunu BOŞ gösteriyor (düzenleme formunda tarih "sıfırlandı"
    // sanılıyordu), `due_date === today` gibi eşitlikler hiç tutmuyordu. TIMESTAMP(TZ) (1114/1184)
    // Date kalır → ISO. Saat dilimi hilesi yok: '2026-09-15' hangi makinede okunursa okunsun aynı gün.
    date:    { to: 1082, from: [1082],            serialize: (x: string) => x,         parse: (x: string) => x },
  },
});

type TxSql = postgres.TransactionSql<{ numeric: number; bigint: number }>;

export async function withRequestContext<T>(
  ctx: { userId?: string; role?: string; email?: string; jwt?: string },
  fn: (sql: TxSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    // Postgres'in `current_setting('request.jwt.claim.sub')` ile auth.uid() döner
    if (ctx.userId) await tx`SELECT set_config('request.jwt.claim.sub', ${ctx.userId}, true)`;
    if (ctx.role) await tx`SELECT set_config('request.jwt.claim.role', ${ctx.role}, true)`;
    if (ctx.email) await tx`SELECT set_config('request.jwt.claim.email', ${ctx.email}, true)`;
    if (ctx.jwt) await tx`SELECT set_config('request.jwt.claims', ${ctx.jwt}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
