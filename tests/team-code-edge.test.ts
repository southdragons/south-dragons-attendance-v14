import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest'
import { CODE_ALPHABET, generateTeamCode, ipKeyFrom, normalizeTeamCode, rotateTeamCode, scryptProof, verifyTeamCode } from '../supabase/functions/team/teamcode'

// Edge team-code flows wired to the real SQL (PGlite) and the real scrypt parameters.
let db: PGlite
const owner='00000000-0000-4000-8000-000000000001', coach='00000000-0000-4000-8000-000000000003', viewer='00000000-0000-4000-8000-000000000004', outsider='00000000-0000-4000-8000-000000000005'
const token='a'.repeat(64)
const strip=(sql:string)=>sql.replace(/^begin;$/m,'').replace(/^commit;$/m,'')
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
  await db.query('insert into auth.users(id) values($1),($2),($3),($4)',[owner,coach,viewer,outsider])
  await db.query(`insert into public.players(id,name,owner_id) values('p1','山田 太郎',$1)`,[owner])
  await db.exec(strip(readFileSync('supabase/migrations/20260913000000_multi_device_access.sql','utf8')))
  await db.exec(strip(readFileSync('supabase/migrations/20261023000000_team_code.sql','utf8')))
})
afterEach(async()=>{await db.exec('rollback')})

async function teamApi(user:string,action:string,payload:unknown={},adminToken='') {
  await db.exec('savepoint s')
  try {
    await db.exec('set local role service_role')
    const r=await db.query<{result:any}>('select public.team_api($1,$2,$3,$4) as result',[user,action,JSON.stringify(payload),adminToken])
    await db.exec('reset role; release savepoint s')
    return r.rows[0]!.result
  } catch(e) {await db.exec('rollback to savepoint s; release savepoint s');throw e}
}
// Mirrors index.ts: rpc(user.id, name, payload, token)
const call=(user:string,adminToken='')=>(name:string,payload:Record<string,unknown>={})=>teamApi(user,name,payload,adminToken)
async function adminSession(){await teamApi(coach,'initializeAdmin',{salt:'b'.repeat(64),proof:'c'.repeat(64),token})}
async function issue(graceHours=0){return rotateTeamCode(call(coach,token),{graceHours})}
const enter=(user:string,code:unknown,extra:Record<string,unknown>={},ipKey?:string)=>verifyTeamCode(call(user),{code,...extra},ipKey)

