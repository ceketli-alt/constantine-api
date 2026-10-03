-- 0014 — "Ödeme alınmadı" (manifest/kaptan ekranı)
--
-- Kaptan tur sonunda para almadıysa bunu BİLEREK işaretleyebilsin; aksi hâlde kırmızı
-- "TAHSİL EDİLMEDİ" uyarısı unutulmuş kayıtla bilinçli olanı ayırt edemiyordu.
-- İki sebep:
--   agency    → acente kendisi tahsil etti/edecek: rezervasyon 'Acente Tahsilatı' ile ödendi
--               sayılır (mevcut kavram: payment_method='agency_collected', tahsilatçı yok),
--               acente mutabakatına düşer.
--   follow_up → para alınmadı, admin peşine düşecek: payment_status DEĞİŞMEZ (pending/deposit
--               kalır, digest + Bekleyen Tahsilat listesinde görünmeye devam eder), sadece
--               kimin/ne zaman/neden işaretlediği tutulur; manifest uyarıyı griye çevirir.
-- record_collection her dalda bu izi temizler: para alınınca "alınmadı" bayrağı kalmaz.
-- Geri alma yalnız follow_up için; agency ödeme durumunu değiştirdiği için düzenleme formundan.

alter table public.bookings
  add column if not exists collection_skipped_at  timestamptz,
  add column if not exists collection_skipped_by  uuid references public.profiles(id),
  add column if not exists collection_skip_reason text
    check (collection_skip_reason in ('agency', 'follow_up')),
  add column if not exists collection_skip_note   text;

create or replace function public.skip_collection(p_booking_id uuid, p_reason text, p_note text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_booking bookings%rowtype;
begin
  select * into v_booking from bookings where id = p_booking_id;
  if not found then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;
  -- Yetki: record_collection ile aynı — super_admin veya tekneye atanmış herkes
  -- auth.uid() null (doğrudan DB oturumu) → is_super_admin() null → "not null" = null → if geçmezdi.
  -- coalesce ile kimliksiz çağrı KESİN reddedilir.
  if not coalesce(
    is_super_admin()
    or exists (select 1 from boat_assignments where user_id = auth.uid() and boat_id = v_booking.boat_id),
    false
  ) then
    raise exception 'not authorized for this boat' using errcode = '42501';
  end if;
  if p_reason not in ('agency', 'follow_up') then
    raise exception 'invalid reason: %', p_reason using errcode = '22023';
  end if;
  if v_booking.payment_status = 'paid' then
    raise exception 'booking already paid' using errcode = '22023';
  end if;

  if p_reason = 'agency' then
    update bookings set
      payment_status         = 'paid',
      payment_method         = 'agency_collected',
      payment_date           = current_date,
      payment_collector_id   = null,
      status                 = case when status = 'draft' then 'confirmed' else status end,
      collection_skipped_at  = now(),
      collection_skipped_by  = auth.uid(),
      collection_skip_reason = 'agency',
      collection_skip_note   = nullif(trim(coalesce(p_note, '')), '')
    where id = p_booking_id;
  else
    update bookings set
      collection_skipped_at  = now(),
      collection_skipped_by  = auth.uid(),
      collection_skip_reason = 'follow_up',
      collection_skip_note   = nullif(trim(coalesce(p_note, '')), '')
    where id = p_booking_id;
  end if;
end;
$function$;

create or replace function public.undo_skip_collection(p_booking_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_booking bookings%rowtype;
begin
  select * into v_booking from bookings where id = p_booking_id;
  if not found then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;
  -- auth.uid() null (doğrudan DB oturumu) → is_super_admin() null → "not null" = null → if geçmezdi.
  -- coalesce ile kimliksiz çağrı KESİN reddedilir.
  if not coalesce(
    is_super_admin()
    or exists (select 1 from boat_assignments where user_id = auth.uid() and boat_id = v_booking.boat_id),
    false
  ) then
    raise exception 'not authorized for this boat' using errcode = '42501';
  end if;
  if v_booking.collection_skip_reason = 'agency' then
    raise exception 'agency collection cannot be undone here' using errcode = '22023';
  end if;
  update bookings set
    collection_skipped_at  = null,
    collection_skipped_by  = null,
    collection_skip_reason = null,
    collection_skip_note   = null
  where id = p_booking_id;
end;
$function$;

-- record_collection: 0013 gövdesi + her dalda "alınmadı" izinin temizlenmesi
CREATE OR REPLACE FUNCTION public.record_collection(p_booking_id uuid, p_mode text, p_amount numeric, p_method text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking bookings%rowtype;
begin
  -- Booking'i bul
  select * into v_booking from bookings where id = p_booking_id;
  if not found then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;

  -- Yetki: super_admin veya boat'a atanmış (rolü ne olursa olsun)
  if not (
    is_super_admin()
    or exists (
      select 1 from boat_assignments
      where user_id = auth.uid() and boat_id = v_booking.boat_id
    )
  ) then
    raise exception 'not authorized for this boat' using errcode = '42501';
  end if;

  -- Mode + amount validation
  if p_mode not in ('deposit', 'full', 'remaining') then
    raise exception 'invalid mode: %', p_mode using errcode = '22023';
  end if;
  if p_mode in ('deposit', 'full') and (p_amount is null or p_amount <= 0) then
    raise exception 'amount required for % mode', p_mode using errcode = '22023';
  end if;

  -- Mode-specific update
  if p_mode = 'deposit' then
    update bookings set
      collection_skipped_at   = null,
      collection_skipped_by   = null,
      collection_skip_reason  = null,
      collection_skip_note    = null,
      deposit_amount       = p_amount,
      deposit_method       = p_method,
      deposit_collector_id = auth.uid(),
      deposit_date         = current_date,
      payment_status       = 'deposit',
      status               = case when status = 'draft' then 'confirmed' else status end
    where id = p_booking_id;
  elsif p_mode = 'full' then
    update bookings set
      collection_skipped_at   = null,
      collection_skipped_by   = null,
      collection_skip_reason  = null,
      collection_skip_note    = null,
      total_price          = case when p_amount > 0 then p_amount else total_price end,
      -- ⬇ EKLENDİ (0013): tutar güncelleniyorsa TRY aynası da güncellenmeli
      total_price_try      = case when p_amount > 0
                                  then round(p_amount * coalesce(exchange_rate, 1), 2)
                                  else total_price_try end,
      payment_method       = p_method,
      payment_collector_id = auth.uid(),
      payment_date         = current_date,
      payment_status       = 'paid',
      status               = case when status = 'draft' then 'confirmed' else status end
    where id = p_booking_id;
  elsif p_mode = 'remaining' then
    update bookings set
      collection_skipped_at   = null,
      collection_skipped_by   = null,
      collection_skip_reason  = null,
      collection_skip_note    = null,
      payment_method       = p_method,
      payment_collector_id = auth.uid(),
      payment_date         = current_date,
      payment_status       = 'paid'
    where id = p_booking_id;
  end if;
end;
$function$;
