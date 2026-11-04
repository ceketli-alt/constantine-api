-- 0015 — Personel yetki koruması (3 Kas 2026 güvenlik denetimi)
--
-- Sorun: API'de checkTableAccess her giriş yapmış kullanıcıya her tabloda yazma izni veriyor
-- ve DB rolü BYPASSRLS. Bu yüzden bir kaptan/mürettebat `PATCH /rest/v1/profiles?id=eq.<kendi>`
-- {role:'super_admin'} ile kendini yönetici yapabiliyordu. Mert: "Kaptanlar kendini yönetici
-- yapamasın."
--
-- Kural (REST, rpc — istek bağlamı olan her yol; tetikleyici olduğu için API'yi atlatmak mümkün değil):
--   super_admin        → her şey serbest.
--   partner            → Ayarlar > Personel ekranı çalışmaya devam eder: başkasının rol/aktiflik/
--                        mutabakat alanlarını değiştirebilir, AMA yönetici satırına dokunamaz,
--                        kimseyi yönetici yapamaz, kendi rol/aktiflik/mutabakat alanını değiştiremez.
--   diğer roller       → yalnız kendi satırında ad ve bildirim tercihi (daily_digest_enabled).
--   Personel ekleme/silme (INSERT/DELETE) yalnız super_admin.
--   İstek bağlamı yoksa (auth.uid() NULL: sunucu içi işler, cron, handle_new_user) → serbest;
--   REST/rpc kimliksiz isteği zaten API katmanında reddediyor.
-- Uygulandı 3 Kas 2026.

create or replace function public.guard_profile_privileges()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_caller_role text;
  v_privileged boolean;
begin
  if v_caller is null then
    return coalesce(new, old);
  end if;

  select role::text into v_caller_role from public.profiles where id = v_caller;
  if v_caller_role = 'super_admin' then
    return coalesce(new, old);
  end if;

  if tg_op in ('INSERT', 'DELETE') then
    raise exception 'Yetki yok: personel ekleme/silme yalnız yönetici (super_admin) yapabilir'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id then
    raise exception 'Yetki yok: profil kimliği değiştirilemez' using errcode = '42501';
  end if;

  v_privileged := new.role is distinct from old.role
               or new.active is distinct from old.active
               or new.email is distinct from old.email
               or new.settlement_share_pct is distinct from old.settlement_share_pct
               or new.settlement_view_access is distinct from old.settlement_view_access;

  if v_caller_role = 'partner' then
    if v_privileged then
      if old.id = v_caller then
        raise exception 'Yetki yok: kendi rolünü/erişimini değiştiremezsin' using errcode = '42501';
      end if;
      if old.role::text = 'super_admin' or new.role::text = 'super_admin' then
        raise exception 'Yetki yok: yönetici (super_admin) rolünü yalnız yönetici verebilir/değiştirebilir'
          using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- captain / crew / accountant / member
  if old.id <> v_caller then
    raise exception 'Yetki yok: başka personelin profilini değiştiremezsin' using errcode = '42501';
  end if;
  if v_privileged then
    raise exception 'Yetki yok: rol/erişim değişikliği yalnız yönetici yapabilir' using errcode = '42501';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_profile_privileges on public.profiles;
create trigger trg_guard_profile_privileges
  before insert or update or delete on public.profiles
  for each row execute function public.guard_profile_privileges();
