import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'

// Rollback of the team code migration: functions return to the previous release, no data is lost,
// and re-applying the migration restores the feature (switched off). Fictitious data only.
const strip = (sql: string) => sql.replace(/^begin;$/im, '').replace(/^commit;$/im, '')
const read = (p: string) => readFileSync(p, 'utf8')
const owner = '00000000-0000-4000-8000-000000000001', mother = '00000000-0000-4000-8000-000000000002', coach = '00000000-0000-4000-8000-000000000003', viewer = '00000000-0000-4000-8000-000000000004', outsider = '00000000-0000-4000-8000-000000000005'
const token = 'a'.repeat(64)
let db: PGlite
async function api(user: string, action: string, payload: unknown = {}, adminToken = '') {
  await db.exec('set role service_role')
  try { return (await db.query<{ r: any }>('select public.team_api($1,$2,$3,$4) as r', [user, action, JSON.stringify(payload), adminToken])).rows[0]!.r }
  finally { await db.exec('reset role') }
}
async function write(user: string, player: string, status: string) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  try { await db.query("select public.save_own_attendance('future',$1,$2,'',null)", [player, status]) } finally { await db.exec('reset role') }
}
const TABLES = ['public.players', 'public.events', 'public.attendance', 'public.player_access', 'public.re_registration_requests', 'public.pending_attendance', 'public.settings', 'private.admin_sessions', 'private.rate_limits', 'private.team_members', 'public.attendance_reminder_deliveries']
async function dump() {
  const out: Record<string, unknown> = {}
  for (const t of TABLES) out[t] = (await db.query(`select to_jsonb(x) j from ${t} x order by 1`)).rows.map((r: any) => JSON.stringify(r.j)).sort()
  out['private.team_code'] = (await db.query('select version, salt, hash, previous_hash from private.team_code')).rows
  out['user_activity'] = (await db.query('select user_id, cleanup_pending from private.user_activity order by 1')).rows
  return out
}
const fnSource = async (sig: string) => (await db.query<{ s: string }>(`select pg_get_functiondef('${sig}'::regprocedure) s`)).rows[0]!.s

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean default true,created_at timestamptz default now(),last_sign_in_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to public;`)
  for (const f of ['20260911000000_v14.sql', '20260911000100_import.sql', '20260912000100_writer_jwt_subject.sql']) await db.exec(read(`supabase/migrations/${f}`))
  await db.exec('revoke usage on schema auth from sd_attendance_writer')
  await db.query('insert into auth.users(id) values($1),($2),($3),($4),($5)', [owner, mother, coach, viewer, outsider])
  await db.exec(`insert into public.events(id,event_date,title,start_time,end_time,location) values ('future',(now() at time zone 'Asia/Tokyo')::date+2,'架空練習','08:00','12:00','架空会場')`)
  await db.exec(strip(read('supabase/migrations/20260913000000_multi_device_access.sql')))
  await db.exec(strip(read('supabase/migrations/20261019000000_attendance_reminder.sql')))
  await db.exec(strip(read('supabase/migrations/20261023000000_team_code.sql')))
  // Build a realistic state with every feature in use.
  await api(coach, 'initializeAdmin', { salt: 'b'.repeat(64), proof: 'c'.repeat(64), token })
  const p1 = (await api(owner, 'registerPlayer', { name: '架空 一郎' })).player.id
  await api(owner, 'registerPlayer', { name: '架空 二郎' })
  await write(owner, p1, 'attend')
  await api(coach, 'rotateTeamCode', { salt: '1'.repeat(64), proof: '2'.repeat(64) }, token)
  await api(coach, 'setFeatureFlag', { name: 'abuse_limits', enabled: true }, token)
  await api(coach, 'setTeamCodeEnforcement', { enforcement: 'on' }, token)
  for (const u of [mother, viewer]) { await api(u, 'teamCodePrepare'); await api(u, 'verifyTeamCode', { proof: '2'.repeat(64), label: '架空' }) }
  const req = await api(mother, 'requestRegistration', { playerId: p1, applicantName: '架空 花子', relation: '母', accessModel: 'multi-device' })
  await api(coach, 'reviewRegistration', { requestId: req.notification.requestId, decision: 'approved', accessModel: 'multi-device' }, token)
  await write(mother, p1, 'absent')
  await db.exec(`insert into public.re_registration_requests(player_id,new_owner_id,applicant_name,relation,notification_status) values('${p1}','${outsider}','架空','父','throttled')`)
  await db.exec(`insert into public.attendance_reminder_deliveries(target_date,destination,state) values ('2026-12-05','test','sent')`)
}, 60000)
afterAll(async () => { await db?.close() })

it('rolls back the functions without losing or changing any data; only the switches turn off', async () => {
  const before = await dump()
  expect((await db.query('select enforcement from private.team_code')).rows).toEqual([{ enforcement: 'on' }])
  await db.exec(read('supabase/rollback/20261023000000_team_code_down.sql'))
  expect(await dump()).toEqual(before)
  expect((await db.query('select enforcement from private.team_code')).rows).toEqual([{ enforcement: 'off' }])
  expect((await db.query('select enabled from private.feature_flags')).rows).toEqual([{ enabled: false }])
  // functions are the previous ones
  expect(await fnSource('public.team_api(uuid,text,jsonb,text)')).not.toContain('TEAM_CODE_REQUIRED')
  expect(await fnSource('public.save_own_attendance(text,text,text,text,uuid)')).not.toContain('attendance_is_member')
  expect(await fnSource('private.snapshot(uuid,boolean)')).not.toContain('team_code_admin')
  expect((await db.query("select pg_get_userbyid(proowner) o, prosecdef d from pg_proc where oid='public.save_own_attendance(text,text,text,text,uuid)'::regprocedure")).rows).toEqual([{ o: 'sd_attendance_writer', d: true }])
  await db.exec(read('supabase/rollback/20261023000000_team_code_down.sql')) // safe to repeat
  expect(await dump()).toEqual(before)
})

it('after rollback the previous flows work for everyone, including former non-members', async () => {
  const data = await api(outsider, 'getData')
  expect(data.players.map((p: any) => p.name).sort()).toEqual(['架空 一郎', '架空 二郎'])
  expect(data).not.toHaveProperty('teamCode')
  const p1 = data.players.find((p: any) => p.name === '架空 一郎').id
  await write(mother, p1, 'attend') // family sharing kept
  await expect(write(outsider, p1, 'absent')).rejects.toThrow('FORBIDDEN')
  await expect(api(outsider, 'verifyTeamCode', { proof: '2'.repeat(64) })).rejects.toThrow('UNAUTHORIZED') // new actions are gone (previous release: unknown action = admin only)
  const p3 = (await api(outsider, 'registerPlayer', { name: '架空 三郎' })).player.id
  expect((await api(outsider, 'getData')).myPlayerIds).toEqual([p3])
  const admin = await api(coach, 'getData', {}, token) // admin session survived
  expect(admin.admin).toBe(true)
  expect(admin).not.toHaveProperty('teamMembers')
  expect(await api(coach, 'changeAdminPassword', { salt: 'd'.repeat(64), proof: 'e'.repeat(64), currentProof: 'c'.repeat(64) }, token)).toEqual({ authenticated: false })
  expect(await api(coach, 'adminLogin', { proof: 'e'.repeat(64), token })).toEqual({ authenticated: true })
})

it('re-applying the migration restores the feature with previous members and code, switched off', async () => {
  const members = async () => (await db.query<{ user_id: string }>('select user_id from private.team_members where revoked_at is null order by 1')).rows.map(r => r.user_id)
  const before = await members()
  expect(before).not.toContain(outsider)
  await db.exec(strip(read('supabase/migrations/20261023000000_team_code.sql')))
  // Everyone kept; plus the device that gained edit rights during the rollback window (migration backfill).
  expect(await members()).toEqual([...before, outsider].sort())
  expect((await db.query('select version, enforcement from private.team_code')).rows).toEqual([{ version: 1, enforcement: 'off' }])
  await api(coach, 'setTeamCodeEnforcement', { enforcement: 'on' }, token)
  // A device that registered a player during the rollback window can edit, so enabling backfills it as a member.
  expect((await api(outsider, 'getData')).players.length).toBe(3)
  expect((await api(viewer, 'getData')).players.length).toBe(3) // code member from before the rollback
  const stranger = '00000000-0000-4000-8000-000000000006'
  await db.query('insert into auth.users(id) values($1)', [stranger])
  await expect(api(stranger, 'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
})
