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
