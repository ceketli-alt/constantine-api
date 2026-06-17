-- ============================================================
-- Self-service kaptan onboarding (partner-fleet v4)
-- ============================================================
-- Admin tekneciye davet linki üretir → kaptan public formdan kendi tekne
-- bilgisi + foto + takvim girer → 'pending_review' draft boat → admin onaylar
-- ('published' + active=true). İdempotent.

BEGIN;

-- Davet token sistemi
CREATE TABLE IF NOT EXISTS boat_onboarding_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token         text UNIQUE NOT NULL,
  label         text,                                  -- admin notu (örn. "Mahir - 2. tekne")
  created_by    uuid REFERENCES profiles(id),
  boat_id       uuid REFERENCES boats(id) ON DELETE SET NULL, -- submit edilince doldurulur
  status        text NOT NULL DEFAULT 'sent',          -- sent | submitted | published | expired
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_boat_onboarding_invites_token ON boat_onboarding_invites(token);
CREATE INDEX IF NOT EXISTS idx_boat_onboarding_invites_status ON boat_onboarding_invites(status);

COMMENT ON TABLE boat_onboarding_invites IS 'Self-service kaptan onboarding davet tokenleri (v4).';

-- boats: kaptan başvurusu durumu (admin-created tekneden ayırt et)
ALTER TABLE boats ADD COLUMN IF NOT EXISTS onboarding_status text;
COMMENT ON COLUMN boats.onboarding_status IS
  'NULL=normal/admin tekne; pending_review=kaptan başvurusu (active=false, onay bekliyor); published=onaylandı. v4.';

COMMIT;
