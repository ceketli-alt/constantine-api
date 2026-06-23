-- 2026-06-22 — Constantine sync takvimi güvenlik kısıtı (defense-in-depth)
--
-- Sync takvimi (boats.sync_calendar_id) ASLA primary ops takvimi olamaz:
--   * 'primary' literal'i (OAuth callback google_calendar_id='primary' yazar)
--   * boats.google_calendar_id (ops takvimi — misafir PII içerir)
-- Bu takvim partnere (Simon) edit yetkisiyle paylaşıldığı için, ops takvimine
-- eşitlenmesi tüm müşteri verisini dış tarafa sızdırır. Uygulama katmanında
-- assertSafeSyncCalendarId guard'ı var (constantine-sync.ts); bu CHECK onun
-- DB-seviyesi ikizidir — herhangi bir kod yolu / manuel UPDATE bunu yazamaz.
--
-- Additive + idempotent (IF NOT EXISTS). Veri değişmez, yalnız kısıt eklenir.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'boats_sync_calendar_id_not_ops_chk'
  ) THEN
    ALTER TABLE boats
      ADD CONSTRAINT boats_sync_calendar_id_not_ops_chk
      CHECK (
        sync_calendar_id IS NULL
        OR (
          sync_calendar_id <> 'primary'
          AND (google_calendar_id IS NULL OR sync_calendar_id <> google_calendar_id)
        )
      );
  END IF;
END $$;

COMMENT ON CONSTRAINT boats_sync_calendar_id_not_ops_chk ON boats IS
  'Güvenlik: sync_calendar_id (partnerla paylaşılan müsaitlik takvimi) primary ops takvimi (''primary'' ya da google_calendar_id) olamaz — aksi halde misafir PII dış partnere sızar.';
