/**
 * Storage proxy — Supabase Storage'a geçici reverse proxy.
 * Storage'ı kendi sunucumuza migrate edene kadar tüm /storage/v1/* istekleri
 * eski Supabase Storage'a forward edilir. Bu kullanıcıyı boat_photos'tan
 * kopmadan tutar.
 *
 * Faz 2: Tüm fotoğrafları R2/MinIO ya da lokal disk'e indirip nginx'ten serv et.
 */
import type { Context } from 'hono';

const SUPABASE_URL = process.env.SUPABASE_STORAGE_PROXY_URL || 'https://gueseggrlelvcoihrpjh.supabase.co';
const SUPABASE_ANON_FOR_STORAGE = process.env.SUPABASE_ANON_FOR_STORAGE || ''; // boş ise sadece public bucket

export async function handleStorageProxy(c: Context): Promise<Response> {
  // Yol: /storage/v1/object/public/<bucket>/<path>
  // Veya: /storage/v1/object/<bucket>/<path> (authenticated)
  const url = new URL(c.req.url);
  const upstreamUrl = `${SUPABASE_URL}${url.pathname}${url.search}`;

  try {
    const headers: Record<string, string> = {};
    const auth = c.req.header('Authorization');
    if (auth) headers.Authorization = auth;
    if (SUPABASE_ANON_FOR_STORAGE) headers.apikey = SUPABASE_ANON_FOR_STORAGE;

    const res = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.arrayBuffer().catch(() => undefined),
    });

    // Stream response back
    const respHeaders = new Headers();
    res.headers.forEach((v, k) => {
      // CORS bizim nginx'imiz halletsin
      if (!/^access-control-/i.test(k)) respHeaders.set(k, v);
    });
    return new Response(res.body, { status: res.status, headers: respHeaders });
  } catch (e: any) {
    return c.json({
      error: 'storage_proxy_error',
      message: e.message,
      hint: 'Supabase Storage\'a proxy başarısız oldu. Network ya da kimlik doğrulama sorunu olabilir.',
    }, 502);
  }
}
