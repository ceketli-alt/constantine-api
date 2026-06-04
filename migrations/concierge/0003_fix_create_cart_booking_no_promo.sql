-- 0003_fix_create_cart_booking_no_promo.sql
--
-- Fix: create_cart_booking() referenced v_promo.id / v_promo.code (a record
-- only assigned inside the 'if p_promo_code is not null' block) in the booking
-- INSERT and the return value. With no promo code, v_promo is unassigned and
-- Postgres raises 'record "v_promo" is not assigned yet', so EVERY promo-less
-- storefront booking failed. Introduces v_promo_id/v_promo_code scalars that
-- default to NULL and are set only when a promo is applied.
--
-- Apply: sudo -u postgres psql concierge -f migrations/concierge/0003_fix_create_cart_booking_no_promo.sql

CREATE OR REPLACE FUNCTION public.create_cart_booking(p_reseller_slug text, p_promo_code text, p_guest jsonb, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cart_id uuid := gen_random_uuid();
  v_reseller_id uuid;
  v_reseller_name text;
  v_line jsonb;
  v_item jsonb;
  v_line_subtotal numeric(12,2);
  v_cart_subtotal numeric(12,2) := 0;
  v_cart_discount numeric(12,2) := 0;
  v_cart_total numeric(12,2);
  v_currency text;
  v_first_currency text;
  v_results jsonb := '[]'::jsonb;
  v_promo record;
  v_promo_id uuid := null;
  v_promo_code text := null;
  v_now timestamptz := now();
  v_proportional_discount numeric(12,2);
  v_lines_arr jsonb := coalesce(p_lines, '[]'::jsonb);
  v_product_id uuid;
  v_vendor_id uuid;
  v_product_title text;
  v_product_type product_type;
  v_capacity_max int;
  v_advance_hours int;
  v_vendor_name text;
  v_booking_date date;
  v_pax int;
  v_qty int;
  v_unit numeric(10,2);
  v_date_capacity int;
  v_booked int;
  v_reference text;
  v_booking_id uuid;
begin
  if jsonb_array_length(v_lines_arr) < 1 then
    raise exception 'empty cart' using errcode = 'P0001';
  end if;

  if p_reseller_slug is not null then
    select id, display_name into v_reseller_id, v_reseller_name from resellers
     where slug = p_reseller_slug and status = 'approved';
  end if;

  -- Pass 1: cart subtotal + currency-consistency check
  for v_line in select * from jsonb_array_elements(v_lines_arr)
  loop
    v_first_currency := coalesce(v_first_currency, v_line->>'currency');
    if v_first_currency <> (v_line->>'currency') then
      raise exception 'mixed currency cart not supported' using errcode = 'P0001';
    end if;

    v_line_subtotal := 0;
    for v_item in select * from jsonb_array_elements(v_line->'items')
    loop
      v_line_subtotal := v_line_subtotal + (v_item->>'unit_price')::numeric * (v_item->>'quantity')::int;
    end loop;
    v_cart_subtotal := v_cart_subtotal + v_line_subtotal;
  end loop;

  v_currency := v_first_currency;
  if v_currency not in ('EUR', 'USD') then
    raise exception 'invalid currency' using errcode = 'P0001';
  end if;

  -- Promo validation against cart subtotal
  if p_promo_code is not null and p_promo_code <> '' then
    select pc.* into v_promo
      from promo_codes pc
     where pc.code = p_promo_code and pc.active = true
       and (pc.starts_at is null or pc.starts_at <= v_now)
       and (pc.expires_at is null or pc.expires_at >= v_now)
       and (pc.max_redemptions is null or pc.redeemed_count < pc.max_redemptions)
       and (
         pc.scope = 'global'
         or (pc.scope = 'reseller' and pc.reseller_id = v_reseller_id)
         or (pc.scope = 'vendor' and pc.vendor_id in (
              select p.vendor_id from products p
               where p.id in (select (l->>'product_id')::uuid from jsonb_array_elements(v_lines_arr) l)
         ))
       );
    if v_promo.id is null then
      raise exception 'invalid promo' using errcode = 'P0001';
    end if;
    if v_promo.discount_type = 'percent' then
      v_cart_discount := round(v_cart_subtotal * v_promo.discount_value / 100, 2);
    else
      if v_promo.currency is not null and v_promo.currency <> v_currency then
        raise exception 'promo currency mismatch' using errcode = 'P0001';
      end if;
      v_cart_discount := least(v_promo.discount_value, v_cart_subtotal);
    end if;
    update promo_codes set redeemed_count = redeemed_count + 1 where id = v_promo.id;
    v_promo_id := v_promo.id;
    v_promo_code := v_promo.code;
  end if;

  v_cart_total := v_cart_subtotal - v_cart_discount;

  -- Pass 2: per-line INSERT directly into bookings + booking_items
  for v_line in select * from jsonb_array_elements(v_lines_arr)
  loop
    v_product_id := (v_line->>'product_id')::uuid;
    v_booking_date := (v_line->>'booking_date')::date;

    select p.vendor_id, p.title, p.type, p.capacity_max, p.advance_booking_hours, v.display_name
      into v_vendor_id, v_product_title, v_product_type, v_capacity_max, v_advance_hours, v_vendor_name
      from products p
      join vendors v on v.id = p.vendor_id
      where p.id = v_product_id and p.status = 'published' and v.status = 'approved'
      for update of p;
    if not found then
      raise exception 'product not available' using errcode = 'P0001';
    end if;

    if v_booking_date < current_date + greatest(1, ceil(v_advance_hours / 24.0))::int then
      raise exception 'booking date too soon' using errcode = 'P0001';
    end if;

    v_line_subtotal := 0;
    v_pax := 0;
    for v_item in select * from jsonb_array_elements(v_line->'items')
    loop
      v_qty := (v_item->>'quantity')::int;
      v_unit := (v_item->>'unit_price')::numeric;
      if v_qty < 1 or v_unit < 0 then
        raise exception 'invalid booking item' using errcode = 'P0001';
      end if;
      v_pax := v_pax + v_qty;
      v_line_subtotal := v_line_subtotal + v_unit * v_qty;
    end loop;
    if v_pax < 1 then
      raise exception 'booking has no guests' using errcode = 'P0001';
    end if;

    -- Capacity for the booking date
    select case when not pa.is_open then 0 else coalesce(pa.capacity, v_capacity_max) end
      into v_date_capacity
      from product_availability pa
      where pa.product_id = v_product_id and pa.date = v_booking_date;
    if not found then
      v_date_capacity := v_capacity_max;
    end if;
    if v_date_capacity <= 0 then
      raise exception 'date not available' using errcode = 'P0001';
    end if;

    select coalesce(sum(pax_total), 0) into v_booked
      from bookings
      where product_id = v_product_id and booking_date = v_booking_date
        and status <> 'cancelled';
    if v_booked + v_pax > v_date_capacity then
      raise exception 'insufficient capacity' using errcode = 'P0001';
    end if;

    -- Proportional discount per line
    if v_cart_subtotal > 0 then
      v_proportional_discount := round(v_line_subtotal - v_line_subtotal * v_cart_total / v_cart_subtotal, 2);
    else
      v_proportional_discount := 0;
    end if;

    v_reference := 'CC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    v_booking_id := gen_random_uuid();

    insert into bookings (
      id, reference, product_id, product_title, product_type, vendor_id, vendor_name,
      reseller_id, reseller_name, booking_date, slot_time,
      guest_name, guest_email, guest_phone, guest_notes,
      pax_total, currency, total, discount_amount, promo_code_id, cart_id, created_at
    ) values (
      v_booking_id, v_reference, v_product_id, v_product_title, v_product_type, v_vendor_id, v_vendor_name,
      v_reseller_id, v_reseller_name, v_booking_date, nullif(v_line->>'slot_time', ''),
      p_guest->>'name', p_guest->>'email',
      nullif(p_guest->>'phone',''), nullif(p_guest->>'notes',''),
      v_pax, v_currency,
      v_line_subtotal - v_proportional_discount,
      v_proportional_discount,
      v_promo_id,
      v_cart_id, v_now
    );

    for v_item in select * from jsonb_array_elements(v_line->'items')
    loop
      v_qty := (v_item->>'quantity')::int;
      v_unit := (v_item->>'unit_price')::numeric;
      insert into booking_items (booking_id, pricing_category_id, label, unit_price, currency, quantity, line_total)
      values (
        v_booking_id,
        nullif(v_item->>'pricing_category_id', '')::uuid,
        v_item->>'label',
        v_unit, v_currency, v_qty, v_unit * v_qty
      );
    end loop;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'reference', v_reference,
      'product_id', v_product_id,
      'product_title', v_product_title,
      'booking_date', v_booking_date,
      'slot_time', nullif(v_line->>'slot_time', ''),
      'total', v_line_subtotal - v_proportional_discount,
      'currency', v_currency
    ));
  end loop;

  return jsonb_build_object(
    'cart_id', v_cart_id,
    'currency', v_currency,
    'subtotal', v_cart_subtotal,
    'discount', v_cart_discount,
    'total', v_cart_total,
    'promo_code', v_promo_code,
    'bookings', v_results
  );
end
$function$

;
