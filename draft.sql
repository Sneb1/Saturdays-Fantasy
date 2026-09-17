-- =============================================================
--  Saturdays Fantasy - draft on the database
--  Safe to run more than once.
-- =============================================================

alter table public.leagues add column if not exists draft_started_at timestamptz;

-- A team's roster after the draft. Kept separate from picks because it keeps
-- changing afterwards - free agency adds and drops - while the draft record
-- must stay exactly what happened on the night.
alter table public.teams add column if not exists roster jsonb not null default '[]'::jsonb;

-- Clients and server must agree on the clock. A browser with a wrong system
-- time would otherwise autopick early or never.
create or replace function public.server_now()
returns timestamptz language sql stable as $$ select now() $$;

create or replace function public.roster_size(s jsonb)
returns int language sql immutable as $$
  select coalesce((s->'slots'->>'QB')::int,0) + coalesce((s->'slots'->>'RB')::int,0)
       + coalesce((s->'slots'->>'WR')::int,0) + coalesce((s->'slots'->>'TE')::int,0)
       + coalesce((s->'slots'->>'K')::int,0)  + coalesce((s->'slots'->>'DEF')::int,0)
       + coalesce((s->>'flex')::int,0)        + coalesce((s->>'bench')::int,0);
$$;

-- -------------------------------------------------------------
--  start_draft - commissioner only. Fills empty seats with CPU
--  teams, fixes the draft order, and stamps the league with the
--  seed that makes everyone's season identical.
-- -------------------------------------------------------------
create or replace function public.start_draft(lid uuid, cpu_names text[] default '{}')
returns void language plpgsql security definer set search_path = public as $$
declare l record; have int; cap int; i int; j int; nm text;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select * into l from public.leagues where id = lid;
  if l is null then raise exception 'no such league'; end if;
  if l.commissioner <> auth.uid() then
    raise exception 'Only the commissioner can start the draft';
  end if;
  if l.phase <> 'setup' then raise exception 'The draft has already started'; end if;

  cap := greatest(2, coalesce((l.settings->>'teams')::int, 10));
  select count(*) into have from public.teams where league_id = lid;

  -- Every unclaimed seat becomes a CPU team so the league can always run.
  -- Skip any suggested name a person has already taken, otherwise two teams
  -- share a name and the draft board and standings become unreadable.
  i := 0; j := 1;
  while have + i < cap loop
    nm := null;
    while nm is null and j <= coalesce(array_length(cpu_names, 1), 0) loop
      if not exists (select 1 from public.teams t
                      where t.league_id = lid and lower(t.name) = lower(cpu_names[j]))
      then nm := cpu_names[j]; end if;
      j := j + 1;
    end loop;
    if nm is null then nm := 'Team ' || (have + i + 1); end if;
    insert into public.teams (league_id, owner, name, abbr, draft_slot)
    values (lid, null, nm,
            upper(left(regexp_replace(nm, '[^A-Za-z0-9]', '', 'g'), 4)), null);
    i := i + 1;
  end loop;

  -- Clear first. The unique index on (league_id, draft_slot) is checked per
  -- row, so reassigning over teams that already hold slots 1 and 2 collides
  -- partway through even though the final state is valid. Nulls are exempt.
  update public.teams set draft_slot = null where league_id = lid;

  -- randomise the order, then hand out slots 1..n
  with shuffled as (
    select id, row_number() over (order by random()) as rn
      from public.teams where league_id = lid
  )
  update public.teams t set draft_slot = s.rn from shuffled s where t.id = s.id;

  update public.leagues
     set phase = 'draft',
         draft_started_at = now(),
         settings = l.settings
                    || jsonb_build_object('seed', (floor(random() * 1000000))::int,
                                          'pool', 1)
   where id = lid;
end $$;

-- -------------------------------------------------------------
--  make_pick - the only way a pick is ever recorded.
--
--  A browser cannot be trusted to say whose turn it is, so the
--  snake order is recomputed here from the picks already made.
--  Three ways a pick is legal. One, the caller owns the team on
--  the clock. Two, the team on the clock is a CPU seat, which any
--  member may drive. Three, the clock has run out, after which any
--  member may autopick.
--  Anything else is refused. The advisory lock plus the unique
--  index on (league_id, pick_no) means two people clicking at the
--  same instant can never take the same slot or the same player.
-- -------------------------------------------------------------
create or replace function public.make_pick(lid uuid, p_key text)
returns table (out_pick_no int, out_team_id uuid, out_auto boolean)
language plpgsql security definer set search_path = public as $$
declare
  l record; nteams int; n int; rnd int; idx int;
  tid uuid; towner uuid; total int; secs int;
  dl timestamptz; last_at timestamptz; is_auto boolean := false;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not public.is_member(lid) then raise exception 'You are not in this league'; end if;

  select * into l from public.leagues where id = lid;
  if l is null then raise exception 'no such league'; end if;
  if l.phase <> 'draft' then raise exception 'This league is not drafting'; end if;

  perform pg_advisory_xact_lock(hashtext(lid::text));

  select count(*) into nteams from public.teams where league_id = lid;
  total := nteams * public.roster_size(l.settings);
  select count(*) into n from public.picks where league_id = lid;
  if n >= total then raise exception 'The draft is complete'; end if;

  rnd := n / nteams;                       -- 0-based round
  idx := n % nteams;
  if rnd % 2 = 1 then idx := nteams - 1 - idx; end if;   -- snake back

  select tm.id, tm.owner into tid, towner
    from public.teams tm
   where tm.league_id = lid
   order by tm.draft_slot nulls last, tm.created_at
   offset idx limit 1;

  secs := greatest(5, coalesce((l.settings->>'secs')::int, 60));
  -- the clock runs from the most recent pick, which is the highest pick
  -- number, not merely the newest timestamp
  select p.created_at into last_at from public.picks p
   where p.league_id = lid order by p.pick_no desc limit 1;
  dl := coalesce(last_at, l.draft_started_at, now()) + make_interval(secs => secs);

  if towner is null then          is_auto := true;
  elsif towner = auth.uid() then  is_auto := false;
  elsif now() > dl then           is_auto := true;
  else raise exception 'It is not your pick';
  end if;

  if exists (select 1 from public.picks
              where league_id = lid and player_id = p_key) then
    raise exception 'That player is already drafted';
  end if;

  insert into public.picks (league_id, pick_no, team_id, player_id, auto)
  values (lid, n + 1, tid, p_key, is_auto);

  if n + 1 >= total then
    -- hand the drafted players over as each team's opening roster
    update public.teams t
       set roster = coalesce((select jsonb_agg(p.player_id order by p.pick_no)
                                from public.picks p where p.team_id = t.id), '[]'::jsonb)
     where t.league_id = lid;
    update public.leagues set phase = 'season', current_week = 1 where id = lid;
  end if;

  return query select n + 1, tid, is_auto;
end $$;

grant execute on function public.server_now()                       to authenticated;
grant execute on function public.roster_size(jsonb)                 to authenticated;
grant execute on function public.start_draft(uuid, text[])          to authenticated;
grant execute on function public.make_pick(uuid, text)              to authenticated;
