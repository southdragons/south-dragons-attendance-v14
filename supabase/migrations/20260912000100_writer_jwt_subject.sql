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