it('generates readable 8-symbol codes from an unambiguous alphabet',()=>{
  const seen=new Set<string>()
  for(let i=0;i<500;i++) {
    const {display,canonical}=generateTeamCode()
    expect(display).toMatch(/^SD-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/)
    expect(normalizeTeamCode(display)).toBe(canonical)
    seen.add(canonical)
  }
  expect(seen.size).toBe(500)
  expect(CODE_ALPHABET).not.toMatch(/[01OIL]/)
})
it('normalizes hyphens, spaces, case and full-width input to the same secret',()=>{
  expect(normalizeTeamCode('sd-abcd-efgh')).toBe('ABCDEFGH')
  expect(normalizeTeamCode('ＳＤ－ＡＢＣＤ－ＥＦＧＨ')).toBe('ABCDEFGH')
  expect(normalizeTeamCode('abcd efgh')).toBe('ABCDEFGH')
  expect(normalizeTeamCode(undefined)).toBe('')
})
it('issues a code once to the admin and stores only salt and scrypt proof',async()=>{
  await adminSession()
  const {teamCode,snapshot}=await issue()
  expect(snapshot.teamCode).toMatchObject({issued:true,version:1,enforcement:'off'})
  const row=(await db.query<any>('select * from private.team_code')).rows[0]
  const canonical=normalizeTeamCode(teamCode)
  expect(JSON.stringify(row)).not.toContain(canonical)
  expect(row.hash).toBe(await scryptProof(canonical,row.salt))
  await expect(rotateTeamCode(call(owner),{})).rejects.toThrow('UNAUTHORIZED')
  await expect(rotateTeamCode(call(coach,token),{graceHours:25})).rejects.toThrow('BAD_REQUEST')
},30000)
it('verifies the issued code in any reasonable spelling and returns the roster',async()=>{
  await adminSession(); const {teamCode}=await issue()
  await teamApi(coach,'setTeamCodeEnforcement',{enforcement:'on'},token)
  await expect(teamApi(viewer,'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
  const ok=await enter(viewer,teamCode.toLowerCase().replace(/-/g,' '),{label:'祖母'})
  expect(ok.snapshot.players.map((p:any)=>p.id)).toEqual(['p1'])
  expect((await teamApi(viewer,'getData')).players).toHaveLength(1)
},30000)
it('answers wrong, malformed and not-yet-issued codes with the same error',async()=>{
  await expect(enter(viewer,'SD-AAAA-AAAA')).rejects.toThrow('TEAM_CODE_INVALID') // nothing issued
  await adminSession(); const {teamCode}=await issue()
  const wrong=teamCode.slice(0,-1)+(teamCode.endsWith('2')?'3':'2')
  for(const input of [wrong,'',123 as unknown as string,'x'.repeat(20)]) {
    const error=await enter(outsider,input).catch(e=>e)
    expect(error.message).toBe(typeof input==='number'?'BAD_REQUEST':'TEAM_CODE_INVALID')
  }
},60000)
it('rate-limits after five attempts and does not consume an attempt for an invalid label',async()=>{
  await adminSession(); const {teamCode}=await issue()
  await expect(enter(viewer,teamCode,{label:'x'.repeat(31)})).rejects.toThrow('BAD_REQUEST')
  for(let i=0;i<5;i++) await expect(enter(viewer,'SD-2222-2222')).rejects.toThrow('TEAM_CODE_INVALID')
  await expect(enter(viewer,teamCode)).rejects.toThrow('RATE_LIMITED')
},60000)
it('accepts the previous code during a grace period and members survive rotation',async()=>{
  await adminSession(); const first=(await issue()).teamCode
  await enter(viewer,first)
  const second=(await issue(24)).teamCode
  expect((await enter(outsider,first)).snapshot).toBeTruthy()
  expect((await enter(owner,second)).snapshot).toBeTruthy()
  await teamApi(coach,'setTeamCodeEnforcement',{enforcement:'on'},token)
  expect((await teamApi(viewer,'getData')).players).toHaveLength(1)
},60000)
it('uses an IP key only when an operator configured a verified header and HMAC key',async()=>{
  const request=new Request('https://example.test',{headers:{'x-forwarded-for':'203.0.113.7, 10.0.0.1','x-real-ip':'198.51.100.2'}})
  expect(await ipKeyFrom(request,()=>undefined)).toBeUndefined()
  expect(await ipKeyFrom(request,k=>({TEAM_CODE_IP_HEADER:'x-real-ip',TEAM_CODE_IP_HMAC_KEY:'short'} as any)[k])).toBeUndefined()
  const env=(k:string)=>({TEAM_CODE_IP_HEADER:'x-forwarded-for',TEAM_CODE_IP_HMAC_KEY:'k'.repeat(32)} as any)[k]
  const key=await ipKeyFrom(request,env)
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(key).not.toContain('203.0.113.7')
  expect(await ipKeyFrom(new Request('https://example.test',{headers:{'x-forwarded-for':'203.0.113.7'}}),env)).toBe(key)
})
it('keeps teamCodePrepare internal and returns error codes from the Edge function',()=>{
  const source=readFileSync('supabase/functions/team/index.ts','utf8')
  const actions=source.match(/const actions\s*=\s*new Set\(\[([\s\S]*?)\]\)/)![1]!
  expect(actions).toContain("'verifyTeamCode'")
  expect(actions).not.toContain("'teamCodePrepare'")
  for(const code of ['TEAM_CODE_REQUIRED','TEAM_CODE_INVALID']) expect(source).toContain(`${code}: [`)
  expect(source).toContain('...(key ? {code:key} : {})')
  // Never log the code: neither the request payload nor the generated value.
  for(const file of ['supabase/functions/team/index.ts','supabase/functions/team/teamcode.ts'])
    expect(readFileSync(file,'utf8')).not.toMatch(/console\.\w+\([^)]*(teamCode|p\.code|payload\.code|canonical|display|secret)/)
})
