/**
 * instagram-publish.ts — Instagram Graph API içerik yayınlama istemcisi.
 *
 * KAPSAM: Sadece Meta API konuşması. Drive'dan indirme, caption eşleştirme,
 * onay akışı ve zamanlama BURADA DEĞİL — onlar çağıran tarafın işi. Bu dosya
 * saf bir istemci olsun ki kimlik bilgisi olmadan da okunabilsin/test edilebilsin.
 *
 * ÜÇ AŞAMALI AKIŞ (Meta'nın dayattığı, kısaltılamaz):
 *   1) container oluştur  → POST /{ig-user-id}/media        → creation_id döner
 *   2) işlenmeyi bekle    → GET  /{container-id}?fields=status_code
 *   3) yayınla            → POST /{ig-user-id}/media_publish?creation_id=...
 *
 * 2. ADIM NEDEN ATLANAMAZ: Fotoğrafta container genelde anında FINISHED olur ve
 * insan "demek ki beklemeye gerek yok" diye yazar. Videoda/Reels'te DEĞİL —
 * Meta videoyu kendi tarafında transcode eder, bu saniyeler değil DAKİKALAR
 * sürebilir. IN_PROGRESS haldeki container'ı publish etmeye çalışmak hata
 * döndürür. O yüzden publish öncesi bekleme her medya türü için zorunlu tutuldu.
 *
 * MEDYA PUBLIC URL'DEN ÇEKİLİR: Meta'ya dosya YÜKLENMİYOR; Meta'ya bir URL
 * veriliyor ve Meta o URL'i kendi sunucusundan indiriyor. Yani URL internetten
 * erişilebilir olmalı — localhost, VPN arkası veya imzalı-süreli link çalışmaz.
 * Bizde bu zaten çözülmüş: /var/www/storage altına konan dosyayı nginx
 * https://api.constantineyachts.com/storage/v1/object/public/<bucket>/<key>
 * adresinden serv ediyor (/etc/nginx/sites-enabled/constantine-suite).
 *
 * TOKEN 60 GÜNDE DOLAR: Uzun ömürlü token kalıcı değil. refreshLongLivedToken()
 * bu yüzden var; çağıran taraf bunu periyodik çalıştırmazsa entegrasyon iki ay
 * sonra SESSİZCE durur (hata da vermez, sadece 190 döner).
 */

/** Graph API sürümü. Meta sürümleri ~2 yılda emekliye ayırıyor; kurulumda
 *  developers.facebook.com/docs/graph-api/changelog ile teyit edilip
 *  IG_GRAPH_VERSION ile sabitlenmeli. Sürümü ATLAMAK (versiyonsuz çağrı)
 *  Meta'nın o anki varsayılanına savrulmak demek — kasten yapılmıyor. */
const GRAPH_VERSION = process.env.IG_GRAPH_VERSION || 'v23.0';

/** Facebook Sayfası'na bağlı Business hesabı için host graph.facebook.com.
 *  (Instagram Login ile kurulan uygulamalarda graph.instagram.com olur ve
 *  token yenileme uç noktası da değişir — bkz. refreshLongLivedToken.) */
const GRAPH_HOST = process.env.IG_GRAPH_HOST || 'https://graph.facebook.com';

const IG_USER_ID = () => process.env.IG_USER_ID || '';
const IG_ACCESS_TOKEN = () => process.env.IG_ACCESS_TOKEN || '';

/** Video işlenmesini bekleme sınırları. 5 dk, Meta'nın uzun Reels'lerde
 *  gözlenen transcode süresine karşı geniş tutuldu; sonsuz beklemek yerine
 *  hata dönüp job'ın tekrar denemesi tercih edildi. */
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

export type IgMediaKind = 'REELS' | 'IMAGE' | 'CAROUSEL';

export interface IgResult<T> {
  ok: boolean;
  data?: T;
  /** Meta'nın hata kodu (ör. 190 = token geçersiz, 4 = rate limit). */
  code?: number;
  error?: string;
}

interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
}

function missingConfig(): string | null {
  if (!IG_USER_ID()) return 'IG_USER_ID tanımsız';
  if (!IG_ACCESS_TOKEN()) return 'IG_ACCESS_TOKEN tanımsız';
  return null;
}

/**
 * Graph API çağrısı. Hata gövdesini OLDUĞU GİBİ yüzeye çıkarır: Meta'nın
 * error_user_msg alanı çoğu zaman gerçek sebebi ("video too long", "aspect
 * ratio") söyler, generic message ise söylemez. İkisini birden taşıyoruz
 * çünkü tek satırlık "Bad Request" logu bu entegrasyonda hiçbir işe yaramıyor.
 */
