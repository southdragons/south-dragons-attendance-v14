import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest'

// Fixed hex stand-ins for values Edge computes. No real team code is used anywhere.
let db: PGlite
const owner='00000000-0000-4000-8000-000000000001', mother='00000000-0000-4000-8000-000000000002', coach='00000000-0000-4000-8000-000000000003', viewer='00000000-0000-4000-8000-000000000004', outsider='00000000-0000-4000-8000-000000000005'
const token='a'.repeat(64), adminSalt='b'.repeat(64), adminProof='c'.repeat(64)
const codeSalt='1'.repeat(64), codeProof='2'.repeat(64), wrongProof='3'.repeat(64), nextSalt='4'.repeat(64), nextProof='5'.repeat(64)
const strip=(sql:string)=>sql.replace(/^begin;$/m,'').replace(/^commit;$/m,'')
const devices=strip(readFileSync('supabase/migrations/20260913000000_multi_device_access.sql','utf8'))
const teamCode=strip(readFileSync('supabase/migrations/20261023000000_team_code.sql','utf8'))
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
  await db.query('insert into auth.users(id) values($1),($2),($3),($4),($5)',[owner,mother,coach,viewer,outsider])
  await db.query(`insert into public.players(id,name,owner_id) values('p1','山田 太郎',$1),('p2','山田 次郎',$1)`,[owner])
  await db.exec(`insert into public.events(id,event_date,title,start_time,end_time,location) values
    ('future',(now() at time zone 'Asia/Tokyo')::date+1,'練習','08:00','12:00','学校');
    insert into attendance(event_id,player_id,status) values('future','p1','attend');`)
  await db.exec(devices)
  await db.exec(teamCode)
})
afterEach(async()=>{await db.exec('rollback')})

async function asRole(role:string,user:string,sql:string,params:unknown[]=[]) {
  await db.exec('savepoint call_test')
  try {
    await db.exec(`set local role ${role}`)
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(user?{sub:user,role}:{})])
    const result=await db.query(sql,params)
    await db.exec('reset role; release savepoint call_test')
    return result
  } catch(e) {await db.exec('rollback to savepoint call_test; release savepoint call_test');throw e}
}
async function api(user:string,action:string,payload:unknown={},adminToken='') {
  const result=await asRole('service_role',user,'select public.team_api($1,$2,$3,$4) as result',[user,action,JSON.stringify(payload),adminToken])
  return (result.rows[0] as any).result
}
const write=(user:string,player='p1',status='absent')=>asRole('authenticated',user,'select public.save_own_attendance($1,$2,$3,$4,$5)',['future',player,status,'',null])
const login=()=>api(coach,'initializeAdmin',{salt:adminSalt,proof:adminProof,token})
const issue=(salt=codeSalt,proof=codeProof,graceHours=0)=>api(coach,'rotateTeamCode',{salt,proof,graceHours},token)
const enforce=(on=true)=>api(coach,'setTeamCodeEnforcement',{enforcement:on?'on':'off'},token)
async function enter(user:string,proof=codeProof,extra:Record<string,unknown>={}) {
  const prepared=await api(user,'teamCodePrepare',extra.ipKey?{ipKey:extra.ipKey}:{})
  if(prepared.limited) return {limited:true}
  return api(user,'verifyTeamCode',{proof,...extra,ipKey:undefined})
}
const members=async()=>(await db.query<{user_id:string;method:string;revoked:boolean}>('select user_id,method,revoked_at is not null as revoked from private.team_members order by user_id')).rows
const accessRows=async()=>(await db.query('select player_id,auth_user_id,active,applicant_name,relation from player_access order by player_id,auth_user_id')).rows
async function addUsers(count:number,prefix='9') {
  const ids=Array.from({length:count},(_,i)=>`${prefix}0000000-0000-4000-8000-${String(i).padStart(12,'0')}`)
  await db.query('insert into auth.users(id) select unnest($1::uuid[])',[ids])
  return ids
}
async function approve(user=mother,playerId='p1') {
  const r=await api(user,'requestRegistration',{playerId,applicantName:'山田 花子',relation:'母',accessModel:'multi-device'})
  await api(coach,'reviewRegistration',{requestId:r.notification.requestId,decision:'approved',accessModel:'multi-device'},token)
}

