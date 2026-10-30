-- Phase 4-F2: registering a new player no longer earns roster access when the view restriction is switched on.
-- Before: switching the restriction on admitted every device with edit rights (player_access), so a device
-- that registered a made-up name while the restriction was off could then read the roster.
-- Now: players carry verified_at. Players that exist when this ships are confirmed once (the admin knows them);
-- players registered later stay unconfirmed until an admin confirms them (verifyPlayer). Only devices of
-- confirmed players are admitted automatically; others enter the team code. Existing members are untouched.
-- Rollback: supabase/rollback/20261031000000_member_admission_down.sql
begin;
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
commit;