async function graphCall<T>(
  path: string,
  init: { method: 'GET' | 'POST'; params?: Record<string, string> },
): Promise<IgResult<T>> {
  const url = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/${path}`);
  const params = { ...(init.params ?? {}), access_token: IG_ACCESS_TOKEN() };

  let res: Response;
  try {
    if (init.method === 'GET') {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      res = await fetch(url, { method: 'GET' });
    } else {
      // POST gövdesi form-encoded: access_token query string'de gitmesin diye
      // (proxy/nginx access log'larına düşer).
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
    }
  } catch (e: any) {
    return { ok: false, error: `ağ hatası: ${e?.message ?? 'bilinmiyor'}` };
  }

  const raw = await res.text();
  let body: any;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, error: `JSON olmayan yanıt (HTTP ${res.status}): ${raw.slice(0, 200)}` };
  }

  if (!res.ok || body?.error) {
    const err: GraphError = body?.error ?? {};
    const detail = err.error_user_msg || err.message || `HTTP ${res.status}`;
    return { ok: false, code: err.code, error: detail };
  }

  return { ok: true, data: body as T };
}

/** 1. adım — tek fotoğraf ya da Reels container'ı. */
export async function createContainer(input: {
  kind: Exclude<IgMediaKind, 'CAROUSEL'>;
  /** Public, doğrudan indirilebilir URL. Drive "paylaşım" linki ÇALIŞMAZ —
   *  o bir HTML sayfası döndürür, medya baytı değil. */
  mediaUrl: string;
  caption?: string;
  /** Reels'i ayrıca ana akışta da göster. Meta varsayılanı true. */
  shareToFeed?: boolean;
}): Promise<IgResult<{ id: string }>> {
  const bad = missingConfig();
  if (bad) return { ok: false, error: bad };

  const params: Record<string, string> = {};
  if (input.kind === 'REELS') {
    params.media_type = 'REELS';
    params.video_url = input.mediaUrl;
    if (input.shareToFeed !== undefined) params.share_to_feed = String(input.shareToFeed);
  } else {
    // IMAGE için media_type GÖNDERİLMİYOR: Meta'nın varsayılanı zaten image ve
    // media_type=IMAGE bazı sürümlerde reddediliyor.
    params.image_url = input.mediaUrl;
  }
  if (input.caption) params.caption = input.caption;

  return graphCall<{ id: string }>(`${IG_USER_ID()}/media`, { method: 'POST', params });
}

/** 1. adım (carousel) — önce her çocuk ayrı container olur, sonra kapsayıcı. */
export async function createCarouselContainer(input: {
  items: { mediaUrl: string; kind: 'IMAGE' | 'REELS' }[];
  caption?: string;
}): Promise<IgResult<{ id: string }>> {
  const bad = missingConfig();
  if (bad) return { ok: false, error: bad };

  // Meta sınırı: 2–10 öğe. Erken ve anlaşılır hata ver, API'ye boşuna gitme.
  if (input.items.length < 2 || input.items.length > 10) {
    return { ok: false, error: `carousel 2–10 öğe olmalı (verilen: ${input.items.length})` };
  }

  const childIds: string[] = [];
  for (const [i, item] of input.items.entries()) {
    const params: Record<string, string> = { is_carousel_item: 'true' };
    if (item.kind === 'REELS') params.video_url = item.mediaUrl;
    else params.image_url = item.mediaUrl;

    const child = await graphCall<{ id: string }>(`${IG_USER_ID()}/media`, { method: 'POST', params });
    if (!child.ok || !child.data) {
      return { ok: false, code: child.code, error: `carousel öğesi ${i + 1} başarısız: ${child.error}` };
    }
    childIds.push(child.data.id);
  }

  // Çocukların hepsi FINISHED olmadan kapsayıcı publish edilemez; bekleme
  // sorumluluğu waitForContainer'da, çağıran taraf kapsayıcı için de çağırmalı.
  return graphCall<{ id: string }>(`${IG_USER_ID()}/media`, {
    method: 'POST',
    params: {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      ...(input.caption ? { caption: input.caption } : {}),
    },
  });
}

/**
 * 2. adım — container işlenene kadar yokla.
 * status_code: IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED
 * EXPIRED ayrı tutuldu: container 24 saat sonra ölür, bu "tekrar dene"
 * değil "baştan container oluştur" demek.
 */
export async function waitForContainer(
  containerId: string,
  opts?: { timeoutMs?: number },
): Promise<IgResult<{ status: string }>> {
  const timeout = opts?.timeoutMs ?? POLL_TIMEOUT_MS;
  const startedAt = Date.now();

  for (;;) {
    const res = await graphCall<{ status_code?: string; status?: string }>(containerId, {
      method: 'GET',
      params: { fields: 'status_code,status' },
    });
    if (!res.ok) return { ok: false, code: res.code, error: res.error };

    const status = res.data?.status_code ?? 'UNKNOWN';
    if (status === 'FINISHED') return { ok: true, data: { status } };
    if (status === 'PUBLISHED') return { ok: true, data: { status } };
    if (status === 'ERROR' || status === 'EXPIRED') {
      // status alanı FINISHED olmayan hallerde sebebi metin olarak taşır.
      return { ok: false, error: `container ${status}: ${res.data?.status ?? 'sebep yok'}` };
    }

    if (Date.now() - startedAt > timeout) {
      return { ok: false, error: `container ${Math.round(timeout / 1000)}sn içinde hazır olmadı (son durum: ${status})` };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/** 3. adım — yayınla. Dönen id artık gerçek gönderinin id'si. */
export async function publishContainer(containerId: string): Promise<IgResult<{ id: string }>> {
  const bad = missingConfig();
  if (bad) return { ok: false, error: bad };
  return graphCall<{ id: string }>(`${IG_USER_ID()}/media_publish`, {
    method: 'POST',
    params: { creation_id: containerId },
  });
}

/**
 * Kalan günlük kota. Meta 24 saatte 25 gönderi sınırı koyuyor; 3-4 günde bir
 * atan bir akış buna asla çarpmaz ama bir döngü hatası art arda publish
 * denerse çarpar. Publish öncesi bakmak ucuz sigorta.
 */
export async function remainingQuota(): Promise<IgResult<{ used: number; limit: number }>> {
  const bad = missingConfig();
  if (bad) return { ok: false, error: bad };
  const res = await graphCall<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(
    `${IG_USER_ID()}/content_publishing_limit`,
    { method: 'GET', params: { fields: 'config,quota_usage' } },
  );
  if (!res.ok) return { ok: false, code: res.code, error: res.error };
  const row = res.data?.data?.[0];
  return { ok: true, data: { used: row?.quota_usage ?? 0, limit: row?.config?.quota_total ?? 25 } };
}

/**
 * Uzun ömürlü token'ı tazeler ve YENİ token'ı döndürür — kalıcı yazma işi
 * çağırana ait (bu modül DB bilmiyor).
 *
 * DİKKAT: Bu uç nokta Facebook Login akışı içindir. Uygulama Instagram Login
 * ile kurulduysa host graph.instagram.com ve yol /refresh_access_token olur;
 * o zaman burası da değişmeli.
 */
export async function refreshLongLivedToken(): Promise<IgResult<{ token: string; expiresInDays: number }>> {
  const appId = process.env.IG_APP_ID;
  const appSecret = process.env.IG_APP_SECRET;
  const current = IG_ACCESS_TOKEN();
  if (!appId || !appSecret) return { ok: false, error: 'IG_APP_ID / IG_APP_SECRET tanımsız' };
  if (!current) return { ok: false, error: 'IG_ACCESS_TOKEN tanımsız' };

  const url = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', current);

  try {
    const res = await fetch(url, { method: 'GET' });
    const body: any = await res.json();
    if (!res.ok || body?.error) {
      return { ok: false, code: body?.error?.code, error: body?.error?.message ?? `HTTP ${res.status}` };
    }
    return {
      ok: true,
      data: {
        token: body.access_token,
        expiresInDays: Math.round((body.expires_in ?? 0) / 86400),
      },
    };
  } catch (e: any) {
    return { ok: false, error: `ağ hatası: ${e?.message ?? 'bilinmiyor'}` };
  }
}

/**
 * Uçtan uca kolaylık sarmalayıcısı: container → bekle → publish.
 * Çağıran taraf üç adımı ayrı ayrı da kullanabilir (onay akışında container'ı
 * şimdi oluşturup publish'i onaydan SONRA yapmak gerekebilir — o yüzden
 * adımlar ayrı ayrı da export ediliyor).
 */
export async function publishNow(input: {
  kind: IgMediaKind;
  mediaUrl?: string;
  items?: { mediaUrl: string; kind: 'IMAGE' | 'REELS' }[];
  caption?: string;
  shareToFeed?: boolean;
}): Promise<IgResult<{ postId: string }>> {
  const created =
    input.kind === 'CAROUSEL'
      ? await createCarouselContainer({ items: input.items ?? [], caption: input.caption })
      : input.mediaUrl
        ? await createContainer({
            kind: input.kind,
            mediaUrl: input.mediaUrl,
            caption: input.caption,
            shareToFeed: input.shareToFeed,
          })
        : { ok: false as const, error: 'mediaUrl gerekli' };

  if (!created.ok || !created.data) {
    console.error('[instagram] container oluşturulamadı:', created.error);
    return { ok: false, code: created.code, error: created.error };
  }

  const ready = await waitForContainer(created.data.id);
  if (!ready.ok) {
    console.error('[instagram] container hazır olmadı:', ready.error);
    return { ok: false, code: ready.code, error: ready.error };
  }

  const published = await publishContainer(created.data.id);
  if (!published.ok || !published.data) {
    console.error('[instagram] publish başarısız:', published.error);
    return { ok: false, code: published.code, error: published.error };
  }

  console.log(`[instagram] yayınlandı: post_id=${published.data.id} kind=${input.kind}`);
  return { ok: true, data: { postId: published.data.id } };
}