it('ships disabled: no code issued and existing flows unchanged',async()=>{
  expect((await db.query('select version,hash,enforcement from private.team_code')).rows).toEqual([{version:0,hash:null,enforcement:'off'}])
  const data=await api(outsider,'getData')
  expect(data.players.map((p:any)=>p.id)).toEqual(['p1','p2'])
  expect(data).not.toHaveProperty('teamCode')
  const registered=await api(outsider,'registerPlayer',{name:'新しい 選手'})
  expect(registered.duplicate).toBe(false)
  await write(outsider,registered.player.id).catch(e=>expect(String(e)).toMatch(/NOT_EDITABLE|FORBIDDEN/))
  await write(owner); expect((await db.query("select status from attendance where player_id='p1'")).rows).toEqual([{status:'absent'}])
})
it('backfills only active editors, idempotently, and never revives a revoked membership',async()=>{
  expect(await members()).toEqual([{user_id:owner,method:'existing_access',revoked:false}])
  await db.exec(`update private.team_members set revoked_at=now() where user_id='${owner}'`)
  await db.exec(teamCode)
  expect(await members()).toEqual([{user_id:owner,method:'existing_access',revoked:true}])
})
it('only an admin can issue a code or enforce it, and enforcement needs an issued code',async()=>{
  await expect(api(owner,'rotateTeamCode',{salt:codeSalt,proof:codeProof})).rejects.toThrow('UNAUTHORIZED')
  await login()
  await expect(enforce()).rejects.toThrow('CONFLICT')
  await issue(); await enforce()
  expect((await db.query('select version,enforcement from private.team_code')).rows).toEqual([{version:1,enforcement:'on'}])
  expect(JSON.stringify(await db.query('select * from private.team_code'))).not.toContain('SD-')
})
it('blocks every data path for non-members once enforced, including the direct writer RPC',async()=>{
  await login(); await issue(); await enforce()
  for(const [action,payload] of [['getData',{}],['registerPlayer',{name:'侵入者'}],['requestRegistration',{playerId:'p1',applicantName:'x',relation:'父',accessModel:'multi-device'}],['saveEvent',{}],['unknownAction',{}]] as const)
    await expect(api(outsider,action,payload)).rejects.toThrow('TEAM_CODE_REQUIRED')
  await db.exec(`insert into player_access(player_id,auth_user_id) values('p2','${outsider}')`) // editor without membership
  await expect(write(outsider,'p2')).rejects.toThrow('TEAM_CODE_REQUIRED')
  expect((await api(owner,'getData')).players).toHaveLength(2)
  await write(owner)
})
it('verifies a correct code once per prepare and answers every failure identically',async()=>{
  expect(await enter(viewer)).toMatchObject({verified:false}) // no code issued yet
  await login(); await issue(); await enforce()
  expect(await enter(viewer,wrongProof)).toEqual({verified:false})
  expect(await api(viewer,'verifyTeamCode',{proof:codeProof})).toEqual({verified:false}) // no ticket
  const ok=await enter(viewer,codeProof,{label:'祖母'})
  expect(ok.verified).toBe(true)
  expect(ok.snapshot.players).toHaveLength(2)
  expect((await db.query('select method,code_version,label from private.team_members where user_id=$1',[viewer])).rows).toEqual([{method:'code',code_version:1,label:'祖母'}])
  await expect(api(viewer,'verifyTeamCode',{proof:'not-hex'})).rejects.toThrow('BAD_REQUEST')
})
it('limits a device to five attempts per 15 minutes and resets after the window',async()=>{
  await login(); await issue()
  for(let i=0;i<5;i++) expect(await enter(viewer,wrongProof)).toEqual({verified:false})
  expect(await enter(viewer,codeProof)).toEqual({limited:true})
  await db.exec(`update private.rate_limits set started_at=now()-interval '16 minutes' where bucket='team-code:user:${viewer}'`)
  expect((await enter(viewer,codeProof)).verified).toBe(true)
})
it('interleaved attempts cannot verify twice on one prepare or avoid counting',async()=>{
  await login(); await issue()
  await api(viewer,'teamCodePrepare'); await api(viewer,'teamCodePrepare')
  expect(await api(viewer,'verifyTeamCode',{proof:wrongProof})).toEqual({verified:false})
  expect(await api(viewer,'verifyTeamCode',{proof:codeProof})).toEqual({verified:false}) // ticket already used
  expect((await db.query(`select attempts from private.rate_limits where bucket='team-code:user:${viewer}'`)).rows).toEqual([{attempts:2}])
  await db.exec(`update private.rate_limits set started_at=now()-interval '3 minutes' where bucket='team-code:ticket:${viewer}'`)
  await api(viewer,'teamCodePrepare')
  await db.exec(`update private.rate_limits set started_at=now()-interval '3 minutes' where bucket='team-code:ticket:${viewer}'`)
  expect(await api(viewer,'verifyTeamCode',{proof:codeProof})).toEqual({verified:false}) // stale ticket
})
it('a global failure cap stops attackers who recreate anonymous users; successes do not consume it',async()=>{
  await login(); await issue()
  const before=await enter(viewer,codeProof); expect(before.verified).toBe(true)
  expect((await db.query(`select attempts from private.rate_limits where bucket='team-code:global-failures'`)).rows).toEqual([{attempts:0}])
  const attackers=await addUsers(200)
  for(const a of attackers) for(let i=0;i<5;i++) await api(a,'teamCodePrepare')
  expect((await db.query(`select attempts from private.rate_limits where bucket='team-code:global-failures'`)).rows).toEqual([{attempts:1000}])
  const [fresh]=await addUsers(1,'8')
  expect(await enter(fresh!,codeProof)).toEqual({limited:true})
},60000)
it('applies an optional IP bucket and ignores malformed IP keys',async()=>{
  await login(); await issue()
  const ip='e'.repeat(64), users=await addUsers(31)
  for(const u of users.slice(0,30)) expect(await enter(u,wrongProof,{ipKey:ip})).toEqual({verified:false})
  expect(await enter(users[30]!,codeProof,{ipKey:ip})).toEqual({limited:true})
  expect((await enter(viewer,codeProof,{ipKey:'not-a-key'})).verified).toBe(true)
},30000)
it('rotation invalidates the old code immediately unless a grace period is set; members stay',async()=>{
  await login(); await issue(); await enforce()
  await enter(viewer)
  await issue(nextSalt,nextProof)
  expect(await enter(mother,codeProof)).toEqual({verified:false})
  expect((await api(viewer,'getData')).players).toHaveLength(2)
  await issue(codeSalt,codeProof,24) // previous = next code, valid 24h
  const prepared=await api(outsider,'teamCodePrepare'); expect(prepared.previousSalt).toBe(nextSalt)
  expect((await api(outsider,'verifyTeamCode',{proof:wrongProof,previousProof:nextProof})).verified).toBe(true)
  await db.exec("update private.team_code set previous_valid_until=now()-interval '1 second'")
  await api(mother,'teamCodePrepare')
  expect(await api(mother,'verifyTeamCode',{proof:wrongProof,previousProof:nextProof})).toEqual({verified:false})
})
it('revokes view access by scope or individually without touching edit rights or family sharing',async()=>{
  await login(); await issue(); await approve(); await enter(viewer)
  const editRights=await accessRows()
  expect((await api(coach,'revokeTeamMembers',{scope:'unbound'},token)).revoked).toBe(1)
  await expect(api(viewer,'getData')).resolves.toBeTruthy() // enforcement still off
  await enforce()
  await expect(api(viewer,'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
  expect((await api(mother,'getData')).myPlayerIds).toEqual(['p1'])
  expect((await api(coach,'revokeTeamMembers',{scope:'all'},token)).revoked).toBe(2)
  await expect(api(owner,'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
  await expect(write(mother)).rejects.toThrow('TEAM_CODE_REQUIRED')
  expect(await accessRows()).toEqual(editRights)
  await enter(mother); await write(mother) // new code entry restores editing, no re-approval
  expect((await api(mother,'getData')).myPlayerIds).toEqual(['p1'])
  const list=(await api(coach,'getData',{},token)).teamMembers
  expect(JSON.stringify(list)).not.toContain(mother)
  await api(coach,'revokeTeamMember',{memberId:list[0].id},token)
  await expect(api(coach,'revokeTeamMember',{memberId:list[0].id},token)).rejects.toThrow('CONFLICT')
  await expect(api(mother,'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
  expect(await accessRows()).toEqual(editRights)
})
it('switching enforcement on re-runs the backfill so devices approved while off are not locked out',async()=>{
  await login(); await issue(); await approve()
  await enforce()
  expect((await api(mother,'getData')).myPlayerIds).toEqual(['p1'])
  await enforce(false); await expect(api(outsider,'getData')).resolves.toBeTruthy()
})
it('admin sign-in works without membership but grants no lasting view access',async()=>{
  await login(); await issue(); await enforce()
  await api(coach,'adminLogout',{},token)
  await expect(api(coach,'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
  await api(coach,'adminLogin',{proof:adminProof,token})
  const admin=await api(coach,'getData',{},token)
  expect(admin.teamCode).toMatchObject({issued:true,version:1,enforcement:'on'})
  for(const action of ['setPlayerActive','renamePlayer']) expect(await api(coach,action,{playerId:'p2',active:true,name:'山田 次郎'},token)).toHaveProperty('snapshot')
  await api(coach,'adminLogout',{},token)
  await expect(api(coach,'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
  await api(coach,'adminLogin',{proof:adminProof,token}); await api(coach,'addCurrentDeviceAsMember',{},token); await api(coach,'adminLogout',{},token)
  expect((await api(coach,'getData')).admin).toBe(false)
})
it('rejects deleted, missing or cleaned-up users and cascades their membership',async()=>{
  await login(); await issue(); await enforce(); await enter(viewer)
  await db.query('delete from private.user_activity where user_id=$1',[viewer])
  await db.query('delete from auth.users where id=$1',[viewer])
  expect((await db.query('select count(*)::int n from private.team_members where user_id=$1',[viewer])).rows).toEqual([{n:0}])
  await expect(api(viewer,'getData')).rejects.toThrow('UNAUTHORIZED')
  await expect(api('','getData')).rejects.toThrow()
  await db.query('insert into private.user_activity(user_id,cleanup_pending) values($1,true) on conflict(user_id) do update set cleanup_pending=true',[owner])
  await expect(api(owner,'getData')).rejects.toThrow('UNAUTHORIZED')
})
const request=(user:string,playerId:string,relation='父')=>api(user,'requestRegistration',{playerId,applicantName:'申請者',relation,accessModel:'multi-device'})
it('with abuse_limits off (default), request, notification and registration behaviour is unchanged',async()=>{
  expect((await db.query('select name,enabled from private.feature_flags')).rows).toEqual([{name:'abuse_limits',enabled:false}])
  const applicants=await addUsers(12)
  for(const a of applicants.slice(0,4)) expect((await request(a,'p1')).notification).toBeTruthy() // 4th pending allowed
  await db.exec("insert into players(id,name) select 'x'||g,'選手'||g from generate_series(1,10) g")
  for(const [i,a] of applicants.slice(4,12).entries()) expect((await request(a,'x'+(i+1))).notification).toBeTruthy() // 12 notifications, none throttled
  expect((await db.query("select count(*)::int n from re_registration_requests where notification_status='throttled'")).rows).toEqual([{n:0}])
  for(let i=0;i<7;i++) expect((await api(outsider,'registerPlayer',{name:'登録 '+i})).duplicate).toBe(false) // more than 5 per device
})
it('only an admin can switch abuse_limits, and only with a boolean',async()=>{
  await expect(api(owner,'setFeatureFlag',{name:'abuse_limits',enabled:true})).rejects.toThrow('UNAUTHORIZED')
  await login()
  for(const payload of [{name:'abuse_limits',enabled:'true'},{name:'other',enabled:true},{name:'abuse_limits'}])
    await expect(api(coach,'setFeatureFlag',payload,token)).rejects.toThrow('BAD_REQUEST')
  const admin=await api(coach,'setFeatureFlag',{name:'abuse_limits',enabled:true},token)
  expect(admin.snapshot.featureFlags).toEqual({abuse_limits:true})
  expect(await api(owner,'getData')).not.toHaveProperty('featureFlags')
  await api(coach,'setFeatureFlag',{name:'abuse_limits',enabled:false},token)
  expect((await db.query('select enabled from private.feature_flags')).rows).toEqual([{enabled:false}])
})
it('team code attempt limits stay active with abuse_limits off',async()=>{
  await login(); await issue()
  for(let i=0;i<5;i++) await enter(viewer,wrongProof)
  expect(await enter(viewer,codeProof)).toEqual({limited:true})
})
it('with abuse_limits on: caps pending requests per player, throttles LINE notifications and limits new players per device',async()=>{
  await login(); await api(coach,'setFeatureFlag',{name:'abuse_limits',enabled:true},token)
  const applicants=await addUsers(14)
  for(const a of applicants.slice(0,3)) expect((await api(a,'requestRegistration',{playerId:'p1',applicantName:'申請者',relation:'父',accessModel:'multi-device'})).notification).toBeTruthy()
  await expect(api(applicants[3]!,'requestRegistration',{playerId:'p1',applicantName:'申請者',relation:'父',accessModel:'multi-device'})).rejects.toThrow('RATE_LIMITED')
  await db.exec("insert into players(id,name) select 'x'||g,'選手'||g from generate_series(1,10) g")
  for(const [i,a] of applicants.slice(3,10).entries()) expect((await api(a,'requestRegistration',{playerId:'x'+(i+1),applicantName:'申請者',relation:'母',accessModel:'multi-device'})).notification).toBeTruthy()
  const throttled=await api(applicants[10]!,'requestRegistration',{playerId:'x9',applicantName:'申請者',relation:'母',accessModel:'multi-device'})
  expect(throttled.notification).toBeUndefined()
  expect((await db.query("select count(*)::int n from re_registration_requests where notification_status='throttled'")).rows).toEqual([{n:1}])
  for(let i=0;i<5;i++) await api(outsider,'registerPlayer',{name:'登録 '+i})
  await expect(api(outsider,'registerPlayer',{name:'登録 6'})).rejects.toThrow('RATE_LIMITED')
  expect((await api(outsider,'registerPlayer',{name:'登録 0'})).duplicate).toBe(true)
})
it('changing the admin password ends every admin session; only the new password signs in',async()=>{
  await login() // coach session with the first password
  const other='a'.repeat(63)+'b'
  await api(owner,'adminLogin',{proof:adminProof,token:other}) // a second admin device
  expect((await api(owner,'getData',{},other)).admin).toBe(true)
  const newSalt='d'.repeat(64), newProof='e'.repeat(64)
  expect(await api(coach,'changeAdminPassword',{salt:newSalt,proof:newProof,currentProof:adminProof},token)).toEqual({authenticated:false})
  expect((await db.query('select count(*)::int n from private.admin_sessions')).rows).toEqual([{n:0}])
  expect((await api(owner,'getData',{},other)).admin).toBe(false)
  await expect(api(coach,'rotateTeamCode',{salt:codeSalt,proof:codeProof},token)).rejects.toThrow('UNAUTHORIZED')
  await expect(api(coach,'adminLogin',{proof:adminProof,token})).rejects.toThrow('BAD_PASSWORD')
  expect(await api(coach,'adminLogin',{proof:newProof,token})).toEqual({authenticated:true})
  expect((await api(coach,'rotateTeamCode',{salt:codeSalt,proof:codeProof},token)).snapshot.teamCode.issued).toBe(true)
})
it('initializeAdmin ends any stale session and is refused once configured',async()=>{
  await db.exec(`insert into private.admin_sessions values(repeat('f',64),'${owner}',now()+interval '1 hour')`)
  await login()
  expect((await db.query('select count(*)::int n from private.admin_sessions')).rows).toEqual([{n:1}]) // only the new one
  await expect(login()).rejects.toThrow('CONFLICT')
})
it('keeps the new tables and helpers closed to browser roles',async()=>{
  for(const role of ['anon','authenticated']) {
    for(const sql of ['select * from private.team_code','select * from private.team_members','select * from private.feature_flags','select private.bump_limit($1,$2)','select public.attendance_is_member()','select private.is_team_member($1)','select private.flag_enabled($1)'])
      await expect(asRole(role,owner,sql,sql.includes('bump')?['x','1 hour']:sql.includes('$1')?[owner]:[])).rejects.toThrow(/permission denied/)
  }
  await expect(asRole('sd_attendance_writer',owner,'select * from private.team_members')).rejects.toThrow(/permission denied/)
  expect((await asRole('sd_attendance_writer',owner,'select public.attendance_is_member() as ok')).rows).toEqual([{ok:true}])
})
