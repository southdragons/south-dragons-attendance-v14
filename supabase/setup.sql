-- Empty project only. Run once in the Supabase SQL Editor.
-- Same result as applying supabase/migrations in order (writer_auth_permissions is a no-op on Supabase and omitted).
-- Project: cuhkjnuwozgnqqqvqhnl
BEGIN;

-- v1.4: browser tables are closed; Edge API and bounded ownership RPCs only.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create role sd_attendance_writer nologin nosuperuser nobypassrls;
grant usage on schema public, auth to sd_attendance_writer;
grant execute on function auth.uid() to sd_attendance_writer;

create table public.players (
  id text primary key default gen_random_uuid()::text,
  name text not null check (char_length(btrim(name)) between 1 and 30),
  normalized_name text generated always as (regexp_replace(name, '[[:space:]　]+', '', 'g')) stored unique check (char_length(normalized_name)>0),
  active boolean not null default true,
  created_at timestamptz not null default now(), retired_at timestamptz,
  owner_id uuid references auth.users(id) on delete restrict
);
create table public.events (
  id text primary key default gen_random_uuid()::text, event_date date not null,
  title text not null check (char_length(btrim(title)) between 1 and 60),
  start_time time not null, end_time time not null check (end_time > start_time),
  location text not null check (char_length(btrim(location)) between 1 and 100),
  note text not null default '' check (char_length(note) <= 1000),
  created_by_name text not null default '' check (char_length(created_by_name) <= 30),
  active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.attendance (
  id text primary key default gen_random_uuid()::text,
  event_id text not null references public.events(id), player_id text not null references public.players(id),
  -- NULL is an unanswered tombstone; no physical DELETE is needed.
  status text check (status in ('attend','late','absent')), comment text not null default '' check (char_length(comment) <= 300),
  updated_at timestamptz not null default now(), unique(event_id, player_id)
);
create table public.settings (key text primary key, value jsonb not null);
create table public.re_registration_requests (
  request_id uuid primary key default gen_random_uuid(), player_id text not null references public.players(id),
  old_owner_id uuid references auth.users(id) on delete restrict,
  new_owner_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(), reviewed_at timestamptz,
  notification_status text not null default 'pending' check (notification_status in ('pending','sent','failed','unconfigured'))
);
create unique index one_pending_per_player on public.re_registration_requests(player_id) where status = 'pending';
create table public.pending_attendance (
  request_id uuid not null references public.re_registration_requests(request_id),
  event_id text not null references public.events(id), player_id text not null references public.players(id),
  status text check (status in ('attend','late','absent')), comment text not null default '' check (char_length(comment) <= 300),
  updated_at timestamptz not null default now(), primary key(request_id, event_id)
);
create index players_owner on public.players(owner_id);
create index events_date on public.events(event_date);
create index attendance_player on public.attendance(player_id);
create index requests_new_owner on public.re_registration_requests(new_owner_id);

create table private.admin_sessions (token_hash text primary key, actor uuid not null references auth.users(id) on delete restrict, expires_at timestamptz not null);
create table private.rate_limits (bucket text primary key, started_at timestamptz not null, attempts integer not null);
create table private.user_activity (user_id uuid primary key references auth.users(id) on delete cascade, last_seen_at timestamptz not null default now(), cleanup_pending boolean not null default false);

alter table public.players enable row level security;
alter table public.events enable row level security;
alter table public.attendance enable row level security;
alter table public.settings enable row level security;
alter table public.re_registration_requests enable row level security;
alter table public.pending_attendance enable row level security;
alter table private.admin_sessions enable row level security;
alter table private.rate_limits enable row level security;
alter table private.user_activity enable row level security;
revoke all on public.players, public.events, public.attendance, public.settings, public.re_registration_requests, public.pending_attendance from public, anon, authenticated;
grant all on public.players, public.events, public.attendance, public.settings, public.re_registration_requests, public.pending_attendance to service_role;

-- A non-login, non-bypass owner gives the validated RPC write privileges,
-- while auth.uid() still refers to the calling anonymous user's signed JWT.
grant select on public.players, public.events, public.attendance, public.re_registration_requests, public.pending_attendance to sd_attendance_writer;
grant insert, update on public.attendance, public.pending_attendance to sd_attendance_writer;
create policy writer_players on public.players for select to sd_attendance_writer using (owner_id = auth.uid() or active);
create policy writer_events on public.events for select to sd_attendance_writer using (active);
create policy writer_requests on public.re_registration_requests for select to sd_attendance_writer using (new_owner_id = auth.uid() and status = 'pending');
create policy writer_attendance_read on public.attendance for select to sd_attendance_writer using (exists (select 1 from public.players p where p.id = player_id and p.owner_id = auth.uid()));
create policy writer_attendance_insert on public.attendance for insert to sd_attendance_writer with check (
  exists (select 1 from public.players p where p.id = player_id and p.owner_id = auth.uid() and p.active)
  and exists (select 1 from public.events e where e.id = event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));
create policy writer_attendance_update on public.attendance for update to sd_attendance_writer using (
  exists (select 1 from public.players p where p.id = player_id and p.owner_id = auth.uid() and p.active)
  and exists (select 1 from public.events e where e.id = event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date)) with check (
  exists (select 1 from public.players p where p.id = player_id and p.owner_id = auth.uid() and p.active)
  and exists (select 1 from public.events e where e.id = event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));
create policy writer_pending_read on public.pending_attendance for select to sd_attendance_writer using (exists (select 1 from public.re_registration_requests r where r.request_id = pending_attendance.request_id and r.new_owner_id = auth.uid() and r.status = 'pending'));
create policy writer_pending_insert on public.pending_attendance for insert to sd_attendance_writer with check (
  exists (select 1 from public.re_registration_requests r join public.players p on p.id=r.player_id where r.request_id=pending_attendance.request_id and r.player_id=pending_attendance.player_id and r.new_owner_id=auth.uid() and r.status='pending' and p.active)
  and exists (select 1 from public.events e where e.id=event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));
create policy writer_pending_update on public.pending_attendance for update to sd_attendance_writer using (
  exists (select 1 from public.re_registration_requests r where r.request_id=pending_attendance.request_id and r.player_id=pending_attendance.player_id and r.new_owner_id=auth.uid() and r.status='pending')) with check (
  exists (select 1 from public.re_registration_requests r join public.players p on p.id=r.player_id where r.request_id=pending_attendance.request_id and r.player_id=pending_attendance.player_id and r.new_owner_id=auth.uid() and r.status='pending' and p.active)
  and exists (select 1 from public.events e where e.id=event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));

create function public.save_own_attendance(p_event text, p_player text, p_status text, p_comment text default '', p_request uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Shared lock order with admin approval and all service mutations.
  perform pg_advisory_xact_lock(734214);
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
  if p_status is not null and p_status not in ('attend','late','absent') then raise exception 'BAD_REQUEST'; end if;
  if p_comment is null or char_length(p_comment)>300 then raise exception 'BAD_REQUEST'; end if;
  if not exists(select 1 from public.events where id=p_event and active and event_date >= (now() at time zone 'Asia/Tokyo')::date)
    or not exists(select 1 from public.players where id=p_player and active) then raise exception 'NOT_EDITABLE'; end if;
  if p_request is null then
    if not exists(select 1 from public.players where id=p_player and owner_id=auth.uid()) then raise exception 'FORBIDDEN'; end if;
    insert into public.attendance(event_id,player_id,status,comment) values(p_event,p_player,p_status,p_comment)
    on conflict(event_id,player_id) do update set status=excluded.status,comment=excluded.comment,updated_at=now();
  else
    if not exists(select 1 from public.re_registration_requests where request_id=p_request and player_id=p_player and new_owner_id=auth.uid() and status='pending') then raise exception 'FORBIDDEN'; end if;
    insert into public.pending_attendance(request_id,event_id,player_id,status,comment) values(p_request,p_event,p_player,p_status,p_comment)
    on conflict(request_id,event_id) do update set status=excluded.status,comment=excluded.comment,updated_at=now();
  end if;
end $$;
grant sd_attendance_writer to postgres;
grant create on schema public to sd_attendance_writer;
alter function public.save_own_attendance(text,text,text,text,uuid) owner to sd_attendance_writer;
revoke create on schema public from sd_attendance_writer;
revoke all on function public.save_own_attendance(text,text,text,text,uuid) from public, anon;
grant execute on function public.save_own_attendance(text,text,text,text,uuid) to authenticated;

create function private.player_json(p public.players) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'active',p.active,'joinedAt',p.created_at,'retiredAt',p.retired_at)
$$;
create function private.snapshot(actor uuid, is_admin boolean) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('version',1,'admin',is_admin,'adminConfigured',exists(select 1 from public.settings where key='admin_password_hash'),
 'myPlayerIds',coalesce((select jsonb_agg(id) from public.players where owner_id=actor),'[]'::jsonb),
 'players',coalesce((select jsonb_agg(private.player_json(p) order by p.created_at,p.id) from public.players p where is_admin or p.active or p.owner_id=actor or exists(select 1 from public.attendance a join public.events e on e.id=a.event_id where a.player_id=p.id and e.active and e.event_date < (now() at time zone 'Asia/Tokyo')::date)),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'date',e.event_date,'title',e.title,'startTime',to_char(e.start_time,'HH24:MI'),'endTime',to_char(e.end_time,'HH24:MI'),'location',e.location,'note',e.note,'createdByName',e.created_by_name,'active',e.active) order by e.event_date,e.start_time) from public.events e where is_admin or e.active),'[]'::jsonb),
 'attendance',coalesce((select jsonb_agg(jsonb_build_object('eventId',a.event_id,'playerId',a.player_id,'status',a.status,'comment',a.comment,'updatedAt',a.updated_at)) from public.attendance a join public.events e on e.id=a.event_id join public.players p on p.id=a.player_id where a.status is not null and (is_admin or (e.active and (p.active or e.event_date < (now() at time zone 'Asia/Tokyo')::date)))),'[]'::jsonb),
 'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.request_id,'playerId',r.player_id,'playerName',p.name,'status',r.status,'requestedAt',r.requested_at,'reviewedAt',r.reviewed_at,'isMine',r.new_owner_id=actor,'notificationStatus',r.notification_status) order by r.requested_at desc) from public.re_registration_requests r join public.players p on p.id=r.player_id where is_admin or r.new_owner_id=actor),'[]'::jsonb),
 'pendingAttendance',coalesce((select jsonb_agg(jsonb_build_object('requestId',a.request_id,'eventId',a.event_id,'playerId',a.player_id,'status',a.status,'comment',a.comment,'updatedAt',a.updated_at)) from public.pending_attendance a join public.re_registration_requests r on r.request_id=a.request_id where r.status='pending' and (is_admin or r.new_owner_id=actor)),'[]'::jsonb))
$$;

