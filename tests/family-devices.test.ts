import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest'

let db: PGlite
const owner='00000000-0000-4000-8000-000000000001', mother='00000000-0000-4000-8000-000000000002', coach='00000000-0000-4000-8000-000000000003'
const token='a'.repeat(64),salt='b'.repeat(64),proof='c'.repeat(64)
const migration=readFileSync('supabase/migrations/20260913000000_multi_device_access.sql','utf8').replace(/^begin;$/m,'').replace(/^commit;$/m,'')
beforeAll(async()=>{
  db=new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean default true,created_at timestamptz default now(),last_sign_in_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to public;`)
  for(const file of ['20260911000000_v14.sql','20260911000100_import.sql','20260912000100_writer_jwt_subject.sql']) await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'))
  await db.exec('revoke usage on schema auth from sd_attendance_writer')
},30000)
afterAll(async()=>{await db?.close()})
beforeEach(async()=>{
  await db.exec('begin')
  await db.query('insert into auth.users(id) values($1),($2),($3)',[owner,mother,coach])
  await db.query(`insert into public.players(id,name,owner_id) values('p1','山田 太郎',$1),('p2','山田 次郎',$1),('imported','移行済み選手',null)`,[owner])
  await db.exec(`insert into public.events(id,event_date,title,start_time,end_time,location) values
    ('future',(now() at time zone 'Asia/Tokyo')::date+1,'練習','08:00','12:00','学校'),
    ('past',(now() at time zone 'Asia/Tokyo')::date-1,'過去','08:00','12:00','学校');
    insert into attendance(event_id,player_id,status) values('future','p1','attend');`)
  await db.exec(migration)
})
afterEach(async()=>{await db.exec('rollback')})
async function asRole(role:string,user:string,sql:string,params:unknown[]=[]) {
  await db.exec('savepoint call_test')
  try {
    await db.exec(`set local role ${role}`)
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(user?{sub:user,role}: {})])
    const result=await db.query(sql,params)
    await db.exec('reset role; release savepoint call_test')
    return result
  } catch(e) {await db.exec('rollback to savepoint call_test; release savepoint call_test');throw e}
}
async function api(user:string,action:string,payload:unknown={},adminToken='') {
  const result=await asRole('service_role',user,'select public.team_api($1,$2,$3,$4) as result',[user,action,JSON.stringify(payload),adminToken])
  return (result.rows[0] as any).result
}
const write=(user:string,event='future',player='p1',status:string|null='attend',request:string|null=null)=>asRole('authenticated',user,'select public.save_own_attendance($1,$2,$3,$4,$5)',[event,player,status,'',request])
async function login(){await api(coach,'initializeAdmin',{salt,proof,token})}
async function request(user=mother,playerId='p1',applicantName='山田 花子',relation='母'){
  return api(user,'requestRegistration',{playerId,applicantName,relation,accessModel:'multi-device'})
}
async function approve(user=mother,playerId='p1'){
  const result=await request(user,playerId)
  const id=result.snapshot.requests.find((r:any)=>r.playerId===playerId && r.status==='pending').id
  await api(coach,'reviewRegistration',{requestId:id,decision:'approved',accessModel:'multi-device'},token)
  return id
}
async function access(user=owner,playerId='p1'){
  return (await db.query<{id:string}>('select id from player_access where auth_user_id=$1 and player_id=$2',[user,playerId])).rows[0]!.id
}
async function revoke(id:string,user=coach,adminToken=token){return api(user,'revokeDeviceAccess',{accessId:id,accessModel:'multi-device'},adminToken)}
async function answer(){return (await db.query('select status from attendance where player_id=$1 and event_id=$2',['p1','future'])).rows[0]}

it('migrates only current owners, including siblings, and preserves answers on repeat',async()=>{
  expect((await api(owner,'getData')).myPlayerIds).toEqual(['p1','p2'])
  expect((await api(mother,'getData')).myPlayerIds).toEqual([])
  expect((await db.query('select * from player_access')).rows).toHaveLength(2)
  await db.exec(migration)
  expect((await db.query('select * from player_access')).rows).toHaveLength(2)
  expect(await answer()).toEqual({status:'attend'})
  expect((await db.query("select count(*)::int as n from player_access where player_id='imported'")).rows[0]).toEqual({n:0})
})
it('creates a first-device grant atomically and never grants access for a duplicate name',async()=>{
  const first=await api(mother,'registerPlayer',{name:'新しい 選手'})
  expect(first.snapshot.myPlayerIds).toEqual([first.player.id])
  expect((await db.query('select owner_id from players where id=$1',[first.player.id])).rows[0]).toEqual({owner_id:null})
  const duplicate=await api(owner,'registerPlayer',{name:'新しい　選手'})
  expect(duplicate.duplicate).toBe(true)
  expect(duplicate.snapshot.myPlayerIds).not.toContain(first.player.id)
})
it('keeps both parents authorized and counts a shared answer once with last save winning',async()=>{
  await login();await approve()
  await write(mother,'future','p1','late')
  expect(await answer()).toEqual({status:'late'})
  await write(owner,'future','p1','absent')
  expect(await answer()).toEqual({status:'absent'})
  expect((await db.query('select * from attendance')).rows).toHaveLength(1)
  expect((await api(mother,'getData')).myPlayerIds).toEqual(['p1'])
  expect((await api(owner,'getData')).myPlayerIds).toEqual(['p1','p2'])
  await expect(write(mother,'future','p2')).rejects.toThrow('FORBIDDEN')
})
it('deduplicates a device request and permits independent requests from another device',async()=>{
  const a=await request();const b=await request()
  expect(a.notification.requestId).toBe(b.snapshot.requests[0].id)
  expect(b.notification).toBeUndefined()
  const other=await request(coach)
  expect(other.snapshot.requests).toHaveLength(1)
  expect(other.snapshot.requests[0].id).not.toBe(a.notification.requestId)
  expect((await api(owner,'getData')).requests).toEqual([])
})
it('requires applicant name, relation, and a client which understands device addition',async()=>{
  await expect(request(mother,'p1','   ')).rejects.toThrow('BAD_REQUEST')
  await expect(request(mother,'p1','a'.repeat(31))).rejects.toThrow('BAD_REQUEST')
  await expect(request(mother,'p1','申請者','不明')).rejects.toThrow('BAD_REQUEST')
  await expect(api(mother,'requestRegistration',{playerId:'p1'})).rejects.toThrow('CLIENT_UPDATE_REQUIRED')
  await expect(request(owner)).rejects.toThrow('ALREADY_OWNED')
})
it('denies unapproved official and provisional writes without changing an answer',async()=>{
  const r=await request()
  await expect(write(mother)).rejects.toThrow('FORBIDDEN')
  await expect(write(mother,'future','p1','absent',r.notification.requestId)).rejects.toThrow('APPROVAL_REQUIRED')
  expect(await answer()).toEqual({status:'attend'})
  expect((await api(mother,'getData')).pendingAttendance).toEqual([])
})
it('never promotes a legacy draft when adding an approved device',async()=>{
  await login();const r=await request()
  await db.query("insert into pending_attendance(request_id,event_id,player_id,status) values($1,'future','p1','absent')",[r.notification.requestId])
  await write(owner,'future','p1','late')
  await api(coach,'reviewRegistration',{requestId:r.notification.requestId,decision:'approved',accessModel:'multi-device'},token)
  expect(await answer()).toEqual({status:'late'})
  expect((await db.query('select * from pending_attendance')).rows).toHaveLength(1)
})
it('allows an admin to process a pre-migration pending request without losing history',async()=>{
  await login()
  const r=await db.query<{request_id:string}>("insert into re_registration_requests(player_id,old_owner_id,new_owner_id) values('p1',$1,$2) returning request_id",[owner,mother])
  await api(coach,'reviewRegistration',{requestId:r.rows[0]!.request_id,decision:'approved',accessModel:'multi-device'},token)
  await write(owner);await write(mother)
  expect((await db.query('select * from re_registration_requests')).rows).toHaveLength(1)
})
it('requires admin authorization, rejects replay and leaves records unchanged on rejection',async()=>{
  await login();const r=await request()
  const payload={requestId:r.notification.requestId,decision:'approved',accessModel:'multi-device'}
  await expect(api(mother,'reviewRegistration',payload,token)).rejects.toThrow('UNAUTHORIZED')
  await expect(api(coach,'reviewRegistration',{requestId:payload.requestId,decision:'approved'},token)).rejects.toThrow('CLIENT_UPDATE_REQUIRED')
  await api(coach,'reviewRegistration',{...payload,decision:'rejected'},token)
  await expect(api(coach,'reviewRegistration',payload,token)).rejects.toThrow('CONFLICT')
  await expect(write(mother)).rejects.toThrow('FORBIDDEN')
  expect(await answer()).toEqual({status:'attend'})
  await expect(request()).rejects.toThrow('RATE_LIMITED')
  await request(coach) // another parent is not blocked by this applicant's rejection
})
it('revokes only the chosen device and child; another parent and sibling remain editable',async()=>{
  await login();await approve()
  const id=await access()
  await expect(revoke(id,mother)).rejects.toThrow('UNAUTHORIZED')
  await revoke(id)
  await expect(write(owner)).rejects.toThrow('FORBIDDEN')
  await expect(asRole('sd_attendance_writer',owner,"update attendance set status='absent' where player_id='p1'")).resolves.toMatchObject({affectedRows:0})
  await write(owner,'future','p2','late');await write(mother)
  expect((await api(owner,'getData')).myPlayerIds).toEqual(['p2'])
  expect((await api(mother,'getData')).myPlayerIds).toEqual(['p1'])
  await db.exec(migration) // legacy owner_id does not resurrect revoked access
  await expect(write(owner)).rejects.toThrow('FORBIDDEN')
  await expect(revoke(id)).rejects.toThrow('CONFLICT')
})
it('supports reapplication after revocation, without granting automatically',async()=>{
  await login();await approve();await revoke(await access(mother))
  await expect(write(mother)).rejects.toThrow('FORBIDDEN')
  const r=await request()
  expect(r.notification).toBeDefined()
  await expect(write(mother)).rejects.toThrow('FORBIDDEN')
  await approve();await write(mother)
  expect((await db.query('select * from player_access where player_id=$1 and auth_user_id=$2',['p1',mother])).rows).toHaveLength(1)
})
it('exposes device identities and applicant names only to the applicant or an admin',async()=>{
  await login();await approve()
  const ordinary=await api(owner,'getData')
  expect(ordinary.deviceAccess).toEqual([])
  expect(JSON.stringify(ordinary)).not.toContain('山田 花子')
  expect(JSON.stringify(ordinary)).not.toContain(mother)
  const admin=await api(coach,'getData',{},token)
  expect(admin.deviceAccess).toHaveLength(3)
  expect(admin.deviceAccess.find((a:any)=>a.applicantName==='山田 花子').relation).toBe('母')
  expect(JSON.stringify(admin.deviceAccess)).not.toContain('auth_user_id')
  expect((await api(mother,'getData')).requests[0].applicantName).toBe('山田 花子')
})
it('denies raw CRUD, helper RPC access and grants forged through RLS',async()=>{
  for(const role of ['anon','authenticated']) {
    for(const sql of ['select * from player_access','insert into player_access default values','update player_access set active=true','delete from player_access']) await expect(asRole(role,mother,sql)).rejects.toThrow(/permission denied/)
  }
  await expect(asRole('sd_attendance_writer',mother,'insert into player_access(player_id,auth_user_id) values($1,$2)',['p1',mother])).rejects.toThrow(/permission denied/)
  await expect(asRole('sd_attendance_writer',mother,"insert into attendance(event_id,player_id,status) values('future','p2','attend')")).rejects.toThrow(/row-level security/)
  await expect(asRole('sd_attendance_writer',mother,'select * from pending_attendance')).rejects.toThrow(/permission denied/)
  await expect(asRole('authenticated',mother,'select public.attendance_actor_id()')).rejects.toThrow(/permission denied/)
})
it('preserves JWT and date/status restrictions with auth schema access denied',async()=>{
  expect((await db.query("select has_schema_privilege('sd_attendance_writer','auth','USAGE') as allowed")).rows[0]).toEqual({allowed:false})
  await login();await approve()
  await expect(write('')).rejects.toThrow('UNAUTHORIZED')
  await expect(write(mother,'past')).rejects.toThrow('NOT_EDITABLE')
  await write(mother,'future','p1',null);expect(await answer()).toEqual({status:null})
  await db.exec("update events set active=false where id='future'")
  await expect(write(mother)).rejects.toThrow('NOT_EDITABLE')
  await db.exec("update events set active=true where id='future'; update players set active=false where id='p1'")
  await expect(write(mother)).rejects.toThrow('NOT_EDITABLE')
})
it('keeps linked and historically referenced anonymous users out of cleanup',async()=>{
  await login();await approve();await revoke(await access(mother))
  await db.exec("delete from private.admin_sessions; update auth.users set created_at=now()-interval '100 days',last_sign_in_at=null; update private.user_activity set last_seen_at=now()-interval '100 days'")
  const result=await asRole('service_role',coach,'select * from public.cleanup_candidates(true)')
  expect(result.rows).toEqual([{user_id:coach}])
})
it('does not approve a request for a player who retired while waiting',async()=>{
  await login();const r=await request()
  await api(coach,'setPlayerActive',{playerId:'p1',active:false},token)
  await expect(api(coach,'reviewRegistration',{requestId:r.notification.requestId,decision:'approved',accessModel:'multi-device'},token)).rejects.toThrow('NOT_EDITABLE')
  expect((await api(mother,'getData')).myPlayerIds).toEqual([])
})
it('installs the consolidated SQL in an empty project with the same device access model',async()=>{
  const fresh=new PGlite()
  try {
    await fresh.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key,is_anonymous boolean default true,created_at timestamptz default now(),last_sign_in_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      grant execute on function auth.uid() to public;`)
    await fresh.exec(readFileSync('supabase/setup.sql','utf8'))
    await fresh.query('insert into auth.users(id) values($1)',[owner])
    const result=await fresh.query<{result:any}>("select team_api($1,'registerPlayer',$2) as result",[owner,JSON.stringify({name:'新規環境'})])
    const value=result.rows[0]!.result
    expect(value.snapshot.accessModel).toBe('multi-device')
    expect(value.snapshot.myPlayerIds).toEqual([value.player.id])
    expect((await fresh.query('select count(*)::int as n from player_access')).rows[0]).toEqual({n:1})
  } finally {await fresh.close()}
})
