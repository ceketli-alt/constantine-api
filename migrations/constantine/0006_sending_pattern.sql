-- 0006 — Faz 1: Gönderim gerçekçiliği + throttling (Instantly özellik boşluk analizi)
-- G3 sending pattern (gap+jitter), G4 max-new-leads + prioritize, G7 text-only,
-- G8 domain/şirket başına günlük limit + şirket-seviyesi reply-stop.
-- Hepsi additive (ADD COLUMN IF NOT EXISTS + ADD VALUE IF NOT EXISTS) → güvenli, geri-uyumlu.
--
-- NOT: ALTER TYPE ADD VALUE ayrı statement olarak (psql -f autocommit) çalışır; aynı migration'da
-- değer KULLANILMAZ (sadece runtime'da worker/email-inbound kullanır) → "unsafe use" hatası olmaz.

-- G8 — company-reply-stop için yeni hedef statüsü (queued sibling'leri durdururken kullanılır)
ALTER TYPE campaign_target_status ADD VALUE IF NOT EXISTS 'company_stopped';

-- G3 — insansı gönderim aralığı (Resend rate-limit gap'inin ÜSTÜNE eklenir)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS min_gap_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS random_gap_seconds integer NOT NULL DEFAULT 0;

-- G4 — yeni lead günlük limiti (follow-up'tan ayrı) + önceliklendirme toggle
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_new_leads_per_day integer; -- null = ayrı limit yok (daily_cap geçerli)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS prioritize_new_leads boolean NOT NULL DEFAULT false;

-- G7 — text-only gönderim (HTML yok → daha az spam sinyali)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS send_text_only boolean NOT NULL DEFAULT false;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS first_email_text_only boolean NOT NULL DEFAULT false;

-- G8 — domain/şirket başına günlük gönderim limiti + bir reply gelince şirketin tümünü durdur
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_per_company_per_day integer; -- null = limitsiz
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS stop_company_on_reply boolean NOT NULL DEFAULT false;
