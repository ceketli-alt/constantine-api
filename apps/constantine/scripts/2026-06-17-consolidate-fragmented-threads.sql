-- 2026-06-17 — G3: Geçmiş fragmente e-posta thread'lerini lead başına birleştir
--
-- Bağlam: Mailcow threading kırıklığı + subject-exact outbound eşleştirme nedeniyle
-- bir lead'in konuşması birden çok thread'e bölünmüştü (19 lead, 47 thread).
-- Kod fix'i (email-send lead.email_thread_id reuse + email-inbound lead-based fallback)
-- YENİ fragmentasyonu durdurur; bu migration GEÇMİŞ veriyi tek-thread-per-lead'e çeker.
--
-- Strateji (tek transaction, tablo kilitli):
--   canonical = lead'in EN ESKİ thread'i (created_at ASC) — orijinal konuşma başlangıcı
--   • non-canonical thread'lerin mesajları canonical'a taşınır (silmeden ÖNCE)
--   • canonical.classification = birleşen set içinde EN GÜNCEL classified (most-recent wins)
--   • unread_count = birleşen thread'lerin toplamı
--   • message_count / last_message_at / last_direction yeniden hesaplanır
--   • boşalan non-canonical thread'ler silinir
--   • leads.email_thread_id = canonical
--
-- GÜVENLİK (adversarial review sonrası eklendi):
--   • LOCK TABLE: canlı IMAP poller + campaign worker yarışmasın (alt-saniye blok, SELECT'i engellemez)
--   • _bkp_* kalıcı yedek tabloları: hatalı birleşme geri alınabilsin (sonra elle DROP)
--   • COMMIT sonrası doğrulama sorguları ayrıca çalıştırılır (bu dosyada değil)

BEGIN;

-- Canlı yazarları (inbound poller / campaign worker) serialize et — alt-saniye.
-- SHARE ROW EXCLUSIVE: INSERT/UPDATE/DELETE'i bekletir, SELECT'i (frontend) engellemez.
LOCK TABLE email_threads, email_messages IN SHARE ROW EXCLUSIVE MODE;

-- Fragmente lead'lerin tüm thread'leri + canonical eşlemesi
CREATE TEMP TABLE _tm ON COMMIT DROP AS
WITH frag AS (
  SELECT lead_id FROM email_threads
  WHERE lead_id IS NOT NULL
  GROUP BY lead_id HAVING count(*) > 1
)
SELECT t.id AS thread_id, t.lead_id, t.unread_count, t.classification, t.classified_at, t.created_at,
       first_value(t.id) OVER (PARTITION BY t.lead_id ORDER BY t.created_at ASC, t.id ASC) AS canonical_id
FROM email_threads t
WHERE t.lead_id IN (SELECT lead_id FROM frag);

-- ── Kalıcı yedek (geri-alma için; iş bitince elle DROP) ──
CREATE TABLE IF NOT EXISTS _bkp_email_threads_20260617 AS
  SELECT t.* FROM email_threads t WHERE t.id IN (SELECT thread_id FROM _tm);
CREATE TABLE IF NOT EXISTS _bkp_email_msg_threadmap_20260617 AS
  SELECT m.id, m.thread_id FROM email_messages m WHERE m.thread_id IN (SELECT thread_id FROM _tm);
CREATE TABLE IF NOT EXISTS _bkp_leads_threadptr_20260617 AS
  SELECT DISTINCT l.id, l.email_thread_id
  FROM leads l WHERE l.id IN (SELECT DISTINCT lead_id FROM _tm);

-- Canonical başına okunmamış toplamı
CREATE TEMP TABLE _canon ON COMMIT DROP AS
SELECT canonical_id, SUM(unread_count)::int AS unread_sum
FROM _tm GROUP BY canonical_id;

-- Classification kaynağı: birleşen set içinde EN GÜNCEL classified (canonical dahil).
-- Tiebreak thread_id ile deterministik.
CREATE TEMP TABLE _classpick ON COMMIT DROP AS
SELECT DISTINCT ON (canonical_id) canonical_id, classification, classified_at
FROM _tm
WHERE classification IS NOT NULL
ORDER BY canonical_id, classified_at DESC NULLS LAST, thread_id;

-- 1. classification carry-over — most-recent-wins (koşulsuz: _classpick zaten
--    canonical dahil en güncel'i seçer; canonical zaten en güncelse no-op).
UPDATE email_threads canon
SET classification = cp.classification, classified_at = cp.classified_at
FROM _classpick cp
WHERE canon.id = cp.canonical_id;

-- 2. mesajları canonical'a taşı (silmeden ÖNCE → CASCADE ile mesaj kaybı imkansız)
UPDATE email_messages msg
SET thread_id = m.canonical_id
FROM _tm m
WHERE msg.thread_id = m.thread_id
  AND m.thread_id <> m.canonical_id;

-- 3. leads.email_thread_id → canonical
UPDATE leads l
SET email_thread_id = m.canonical_id
FROM (SELECT DISTINCT lead_id, canonical_id FROM _tm) m
WHERE l.id = m.lead_id;

-- 4. boşalan non-canonical thread'leri sil (artık mesajsız)
DELETE FROM email_threads
WHERE id IN (SELECT thread_id FROM _tm WHERE thread_id <> canonical_id);

-- 5. canonical aggregate recompute
UPDATE email_threads t
SET message_count = agg.mc,
    last_message_at = agg.last_at,
    last_direction = agg.last_dir
FROM (
  SELECT thread_id,
         count(*)::int AS mc,
         max(COALESCE(sent_at, received_at, created_at)) AS last_at,
         (ARRAY_AGG(direction ORDER BY COALESCE(sent_at, received_at, created_at) DESC, created_at DESC))[1] AS last_dir
  FROM email_messages
  WHERE thread_id IN (SELECT DISTINCT canonical_id FROM _tm)
  GROUP BY thread_id
) agg
WHERE t.id = agg.thread_id;

-- 6. unread_count = birleşen thread'lerin toplamı
UPDATE email_threads t
SET unread_count = c.unread_sum
FROM _canon c
WHERE t.id = c.canonical_id;

COMMIT;
