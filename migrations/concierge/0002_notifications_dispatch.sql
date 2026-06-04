-- 0002_notifications_dispatch.sql
-- Server-side claim/mark/count helpers for the Node notifications dispatcher.
--
-- The `notifications` queue is admin-only (RLS policy notifications_admin_all
-- USING is_platform_admin(); table GRANTs are postgres-only). The backend
-- connects as concierge_user with no platform-admin JWT context, so it cannot
-- read/update the queue directly. These SECURITY DEFINER helpers (owned by the
-- table owner, mirroring queue_notification) let the dispatcher drain the queue
-- without granting concierge_user broad table access or threading an admin JWT.
--
-- Apply as postgres superuser:
--   sudo -u postgres psql concierge -f migrations/concierge/0002_notifications_dispatch.sql

-- Claim a batch of pending rows (or specific ids for retry). Read-only select;
-- the Node side serialises drains with an in-process mutex, so no row lock is
-- needed at this scale.
CREATE OR REPLACE FUNCTION public.notifications_claim_batch(
  p_limit int DEFAULT 50,
  p_max_attempts int DEFAULT 3,
  p_ids text[] DEFAULT NULL
)
RETURNS SETOF public.notifications
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT *
  FROM notifications
  WHERE CASE
          WHEN p_ids IS NOT NULL THEN id = ANY (p_ids::uuid[])
          ELSE status = 'pending' AND attempts < p_max_attempts
        END
  ORDER BY created_at ASC
  LIMIT GREATEST(p_limit, 0)
$function$;

-- Mark a row after a send attempt. Always bumps attempts; sets sent_at only on
-- success; merges provider_message_id; records last_error (NULL clears it).
CREATE OR REPLACE FUNCTION public.notifications_mark(
  p_id uuid,
  p_status notification_status,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  update notifications
     set status = p_status,
         attempts = attempts + 1,
         sent_at = case when p_status = 'sent' then now() else sent_at end,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         last_error = p_error
   where id = p_id;
end;
$function$;

-- Count rows still eligible for sending (informational for the runner).
CREATE OR REPLACE FUNCTION public.notifications_pending_count(p_max_attempts int DEFAULT 3)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT count(*)::int FROM notifications WHERE status = 'pending' AND attempts < p_max_attempts
$function$;

GRANT EXECUTE ON FUNCTION public.notifications_claim_batch(int, int, text[]) TO concierge_user;
GRANT EXECUTE ON FUNCTION public.notifications_mark(uuid, notification_status, text, text) TO concierge_user;
GRANT EXECUTE ON FUNCTION public.notifications_pending_count(int) TO concierge_user;
