-- 0013 — record_collection: 'full' modunda TRY aynasını da güncelle
--
-- SORUN (2026-08-19 denetimi):
-- `bookings` hem orijinal tutarı (total_price) hem TRY aynasını (total_price_try)
-- taşıyor; ikisini senkron tutan HİÇBİR trigger yok ve TRY kolonlarının DEFAULT'u 0.
-- record_collection 'full' modu `total_price`'ı p_amount ile güncelliyor ama
-- `total_price_try`'a HİÇ dokunmuyordu. Sonuç: tahsilat kaydedilen rezervasyonun
-- TRY aynası eski (çoğu zaman 0) kalıyor.
--
-- Bu kolonu okuyan yerler — yani sessizce ₺0 gören her yer:
--   daily-digest.ts:296,341   SUM(total_price_try)  → günlük/haftalık KPI mailleri
--   settlement.ts:162,175,316 ortak mutabakatı      → yanlış bakiye ve transfer önerisi
--   Calendar.tsx              fmtTRY(total_price_try)
--
-- Ölçülen etki (düzeltme öncesi): total_price > 0 ve total_price_try = 0 olan
-- 30 rezervasyon, toplam ₺212.696,86 görünmez ciro.
--
-- NOT: p_amount rezervasyonun KENDİ para biriminde; TRY karşılığı için kur ile
-- çarpılır. TRY rezervasyonlarda exchange_rate = 1 olduğundan sonuç tutarın kendisi.
-- our_share bu modda değişmediği için our_share_try'a dokunulmuyor (aynası geçerli).
--
-- Geri alma: bu dosyadaki gövdeden `total_price_try` satırını çıkarıp tekrar çalıştır.

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
      deposit_amount       = p_amount,
      deposit_method       = p_method,
      deposit_collector_id = auth.uid(),
      deposit_date         = current_date,
      payment_status       = 'deposit',
      status               = case when status = 'draft' then 'confirmed' else status end
    where id = p_booking_id;
  elsif p_mode = 'full' then
    update bookings set
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
      payment_method       = p_method,
      payment_collector_id = auth.uid(),
      payment_date         = current_date,
      payment_status       = 'paid'
    where id = p_booking_id;
  end if;
end;
$function$;
