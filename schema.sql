-- =============================================================
--  Saturdays Fantasy - database schema
--  Supabase: SQL Editor -> New query -> paste all of this -> Run
--  Safe to run more than once.
-- =============================================================

-- ---------------------------------------------------------- profiles
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null default 'Manager',
  created_at   timestamptz not null default now()
);

-- Give every new sign-up a profile row automatically.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name',''),
                           split_part(coalesce(new.email,'manager@x'), '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

do $mk$
begin
  drop trigger if exists on_auth_user_created on auth.users;
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
exception when others then
  raise notice 'Skipped the auth trigger (no permission). Harmless, profiles are created on demand.';
end
$mk$;

-- ---------------------------------------------------------- leagues
create table if not exists public.leagues (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  join_code    text not null unique,
  commissioner uuid not null references public.profiles(id) on delete cascade,
  settings     jsonb not null default '{}'::jsonb,
  phase        text not null default 'setup'
               check (phase in ('setup','draft','season','done')),
  current_week int  not null default 1,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------- teams
-- One row per team. owner = null means an unclaimed slot a friend can take.
create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues(id) on delete cascade,
  owner      uuid references public.profiles(id) on delete set null,
  name       text not null,
  abbr       text not null,
  draft_slot int,
  created_at timestamptz not null default now()
);
create unique index if not exists teams_one_per_owner
  on public.teams (league_id, owner) where owner is not null;
create unique index if not exists teams_slot_unique
  on public.teams (league_id, draft_slot) where draft_slot is not null;

-- Membership tests used by the policies below. SECURITY DEFINER matters:
-- without it, a policy on teams that queries teams re-enters itself forever.
create or replace function public.is_member(lid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.teams t
                  where t.league_id = lid and t.owner = auth.uid());
$$;

create or replace function public.is_commish(lid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.leagues l
                  where l.id = lid and l.commissioner = auth.uid());
$$;

-- ---------------------------------------------------------- draft picks
create table if not exists public.picks (
  id         bigint generated always as identity primary key,
  league_id  uuid not null references public.leagues(id) on delete cascade,
  pick_no    int  not null,
  team_id    uuid not null references public.teams(id) on delete cascade,
  player_id  text not null,
  auto       boolean not null default false,
  created_at timestamptz not null default now(),
  unique (league_id, pick_no),
  unique (league_id, player_id)   -- the database itself refuses a double-draft
);

-- ---------------------------------------------------------- lineups
create table if not exists public.lineups (
  league_id uuid not null references public.leagues(id) on delete cascade,
  team_id   uuid not null references public.teams(id) on delete cascade,
  week      int  not null,
  slots     jsonb not null default '[]'::jsonb,
  primary key (team_id, week)
);

-- ---------------------------------------------------------- results
create table if not exists public.results (
  league_id  uuid not null references public.leagues(id) on delete cascade,
  week       int  not null,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  primary key (league_id, week)
);

-- =============================================================
--  Row level security - who may read and write what
-- =============================================================
alter table public.profiles enable row level security;
alter table public.leagues  enable row level security;
alter table public.teams    enable row level security;
alter table public.picks    enable row level security;
alter table public.lineups  enable row level security;
alter table public.results  enable row level security;

drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_read   on public.profiles for select to authenticated using (true);
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid());

drop policy if exists leagues_read   on public.leagues;
drop policy if exists leagues_insert on public.leagues;
drop policy if exists leagues_update on public.leagues;
create policy leagues_read   on public.leagues for select to authenticated
  using (public.is_member(id) or commissioner = auth.uid());
create policy leagues_insert on public.leagues for insert to authenticated
  with check (commissioner = auth.uid());
create policy leagues_update on public.leagues for update to authenticated
  using (commissioner = auth.uid());

drop policy if exists teams_read   on public.teams;
drop policy if exists teams_insert on public.teams;
drop policy if exists teams_update on public.teams;
create policy teams_read   on public.teams for select to authenticated
  using (public.is_member(league_id) or public.is_commish(league_id));
create policy teams_insert on public.teams for insert to authenticated
  with check (public.is_commish(league_id) or owner = auth.uid());
create policy teams_update on public.teams for update to authenticated
  using (owner = auth.uid() or public.is_commish(league_id));

drop policy if exists picks_read   on public.picks;
drop policy if exists picks_insert on public.picks;
create policy picks_read   on public.picks for select to authenticated using (public.is_member(league_id));
create policy picks_insert on public.picks for insert to authenticated with check (public.is_member(league_id));

drop policy if exists lineups_read  on public.lineups;
drop policy if exists lineups_write on public.lineups;
create policy lineups_read  on public.lineups for select to authenticated
  using (public.is_member(league_id));