-- Called only with a service credential after Edge has verified the JWT.
create function public.team_api(actor uuid, action text, payload jsonb default '{}', admin_token text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  admin_ok boolean := false; player public.players; req public.re_registration_requests;
  credential jsonb; result jsonb := '{}'; existing boolean := false; e jsonb; attempts integer;
  t text; normalized text; bucket_name text;
begin
  perform pg_advisory_xact_lock(734214);
  if actor is null or not exists(select 1 from auth.users where id=actor and is_anonymous) then raise exception 'UNAUTHORIZED'; end if;
  if exists(select 1 from private.user_activity where user_id=actor and cleanup_pending) then raise exception 'UNAUTHORIZED'; end if;
  insert into private.user_activity(user_id,last_seen_at) values(actor,now()) on conflict(user_id) do update set last_seen_at=now();
  select exists(select 1 from private.admin_sessions s where s.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex') and expires_at>now()) into admin_ok;
  select value into credential from public.settings where key='admin_password_hash';
  if action='getData' then return private.snapshot(actor,admin_ok); end if;
  if action='authPrepare' then
    -- Committed before password hashing; failed login calls cannot roll this back.
    bucket_name := 'admin-global';
    insert into private.rate_limits values(bucket_name,now(),1) on conflict(bucket) do update set
      attempts=case when private.rate_limits.started_at < now()-interval '15 minutes' then 1 else private.rate_limits.attempts+1 end,
      started_at=case when private.rate_limits.started_at < now()-interval '15 minutes' then now() else private.rate_limits.started_at end returning private.rate_limits.attempts into attempts;
    if attempts>20 then return jsonb_build_object('limited',true); end if;
    return jsonb_build_object('configured',credential is not null,'salt',credential->>'salt');
  elsif action in ('initializeAdmin','adminLogin','changeAdminPassword') then
    if coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    if action='initializeAdmin' then
      if credential is not null then raise exception 'CONFLICT'; end if;
      -- Setup code is checked by Edge; this service-only operation cannot be called by a browser.
    elsif action='adminLogin' then
      if credential is null or credential->>'hash' is distinct from payload->>'proof' then raise exception 'BAD_PASSWORD'; end if;
    else
      if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
      if credential->>'hash' is distinct from payload->>'currentProof' then raise exception 'BAD_PASSWORD'; end if;
    end if;
    if action<>'adminLogin' then
      if coalesce(payload->>'salt','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
      insert into public.settings values('admin_password_hash',jsonb_build_object('algorithm','scrypt-N32768-r8-p3-v1','salt',payload->>'salt','hash',payload->>'proof')) on conflict(key) do update set value=excluded.value;
      delete from private.admin_sessions;
      if action='changeAdminPassword' then return jsonb_build_object('authenticated',false); end if;
    end if;
    t := payload->>'token';
    if coalesce(t,'') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    delete from private.admin_sessions where expires_at<=now() or private.admin_sessions.actor=team_api.actor;
    insert into private.admin_sessions values(encode(sha256(convert_to(t,'UTF8')),'hex'),actor,now()+interval '1 hour');
    return jsonb_build_object('authenticated',true);
  elsif action='adminLogout' then
    delete from private.admin_sessions where private.admin_sessions.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex');
    return jsonb_build_object('authenticated',false);
  elsif action='registerPlayer' then
    t := btrim(payload->>'name'); normalized := regexp_replace(t,'[[:space:]　]+','','g');
    if t is null or char_length(t)>30 or normalized='' then raise exception 'BAD_REQUEST'; end if;
    select * into player from public.players where normalized_name=normalized;
    existing:=found;
    if not existing then insert into public.players(name,owner_id) values(t,actor) returning * into player; end if;
    result:=jsonb_build_object('duplicate',existing,'player',private.player_json(player));
  elsif action='requestRegistration' then
    select * into player from public.players where id=payload->>'playerId';
    if not found or not player.active then raise exception 'NOT_EDITABLE'; end if;
    if player.owner_id=actor then raise exception 'ALREADY_OWNED'; end if;
    select * into req from public.re_registration_requests where player_id=player.id and status='pending';
    if found then
      if req.new_owner_id<>actor then raise exception 'REQUEST_EXISTS'; end if;
    else
      if exists(select 1 from public.re_registration_requests where player_id=player.id and requested_at>now()-interval '1 day' and status='rejected') then raise exception 'RATE_LIMITED'; end if;
      insert into public.re_registration_requests(player_id,old_owner_id,new_owner_id) values(player.id,player.owner_id,actor) returning * into req;
      result:=jsonb_build_object('notification',jsonb_build_object('requestId',req.request_id,'playerName',player.name,'requestedAt',req.requested_at));
    end if;
  else
    if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
    if action='reviewRegistration' then
      select * into req from public.re_registration_requests where request_id=(payload->>'requestId')::uuid;
      if not found or req.status<>'pending' then raise exception 'CONFLICT'; end if;
      if payload->>'decision' not in ('approved','rejected') or payload->>'decision' is null then raise exception 'BAD_REQUEST'; end if;
      if payload->>'decision'='approved' then
        select * into player from public.players where id=req.player_id;
        if not player.active or player.owner_id is distinct from req.old_owner_id then raise exception 'CONFLICT'; end if;
        update public.players set owner_id=req.new_owner_id where id=req.player_id;
        insert into public.attendance(event_id,player_id,status,comment,updated_at)
          select a.event_id,a.player_id,a.status,a.comment,now() from public.pending_attendance a join public.events ev on ev.id=a.event_id
          where a.request_id=req.request_id and a.player_id=req.player_id and ev.active and ev.event_date >= (now() at time zone 'Asia/Tokyo')::date
          on conflict(event_id,player_id) do update set status=excluded.status,comment=excluded.comment,updated_at=excluded.updated_at;
      end if;
      update public.re_registration_requests set status=payload->>'decision',reviewed_at=now() where request_id=req.request_id;
    elsif action='saveEvent' then
      e:=payload->'event';
      if jsonb_typeof(e)<>'object' or coalesce(e->>'id','')='' or (e->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'BAD_REQUEST'; end if;
      if (payload->>'create')::boolean then
        insert into public.events(id,event_date,title,start_time,end_time,location,note,created_by_name) values(e->>'id',(e->>'date')::date,btrim(e->>'title'),(e->>'startTime')::time,(e->>'endTime')::time,btrim(e->>'location'),coalesce(e->>'note',''),coalesce(e->>'createdByName','')) on conflict(id) do nothing;
      else
        update public.events set event_date=(e->>'date')::date,title=btrim(e->>'title'),start_time=(e->>'startTime')::time,end_time=(e->>'endTime')::time,location=btrim(e->>'location'),note=coalesce(e->>'note',''),created_by_name=coalesce(e->>'createdByName',''),updated_at=now() where id=e->>'id';
        if not found then raise exception 'NOT_FOUND'; end if;
      end if;
    elsif action='setEventActive' then
      update public.events set active=(payload->>'active')::boolean,updated_at=now() where id=payload->>'eventId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='setPlayerActive' then
      update public.players set active=(payload->>'active')::boolean,retired_at=case when (payload->>'active')::boolean then null else now() end where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='renamePlayer' then
      update public.players set name=btrim(payload->>'name') where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    else raise exception 'BAD_REQUEST'; end if;
  end if;
  return result || jsonb_build_object('snapshot',private.snapshot(actor,admin_ok));
end $$;
revoke all on function public.team_api(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.team_api(uuid,text,jsonb,text) to service_role;

create function public.team_health() returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('ok',true,'database',exists(select 1 from pg_class where oid='public.players'::regclass),'checkedAt',now())
$$;
revoke all on function public.team_health() from public,anon,authenticated;
grant execute on function public.team_health() to service_role;

create function public.record_notification(p_request uuid, p_status text) returns void language sql security definer set search_path='' as $$
 update public.re_registration_requests set notification_status=p_status where request_id=p_request and p_status in ('sent','failed','unconfigured')
$$;
revoke all on function public.record_notification(uuid,text) from public,anon,authenticated;
grant execute on function public.record_notification(uuid,text) to service_role;

create function public.cleanup_candidates(dry_run boolean default true) returns table(user_id uuid) language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(734214);
  if not dry_run then delete from private.admin_sessions where expires_at<=now(); end if;
  -- Only unreferenced anonymous users; historical request references are retained too.
  if not dry_run then
    insert into private.user_activity(user_id,last_seen_at,cleanup_pending)
      select u.id,coalesce(u.last_sign_in_at,u.created_at),true from auth.users u
      left join private.user_activity a on a.user_id=u.id
      where u.is_anonymous and greatest(coalesce(a.last_seen_at,u.created_at),coalesce(u.last_sign_in_at,u.created_at)) < now()-interval '90 days'
      and not exists(select 1 from public.players p where p.owner_id=u.id)
      and not exists(select 1 from public.re_registration_requests r where r.old_owner_id=u.id or r.new_owner_id=u.id)
      and not exists(select 1 from private.admin_sessions s where s.actor=u.id and s.expires_at>now())
      order by u.created_at limit 100
      on conflict on constraint user_activity_pkey do update set cleanup_pending=true;
  end if;
  return query select u.id from auth.users u left join private.user_activity a on a.user_id=u.id
    where u.is_anonymous and greatest(coalesce(a.last_seen_at,u.created_at),coalesce(u.last_sign_in_at,u.created_at)) < now()-interval '90 days'
    and not exists(select 1 from public.players p where p.owner_id=u.id)
    and not exists(select 1 from public.re_registration_requests r where r.old_owner_id=u.id or r.new_owner_id=u.id)
    and not exists(select 1 from private.admin_sessions s where s.actor=u.id and s.expires_at>now())
    and (dry_run or a.cleanup_pending) order by u.created_at limit 100;
end $$;
revoke all on function public.cleanup_candidates(boolean) from public,anon,authenticated;
grant execute on function public.cleanup_candidates(boolean) to service_role;
revoke all on all functions in schema private from public,anon,authenticated;


-- One-shot import into an empty destination. All rows commit together.
create function public.import_legacy_snapshot(snapshot jsonb, credential jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row jsonb;
begin
  perform pg_advisory_xact_lock(734214);
  if exists(select 1 from public.players) or exists(select 1 from public.events) or exists(select 1 from public.attendance) or exists(select 1 from public.settings) then raise exception 'DESTINATION_NOT_EMPTY'; end if;
  if snapshot->>'version' is distinct from '1' or jsonb_typeof(snapshot->'players') is distinct from 'array' or jsonb_typeof(snapshot->'events') is distinct from 'array' or jsonb_typeof(snapshot->'attendance') is distinct from 'array' then raise exception 'BAD_SNAPSHOT'; end if;
  for row in select * from jsonb_array_elements(snapshot->'players') loop
    insert into public.players(id,name,active,created_at,retired_at,owner_id)
      values(row->>'id',row->>'name',(row->>'active')::boolean,(row->>'joinedAt')::timestamptz,(row->>'retiredAt')::timestamptz,null);
  end loop;
  for row in select * from jsonb_array_elements(snapshot->'events') loop
    insert into public.events(id,event_date,title,start_time,end_time,location,note,created_by_name,active)
      values(row->>'id',(row->>'date')::date,row->>'title',(row->>'startTime')::time,(row->>'endTime')::time,row->>'location',coalesce(row->>'note',''),coalesce(row->>'createdByName',''),(row->>'active')::boolean);
  end loop;
  for row in select * from jsonb_array_elements(snapshot->'attendance') loop
    if row->>'status' is null then raise exception 'BAD_SNAPSHOT'; end if;
    insert into public.attendance(event_id,player_id,status,comment,updated_at)
      values(row->>'eventId',row->>'playerId',row->>'status',coalesce(row->>'comment',''),(row->>'updatedAt')::timestamptz);
  end loop;
  if credential is not null then
    if credential->>'algorithm' is distinct from 'scrypt-N32768-r8-p3-v1' or coalesce(credential->>'salt','') !~ '^[a-f0-9]{64}$' or coalesce(credential->>'hash','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_CREDENTIAL'; end if;
    insert into public.settings values('admin_password_hash',credential);
  end if;
  return jsonb_build_object('players',(select count(*) from public.players),'events',(select count(*) from public.events),'attendance',(select count(*) from public.attendance));
end $$;
revoke all on function public.import_legacy_snapshot(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.import_legacy_snapshot(jsonb,jsonb) to service_role;


-- v1.4 repair: the restricted writer does not need access to Supabase's auth schema.
-- Read only the subject of the JWT verified and installed by PostgREST.
-- No caller-supplied actor argument, extra role membership, or table grants.
create or replace function public.attendance_actor_id()
returns uuid language sql stable security invoker set search_path='' as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
revoke all on function public.attendance_actor_id() from public, anon, authenticated;
grant execute on function public.attendance_actor_id() to sd_attendance_writer;

drop policy if exists writer_players on public.players;
create policy writer_players on public.players for select to sd_attendance_writer using (owner_id = public.attendance_actor_id() or active);
drop policy if exists writer_events on public.events;
create policy writer_events on public.events for select to sd_attendance_writer using (active);
drop policy if exists writer_requests on public.re_registration_requests;
create policy writer_requests on public.re_registration_requests for select to sd_attendance_writer using (new_owner_id = public.attendance_actor_id() and status = 'pending');
drop policy if exists writer_attendance_read on public.attendance;
create policy writer_attendance_read on public.attendance for select to sd_attendance_writer using (exists (select 1 from public.players p where p.id = player_id and p.owner_id = public.attendance_actor_id()));
drop policy if exists writer_attendance_insert on public.attendance;
create policy writer_attendance_insert on public.attendance for insert to sd_attendance_writer with check (
  exists (select 1 from public.players p where p.id = player_id and p.owner_id = public.attendance_actor_id() and p.active)
  and exists (select 1 from public.events e where e.id = event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));
drop policy if exists writer_attendance_update on public.attendance;
create policy writer_attendance_update on public.attendance for update to sd_attendance_writer using (
  exists (select 1 from public.players p where p.id = player_id and p.owner_id = public.attendance_actor_id() and p.active)
  and exists (select 1 from public.events e where e.id = event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date)) with check (
  exists (select 1 from public.players p where p.id = player_id and p.owner_id = public.attendance_actor_id() and p.active)
  and exists (select 1 from public.events e where e.id = event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));
drop policy if exists writer_pending_read on public.pending_attendance;
create policy writer_pending_read on public.pending_attendance for select to sd_attendance_writer using (exists (select 1 from public.re_registration_requests r where r.request_id = pending_attendance.request_id and r.new_owner_id = public.attendance_actor_id() and r.status = 'pending'));
drop policy if exists writer_pending_insert on public.pending_attendance;
create policy writer_pending_insert on public.pending_attendance for insert to sd_attendance_writer with check (
  exists (select 1 from public.re_registration_requests r join public.players p on p.id=r.player_id where r.request_id=pending_attendance.request_id and r.player_id=pending_attendance.player_id and r.new_owner_id=public.attendance_actor_id() and r.status='pending' and p.active)
  and exists (select 1 from public.events e where e.id=event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));
drop policy if exists writer_pending_update on public.pending_attendance;
create policy writer_pending_update on public.pending_attendance for update to sd_attendance_writer using (
  exists (select 1 from public.re_registration_requests r where r.request_id=pending_attendance.request_id and r.player_id=pending_attendance.player_id and r.new_owner_id=public.attendance_actor_id() and r.status='pending')) with check (
  exists (select 1 from public.re_registration_requests r join public.players p on p.id=r.player_id where r.request_id=pending_attendance.request_id and r.player_id=pending_attendance.player_id and r.new_owner_id=public.attendance_actor_id() and r.status='pending' and p.active)
  and exists (select 1 from public.events e where e.id=event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));

create or replace function public.save_own_attendance(p_event text, p_player text, p_status text, p_comment text default '', p_request uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Shared lock order with admin approval and all service mutations.
  perform pg_advisory_xact_lock(734214);
  if public.attendance_actor_id() is null then raise exception 'UNAUTHORIZED'; end if;
  if p_status is not null and p_status not in ('attend','late','absent') then raise exception 'BAD_REQUEST'; end if;
  if p_comment is null or char_length(p_comment)>300 then raise exception 'BAD_REQUEST'; end if;
  if not exists(select 1 from public.events where id=p_event and active and event_date >= (now() at time zone 'Asia/Tokyo')::date)
    or not exists(select 1 from public.players where id=p_player and active) then raise exception 'NOT_EDITABLE'; end if;
  if p_request is null then
    if not exists(select 1 from public.players where id=p_player and owner_id=public.attendance_actor_id()) then raise exception 'FORBIDDEN'; end if;
    insert into public.attendance(event_id,player_id,status,comment) values(p_event,p_player,p_status,p_comment)
    on conflict(event_id,player_id) do update set status=excluded.status,comment=excluded.comment,updated_at=now();
  else
    if not exists(select 1 from public.re_registration_requests where request_id=p_request and player_id=p_player and new_owner_id=public.attendance_actor_id() and status='pending') then raise exception 'FORBIDDEN'; end if;
    insert into public.pending_attendance(request_id,event_id,player_id,status,comment) values(p_request,p_event,p_player,p_status,p_comment)
    on conflict(request_id,event_id) do update set status=excluded.status,comment=excluded.comment,updated_at=now();
  end if;
end $$;

-- Preserve the original non-bypass function owner and restricted entry point.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='public.save_own_attendance(text,text,text,text,uuid)'::regprocedure
      and r.rolname='sd_attendance_writer' and not r.rolbypassrls and not r.rolsuper
      and p.prosecdef
  ) then raise exception 'UNEXPECTED_ATTENDANCE_WRITER_OWNER'; end if;
end $$;
revoke all on function public.save_own_attendance(text,text,text,text,uuid) from public, anon;
grant execute on function public.save_own_attendance(text,text,text,text,uuid) to authenticated;
notify pgrst, 'reload schema';

-- Add approved device access without creating a guardian directory.
-- Safe to repeat: existing grants, answers, and request history are preserved.
select pg_advisory_xact_lock(734214);
create table if not exists public.player_access (
  id uuid primary key default gen_random_uuid(),
  player_id text not null references public.players(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  applicant_name text not null default '' check (char_length(applicant_name)<=30),
  relation text not null default '' check (relation in ('','父','母','祖父母','その他')),
  active boolean not null default true,
  granted_at timestamptz not null default now(), revoked_at timestamptz,
  unique(player_id,auth_user_id)
);
create index if not exists player_access_user on public.player_access(auth_user_id) where active;
alter table public.player_access enable row level security;
revoke all on public.player_access from public,anon,authenticated;
grant all on public.player_access to service_role;
grant select on public.player_access to sd_attendance_writer;
drop policy if exists writer_access on public.player_access;
create policy writer_access on public.player_access for select to sd_attendance_writer
 using (auth_user_id=public.attendance_actor_id() and active);
-- Only current owners migrate. Past owners from request history never receive access.
-- A retry must not reactivate a grant which the administrator has revoked.
insert into public.player_access(player_id,auth_user_id,granted_at)
 select id,owner_id,now() from public.players where owner_id is not null
 on conflict(player_id,auth_user_id) do nothing;
alter table public.re_registration_requests add column if not exists applicant_name text not null default '' check (char_length(applicant_name)<=30);
alter table public.re_registration_requests add column if not exists relation text not null default '' check (relation in ('','父','母','祖父母','その他'));
drop index if exists public.one_pending_per_player;
create unique index if not exists one_pending_per_device on public.re_registration_requests(player_id,new_owner_id) where status='pending';

-- The JWT subject helper avoids the managed auth schema permission issue.
-- All normal writes still run under a NOLOGIN NOBYPASSRLS role.
drop policy if exists writer_players on public.players;
create policy writer_players on public.players for select to sd_attendance_writer using (active or exists(select 1 from public.player_access pa where pa.player_id=players.id and pa.auth_user_id=public.attendance_actor_id() and pa.active));
drop policy if exists writer_events on public.events;
create policy writer_events on public.events for select to sd_attendance_writer using (active);
drop policy if exists writer_requests on public.re_registration_requests;
create policy writer_requests on public.re_registration_requests for select to sd_attendance_writer using (new_owner_id = public.attendance_actor_id() and status = 'pending');
drop policy if exists writer_attendance_read on public.attendance;
create policy writer_attendance_read on public.attendance for select to sd_attendance_writer using (exists (select 1 from public.players p where p.id = player_id and exists(select 1 from public.player_access pa where pa.player_id=p.id and pa.auth_user_id=public.attendance_actor_id() and pa.active)));
drop policy if exists writer_attendance_insert on public.attendance;
create policy writer_attendance_insert on public.attendance for insert to sd_attendance_writer with check (
  exists (select 1 from public.players p where p.id = player_id and exists(select 1 from public.player_access pa where pa.player_id=p.id and pa.auth_user_id=public.attendance_actor_id() and pa.active) and p.active)
  and exists (select 1 from public.events e where e.id = event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));
drop policy if exists writer_attendance_update on public.attendance;
create policy writer_attendance_update on public.attendance for update to sd_attendance_writer using (
  exists (select 1 from public.players p where p.id = player_id and exists(select 1 from public.player_access pa where pa.player_id=p.id and pa.auth_user_id=public.attendance_actor_id() and pa.active) and p.active)
  and exists (select 1 from public.events e where e.id = event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date)) with check (
  exists (select 1 from public.players p where p.id = player_id and exists(select 1 from public.player_access pa where pa.player_id=p.id and pa.auth_user_id=public.attendance_actor_id() and pa.active) and p.active)
  and exists (select 1 from public.events e where e.id = event_id and e.active and e.event_date >= (now() at time zone 'Asia/Tokyo')::date));

-- Legacy drafts are retained as history, but are no longer writable or promoted.
revoke all on public.pending_attendance from sd_attendance_writer;
drop policy if exists writer_pending_read on public.pending_attendance;
drop policy if exists writer_pending_insert on public.pending_attendance;
drop policy if exists writer_pending_update on public.pending_attendance;
create or replace function public.save_own_attendance(p_event text,p_player text,p_status text,p_comment text default '',p_request uuid default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(734214);
  if public.attendance_actor_id() is null then raise exception 'UNAUTHORIZED'; end if;
  if p_request is not null then raise exception 'APPROVAL_REQUIRED'; end if;
  if p_status is not null and p_status not in ('attend','late','absent') then raise exception 'BAD_REQUEST'; end if;
  if p_comment is null or char_length(p_comment)>300 then raise exception 'BAD_REQUEST'; end if;
  if not exists(select 1 from public.events where id=p_event and active and event_date >= (now() at time zone 'Asia/Tokyo')::date)
    or not exists(select 1 from public.players where id=p_player and active) then raise exception 'NOT_EDITABLE'; end if;
  if not exists(select 1 from public.player_access where player_id=p_player and auth_user_id=public.attendance_actor_id() and active) then raise exception 'FORBIDDEN'; end if;
  insert into public.attendance(event_id,player_id,status,comment) values(p_event,p_player,p_status,p_comment)
  on conflict(event_id,player_id) do update set status=excluded.status,comment=excluded.comment,updated_at=now();
end $$;
-- Preserve the original non-bypass function owner and restricted entry point.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='public.save_own_attendance(text,text,text,text,uuid)'::regprocedure
      and r.rolname='sd_attendance_writer' and not r.rolbypassrls and not r.rolsuper
      and p.prosecdef
  ) then raise exception 'UNEXPECTED_ATTENDANCE_WRITER_OWNER'; end if;
end $$;
revoke all on function public.save_own_attendance(text,text,text,text,uuid) from public, anon;
grant execute on function public.save_own_attendance(text,text,text,text,uuid) to authenticated;
create or replace function private.snapshot(actor uuid, is_admin boolean) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('version',1,'accessModel','multi-device','admin',is_admin,'adminConfigured',exists(select 1 from public.settings where key='admin_password_hash'),
 'myPlayerIds',coalesce((select jsonb_agg(player_id order by player_id) from public.player_access where auth_user_id=actor and active),'[]'::jsonb),
 'players',coalesce((select jsonb_agg(private.player_json(p) order by p.created_at,p.id) from public.players p where is_admin or p.active or exists(select 1 from public.player_access pa where pa.player_id=p.id and pa.auth_user_id=actor and pa.active) or exists(select 1 from public.attendance a join public.events e on e.id=a.event_id where a.player_id=p.id and e.active and e.event_date < (now() at time zone 'Asia/Tokyo')::date)),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'date',e.event_date,'title',e.title,'startTime',to_char(e.start_time,'HH24:MI'),'endTime',to_char(e.end_time,'HH24:MI'),'location',e.location,'note',e.note,'createdByName',e.created_by_name,'active',e.active) order by e.event_date,e.start_time) from public.events e where is_admin or e.active),'[]'::jsonb),
 'attendance',coalesce((select jsonb_agg(jsonb_build_object('eventId',a.event_id,'playerId',a.player_id,'status',a.status,'comment',a.comment,'updatedAt',a.updated_at)) from public.attendance a join public.events e on e.id=a.event_id join public.players p on p.id=a.player_id where a.status is not null and (is_admin or (e.active and (p.active or e.event_date < (now() at time zone 'Asia/Tokyo')::date)))),'[]'::jsonb),
 'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.request_id,'playerId',r.player_id,'playerName',p.name,'status',r.status,'requestedAt',r.requested_at,'reviewedAt',r.reviewed_at,'isMine',r.new_owner_id=actor,'notificationStatus',r.notification_status,'applicantName',r.applicant_name,'relation',r.relation) order by r.requested_at desc) from public.re_registration_requests r join public.players p on p.id=r.player_id where is_admin or r.new_owner_id=actor),'[]'::jsonb),
 'pendingAttendance','[]'::jsonb,
 'deviceAccess',case when is_admin then coalesce((select jsonb_agg(jsonb_build_object(
   'id',pa.id,'playerId',pa.player_id,'applicantName',pa.applicant_name,'relation',pa.relation,
   'grantedAt',pa.granted_at,'lastSeenAt',ua.last_seen_at,'isCurrentDevice',pa.auth_user_id=actor) order by pa.granted_at,pa.id)
   from public.player_access pa left join private.user_activity ua on ua.user_id=pa.auth_user_id where pa.active),'[]'::jsonb) else '[]'::jsonb end)
$$;

create or replace function public.team_api(actor uuid, action text, payload jsonb default '{}', admin_token text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  admin_ok boolean := false; player public.players; req public.re_registration_requests;
  credential jsonb; result jsonb := '{}'; existing boolean := false; e jsonb; attempts integer;
  t text; normalized text; bucket_name text;
begin
  perform pg_advisory_xact_lock(734214);
  if actor is null or not exists(select 1 from auth.users where id=actor and is_anonymous) then raise exception 'UNAUTHORIZED'; end if;
  if exists(select 1 from private.user_activity where user_id=actor and cleanup_pending) then raise exception 'UNAUTHORIZED'; end if;
  insert into private.user_activity(user_id,last_seen_at) values(actor,now()) on conflict(user_id) do update set last_seen_at=now();
  select exists(select 1 from private.admin_sessions s where s.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex') and expires_at>now()) into admin_ok;
  select value into credential from public.settings where key='admin_password_hash';
  if action='getData' then return private.snapshot(actor,admin_ok); end if;
  if action='authPrepare' then
    -- Committed before password hashing; failed login calls cannot roll this back.
    bucket_name := 'admin-global';
    insert into private.rate_limits values(bucket_name,now(),1) on conflict(bucket) do update set
      attempts=case when private.rate_limits.started_at < now()-interval '15 minutes' then 1 else private.rate_limits.attempts+1 end,
      started_at=case when private.rate_limits.started_at < now()-interval '15 minutes' then now() else private.rate_limits.started_at end returning private.rate_limits.attempts into attempts;
    if attempts>20 then return jsonb_build_object('limited',true); end if;
    return jsonb_build_object('configured',credential is not null,'salt',credential->>'salt');
  elsif action in ('initializeAdmin','adminLogin','changeAdminPassword') then
    if coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    if action='initializeAdmin' then
      if credential is not null then raise exception 'CONFLICT'; end if;
      -- Setup code is checked by Edge; this service-only operation cannot be called by a browser.
    elsif action='adminLogin' then
      if credential is null or credential->>'hash' is distinct from payload->>'proof' then raise exception 'BAD_PASSWORD'; end if;
    else
      if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
      if credential->>'hash' is distinct from payload->>'currentProof' then raise exception 'BAD_PASSWORD'; end if;
    end if;
    if action<>'adminLogin' then
      if coalesce(payload->>'salt','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
      insert into public.settings values('admin_password_hash',jsonb_build_object('algorithm','scrypt-N32768-r8-p3-v1','salt',payload->>'salt','hash',payload->>'proof')) on conflict(key) do update set value=excluded.value;
      delete from private.admin_sessions;
      if action='changeAdminPassword' then return jsonb_build_object('authenticated',false); end if;
    end if;
    t := payload->>'token';
    if coalesce(t,'') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    delete from private.admin_sessions where expires_at<=now() or private.admin_sessions.actor=team_api.actor;
    insert into private.admin_sessions values(encode(sha256(convert_to(t,'UTF8')),'hex'),actor,now()+interval '1 hour');
    return jsonb_build_object('authenticated',true);
  elsif action='adminLogout' then
    delete from private.admin_sessions where private.admin_sessions.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex');
    return jsonb_build_object('authenticated',false);
  elsif action='registerPlayer' then
    t := btrim(payload->>'name'); normalized := regexp_replace(t,'[[:space:]　]+','','g');
    if t is null or char_length(t)>30 or normalized='' then raise exception 'BAD_REQUEST'; end if;
    select * into player from public.players where normalized_name=normalized;
    existing:=found;
    if not existing then
      insert into public.players(name) values(t) returning * into player;
      insert into public.player_access(player_id,auth_user_id) values(player.id,actor);
    end if;
    result:=jsonb_build_object('duplicate',existing,'player',private.player_json(player));
  elsif action='requestRegistration' then
    -- Old cached clients must not silently use the changed approval semantics.
    if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
    t:=btrim(payload->>'applicantName');
    if t is null or char_length(t) not between 1 and 30 or coalesce(payload->>'relation','') not in ('父','母','祖父母','その他') then raise exception 'BAD_REQUEST'; end if;
    select * into player from public.players where id=payload->>'playerId';
    if not found or not player.active then raise exception 'NOT_EDITABLE'; end if;
    if exists(select 1 from public.player_access where player_id=player.id and auth_user_id=actor and active) then raise exception 'ALREADY_OWNED'; end if;
    select * into req from public.re_registration_requests where player_id=player.id and new_owner_id=actor and status='pending';
    if not found then
      if exists(select 1 from public.re_registration_requests where player_id=player.id and new_owner_id=actor and requested_at>now()-interval '1 day' and status='rejected') then raise exception 'RATE_LIMITED'; end if;
      if (select count(*) from public.re_registration_requests where new_owner_id=actor and requested_at>now()-interval '1 day')>=10 then raise exception 'RATE_LIMITED'; end if;
      insert into public.re_registration_requests(player_id,new_owner_id,applicant_name,relation)
        values(player.id,actor,t,payload->>'relation') returning * into req;
      result:=jsonb_build_object('notification',jsonb_build_object('requestId',req.request_id,'playerName',player.name,
        'requestedAt',req.requested_at,'applicantName',req.applicant_name,'relation',req.relation,'accessModel','multi-device'));
    end if;
  else
    if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
    if action='reviewRegistration' then
      if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      select * into req from public.re_registration_requests where request_id=(payload->>'requestId')::uuid;
      if not found or req.status<>'pending' then raise exception 'CONFLICT'; end if;
      if payload->>'decision' not in ('approved','rejected') or payload->>'decision' is null then raise exception 'BAD_REQUEST'; end if;
      if payload->>'decision'='approved' then
        if not exists(select 1 from public.players where id=req.player_id and active) then raise exception 'NOT_EDITABLE'; end if;
        if exists(select 1 from private.user_activity where user_id=req.new_owner_id and cleanup_pending) then raise exception 'CONFLICT'; end if;
        insert into public.player_access(player_id,auth_user_id,applicant_name,relation)
          values(req.player_id,req.new_owner_id,req.applicant_name,req.relation)
          on conflict(player_id,auth_user_id) do update set active=true,revoked_at=null,granted_at=now(),applicant_name=excluded.applicant_name,relation=excluded.relation;
        -- Never replace another device's access or overwrite an official answer.
      end if;
      update public.re_registration_requests set status=payload->>'decision',reviewed_at=now() where request_id=req.request_id;
    elsif action='revokeDeviceAccess' then
      if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      update public.player_access set active=false,revoked_at=now() where id=(payload->>'accessId')::uuid and active;
      if not found then raise exception 'CONFLICT'; end if;
    elsif action='saveEvent' then
      e:=payload->'event';
      if jsonb_typeof(e)<>'object' or coalesce(e->>'id','')='' or (e->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'BAD_REQUEST'; end if;
      if (payload->>'create')::boolean then
        insert into public.events(id,event_date,title,start_time,end_time,location,note,created_by_name) values(e->>'id',(e->>'date')::date,btrim(e->>'title'),(e->>'startTime')::time,(e->>'endTime')::time,btrim(e->>'location'),coalesce(e->>'note',''),coalesce(e->>'createdByName','')) on conflict(id) do nothing;
      else
        update public.events set event_date=(e->>'date')::date,title=btrim(e->>'title'),start_time=(e->>'startTime')::time,end_time=(e->>'endTime')::time,location=btrim(e->>'location'),note=coalesce(e->>'note',''),created_by_name=coalesce(e->>'createdByName',''),updated_at=now() where id=e->>'id';
        if not found then raise exception 'NOT_FOUND'; end if;
      end if;
    elsif action='setEventActive' then
      update public.events set active=(payload->>'active')::boolean,updated_at=now() where id=payload->>'eventId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='setPlayerActive' then
      update public.players set active=(payload->>'active')::boolean,retired_at=case when (payload->>'active')::boolean then null else now() end where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='renamePlayer' then
      update public.players set name=btrim(payload->>'name') where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    else raise exception 'BAD_REQUEST'; end if;
  end if;
  return result || jsonb_build_object('snapshot',private.snapshot(actor,admin_ok));
end $$;
revoke all on function public.team_api(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.team_api(uuid,text,jsonb,text) to service_role;

create or replace function public.cleanup_candidates(dry_run boolean default true) returns table(user_id uuid) language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(734214);
  if not dry_run then delete from private.admin_sessions where expires_at<=now(); end if;
  -- Only unreferenced anonymous users; historical request references are retained too.
  if not dry_run then
    insert into private.user_activity(user_id,last_seen_at,cleanup_pending)
      select u.id,coalesce(u.last_sign_in_at,u.created_at),true from auth.users u
      left join private.user_activity a on a.user_id=u.id
      where u.is_anonymous and greatest(coalesce(a.last_seen_at,u.created_at),coalesce(u.last_sign_in_at,u.created_at)) < now()-interval '90 days'
      and not exists(select 1 from public.players p where p.owner_id=u.id)
      and not exists(select 1 from public.player_access pa where pa.auth_user_id=u.id)
      and not exists(select 1 from public.re_registration_requests r where r.old_owner_id=u.id or r.new_owner_id=u.id)
      and not exists(select 1 from private.admin_sessions s where s.actor=u.id and s.expires_at>now())
      order by u.created_at limit 100
      on conflict on constraint user_activity_pkey do update set cleanup_pending=true;
  end if;
  return query select u.id from auth.users u left join private.user_activity a on a.user_id=u.id
    where u.is_anonymous and greatest(coalesce(a.last_seen_at,u.created_at),coalesce(u.last_sign_in_at,u.created_at)) < now()-interval '90 days'
    and not exists(select 1 from public.players p where p.owner_id=u.id)
      and not exists(select 1 from public.player_access pa where pa.auth_user_id=u.id)
    and not exists(select 1 from public.re_registration_requests r where r.old_owner_id=u.id or r.new_owner_id=u.id)
    and not exists(select 1 from private.admin_sessions s where s.actor=u.id and s.expires_at>now())
    and (dry_run or a.cleanup_pending) order by u.created_at limit 100;
end $$;
revoke all on function public.cleanup_candidates(boolean) from public,anon,authenticated;
grant execute on function public.cleanup_candidates(boolean) to service_role;

-- ---- 20261019000000_attendance_reminder.sql (LINE absence reminder; additive) ----
-- ADDITIVE ONLY. Apply to the NEW project cuhkjnuwozgnqqqvqhnl after review.
-- Never run the old setup.sql against a populated database.
CREATE TABLE IF NOT EXISTS public.attendance_reminder_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_date date NOT NULL,
  destination text NOT NULL CHECK (destination IN ('test','production')),
  retry_key uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  last_http_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_date,destination),
  UNIQUE (retry_key)
);
ALTER TABLE public.attendance_reminder_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_reminder_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE ON public.attendance_reminder_deliveries TO service_role;
REVOKE ALL ON SEQUENCE public.attendance_reminder_deliveries_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE,SELECT ON SEQUENCE public.attendance_reminder_deliveries_id_seq TO service_role;

-- One atomic claim per calendar date and destination. An expired claim may be retried
-- with the SAME LINE retry key, so a lost LINE response does not cause a duplicate.
CREATE OR REPLACE FUNCTION public.claim_attendance_reminder(p_date date, p_destination text)
RETURNS TABLE (retry_key uuid, should_send boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.attendance_reminder_deliveries%ROWTYPE;
BEGIN
  IF p_destination NOT IN ('test','production') OR p_date IS NULL THEN RAISE EXCEPTION 'BAD_REQUEST'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('attendance-reminder:' || p_date::text || ':' || p_destination, 0));
  INSERT INTO public.attendance_reminder_deliveries (target_date,destination)
    VALUES (p_date,p_destination) ON CONFLICT (target_date,destination) DO NOTHING;
  SELECT * INTO v FROM public.attendance_reminder_deliveries d
    WHERE d.target_date=p_date AND d.destination=p_destination FOR UPDATE;
  IF v.state='sent' OR (v.state='processing' AND v.claimed_at > now()-interval '5 minutes') THEN
    RETURN QUERY SELECT v.retry_key, false;
    RETURN;
  END IF;
  UPDATE public.attendance_reminder_deliveries d
    SET state='processing',claimed_at=now(),attempt_count=d.attempt_count+1,last_error=NULL
    WHERE d.id=v.id;
  RETURN QUERY SELECT v.retry_key, true;
END $$;

CREATE OR REPLACE FUNCTION public.finish_attendance_reminder(
  p_date date, p_destination text, p_retry_key uuid,
  p_success boolean, p_status integer, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.attendance_reminder_deliveries d SET
    state=CASE WHEN p_success THEN 'sent' ELSE 'failed' END,
    sent_at=CASE WHEN p_success THEN now() ELSE d.sent_at END,
    last_http_status=p_status,
    last_error=CASE WHEN p_success THEN NULL ELSE left(coalesce(p_error,'unknown'),200) END
  WHERE d.target_date=p_date AND d.destination=p_destination AND d.retry_key=p_retry_key
    AND d.state='processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;
END $$;

-- Functions are callable ONLY by the service_role used inside Edge Functions.
REVOKE ALL ON FUNCTION public.claim_attendance_reminder(date,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_attendance_reminder(date,text,uuid,boolean,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_attendance_reminder(date,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_attendance_reminder(date,text,uuid,boolean,integer,text) TO service_role;

-- ---- 20261023000000_team_code.sql (team code view restriction; ships disabled) ----
-- Team code: only devices that entered the shared team code may view the roster.
-- Ships DISABLED: team code enforcement='off' and feature flag abuse_limits=false.
-- With both off, existing actions behave exactly as in the previous release.
-- Safe to repeat. Never touches player_access (edit rights) or attendance rows.
select pg_advisory_xact_lock(734214);

-- Current code (one row). version 0 / hash null = no code issued yet.
create table if not exists private.team_code (
  id boolean primary key default true check (id),
  version integer not null default 0,
  salt text check (salt ~ '^[a-f0-9]{64}$'),
  hash text check (hash ~ '^[a-f0-9]{64}$'),
  enforcement text not null default 'off' check (enforcement in ('off','on')),
  previous_salt text check (previous_salt ~ '^[a-f0-9]{64}$'),
  previous_hash text check (previous_hash ~ '^[a-f0-9]{64}$'),
  previous_valid_until timestamptz,
  updated_at timestamptz not null default now()
);
insert into private.team_code(id) values(true) on conflict (id) do nothing;

-- Devices allowed to view. Separate from player_access, which grants editing.
create table if not exists private.team_members (
  id uuid not null default gen_random_uuid() unique,
  user_id uuid primary key references auth.users(id) on delete cascade,
  method text not null check (method in ('code','existing_access','admin')),
  code_version integer,
  label text not null default '' check (char_length(label) <= 30),
  verified_at timestamptz not null default now(),
  revoked_at timestamptz
);
-- System-wide switches, independent of the team code. Off = previous behaviour.
create table if not exists private.feature_flags (
  name text primary key check (name in ('abuse_limits')),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into private.feature_flags(name) values ('abuse_limits') on conflict (name) do nothing;

alter table private.team_code enable row level security;
alter table private.team_members enable row level security;
alter table private.feature_flags enable row level security;
revoke all on private.team_code, private.team_members, private.feature_flags from public, anon, authenticated;

-- Devices that can already edit a player keep working. A revoked membership is never revived.
insert into private.team_members(user_id, method)
  select distinct auth_user_id, 'existing_access' from public.player_access where active
  on conflict (user_id) do nothing;

alter table public.re_registration_requests drop constraint if exists re_registration_requests_notification_status_check;
alter table public.re_registration_requests add constraint re_registration_requests_notification_status_check
  check (notification_status in ('pending','sent','failed','unconfigured','throttled'));

-- Atomic counter: one statement, row-locked by the upsert. A negative delta never goes below zero.
create or replace function private.bump_limit(p_bucket text, p_window interval, p_delta integer default 1)
returns integer language sql volatile set search_path='' as $$
  insert into private.rate_limits as r(bucket, started_at, attempts) values (p_bucket, now(), greatest(p_delta, 0))
  on conflict (bucket) do update set
    attempts = case when r.started_at < now() - p_window then greatest(p_delta, 0) else greatest(r.attempts + p_delta, 0) end,
    started_at = case when r.started_at < now() - p_window then now() else r.started_at end
  returning attempts
$$;

create or replace function private.flag_enabled(p_name text) returns boolean language sql stable set search_path='' as $$
  select coalesce((select enabled from private.feature_flags where name = p_name), false)
$$;

create or replace function private.is_team_member(p_user uuid) returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from private.team_members where user_id = p_user and revoked_at is null)
$$;

-- Same idempotent backfill, run again when enforcement is switched on.
create or replace function private.backfill_team_members() returns void language sql volatile set search_path='' as $$
  insert into private.team_members(user_id, method)
    select distinct auth_user_id, 'existing_access' from public.player_access where active
    on conflict (user_id) do nothing
$$;

-- For save_own_attendance (runs as the restricted writer). True when enforcement is off.
create or replace function public.attendance_is_member() returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select enforcement from private.team_code where id), 'off') <> 'on'
    or exists(select 1 from private.team_members where user_id = public.attendance_actor_id() and revoked_at is null)
$$;
revoke all on function public.attendance_is_member() from public, anon, authenticated;
grant execute on function public.attendance_is_member() to sd_attendance_writer;

create or replace function private.team_code_admin(actor uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'teamCode', (select jsonb_build_object('issued', c.hash is not null, 'version', c.version, 'enforcement', c.enforcement,
        'updatedAt', c.updated_at, 'previousValidUntil', case when c.previous_valid_until > now() then c.previous_valid_until end)
      from private.team_code c where c.id),
    'featureFlags', coalesce((select jsonb_object_agg(f.name, f.enabled) from private.feature_flags f), '{}'::jsonb),
    'teamMemberCounts', (select jsonb_build_object(
        'code', count(*) filter (where m.revoked_at is null and m.method = 'code'),
        'existingAccess', count(*) filter (where m.revoked_at is null and m.method = 'existing_access'),
        'admin', count(*) filter (where m.revoked_at is null and m.method = 'admin'),
        'revoked', count(*) filter (where m.revoked_at is not null)) from private.team_members m),
    'teamMembers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'method', m.method, 'label', m.label, 'verifiedAt', m.verified_at, 'lastSeenAt', ua.last_seen_at,
        'isCurrentDevice', m.user_id = actor,
        'players', coalesce((select jsonb_agg(p.name order by p.name) from public.player_access pa join public.players p on p.id = pa.player_id
                             where pa.auth_user_id = m.user_id and pa.active), '[]'::jsonb)) order by m.verified_at, m.id)
      from private.team_members m left join private.user_activity ua on ua.user_id = m.user_id where m.revoked_at is null), '[]'::jsonb))
$$;

-- Unchanged for non-admins; admins additionally receive the team code status.
create or replace function private.snapshot(actor uuid, is_admin boolean) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('version',1,'accessModel','multi-device','admin',is_admin,'adminConfigured',exists(select 1 from public.settings where key='admin_password_hash'),
 'myPlayerIds',coalesce((select jsonb_agg(player_id order by player_id) from public.player_access where auth_user_id=actor and active),'[]'::jsonb),
 'players',coalesce((select jsonb_agg(private.player_json(p) order by p.created_at,p.id) from public.players p where is_admin or p.active or exists(select 1 from public.player_access pa where pa.player_id=p.id and pa.auth_user_id=actor and pa.active) or exists(select 1 from public.attendance a join public.events e on e.id=a.event_id where a.player_id=p.id and e.active and e.event_date < (now() at time zone 'Asia/Tokyo')::date)),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'date',e.event_date,'title',e.title,'startTime',to_char(e.start_time,'HH24:MI'),'endTime',to_char(e.end_time,'HH24:MI'),'location',e.location,'note',e.note,'createdByName',e.created_by_name,'active',e.active) order by e.event_date,e.start_time) from public.events e where is_admin or e.active),'[]'::jsonb),
 'attendance',coalesce((select jsonb_agg(jsonb_build_object('eventId',a.event_id,'playerId',a.player_id,'status',a.status,'comment',a.comment,'updatedAt',a.updated_at)) from public.attendance a join public.events e on e.id=a.event_id join public.players p on p.id=a.player_id where a.status is not null and (is_admin or (e.active and (p.active or e.event_date < (now() at time zone 'Asia/Tokyo')::date)))),'[]'::jsonb),
 'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.request_id,'playerId',r.player_id,'playerName',p.name,'status',r.status,'requestedAt',r.requested_at,'reviewedAt',r.reviewed_at,'isMine',r.new_owner_id=actor,'notificationStatus',r.notification_status,'applicantName',r.applicant_name,'relation',r.relation) order by r.requested_at desc) from public.re_registration_requests r join public.players p on p.id=r.player_id where is_admin or r.new_owner_id=actor),'[]'::jsonb),
 'pendingAttendance','[]'::jsonb,
 'deviceAccess',case when is_admin then coalesce((select jsonb_agg(jsonb_build_object(
   'id',pa.id,'playerId',pa.player_id,'applicantName',pa.applicant_name,'relation',pa.relation,
   'grantedAt',pa.granted_at,'lastSeenAt',ua.last_seen_at,'isCurrentDevice',pa.auth_user_id=actor) order by pa.granted_at,pa.id)
   from public.player_access pa left join private.user_activity ua on ua.user_id=pa.auth_user_id where pa.active),'[]'::jsonb) else '[]'::jsonb end)
 || case when is_admin then private.team_code_admin(actor) else '{}'::jsonb end
$$;

-- Previous body plus: one membership gate, team code actions, registration and notification limits.
create or replace function public.save_own_attendance(p_event text,p_player text,p_status text,p_comment text default '',p_request uuid default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(734214);
  if public.attendance_actor_id() is null then raise exception 'UNAUTHORIZED'; end if;
  if not public.attendance_is_member() then raise exception 'TEAM_CODE_REQUIRED'; end if;
  if p_request is not null then raise exception 'APPROVAL_REQUIRED'; end if;
  if p_status is not null and p_status not in ('attend','late','absent') then raise exception 'BAD_REQUEST'; end if;
  if p_comment is null or char_length(p_comment)>300 then raise exception 'BAD_REQUEST'; end if;
  if not exists(select 1 from public.events where id=p_event and active and event_date >= (now() at time zone 'Asia/Tokyo')::date)
    or not exists(select 1 from public.players where id=p_player and active) then raise exception 'NOT_EDITABLE'; end if;
  if not exists(select 1 from public.player_access where player_id=p_player and auth_user_id=public.attendance_actor_id() and active) then raise exception 'FORBIDDEN'; end if;
  insert into public.attendance(event_id,player_id,status,comment) values(p_event,p_player,p_status,p_comment)
  on conflict(event_id,player_id) do update set status=excluded.status,comment=excluded.comment,updated_at=now();
end $$;
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='public.save_own_attendance(text,text,text,text,uuid)'::regprocedure
      and r.rolname='sd_attendance_writer' and not r.rolbypassrls and not r.rolsuper
      and p.prosecdef
  ) then raise exception 'UNEXPECTED_ATTENDANCE_WRITER_OWNER'; end if;
end $$;
revoke all on function public.save_own_attendance(text,text,text,text,uuid) from public, anon;
grant execute on function public.save_own_attendance(text,text,text,text,uuid) to authenticated;

create or replace function public.team_api(actor uuid, action text, payload jsonb default '{}', admin_token text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  admin_ok boolean := false; player public.players; req public.re_registration_requests;
  credential jsonb; result jsonb := '{}'; existing boolean := false; e jsonb; attempts integer;
  t text; normalized text; bucket_name text;
  code private.team_code; matched_version integer; n integer;
begin
  perform pg_advisory_xact_lock(734214);
  if actor is null or not exists(select 1 from auth.users where id=actor and is_anonymous) then raise exception 'UNAUTHORIZED'; end if;
  if exists(select 1 from private.user_activity where user_id=actor and cleanup_pending) then raise exception 'UNAUTHORIZED'; end if;
  insert into private.user_activity(user_id,last_seen_at) values(actor,now()) on conflict(user_id) do update set last_seen_at=now();
  select exists(select 1 from private.admin_sessions s where s.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex') and expires_at>now()) into admin_ok;
  select value into credential from public.settings where key='admin_password_hash';
  select * into code from private.team_code where id;
  -- Single gate. Allow-list: only sign-in and code entry work without membership. Admin sessions are exempt.
  if coalesce(code.enforcement,'off')='on' and not admin_ok and not private.is_team_member(actor)
     and action not in ('authPrepare','initializeAdmin','adminLogin','adminLogout','teamCodePrepare','verifyTeamCode') then
    raise exception 'TEAM_CODE_REQUIRED';
  end if;
  if action='getData' then return private.snapshot(actor,admin_ok); end if;
  if action='authPrepare' then
    -- Committed before password hashing; failed login calls cannot roll this back.
    bucket_name := 'admin-global';
    insert into private.rate_limits values(bucket_name,now(),1) on conflict(bucket) do update set
      attempts=case when private.rate_limits.started_at < now()-interval '15 minutes' then 1 else private.rate_limits.attempts+1 end,
      started_at=case when private.rate_limits.started_at < now()-interval '15 minutes' then now() else private.rate_limits.started_at end returning private.rate_limits.attempts into attempts;
    if attempts>20 then return jsonb_build_object('limited',true); end if;
    return jsonb_build_object('configured',credential is not null,'salt',credential->>'salt');
  elsif action='teamCodePrepare' then
    -- Committed before hashing. Device and optional IP limits first; the global bucket counts failures only.
    if private.bump_limit('team-code:user:'||actor, interval '15 minutes') > 5 then return jsonb_build_object('limited',true); end if;
    if coalesce(payload->>'ipKey','') ~ '^[a-f0-9]{64}$'
       and private.bump_limit('team-code:ip:'||(payload->>'ipKey'), interval '1 hour') > 30 then return jsonb_build_object('limited',true); end if;
    if private.bump_limit('team-code:global-failures', interval '1 hour') > 1000 then return jsonb_build_object('limited',true); end if;
    -- One verification per prepare.
    insert into private.rate_limits values('team-code:ticket:'||actor,now(),1)
      on conflict(bucket) do update set started_at=now(),attempts=1;
    return jsonb_build_object('limited',false,
      'salt',coalesce(code.salt,encode(sha256(convert_to('team-code-unissued:'||actor,'UTF8')),'hex')),
      'previousSalt',case when code.previous_valid_until>now() then code.previous_salt end);
  elsif action='verifyTeamCode' then
    if coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$'
       or (payload ? 'previousProof' and coalesce(payload->>'previousProof','') !~ '^[a-f0-9]{64}$') then raise exception 'BAD_REQUEST'; end if;
    t := btrim(coalesce(payload->>'label',''));
    if char_length(t)>30 then raise exception 'BAD_REQUEST'; end if;
    delete from private.rate_limits where bucket='team-code:ticket:'||actor and private.rate_limits.started_at>now()-interval '2 minutes' returning private.rate_limits.attempts into n;
    -- Same answer for every failure: no ticket, no code issued, wrong code, expired previous code.
    if n is null or code.hash is null then return jsonb_build_object('verified',false); end if;
    if code.hash=payload->>'proof' then matched_version := code.version;
    elsif code.previous_valid_until>now() and code.previous_hash=payload->>'previousProof' then matched_version := code.version-1;
    else return jsonb_build_object('verified',false); end if;
    perform private.bump_limit('team-code:global-failures', interval '1 hour', -1);
    insert into private.team_members(user_id,method,code_version,label) values(actor,'code',matched_version,t)
      on conflict(user_id) do update set method='code',code_version=excluded.code_version,verified_at=now(),revoked_at=null,
        label=case when excluded.label<>'' then excluded.label else private.team_members.label end;
    result := jsonb_build_object('verified',true);
  elsif action in ('initializeAdmin','adminLogin','changeAdminPassword') then
    if coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    if action='initializeAdmin' then
      if credential is not null then raise exception 'CONFLICT'; end if;
      -- Setup code is checked by Edge; this service-only operation cannot be called by a browser.
    elsif action='adminLogin' then
      if credential is null or credential->>'hash' is distinct from payload->>'proof' then raise exception 'BAD_PASSWORD'; end if;
    else
      if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
      if credential->>'hash' is distinct from payload->>'currentProof' then raise exception 'BAD_PASSWORD'; end if;
    end if;
    if action<>'adminLogin' then
      if coalesce(payload->>'salt','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
      insert into public.settings values('admin_password_hash',jsonb_build_object('algorithm','scrypt-N32768-r8-p3-v1','salt',payload->>'salt','hash',payload->>'proof')) on conflict(key) do update set value=excluded.value;
      -- Sign out every admin session. `where true` keeps this valid under safeupdate (API connections).
      delete from private.admin_sessions where true;
      if action='changeAdminPassword' then return jsonb_build_object('authenticated',false); end if;
    end if;
    t := payload->>'token';
    if coalesce(t,'') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    delete from private.admin_sessions where expires_at<=now() or private.admin_sessions.actor=team_api.actor;
    insert into private.admin_sessions values(encode(sha256(convert_to(t,'UTF8')),'hex'),actor,now()+interval '1 hour');
    return jsonb_build_object('authenticated',true);
  elsif action='adminLogout' then
    delete from private.admin_sessions where private.admin_sessions.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex');
    return jsonb_build_object('authenticated',false);
  elsif action='registerPlayer' then
    t := btrim(payload->>'name'); normalized := regexp_replace(t,'[[:space:]　]+','','g');
    if t is null or char_length(t)>30 or normalized='' then raise exception 'BAD_REQUEST'; end if;
    select * into player from public.players where normalized_name=normalized;
    existing:=found;
    if not existing then
      if private.flag_enabled('abuse_limits') and (
         (select count(*) from public.player_access where auth_user_id=actor and applicant_name='' and relation='' and granted_at>now()-interval '1 day')>=5
         or (select count(*) from public.players where created_at>now()-interval '1 day')>=100) then raise exception 'RATE_LIMITED'; end if;
      insert into public.players(name) values(t) returning * into player;
      insert into public.player_access(player_id,auth_user_id) values(player.id,actor);
    end if;
    result:=jsonb_build_object('duplicate',existing,'player',private.player_json(player));
  elsif action='requestRegistration' then
    -- Old cached clients must not silently use the changed approval semantics.
    if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
    t:=btrim(payload->>'applicantName');
    if t is null or char_length(t) not between 1 and 30 or coalesce(payload->>'relation','') not in ('父','母','祖父母','その他') then raise exception 'BAD_REQUEST'; end if;
    select * into player from public.players where id=payload->>'playerId';
    if not found or not player.active then raise exception 'NOT_EDITABLE'; end if;
    if exists(select 1 from public.player_access where player_id=player.id and auth_user_id=actor and active) then raise exception 'ALREADY_OWNED'; end if;
    select * into req from public.re_registration_requests where player_id=player.id and new_owner_id=actor and status='pending';
    if not found then
      if exists(select 1 from public.re_registration_requests where player_id=player.id and new_owner_id=actor and requested_at>now()-interval '1 day' and status='rejected') then raise exception 'RATE_LIMITED'; end if;
      if (select count(*) from public.re_registration_requests where new_owner_id=actor and requested_at>now()-interval '1 day')>=10 then raise exception 'RATE_LIMITED'; end if;
      if private.flag_enabled('abuse_limits')
         and (select count(*) from public.re_registration_requests where player_id=player.id and status='pending')>=3 then raise exception 'RATE_LIMITED'; end if;
      insert into public.re_registration_requests(player_id,new_owner_id,applicant_name,relation)
        values(player.id,actor,t,payload->>'relation') returning * into req;
      -- With abuse_limits on, cap LINE notifications; the request is still stored and shown to admins.
      if private.flag_enabled('abuse_limits') and (
         (select count(*) from public.re_registration_requests where notification_status<>'throttled' and requested_at>now()-interval '1 hour' and request_id<>req.request_id)>=10
         or (select count(*) from public.re_registration_requests where notification_status<>'throttled' and requested_at>now()-interval '1 day' and request_id<>req.request_id)>=30) then
        update public.re_registration_requests set notification_status='throttled' where request_id=req.request_id;
      else
        result:=jsonb_build_object('notification',jsonb_build_object('requestId',req.request_id,'playerName',player.name,
          'requestedAt',req.requested_at,'applicantName',req.applicant_name,'relation',req.relation,'accessModel','multi-device'));
      end if;
    end if;
  else
    if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
    if action='reviewRegistration' then
      if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      select * into req from public.re_registration_requests where request_id=(payload->>'requestId')::uuid;
      if not found or req.status<>'pending' then raise exception 'CONFLICT'; end if;
      if payload->>'decision' not in ('approved','rejected') or payload->>'decision' is null then raise exception 'BAD_REQUEST'; end if;
      if payload->>'decision'='approved' then
        if not exists(select 1 from public.players where id=req.player_id and active) then raise exception 'NOT_EDITABLE'; end if;
        if exists(select 1 from private.user_activity where user_id=req.new_owner_id and cleanup_pending) then raise exception 'CONFLICT'; end if;
        insert into public.player_access(player_id,auth_user_id,applicant_name,relation)
          values(req.player_id,req.new_owner_id,req.applicant_name,req.relation)
          on conflict(player_id,auth_user_id) do update set active=true,revoked_at=null,granted_at=now(),applicant_name=excluded.applicant_name,relation=excluded.relation;
        -- Never replace another device's access or overwrite an official answer.
      end if;
      update public.re_registration_requests set status=payload->>'decision',reviewed_at=now() where request_id=req.request_id;
    elsif action='revokeDeviceAccess' then
      if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      update public.player_access set active=false,revoked_at=now() where id=(payload->>'accessId')::uuid and active;
      if not found then raise exception 'CONFLICT'; end if;
    elsif action='saveEvent' then
      e:=payload->'event';
      if jsonb_typeof(e)<>'object' or coalesce(e->>'id','')='' or (e->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'BAD_REQUEST'; end if;
      if (payload->>'create')::boolean then
        insert into public.events(id,event_date,title,start_time,end_time,location,note,created_by_name) values(e->>'id',(e->>'date')::date,btrim(e->>'title'),(e->>'startTime')::time,(e->>'endTime')::time,btrim(e->>'location'),coalesce(e->>'note',''),coalesce(e->>'createdByName','')) on conflict(id) do nothing;
      else
        update public.events set event_date=(e->>'date')::date,title=btrim(e->>'title'),start_time=(e->>'startTime')::time,end_time=(e->>'endTime')::time,location=btrim(e->>'location'),note=coalesce(e->>'note',''),created_by_name=coalesce(e->>'createdByName',''),updated_at=now() where id=e->>'id';
        if not found then raise exception 'NOT_FOUND'; end if;
      end if;
    elsif action='setEventActive' then
      update public.events set active=(payload->>'active')::boolean,updated_at=now() where id=payload->>'eventId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='setPlayerActive' then
      update public.players set active=(payload->>'active')::boolean,retired_at=case when (payload->>'active')::boolean then null else now() end where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='renamePlayer' then
      update public.players set name=btrim(payload->>'name') where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='rotateTeamCode' then
      -- Edge generates the code and sends only salt and scrypt proof. Members are unaffected.
      if coalesce(payload->>'salt','') !~ '^[a-f0-9]{64}$' or coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$'
         or coalesce(payload->>'graceHours','0') !~ '^\d{1,2}$' or (payload->>'graceHours')::int > 24 then raise exception 'BAD_REQUEST'; end if;
      n := coalesce((payload->>'graceHours')::int,0);
      update private.team_code set
        previous_salt=case when n>0 and hash is not null then salt end,
        previous_hash=case when n>0 and hash is not null then hash end,
        previous_valid_until=case when n>0 and hash is not null then now()+make_interval(hours=>n) end,
        salt=payload->>'salt',hash=payload->>'proof',version=version+1,updated_at=now()
      where id;
    elsif action='setTeamCodeEnforcement' then
      if payload->>'enforcement' not in ('on','off') or payload->>'enforcement' is null then raise exception 'BAD_REQUEST'; end if;
      if payload->>'enforcement'='on' then
        if code.hash is null then raise exception 'CONFLICT'; end if;
        perform private.backfill_team_members();
      end if;
      update private.team_code set enforcement=payload->>'enforcement',updated_at=now() where id;
    elsif action='revokeTeamMembers' then
      -- View access only. player_access (editing and family sharing) is never touched.
      if payload->>'scope' not in ('unbound','all') or payload->>'scope' is null then raise exception 'BAD_REQUEST'; end if;
      update private.team_members m set revoked_at=now() where m.revoked_at is null
        and (payload->>'scope'='all' or not exists(select 1 from public.player_access pa where pa.auth_user_id=m.user_id and pa.active));
      get diagnostics n = row_count;
      result := jsonb_build_object('revoked',n);
    elsif action='revokeTeamMember' then
      if coalesce(payload->>'memberId','') !~ '^[0-9a-f-]{36}$' then raise exception 'BAD_REQUEST'; end if;
      update private.team_members set revoked_at=now() where id=(payload->>'memberId')::uuid and revoked_at is null;
      if not found then raise exception 'CONFLICT'; end if;
    elsif action='setFeatureFlag' then
      if payload->>'name' is distinct from 'abuse_limits' or jsonb_typeof(payload->'enabled') is distinct from 'boolean' then raise exception 'BAD_REQUEST'; end if;
      update private.feature_flags set enabled=(payload->>'enabled')::boolean,updated_at=now() where name=payload->>'name';
    elsif action='addCurrentDeviceAsMember' then
      insert into private.team_members(user_id,method) values(actor,'admin')
        on conflict(user_id) do update set method='admin',verified_at=now(),revoked_at=null;
    else raise exception 'BAD_REQUEST'; end if;
  end if;
  return result || jsonb_build_object('snapshot',private.snapshot(actor,admin_ok));
end $$;
revoke all on function public.team_api(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.team_api(uuid,text,jsonb,text) to service_role;
revoke all on all functions in schema private from public,anon,authenticated;


-- ---- 20261030000000_registration_guard.sql (Phase 4-F: confirmed registration, roster picker, safer approval) ----
-- Phase 4-F: prevent duplicate players from mistyped names and wrong approvals of device requests.
-- 1) registerPlayer needs the screen's final confirmation; similar names are a warning only.
--    The unique constraint on players.normalized_name is unchanged.
-- 2) listDeviceCandidates: only team-code devices and admins may pick an existing player.
--    findPlayerForDevice: exact-name lookup for other devices (no lists, no hints).
-- 3) reviewRegistration checks the player the screen showed and locks the request row.
-- No table or data is changed. Safe to repeat. Rollback: supabase/rollback/20261030000000_registration_guard_down.sql

select pg_advisory_xact_lock(734214);

-- Comparison key for similar names only: NFKC (full/half width), lower case, katakana -> hiragana,
-- spaces, middle dots and dashes removed. The long vowel mark is kept.
create or replace function private.name_key(p_name text) returns text language sql immutable set search_path='' as $$
  select translate(lower(regexp_replace(normalize(coalesce(p_name,''), NFKC), '[[:space:]・·.‐‑–—_-]+', '', 'g')),
    'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴヵヶ',
    'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんゔゕゖ')
$$;

-- Levenshtein distance (names are at most 30 characters).
create or replace function private.edit_distance(a text, b text) returns integer language plpgsql immutable set search_path='' as $$
declare
  la integer := char_length(a); lb integer := char_length(b);
  prev integer[]; cur integer[]; i integer; j integer; cost integer;
begin
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;
  prev := array(select generate_series(0, lb));
  for i in 1..la loop
    cur := array[i];
    for j in 1..lb loop
      cost := case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end;
      cur := cur || least(cur[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    end loop;
    prev := cur;
  end loop;
  return prev[lb + 1];
end $$;

-- Similar: same key, one name contains the other (at least 2 characters), or one character different.
create or replace function private.names_similar(a text, b text) returns boolean language plpgsql immutable set search_path='' as $$
begin
  if a = '' or b = '' then return false; end if;
  if a = b then return true; end if;
  if least(char_length(a), char_length(b)) >= 2 and (strpos(a, b) > 0 or strpos(b, a) > 0) then return true; end if;
  if abs(char_length(a) - char_length(b)) > 1 then return false; end if;
  return private.edit_distance(a, b) <= 1;
end $$;

-- Up to 5 active players whose names look like p_name. Only for devices allowed to view the roster.
create or replace function private.similar_players_json(p_name text) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.name, x.id), '[]'::jsonb)
  from (select p.id, p.name from public.players p
        where p.active and private.names_similar(private.name_key(p.name), private.name_key(p_name))
        order by p.name, p.id limit 5) x
$$;

create or replace function public.team_api(actor uuid, action text, payload jsonb default '{}', admin_token text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  admin_ok boolean := false; player public.players; req public.re_registration_requests;
  credential jsonb; result jsonb := '{}'; existing boolean := false; e jsonb; attempts integer;
  t text; normalized text; bucket_name text;
  code private.team_code; matched_version integer; n integer;
  can_view boolean := false;
begin
  perform pg_advisory_xact_lock(734214);
  if actor is null or not exists(select 1 from auth.users where id=actor and is_anonymous) then raise exception 'UNAUTHORIZED'; end if;
  if exists(select 1 from private.user_activity where user_id=actor and cleanup_pending) then raise exception 'UNAUTHORIZED'; end if;
  insert into private.user_activity(user_id,last_seen_at) values(actor,now()) on conflict(user_id) do update set last_seen_at=now();
  select exists(select 1 from private.admin_sessions s where s.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex') and expires_at>now()) into admin_ok;
  select value into credential from public.settings where key='admin_password_hash';
  select * into code from private.team_code where id;
  -- Single gate. Allow-list: only sign-in and code entry work without membership. Admin sessions are exempt.
  if coalesce(code.enforcement,'off')='on' and not admin_ok and not private.is_team_member(actor)
     and action not in ('authPrepare','initializeAdmin','adminLogin','adminLogout','teamCodePrepare','verifyTeamCode') then
    raise exception 'TEAM_CODE_REQUIRED';
  end if;
  if action='getData' then return private.snapshot(actor,admin_ok); end if;
  if action='authPrepare' then
    -- Committed before password hashing; failed login calls cannot roll this back.
    bucket_name := 'admin-global';
    insert into private.rate_limits values(bucket_name,now(),1) on conflict(bucket) do update set
      attempts=case when private.rate_limits.started_at < now()-interval '15 minutes' then 1 else private.rate_limits.attempts+1 end,
      started_at=case when private.rate_limits.started_at < now()-interval '15 minutes' then now() else private.rate_limits.started_at end returning private.rate_limits.attempts into attempts;
    if attempts>20 then return jsonb_build_object('limited',true); end if;
    return jsonb_build_object('configured',credential is not null,'salt',credential->>'salt');
  elsif action='teamCodePrepare' then
    -- Committed before hashing. Device and optional IP limits first; the global bucket counts failures only.
    if private.bump_limit('team-code:user:'||actor, interval '15 minutes') > 5 then return jsonb_build_object('limited',true); end if;
    if coalesce(payload->>'ipKey','') ~ '^[a-f0-9]{64}$'
       and private.bump_limit('team-code:ip:'||(payload->>'ipKey'), interval '1 hour') > 30 then return jsonb_build_object('limited',true); end if;
    if private.bump_limit('team-code:global-failures', interval '1 hour') > 1000 then return jsonb_build_object('limited',true); end if;
    -- One verification per prepare.
    insert into private.rate_limits values('team-code:ticket:'||actor,now(),1)
      on conflict(bucket) do update set started_at=now(),attempts=1;
    return jsonb_build_object('limited',false,
      'salt',coalesce(code.salt,encode(sha256(convert_to('team-code-unissued:'||actor,'UTF8')),'hex')),
      'previousSalt',case when code.previous_valid_until>now() then code.previous_salt end);
  elsif action='verifyTeamCode' then
    if coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$'
       or (payload ? 'previousProof' and coalesce(payload->>'previousProof','') !~ '^[a-f0-9]{64}$') then raise exception 'BAD_REQUEST'; end if;
    t := btrim(coalesce(payload->>'label',''));
    if char_length(t)>30 then raise exception 'BAD_REQUEST'; end if;
    delete from private.rate_limits where bucket='team-code:ticket:'||actor and private.rate_limits.started_at>now()-interval '2 minutes' returning private.rate_limits.attempts into n;
    -- Same answer for every failure: no ticket, no code issued, wrong code, expired previous code.
    if n is null or code.hash is null then return jsonb_build_object('verified',false); end if;
    if code.hash=payload->>'proof' then matched_version := code.version;
    elsif code.previous_valid_until>now() and code.previous_hash=payload->>'previousProof' then matched_version := code.version-1;
    else return jsonb_build_object('verified',false); end if;
    perform private.bump_limit('team-code:global-failures', interval '1 hour', -1);
    insert into private.team_members(user_id,method,code_version,label) values(actor,'code',matched_version,t)
      on conflict(user_id) do update set method='code',code_version=excluded.code_version,verified_at=now(),revoked_at=null,
        label=case when excluded.label<>'' then excluded.label else private.team_members.label end;
    result := jsonb_build_object('verified',true);
  elsif action in ('initializeAdmin','adminLogin','changeAdminPassword') then
    if coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    if action='initializeAdmin' then
      if credential is not null then raise exception 'CONFLICT'; end if;
      -- Setup code is checked by Edge; this service-only operation cannot be called by a browser.
    elsif action='adminLogin' then
      if credential is null or credential->>'hash' is distinct from payload->>'proof' then raise exception 'BAD_PASSWORD'; end if;
    else
      if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
      if credential->>'hash' is distinct from payload->>'currentProof' then raise exception 'BAD_PASSWORD'; end if;
    end if;
    if action<>'adminLogin' then
      if coalesce(payload->>'salt','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
      insert into public.settings values('admin_password_hash',jsonb_build_object('algorithm','scrypt-N32768-r8-p3-v1','salt',payload->>'salt','hash',payload->>'proof')) on conflict(key) do update set value=excluded.value;
      -- Sign out every admin session. `where true` keeps this valid under safeupdate (API connections).
      delete from private.admin_sessions where true;
      if action='changeAdminPassword' then return jsonb_build_object('authenticated',false); end if;
    end if;
    t := payload->>'token';
    if coalesce(t,'') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    delete from private.admin_sessions where expires_at<=now() or private.admin_sessions.actor=team_api.actor;
    insert into private.admin_sessions values(encode(sha256(convert_to(t,'UTF8')),'hex'),actor,now()+interval '1 hour');
    return jsonb_build_object('authenticated',true);
  elsif action='adminLogout' then
    delete from private.admin_sessions where private.admin_sessions.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex');
    return jsonb_build_object('authenticated',false);
  elsif action='registerPlayer' then
    -- Phase 4-F: a new player is created only after the screen's final confirmation (confirmed=true).
    -- Old cached screens do not send `confirmed` and are asked to reload instead of registering at once.
    if jsonb_typeof(payload->'confirmed') is distinct from 'boolean' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
    t := btrim(payload->>'name'); normalized := regexp_replace(t,'[[:space:]　]+','','g');
    if t is null or char_length(t)>30 or normalized='' then raise exception 'BAD_REQUEST'; end if;
    select * into player from public.players where normalized_name=normalized;
    existing:=found;
    if existing then
      -- Unchanged: an exact match (spaces ignored) is never registered twice.
      result:=jsonb_build_object('duplicate',true,'player',private.player_json(player));
    elsif not (payload->>'confirmed')::boolean then
      -- Similar names go only to devices that may view the roster. Every other device gets the same answer
      -- whether or not a similar name exists, so it cannot probe the roster with near-miss names.
      can_view := admin_ok or private.is_team_member(actor);
      result:=jsonb_build_object('duplicate',false,'needsConfirmation',true,'similarVisible',can_view,
        'similar',case when can_view then private.similar_players_json(t) else '[]'::jsonb end);
    else
      if private.flag_enabled('abuse_limits') and (
         (select count(*) from public.player_access where auth_user_id=actor and applicant_name='' and relation='' and granted_at>now()-interval '1 day')>=5
         or (select count(*) from public.players where created_at>now()-interval '1 day')>=100) then raise exception 'RATE_LIMITED'; end if;
      insert into public.players(name) values(t) returning * into player;
      insert into public.player_access(player_id,auth_user_id) values(player.id,actor);
      result:=jsonb_build_object('duplicate',false,'player',private.player_json(player));
    end if;
  elsif action='listDeviceCandidates' then
    -- Phase 4-F: picking an existing player is limited to devices that entered the team code, and admins.
    -- Edit rights (player_access) alone do not count: anyone could register a new name to get them.
    if not (admin_ok or private.is_team_member(actor)) then return jsonb_build_object('allowed',false); end if;
    return jsonb_build_object('allowed',true,'players',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,
        'mine',exists(select 1 from public.player_access pa where pa.player_id=p.id and pa.auth_user_id=actor and pa.active),
        'pending',exists(select 1 from public.re_registration_requests r where r.player_id=p.id and r.new_owner_id=actor and r.status='pending'))
      order by p.name,p.id) from public.players p where p.active),'[]'::jsonb));
  elsif action='findPlayerForDevice' then
    -- Phase 4-F: for devices without the team code. Exact name only (the same match registerPlayer uses);
    -- never lists or hints at other names. Committed counter, so failures cannot roll it back.
    t := btrim(payload->>'name'); normalized := regexp_replace(t,'[[:space:]　]+','','g');
    if t is null or char_length(t)>30 or normalized='' then raise exception 'BAD_REQUEST'; end if;
    if private.bump_limit('find-player:user:'||actor, interval '15 minutes') > 20 then return jsonb_build_object('found',false,'limited',true); end if;
    select * into player from public.players where normalized_name=normalized and active;
    if not found then return jsonb_build_object('found',false); end if;
    return jsonb_build_object('found',true,'player',jsonb_build_object('id',player.id,'name',player.name));
  elsif action='requestRegistration' then
    -- Old cached clients must not silently use the changed approval semantics.
    if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
    t:=btrim(payload->>'applicantName');
    if t is null or char_length(t) not between 1 and 30 or coalesce(payload->>'relation','') not in ('父','母','祖父母','その他') then raise exception 'BAD_REQUEST'; end if;
    select * into player from public.players where id=payload->>'playerId';
    if not found or not player.active then raise exception 'NOT_EDITABLE'; end if;
    if exists(select 1 from public.player_access where player_id=player.id and auth_user_id=actor and active) then raise exception 'ALREADY_OWNED'; end if;
    select * into req from public.re_registration_requests where player_id=player.id and new_owner_id=actor and status='pending';
    if not found then
      if exists(select 1 from public.re_registration_requests where player_id=player.id and new_owner_id=actor and requested_at>now()-interval '1 day' and status='rejected') then raise exception 'RATE_LIMITED'; end if;
      if (select count(*) from public.re_registration_requests where new_owner_id=actor and requested_at>now()-interval '1 day')>=10 then raise exception 'RATE_LIMITED'; end if;
      if private.flag_enabled('abuse_limits')
         and (select count(*) from public.re_registration_requests where player_id=player.id and status='pending')>=3 then raise exception 'RATE_LIMITED'; end if;
      insert into public.re_registration_requests(player_id,new_owner_id,applicant_name,relation)
        values(player.id,actor,t,payload->>'relation') returning * into req;
      -- With abuse_limits on, cap LINE notifications; the request is still stored and shown to admins.
      if private.flag_enabled('abuse_limits') and (
         (select count(*) from public.re_registration_requests where notification_status<>'throttled' and requested_at>now()-interval '1 hour' and request_id<>req.request_id)>=10
         or (select count(*) from public.re_registration_requests where notification_status<>'throttled' and requested_at>now()-interval '1 day' and request_id<>req.request_id)>=30) then
        update public.re_registration_requests set notification_status='throttled' where request_id=req.request_id;
      else
        result:=jsonb_build_object('notification',jsonb_build_object('requestId',req.request_id,'playerName',player.name,
          'requestedAt',req.requested_at,'applicantName',req.applicant_name,'relation',req.relation,'accessModel','multi-device'));
      end if;
    end if;
  else
    if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
    if action='reviewRegistration' then
      if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      -- Phase 4-F: the screen sends the player it showed. Old screens are asked to reload.
      if coalesce(payload->>'playerId','')='' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      -- Decided by request ID. The row lock (on top of the advisory lock) makes a second, concurrent or
      -- stale decision see the new status and fail; a request for another player is never decided.
      select * into req from public.re_registration_requests where request_id=(payload->>'requestId')::uuid for update;
      if not found or req.status<>'pending' or req.player_id is distinct from payload->>'playerId' then raise exception 'CONFLICT'; end if;
      if payload->>'decision' not in ('approved','rejected') or payload->>'decision' is null then raise exception 'BAD_REQUEST'; end if;
      if payload->>'decision'='approved' then
        if not exists(select 1 from public.players where id=req.player_id and active) then raise exception 'NOT_EDITABLE'; end if;
        if exists(select 1 from private.user_activity where user_id=req.new_owner_id and cleanup_pending) then raise exception 'CONFLICT'; end if;
        insert into public.player_access(player_id,auth_user_id,applicant_name,relation)
          values(req.player_id,req.new_owner_id,req.applicant_name,req.relation)
          on conflict(player_id,auth_user_id) do update set active=true,revoked_at=null,granted_at=now(),applicant_name=excluded.applicant_name,relation=excluded.relation;
        -- Never replace another device's access or overwrite an official answer.
      end if;
      update public.re_registration_requests set status=payload->>'decision',reviewed_at=now() where request_id=req.request_id;
    elsif action='revokeDeviceAccess' then
      if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      update public.player_access set active=false,revoked_at=now() where id=(payload->>'accessId')::uuid and active;
      if not found then raise exception 'CONFLICT'; end if;
    elsif action='saveEvent' then
      e:=payload->'event';
      if jsonb_typeof(e)<>'object' or coalesce(e->>'id','')='' or (e->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'BAD_REQUEST'; end if;
      if (payload->>'create')::boolean then
        insert into public.events(id,event_date,title,start_time,end_time,location,note,created_by_name) values(e->>'id',(e->>'date')::date,btrim(e->>'title'),(e->>'startTime')::time,(e->>'endTime')::time,btrim(e->>'location'),coalesce(e->>'note',''),coalesce(e->>'createdByName','')) on conflict(id) do nothing;
      else
        update public.events set event_date=(e->>'date')::date,title=btrim(e->>'title'),start_time=(e->>'startTime')::time,end_time=(e->>'endTime')::time,location=btrim(e->>'location'),note=coalesce(e->>'note',''),created_by_name=coalesce(e->>'createdByName',''),updated_at=now() where id=e->>'id';
        if not found then raise exception 'NOT_FOUND'; end if;
      end if;
    elsif action='setEventActive' then
      update public.events set active=(payload->>'active')::boolean,updated_at=now() where id=payload->>'eventId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='setPlayerActive' then
      update public.players set active=(payload->>'active')::boolean,retired_at=case when (payload->>'active')::boolean then null else now() end where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='renamePlayer' then
      update public.players set name=btrim(payload->>'name') where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='rotateTeamCode' then
      -- Edge generates the code and sends only salt and scrypt proof. Members are unaffected.
      if coalesce(payload->>'salt','') !~ '^[a-f0-9]{64}$' or coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$'
         or coalesce(payload->>'graceHours','0') !~ '^\d{1,2}$' or (payload->>'graceHours')::int > 24 then raise exception 'BAD_REQUEST'; end if;
      n := coalesce((payload->>'graceHours')::int,0);
      update private.team_code set
        previous_salt=case when n>0 and hash is not null then salt end,
        previous_hash=case when n>0 and hash is not null then hash end,
        previous_valid_until=case when n>0 and hash is not null then now()+make_interval(hours=>n) end,
        salt=payload->>'salt',hash=payload->>'proof',version=version+1,updated_at=now()
      where id;
    elsif action='setTeamCodeEnforcement' then
      if payload->>'enforcement' not in ('on','off') or payload->>'enforcement' is null then raise exception 'BAD_REQUEST'; end if;
      if payload->>'enforcement'='on' then
        if code.hash is null then raise exception 'CONFLICT'; end if;
        perform private.backfill_team_members();
      end if;
      update private.team_code set enforcement=payload->>'enforcement',updated_at=now() where id;
    elsif action='revokeTeamMembers' then
      -- View access only. player_access (editing and family sharing) is never touched.
      if payload->>'scope' not in ('unbound','all') or payload->>'scope' is null then raise exception 'BAD_REQUEST'; end if;
      update private.team_members m set revoked_at=now() where m.revoked_at is null
        and (payload->>'scope'='all' or not exists(select 1 from public.player_access pa where pa.auth_user_id=m.user_id and pa.active));
      get diagnostics n = row_count;
      result := jsonb_build_object('revoked',n);
    elsif action='revokeTeamMember' then
      if coalesce(payload->>'memberId','') !~ '^[0-9a-f-]{36}$' then raise exception 'BAD_REQUEST'; end if;
      update private.team_members set revoked_at=now() where id=(payload->>'memberId')::uuid and revoked_at is null;
      if not found then raise exception 'CONFLICT'; end if;
    elsif action='setFeatureFlag' then
      if payload->>'name' is distinct from 'abuse_limits' or jsonb_typeof(payload->'enabled') is distinct from 'boolean' then raise exception 'BAD_REQUEST'; end if;
      update private.feature_flags set enabled=(payload->>'enabled')::boolean,updated_at=now() where name=payload->>'name';
    elsif action='addCurrentDeviceAsMember' then
      insert into private.team_members(user_id,method) values(actor,'admin')
        on conflict(user_id) do update set method='admin',verified_at=now(),revoked_at=null;
    else raise exception 'BAD_REQUEST'; end if;
  end if;
  return result || jsonb_build_object('snapshot',private.snapshot(actor,admin_ok));
end $$;
revoke all on function public.team_api(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.team_api(uuid,text,jsonb,text) to service_role;

revoke all on all functions in schema private from public,anon,authenticated;


-- ---- 20261031000000_member_admission.sql (Phase 4-F2: only confirmed players' devices are admitted automatically) ----
-- Phase 4-F2: registering a new player no longer earns roster access when the view restriction is switched on.
-- Before: switching the restriction on admitted every device with edit rights (player_access), so a device
-- that registered a made-up name while the restriction was off could then read the roster.
-- Now: players carry verified_at. Players that exist when this ships are confirmed once (the admin knows them);
-- players registered later stay unconfirmed until an admin confirms them (verifyPlayer). Only devices of
-- confirmed players are admitted automatically; others enter the team code. Existing members are untouched.
-- Rollback: supabase/rollback/20261031000000_member_admission_down.sql

select pg_advisory_xact_lock(734214);

-- Requires 20261030000000_registration_guard.sql (its team_api is the base of this one). Stop instead of
-- creating a team_api that would fail at run time.
do $$
begin
  if to_regprocedure('private.similar_players_json(text)') is null then raise exception 'APPLY_20261030000000_REGISTRATION_GUARD_FIRST'; end if;
end $$;

-- One time only: add the column and confirm the players that exist now. Re-running never confirms later players.
do $$
begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='players' and column_name='verified_at') then
    alter table public.players add column verified_at timestamptz;
    update public.players set verified_at=now() where verified_at is null;
  end if;
end $$;

create or replace function private.backfill_team_members() returns void language sql volatile set search_path='' as $$
  -- Phase 4-F2: only devices that can edit an active player the admin has confirmed (players.verified_at).
  -- Registering a new name alone no longer admits a device to the roster. Revoked members stay revoked.
  insert into private.team_members(user_id, method)
    select distinct pa.auth_user_id, 'existing_access' from public.player_access pa join public.players p on p.id = pa.player_id
    where pa.active and p.active and p.verified_at is not null
    on conflict (user_id) do nothing
$$;

create or replace function private.team_code_admin(actor uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'teamCode', (select jsonb_build_object('issued', c.hash is not null, 'version', c.version, 'enforcement', c.enforcement,
        'updatedAt', c.updated_at, 'previousValidUntil', case when c.previous_valid_until > now() then c.previous_valid_until end)
      from private.team_code c where c.id),
    'featureFlags', coalesce((select jsonb_object_agg(f.name, f.enabled) from private.feature_flags f), '{}'::jsonb),
    -- Phase 4-F2: players registered on a device but not yet confirmed by an admin.
    'unverifiedPlayerIds', coalesce((select jsonb_agg(p.id order by p.created_at, p.id) from public.players p where p.verified_at is null and p.active), '[]'::jsonb),
    -- What switching the restriction on would do to devices that are not members yet.
    'admissionPreview', (select jsonb_build_object(
        'admitted', count(*) filter (where x.verified),
        'needsCode', count(*) filter (where not x.verified))
      from (select pa.auth_user_id, bool_or(p.verified_at is not null and p.active) verified
            from public.player_access pa join public.players p on p.id = pa.player_id
            where pa.active and not exists(select 1 from private.team_members m where m.user_id = pa.auth_user_id)
            group by pa.auth_user_id) x),
    'teamMemberCounts', (select jsonb_build_object(
        'code', count(*) filter (where m.revoked_at is null and m.method = 'code'),
        'existingAccess', count(*) filter (where m.revoked_at is null and m.method = 'existing_access'),
        'admin', count(*) filter (where m.revoked_at is null and m.method = 'admin'),
        'revoked', count(*) filter (where m.revoked_at is not null)) from private.team_members m),
    'teamMembers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'method', m.method, 'label', m.label, 'verifiedAt', m.verified_at, 'lastSeenAt', ua.last_seen_at,
        'isCurrentDevice', m.user_id = actor,
        'players', coalesce((select jsonb_agg(p.name order by p.name) from public.player_access pa join public.players p on p.id = pa.player_id
                             where pa.auth_user_id = m.user_id and pa.active), '[]'::jsonb)) order by m.verified_at, m.id)
      from private.team_members m left join private.user_activity ua on ua.user_id = m.user_id where m.revoked_at is null), '[]'::jsonb))
$$;

create or replace function public.team_api(actor uuid, action text, payload jsonb default '{}', admin_token text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  admin_ok boolean := false; player public.players; req public.re_registration_requests;
  credential jsonb; result jsonb := '{}'; existing boolean := false; e jsonb; attempts integer;
  t text; normalized text; bucket_name text;
  code private.team_code; matched_version integer; n integer;
  can_view boolean := false;
begin
  perform pg_advisory_xact_lock(734214);
  if actor is null or not exists(select 1 from auth.users where id=actor and is_anonymous) then raise exception 'UNAUTHORIZED'; end if;
  if exists(select 1 from private.user_activity where user_id=actor and cleanup_pending) then raise exception 'UNAUTHORIZED'; end if;
  insert into private.user_activity(user_id,last_seen_at) values(actor,now()) on conflict(user_id) do update set last_seen_at=now();
  select exists(select 1 from private.admin_sessions s where s.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex') and expires_at>now()) into admin_ok;
  select value into credential from public.settings where key='admin_password_hash';
  select * into code from private.team_code where id;
  -- Single gate. Allow-list: only sign-in and code entry work without membership. Admin sessions are exempt.
  if coalesce(code.enforcement,'off')='on' and not admin_ok and not private.is_team_member(actor)
     and action not in ('authPrepare','initializeAdmin','adminLogin','adminLogout','teamCodePrepare','verifyTeamCode') then
    raise exception 'TEAM_CODE_REQUIRED';
  end if;
  if action='getData' then return private.snapshot(actor,admin_ok); end if;
  if action='authPrepare' then
    -- Committed before password hashing; failed login calls cannot roll this back.
    bucket_name := 'admin-global';
    insert into private.rate_limits values(bucket_name,now(),1) on conflict(bucket) do update set
      attempts=case when private.rate_limits.started_at < now()-interval '15 minutes' then 1 else private.rate_limits.attempts+1 end,
      started_at=case when private.rate_limits.started_at < now()-interval '15 minutes' then now() else private.rate_limits.started_at end returning private.rate_limits.attempts into attempts;
    if attempts>20 then return jsonb_build_object('limited',true); end if;
    return jsonb_build_object('configured',credential is not null,'salt',credential->>'salt');
  elsif action='teamCodePrepare' then
    -- Committed before hashing. Device and optional IP limits first; the global bucket counts failures only.
    if private.bump_limit('team-code:user:'||actor, interval '15 minutes') > 5 then return jsonb_build_object('limited',true); end if;
    if coalesce(payload->>'ipKey','') ~ '^[a-f0-9]{64}$'
       and private.bump_limit('team-code:ip:'||(payload->>'ipKey'), interval '1 hour') > 30 then return jsonb_build_object('limited',true); end if;
    if private.bump_limit('team-code:global-failures', interval '1 hour') > 1000 then return jsonb_build_object('limited',true); end if;
    -- One verification per prepare.
    insert into private.rate_limits values('team-code:ticket:'||actor,now(),1)
      on conflict(bucket) do update set started_at=now(),attempts=1;
    return jsonb_build_object('limited',false,
      'salt',coalesce(code.salt,encode(sha256(convert_to('team-code-unissued:'||actor,'UTF8')),'hex')),
      'previousSalt',case when code.previous_valid_until>now() then code.previous_salt end);
  elsif action='verifyTeamCode' then
    if coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$'
       or (payload ? 'previousProof' and coalesce(payload->>'previousProof','') !~ '^[a-f0-9]{64}$') then raise exception 'BAD_REQUEST'; end if;
    t := btrim(coalesce(payload->>'label',''));
    if char_length(t)>30 then raise exception 'BAD_REQUEST'; end if;
    delete from private.rate_limits where bucket='team-code:ticket:'||actor and private.rate_limits.started_at>now()-interval '2 minutes' returning private.rate_limits.attempts into n;
    -- Same answer for every failure: no ticket, no code issued, wrong code, expired previous code.
    if n is null or code.hash is null then return jsonb_build_object('verified',false); end if;
    if code.hash=payload->>'proof' then matched_version := code.version;
    elsif code.previous_valid_until>now() and code.previous_hash=payload->>'previousProof' then matched_version := code.version-1;
    else return jsonb_build_object('verified',false); end if;
    perform private.bump_limit('team-code:global-failures', interval '1 hour', -1);
    insert into private.team_members(user_id,method,code_version,label) values(actor,'code',matched_version,t)
      on conflict(user_id) do update set method='code',code_version=excluded.code_version,verified_at=now(),revoked_at=null,
        label=case when excluded.label<>'' then excluded.label else private.team_members.label end;
    result := jsonb_build_object('verified',true);
  elsif action in ('initializeAdmin','adminLogin','changeAdminPassword') then
    if coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    if action='initializeAdmin' then
      if credential is not null then raise exception 'CONFLICT'; end if;
      -- Setup code is checked by Edge; this service-only operation cannot be called by a browser.
    elsif action='adminLogin' then
      if credential is null or credential->>'hash' is distinct from payload->>'proof' then raise exception 'BAD_PASSWORD'; end if;
    else
      if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
      if credential->>'hash' is distinct from payload->>'currentProof' then raise exception 'BAD_PASSWORD'; end if;
    end if;
    if action<>'adminLogin' then
      if coalesce(payload->>'salt','') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
      insert into public.settings values('admin_password_hash',jsonb_build_object('algorithm','scrypt-N32768-r8-p3-v1','salt',payload->>'salt','hash',payload->>'proof')) on conflict(key) do update set value=excluded.value;
      -- Sign out every admin session. `where true` keeps this valid under safeupdate (API connections).
      delete from private.admin_sessions where true;
      if action='changeAdminPassword' then return jsonb_build_object('authenticated',false); end if;
    end if;
    t := payload->>'token';
    if coalesce(t,'') !~ '^[a-f0-9]{64}$' then raise exception 'BAD_REQUEST'; end if;
    delete from private.admin_sessions where expires_at<=now() or private.admin_sessions.actor=team_api.actor;
    insert into private.admin_sessions values(encode(sha256(convert_to(t,'UTF8')),'hex'),actor,now()+interval '1 hour');
    return jsonb_build_object('authenticated',true);
  elsif action='adminLogout' then
    delete from private.admin_sessions where private.admin_sessions.actor=team_api.actor and token_hash=encode(sha256(convert_to(admin_token,'UTF8')),'hex');
    return jsonb_build_object('authenticated',false);
  elsif action='registerPlayer' then
    -- Phase 4-F: a new player is created only after the screen's final confirmation (confirmed=true).
    -- Old cached screens do not send `confirmed` and are asked to reload instead of registering at once.
    if jsonb_typeof(payload->'confirmed') is distinct from 'boolean' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
    t := btrim(payload->>'name'); normalized := regexp_replace(t,'[[:space:]　]+','','g');
    if t is null or char_length(t)>30 or normalized='' then raise exception 'BAD_REQUEST'; end if;
    select * into player from public.players where normalized_name=normalized;
    existing:=found;
    if existing then
      -- Unchanged: an exact match (spaces ignored) is never registered twice.
      result:=jsonb_build_object('duplicate',true,'player',private.player_json(player));
    elsif not (payload->>'confirmed')::boolean then
      -- Similar names go only to devices that may view the roster. Every other device gets the same answer
      -- whether or not a similar name exists, so it cannot probe the roster with near-miss names.
      can_view := admin_ok or private.is_team_member(actor);
      result:=jsonb_build_object('duplicate',false,'needsConfirmation',true,'similarVisible',can_view,
        'similar',case when can_view then private.similar_players_json(t) else '[]'::jsonb end);
    else
      if private.flag_enabled('abuse_limits') and (
         (select count(*) from public.player_access where auth_user_id=actor and applicant_name='' and relation='' and granted_at>now()-interval '1 day')>=5
         or (select count(*) from public.players where created_at>now()-interval '1 day')>=100) then raise exception 'RATE_LIMITED'; end if;
      insert into public.players(name) values(t) returning * into player;
      insert into public.player_access(player_id,auth_user_id) values(player.id,actor);
      result:=jsonb_build_object('duplicate',false,'player',private.player_json(player));
    end if;
  elsif action='listDeviceCandidates' then
    -- Phase 4-F: picking an existing player is limited to devices that entered the team code, and admins.
    -- Edit rights (player_access) alone do not count: anyone could register a new name to get them.
    if not (admin_ok or private.is_team_member(actor)) then return jsonb_build_object('allowed',false); end if;
    return jsonb_build_object('allowed',true,'players',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,
        'mine',exists(select 1 from public.player_access pa where pa.player_id=p.id and pa.auth_user_id=actor and pa.active),
        'pending',exists(select 1 from public.re_registration_requests r where r.player_id=p.id and r.new_owner_id=actor and r.status='pending'))
      order by p.name,p.id) from public.players p where p.active),'[]'::jsonb));
  elsif action='findPlayerForDevice' then
    -- Phase 4-F: for devices without the team code. Exact name only (the same match registerPlayer uses);
    -- never lists or hints at other names. Committed counter, so failures cannot roll it back.
    t := btrim(payload->>'name'); normalized := regexp_replace(t,'[[:space:]　]+','','g');
    if t is null or char_length(t)>30 or normalized='' then raise exception 'BAD_REQUEST'; end if;
    if private.bump_limit('find-player:user:'||actor, interval '15 minutes') > 20 then return jsonb_build_object('found',false,'limited',true); end if;
    select * into player from public.players where normalized_name=normalized and active;
    if not found then return jsonb_build_object('found',false); end if;
    return jsonb_build_object('found',true,'player',jsonb_build_object('id',player.id,'name',player.name));
  elsif action='requestRegistration' then
    -- Old cached clients must not silently use the changed approval semantics.
    if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
    t:=btrim(payload->>'applicantName');
    if t is null or char_length(t) not between 1 and 30 or coalesce(payload->>'relation','') not in ('父','母','祖父母','その他') then raise exception 'BAD_REQUEST'; end if;
    select * into player from public.players where id=payload->>'playerId';
    if not found or not player.active then raise exception 'NOT_EDITABLE'; end if;
    if exists(select 1 from public.player_access where player_id=player.id and auth_user_id=actor and active) then raise exception 'ALREADY_OWNED'; end if;
    select * into req from public.re_registration_requests where player_id=player.id and new_owner_id=actor and status='pending';
    if not found then
      if exists(select 1 from public.re_registration_requests where player_id=player.id and new_owner_id=actor and requested_at>now()-interval '1 day' and status='rejected') then raise exception 'RATE_LIMITED'; end if;
      if (select count(*) from public.re_registration_requests where new_owner_id=actor and requested_at>now()-interval '1 day')>=10 then raise exception 'RATE_LIMITED'; end if;
      if private.flag_enabled('abuse_limits')
         and (select count(*) from public.re_registration_requests where player_id=player.id and status='pending')>=3 then raise exception 'RATE_LIMITED'; end if;
      insert into public.re_registration_requests(player_id,new_owner_id,applicant_name,relation)
        values(player.id,actor,t,payload->>'relation') returning * into req;
      -- With abuse_limits on, cap LINE notifications; the request is still stored and shown to admins.
      if private.flag_enabled('abuse_limits') and (
         (select count(*) from public.re_registration_requests where notification_status<>'throttled' and requested_at>now()-interval '1 hour' and request_id<>req.request_id)>=10
         or (select count(*) from public.re_registration_requests where notification_status<>'throttled' and requested_at>now()-interval '1 day' and request_id<>req.request_id)>=30) then
        update public.re_registration_requests set notification_status='throttled' where request_id=req.request_id;
      else
        result:=jsonb_build_object('notification',jsonb_build_object('requestId',req.request_id,'playerName',player.name,
          'requestedAt',req.requested_at,'applicantName',req.applicant_name,'relation',req.relation,'accessModel','multi-device'));
      end if;
    end if;
  else
    if not admin_ok then raise exception 'UNAUTHORIZED'; end if;
    if action='reviewRegistration' then
      if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      -- Phase 4-F: the screen sends the player it showed. Old screens are asked to reload.
      if coalesce(payload->>'playerId','')='' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      -- Decided by request ID. The row lock (on top of the advisory lock) makes a second, concurrent or
      -- stale decision see the new status and fail; a request for another player is never decided.
      select * into req from public.re_registration_requests where request_id=(payload->>'requestId')::uuid for update;
      if not found or req.status<>'pending' or req.player_id is distinct from payload->>'playerId' then raise exception 'CONFLICT'; end if;
      if payload->>'decision' not in ('approved','rejected') or payload->>'decision' is null then raise exception 'BAD_REQUEST'; end if;
      if payload->>'decision'='approved' then
        if not exists(select 1 from public.players where id=req.player_id and active) then raise exception 'NOT_EDITABLE'; end if;
        if exists(select 1 from private.user_activity where user_id=req.new_owner_id and cleanup_pending) then raise exception 'CONFLICT'; end if;
        insert into public.player_access(player_id,auth_user_id,applicant_name,relation)
          values(req.player_id,req.new_owner_id,req.applicant_name,req.relation)
          on conflict(player_id,auth_user_id) do update set active=true,revoked_at=null,granted_at=now(),applicant_name=excluded.applicant_name,relation=excluded.relation;
        -- Never replace another device's access or overwrite an official answer.
      end if;
      update public.re_registration_requests set status=payload->>'decision',reviewed_at=now() where request_id=req.request_id;
    elsif action='revokeDeviceAccess' then
      if payload->>'accessModel' is distinct from 'multi-device' then raise exception 'CLIENT_UPDATE_REQUIRED'; end if;
      update public.player_access set active=false,revoked_at=now() where id=(payload->>'accessId')::uuid and active;
      if not found then raise exception 'CONFLICT'; end if;
    elsif action='saveEvent' then
      e:=payload->'event';
      if jsonb_typeof(e)<>'object' or coalesce(e->>'id','')='' or (e->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'BAD_REQUEST'; end if;
      if (payload->>'create')::boolean then
        insert into public.events(id,event_date,title,start_time,end_time,location,note,created_by_name) values(e->>'id',(e->>'date')::date,btrim(e->>'title'),(e->>'startTime')::time,(e->>'endTime')::time,btrim(e->>'location'),coalesce(e->>'note',''),coalesce(e->>'createdByName','')) on conflict(id) do nothing;
      else
        update public.events set event_date=(e->>'date')::date,title=btrim(e->>'title'),start_time=(e->>'startTime')::time,end_time=(e->>'endTime')::time,location=btrim(e->>'location'),note=coalesce(e->>'note',''),created_by_name=coalesce(e->>'createdByName',''),updated_at=now() where id=e->>'id';
        if not found then raise exception 'NOT_FOUND'; end if;
      end if;
    elsif action='setEventActive' then
      update public.events set active=(payload->>'active')::boolean,updated_at=now() where id=payload->>'eventId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='setPlayerActive' then
      update public.players set active=(payload->>'active')::boolean,retired_at=case when (payload->>'active')::boolean then null else now() end where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='renamePlayer' then
      update public.players set name=btrim(payload->>'name') where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
    elsif action='verifyPlayer' then
      -- Phase 4-F2: the admin confirms a player is a real team member. Only devices of confirmed players
      -- are admitted as viewers automatically (backfill). With the restriction on, admit them right away.
      update public.players set verified_at=coalesce(verified_at,now()) where id=payload->>'playerId';
      if not found then raise exception 'NOT_FOUND'; end if;
      if coalesce(code.enforcement,'off')='on' then perform private.backfill_team_members(); end if;
    elsif action='rotateTeamCode' then
      -- Edge generates the code and sends only salt and scrypt proof. Members are unaffected.
      if coalesce(payload->>'salt','') !~ '^[a-f0-9]{64}$' or coalesce(payload->>'proof','') !~ '^[a-f0-9]{64}$'
         or coalesce(payload->>'graceHours','0') !~ '^\d{1,2}$' or (payload->>'graceHours')::int > 24 then raise exception 'BAD_REQUEST'; end if;
      n := coalesce((payload->>'graceHours')::int,0);
      update private.team_code set
        previous_salt=case when n>0 and hash is not null then salt end,
        previous_hash=case when n>0 and hash is not null then hash end,
        previous_valid_until=case when n>0 and hash is not null then now()+make_interval(hours=>n) end,
        salt=payload->>'salt',hash=payload->>'proof',version=version+1,updated_at=now()
      where id;
    elsif action='setTeamCodeEnforcement' then
      if payload->>'enforcement' not in ('on','off') or payload->>'enforcement' is null then raise exception 'BAD_REQUEST'; end if;
      if payload->>'enforcement'='on' then
        if code.hash is null then raise exception 'CONFLICT'; end if;
        perform private.backfill_team_members();
      end if;
      update private.team_code set enforcement=payload->>'enforcement',updated_at=now() where id;
    elsif action='revokeTeamMembers' then
      -- View access only. player_access (editing and family sharing) is never touched.
      if payload->>'scope' not in ('unbound','all') or payload->>'scope' is null then raise exception 'BAD_REQUEST'; end if;
      update private.team_members m set revoked_at=now() where m.revoked_at is null
        and (payload->>'scope'='all' or not exists(select 1 from public.player_access pa where pa.auth_user_id=m.user_id and pa.active));
      get diagnostics n = row_count;
      result := jsonb_build_object('revoked',n);
    elsif action='revokeTeamMember' then
      if coalesce(payload->>'memberId','') !~ '^[0-9a-f-]{36}$' then raise exception 'BAD_REQUEST'; end if;
      update private.team_members set revoked_at=now() where id=(payload->>'memberId')::uuid and revoked_at is null;
      if not found then raise exception 'CONFLICT'; end if;
    elsif action='setFeatureFlag' then
      if payload->>'name' is distinct from 'abuse_limits' or jsonb_typeof(payload->'enabled') is distinct from 'boolean' then raise exception 'BAD_REQUEST'; end if;
      update private.feature_flags set enabled=(payload->>'enabled')::boolean,updated_at=now() where name=payload->>'name';
    elsif action='addCurrentDeviceAsMember' then
      insert into private.team_members(user_id,method) values(actor,'admin')
        on conflict(user_id) do update set method='admin',verified_at=now(),revoked_at=null;
    else raise exception 'BAD_REQUEST'; end if;
  end if;
  return result || jsonb_build_object('snapshot',private.snapshot(actor,admin_ok));
end $$;
revoke all on function public.team_api(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.team_api(uuid,text,jsonb,text) to service_role;

revoke all on all functions in schema private from public,anon,authenticated;

notify pgrst, 'reload schema';
COMMIT;
