import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest'

let db: PGlite
const owner='00000000-0000-4000-8000-000000000001', stranger='00000000-0000-4000-8000-000000000002', coach='00000000-0000-4000-8000-000000000003'
const token='a'.repeat(64), salt='b'.repeat(64), proof='c'.repeat(64)
beforeAll(async()=>{
  db=new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean default true,created_at timestamptz default now(),last_sign_in_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to public;`)
  await db.exec(readFileSync('supabase/migrations/20260911000000_v14.sql','utf8'))
  await db.exec(readFileSync('supabase/migrations/20260911000100_import.sql','utf8'))
},30000)
afterAll(async()=>{await db?.close()})
beforeEach(async()=>{
  await db.exec('begin')
  await db.query('insert into auth.users(id) values($1),($2),($3)',[owner,stranger,coach])
  await db.query(`insert into public.players(id,name,owner_id) values('p1','山田 太郎',$1),('p2','山田 次郎',$1)`,[owner])
  await db.exec(`insert into public.events(id,event_date,title,start_time,end_time,location) values
    ('future',(now() at time zone 'Asia/Tokyo')::date+1,'練習','08:00','12:00','学校'),
    ('past',(now() at time zone 'Asia/Tokyo')::date-1,'過去','08:00','12:00','学校')`)
})
afterEach(async()=>{await db.exec('rollback')})
async function asRole(role:string,user:string,sql:string,params:unknown[]=[]) {
  await db.exec('savepoint call_test')
  try {
    await db.exec(`set local role ${role}`)
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user])
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
async function request(){return (await api(stranger,'requestRegistration',{playerId:'p1'})).snapshot.requests[0].id as string}

it('closes every exposed table to raw anon/authenticated CRUD',async()=>{
  for(const table of ['players','events','attendance','settings','re_registration_requests','pending_attendance']) {
    for(const role of ['anon','authenticated']) {
      await expect(asRole(role,owner,`select * from public.${table}`)).rejects.toThrow(/permission denied/)
      await expect(asRole(role,owner,`insert into public.${table} default values`)).rejects.toThrow(/permission denied/)
      await expect(asRole(role,owner,`delete from public.${table}`)).rejects.toThrow(/permission denied/)
      const key=table==='settings'?'key':table==='re_registration_requests'?'request_id':table==='pending_attendance'?'request_id':'id'
      await expect(asRole(role,owner,`update public.${table} set ${key}=${key}`)).rejects.toThrow(/permission denied/)
    }
  }
  await expect(asRole('authenticated',owner,"select public.team_api($1,'getData')",[coach])).rejects.toThrow(/permission denied/)
  await expect(asRole('anon','',"select public.save_own_attendance('future','p1','attend')")).rejects.toThrow(/permission denied/)
})
it('allows siblings owned by the caller, denies foreign, past and retired writes',async()=>{
  await write(owner);await write(owner,'future','p2','late')
  await expect(write(stranger)).rejects.toThrow('FORBIDDEN')
  await expect(write(owner,'past')).rejects.toThrow('NOT_EDITABLE')
  await db.exec("update players set active=false where id='p1'")
  await expect(write(owner)).rejects.toThrow('NOT_EDITABLE')
  expect((await db.query('select * from attendance')).rows).toHaveLength(2)
})
it('enforces ownership in RLS even if a future RPC accidentally omitted its checks',async()=>{
  await expect(asRole('sd_attendance_writer',stranger,"insert into attendance(event_id,player_id,status) values('future','p1','attend')")).rejects.toThrow(/row-level security/)
  await expect(asRole('sd_attendance_writer',owner,"insert into attendance(event_id,player_id,status) values('past','p1','attend')")).rejects.toThrow(/row-level security/)
})
it('detects space-normalized duplicates without giving away ownership',async()=>{
  const result=await api(stranger,'registerPlayer',{name:'山田　太郎'})
  expect(result.duplicate).toBe(true);expect(result.player.id).toBe('p1');expect(result.snapshot.myPlayerIds).toEqual([])
  expect(JSON.stringify(result)).not.toContain('owner_id')
  expect((await api(owner,'getData')).myPlayerIds).toEqual(['p1','p2'])
})
it('deduplicates pending requests, protects them from another requester, keeps drafts separate',async()=>{
  const id=await request()
  expect((await request())).toBe(id)
  await expect(api(coach,'requestRegistration',{playerId:'p1'})).rejects.toThrow('REQUEST_EXISTS')
  await write(stranger,'future','p1','late',id)
  await expect(write(coach,'future','p1','absent',id)).rejects.toThrow('FORBIDDEN')
  await expect(write(stranger,'future','p2','absent',id)).rejects.toThrow('FORBIDDEN')
  expect((await db.query('select * from attendance')).rows).toHaveLength(0)
  expect((await api(stranger,'getData')).pendingAttendance[0].status).toBe('late')
  expect((await api(owner,'getData')).pendingAttendance).toEqual([])
})
it('atomically approves ownership and drafts, revokes old owner and is not replayable',async()=>{
  await login();await write(owner)
  const id=await request();await write(stranger,'future','p1','absent',id)
  await api(coach,'reviewRegistration',{requestId:id,decision:'approved'},token)
  expect((await api(stranger,'getData')).myPlayerIds).toEqual(['p1'])
  expect((await db.query('select status from attendance')).rows[0]).toEqual({status:'absent'})
  await expect(write(owner)).rejects.toThrow('FORBIDDEN')
  await write(stranger)
  await expect(api(coach,'reviewRegistration',{requestId:id,decision:'approved'},token)).rejects.toThrow('CONFLICT')
})
it('rejects without modifying official answers and preserves unanswered tombstones on approval',async()=>{
  await login();await write(owner)
  const id=await request();await write(stranger,'future','p1',null,id)
  await api(coach,'reviewRegistration',{requestId:id,decision:'rejected'},token)
  expect((await db.query('select status from attendance')).rows[0]).toEqual({status:'attend'})
  await expect(write(stranger,'future','p1','late',id)).rejects.toThrow('FORBIDDEN')
  expect((await api(owner,'getData')).myPlayerIds).toContain('p1')
})
it('does not promote drafts for events that became past or hidden',async()=>{
  await login();const id=await request();await write(stranger,'future','p1','late',id)
  await db.exec("update events set active=false where id='future'")
  await api(coach,'reviewRegistration',{requestId:id,decision:'approved'},token)
  expect((await db.query('select * from attendance')).rows).toHaveLength(0)
})
it('requires real admin sessions bound to actor; password changes revoke all sessions',async()=>{
  await login()
  await expect(api(stranger,'setPlayerActive',{playerId:'p1',active:false},token)).rejects.toThrow('UNAUTHORIZED')
  await api(coach,'changeAdminPassword',{salt,proof:'d'.repeat(64),currentProof:proof},token)
  await expect(api(coach,'setPlayerActive',{playerId:'p1',active:false},token)).rejects.toThrow('UNAUTHORIZED')
})
it('rate limits failed passwords across anonymous identities',async()=>{
  for(let i=0;i<20;i++) expect((await api(i%2?owner:stranger,'authPrepare')).limited).not.toBe(true)
  expect((await api(coach,'authPrepare')).limited).toBe(true)
})
it('only returns expired unreferenced anonymous users for cleanup',async()=>{
  await db.exec("update auth.users set created_at=now()-interval '100 days'")
  await api(stranger,'getData') // recently used despite old sign-in
  const result=await asRole('service_role',coach,'select * from public.cleanup_candidates(true)')
  expect(result.rows).toEqual([{user_id:coach}])
  await asRole('service_role',coach,'select * from public.cleanup_candidates(false)')
  await expect(api(coach,'registerPlayer',{name:'新しい選手'})).rejects.toThrow('UNAUTHORIZED')
})

it('approves an unanswered draft by clearing the official answer without deleting its row',async()=>{
  await login();await write(owner)
  const id=await request();await write(stranger,'future','p1',null,id)
  await api(coach,'reviewRegistration',{requestId:id,decision:'approved'},token)
  expect((await db.query('select status from attendance')).rows).toEqual([{status:null}])
  expect((await api(stranger,'getData')).attendance).toEqual([])
})
it('protects hidden events and keeps them visible only to authenticated admins',async()=>{
  await login();await api(coach,'setEventActive',{eventId:'future',active:false},token)
  expect((await api(owner,'getData')).events.map((e:any)=>e.id)).toEqual(['past'])
  expect((await api(coach,'getData',{},token)).events).toHaveLength(2)
  await expect(write(owner)).rejects.toThrow('NOT_EDITABLE')
  await db.exec("update private.admin_sessions set expires_at=now()-interval '1 minute'")
  expect((await api(coach,'getData',{},token)).admin).toBe(false)
})
it('accepts optional event creator and validates schedule bounds',async()=>{
  await login()
  const event={id:'new',date:'2027-01-01',title:'練習',startTime:'08:00',endTime:'12:00',location:'学校',note:'',createdByName:''}
  await api(coach,'saveEvent',{event,create:true},token)
  await expect(api(coach,'saveEvent',{event:{...event,endTime:'07:00'},create:false},token)).rejects.toThrow(/check constraint/)
  expect((await db.query("select created_by_name from events where id='new'")).rows).toEqual([{created_by_name:''}])
})
it('imports all legacy records together, preserves credentials, never trusts legacy ownership',async()=>{
  const snapshot=await api(owner,'getData')
  await db.exec('delete from events; delete from players')
  const imported=await asRole('service_role',owner,'select import_legacy_snapshot($1,$2) as result',[JSON.stringify(snapshot),JSON.stringify({algorithm:'scrypt-N32768-r8-p3-v1',salt,hash:proof})])
  expect((imported.rows[0] as any).result).toEqual({players:2,events:2,attendance:0})
  expect((await db.query('select owner_id from players')).rows).toEqual([{owner_id:null},{owner_id:null}])
  await api(coach,'adminLogin',{proof,token})
  expect((await api(coach,'getData',{},token)).admin).toBe(true)
  await expect(asRole('service_role',owner,'select import_legacy_snapshot($1)',[JSON.stringify(snapshot)])).rejects.toThrow('DESTINATION_NOT_EMPTY')
})
it('rolls back the whole import when a record references a missing event',async()=>{
  const snapshot=await api(owner,'getData')
  snapshot.attendance=[{eventId:'missing',playerId:'p1',status:'attend',updatedAt:new Date().toISOString()}]
  await db.exec('delete from events; delete from players')
  await expect(asRole('service_role',owner,'select import_legacy_snapshot($1)',[JSON.stringify(snapshot)])).rejects.toThrow(/foreign key/)
  expect((await db.query('select * from players')).rows).toHaveLength(0)
})