create policy lineups_write on public.lineups for all to authenticated
  using      (exists (select 1 from public.teams t where t.id = team_id and t.owner = auth.uid()))
  with check (exists (select 1 from public.teams t where t.id = team_id and t.owner = auth.uid()));

drop policy if exists results_read  on public.results;
drop policy if exists results_write on public.results;
create policy results_read  on public.results for select to authenticated using (public.is_member(league_id));
create policy results_write on public.results for insert to authenticated with check (public.is_commish(league_id));

-- =============================================================
--  Two RPCs. Creating and joining both need to touch rows the
--  caller cannot see yet, so they run as SECURITY DEFINER with
--  their own checks rather than loosening the policies above.
-- =============================================================

create or replace function public.new_join_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  -- no I, O, 0 or 1: nothing that can be misread when a code is typed by hand
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code  text;
  i     int;
  tries int := 0;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.leagues l where l.join_code = code);
    tries := tries + 1;
    if tries > 40 then raise exception 'could not allocate a join code'; end if;
  end loop;
  return code;
end $$;

create or replace function public.create_league(
  league_name text, team_name text, settings jsonb default '{}'::jsonb)
returns table (league_id uuid, join_code text)
language plpgsql security definer set search_path = public as $$
declare lid uuid; code text;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  code := public.new_join_code();
  insert into public.leagues (name, join_code, commissioner, settings)
  values (coalesce(nullif(league_name,''),'My League'), code, auth.uid(), coalesce(settings,'{}'::jsonb))
  returning id into lid;
  insert into public.teams (league_id, owner, name, abbr, draft_slot)
  values (lid, auth.uid(), coalesce(nullif(team_name,''),'My Team'),
          upper(left(regexp_replace(coalesce(nullif(team_name,''),'TEAM'),'[^A-Za-z]','','g'),4)), 1);
  return query select lid, code;
end $$;

create or replace function public.join_league(code text, team_name text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare lid uuid; tid uuid; slot int; cap int; taken int;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;

  select l.id into lid from public.leagues l where l.join_code = upper(trim(code));
  if lid is null then raise exception 'No league with that code'; end if;

  select t.id into tid from public.teams t where t.league_id = lid and t.owner = auth.uid();
  if tid is not null then return lid; end if;                 -- already in, no-op

  if (select phase from public.leagues where id = lid) <> 'setup' then
    raise exception 'That league has already started drafting';
  end if;

  -- take an unclaimed slot if one exists, otherwise add a team on the end
  select t.id into tid from public.teams t
   where t.league_id = lid and t.owner is null
   order by t.draft_slot nulls last limit 1;

  if tid is not null then
    update public.teams
       set owner = auth.uid(),
           name  = coalesce(nullif(team_name,''), name),
           abbr  = upper(left(regexp_replace(coalesce(nullif(team_name,''), name),'[^A-Za-z]','','g'),4))
     where id = tid;
  else
    -- a new team means a new seat, so respect the size the commissioner set
    select coalesce((l.settings->>'teams')::int, 12) into cap
      from public.leagues l where l.id = lid;
    select count(*) into taken from public.teams t where t.league_id = lid;
    if taken >= cap then
      raise exception 'That league is full (% of % teams). Ask the commissioner to raise the team count.', taken, cap;
    end if;

    select coalesce(max(t.draft_slot),0) + 1 into slot from public.teams t where t.league_id = lid;
    insert into public.teams (league_id, owner, name, abbr, draft_slot)
    values (lid, auth.uid(), coalesce(nullif(team_name,''),'New Team'),
            upper(left(regexp_replace(coalesce(nullif(team_name,''),'TEAM'),'[^A-Za-z]','','g'),4)), slot);
  end if;
  return lid;
end $$;

grant execute on function public.create_league(text,text,jsonb) to authenticated;
grant execute on function public.join_league(text,text)          to authenticated;

-- Supabase already grants these to the authenticated role, so this is usually a
-- no-op there. It is restated so the schema also works on a plain Postgres, and
-- wrapped so a permissions problem cannot stop the rest of the script.
do $gr$
begin
  grant usage on schema public to authenticated;
  grant select, insert, update on all tables in schema public to authenticated;
exception when others then
  raise notice 'Skipped the table grants. Supabase sets these up already.';
end
$gr$;

-- =============================================================
--  Realtime. Without this the pages never hear about a join or a
--  settings change - they would only update on a manual reload.
-- =============================================================
do $rt$
declare t text;
begin
  foreach t in array array['leagues','teams','picks','lineups','results'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
             when others then raise notice 'Realtime not enabled for %', t;
    end;
  end loop;
end
$rt$;
