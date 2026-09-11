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
