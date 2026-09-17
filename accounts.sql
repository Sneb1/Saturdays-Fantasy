-- =============================================================
--  Saturdays Fantasy - usernames on accounts
--  Safe to run more than once.
-- =============================================================

alter table public.profiles add column if not exists username text;

-- Unique without regard to case, so Ben and ben cannot both exist.
create unique index if not exists profiles_username_unique
  on public.profiles (lower(username)) where username is not null;

-- 3 to 20 characters, starts with a letter, letters/numbers/underscore.
alter table public.profiles drop constraint if exists profiles_username_shape;
alter table public.profiles add constraint profiles_username_shape
  check (username is null or username ~ '^[A-Za-z][A-Za-z0-9_]{2,19}$');

-- -------------------------------------------------------------
--  New sign-ups carry their chosen username in the auth metadata.
--  If it was taken in the moment between the check and the sign-up,
--  leave it null rather than failing the sign-up - the app then asks
--  for another one. A profile row must never block account creation.
-- -------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare want text; fallback text;
begin
  want := nullif(new.raw_user_meta_data->>'username', '');
  fallback := split_part(coalesce(new.email, 'manager@x'), '@', 1);
  if want is not null and (
       want !~ '^[A-Za-z][A-Za-z0-9_]{2,19}$'
       or exists (select 1 from public.profiles p where lower(p.username) = lower(want)))
  then
    want := null;
  end if;
  insert into public.profiles (id, display_name, username)
  values (new.id, coalesce(want, fallback), want)
  on conflict (id) do nothing;
  return new;
exception when others then
  begin
    insert into public.profiles (id, display_name) values (new.id, fallback)
    on conflict (id) do nothing;
  exception when others then null;
  end;
  return new;
end $$;

do $mk$
begin
  drop trigger if exists on_auth_user_created on auth.users;
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
exception when others then
  raise notice 'Skipped the auth trigger (no permission).';
end
$mk$;

-- -------------------------------------------------------------
--  Is this username free? Answers for signed-out visitors too,
--  because it is asked on the sign-up form. It reveals only
--  whether a name is taken - never an email address.
-- -------------------------------------------------------------
create or replace function public.username_available(u text)
returns boolean language sql security definer stable set search_path = public as $$
  select u ~ '^[A-Za-z][A-Za-z0-9_]{2,19}$'
     and not exists (select 1 from public.profiles p where lower(p.username) = lower(u));
$$;

-- -------------------------------------------------------------
--  Claim a username. Used for accounts that have none yet, which
--  includes anyone who signed in by emailed link before usernames
--  existed.
-- -------------------------------------------------------------
create or replace function public.set_username(u text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  u := trim(u);
  if u !~ '^[A-Za-z][A-Za-z0-9_]{2,19}$' then
    raise exception 'Usernames are 3 to 20 characters, start with a letter, and use only letters, numbers and underscores';
  end if;
  if exists (select 1 from public.profiles p
              where lower(p.username) = lower(u) and p.id <> auth.uid()) then
    raise exception 'That username is taken';
  end if;
  insert into public.profiles (id, username, display_name)
  values (auth.uid(), u, u)
  on conflict (id) do update set username = excluded.username,
                                 display_name = excluded.display_name;
  return u;
end $$;

do $gr$
begin
  grant execute on function public.username_available(text) to anon, authenticated;
  grant execute on function public.set_username(text)       to authenticated;
exception when others then
  raise notice 'Skipped a grant. Harmless outside Supabase.';
end
$gr$;
