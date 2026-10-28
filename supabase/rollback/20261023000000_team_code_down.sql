-- ROLLBACK for 20261023000000_team_code.sql (team code view restriction).
-- Functional rollback: restores the three functions that migration replaced to their previous
-- definitions (copied verbatim from 20260913000000_multi_device_access.sql), so the previous `team`
-- Edge Function and screens work exactly as before.
--
-- NO DATA IS DELETED OR CHANGED. players, events, attendance, player_access, requests,
-- admin sessions, settings and user activity are not touched. The team code tables
-- (private.team_code / team_members / feature_flags), their helper functions and the widened
-- notification_status constraint are left in place but unused, so re-applying the migration later
-- restores everything. Only the two switches are set to off, so a later re-apply starts disabled.
--
-- One intentional difference from the previous team_api: `delete from private.admin_sessions where true`
-- (the old unqualified DELETE fails under Supabase's safeupdate guard; see tests/sql-safeupdate.test.ts).
--
-- Order (see docs/team-code-release.md): 1) admin switches the view restriction off in the app,
-- 2) run this file once in the SQL Editor, 3) redeploy the previous `team` function, 4) revert the screens.
-- Between steps everything keeps working: with the restriction off the new function/screens never need
-- the removed behaviour, and the previous function never calls the new actions. Safe to repeat.
begin;
select pg_advisory_xact_lock(734214);

-- Switch the dormant features off (kept rows: code hash, members, flags).
update private.team_code set enforcement='off', updated_at=now() where id;
update private.feature_flags set enabled=false, updated_at=now() where name='abuse_limits';

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
      delete from private.admin_sessions where true; -- rollback keeps the safeupdate fix
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

notify pgrst, 'reload schema';
commit;
