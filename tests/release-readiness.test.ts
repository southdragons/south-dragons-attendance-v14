import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Release rehearsal for Phase 4-F (registration guard) and 4-F2 (member admission), in the production order,
// starting from a production-like database built with the CURRENT release (up to 20261023000000_team_code.sql)
// and the payloads of the CURRENT screens. Fictitious data only.
const strip = (sql: string) => sql.replace(/^begin;$/im, '').replace(/^commit;$/im, '')
const read = (p: string) => readFileSync(p, 'utf8')
const F = strip(read('supabase/migrations/20261030000000_registration_guard.sql'))
const F2 = strip(read('supabase/migrations/20261031000000_member_admission.sql'))
const F_DOWN = strip(read('supabase/rollback/20261030000000_registration_guard_down.sql'))
const F2_DOWN = strip(read('supabase/rollback/20261031000000_member_admission_down.sql'))
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const U = { coach: id(1), p1: id(2), p2: id(3), p3: id(4), p4: id(5), grandma: id(6), codeViewer: id(7), revokedViewer: id(8), lostDevice: id(9), retiredFamily: id(10), pending: id(11), later1: id(12), later2: id(13) }
const token = 'a'.repeat(64), SALT = '1'.repeat(64), PROOF = '2'.repeat(64)
let db: PGlite
const players: Record<string, string> = {}
let pendingRequestId = ''

async function api(user: string, action: string, payload: unknown = {}, adminToken = '') {
  await db.exec('set role service_role')
  try { return (await db.query<{ r: any }>('select public.team_api($1,$2,$3,$4) as r', [user, action, JSON.stringify(payload), adminToken])).rows[0]!.r }
  finally { await db.exec('reset role') }
}
async function write(user: string, player: string, status = 'attend') {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  try { await db.query("select public.save_own_attendance('future',$1,$2,'',null)", [player, status]) } finally { await db.exec('reset role') }
}
const one = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0] as T
// Fingerprints of the data a release must never change (players without the new column).
async function fingerprint() {
  const q = (sql: string) => one<{ h: string }>(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) h from (${sql}) t`).then(r => r.h)
  return {
    players: await q('select id,name,active,created_at,retired_at,owner_id from public.players'),
    access: await q('select id,player_id,auth_user_id,applicant_name,relation,active,granted_at,revoked_at from public.player_access'),
    attendance: await q('select event_id,player_id,status,comment,updated_at from public.attendance'),
    events: await q('select * from public.events'),
    requests: await q('select * from public.re_registration_requests'),
    members: await q('select id,user_id,method,code_version,label,verified_at,revoked_at from private.team_members'),
    settings: await q('select * from public.settings'),
    code: await q('select version,salt,hash,enforcement from private.team_code'),
  }
}
const isMember = async (user: string) => (await one<{ n: number }>('select count(*)::int n from private.team_members where user_id=$1 and revoked_at is null', [user])).n === 1

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean default true,created_at timestamptz default now(),last_sign_in_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to public;`)
  for (const f of ['20260911000000_v14.sql', '20260911000100_import.sql', '20260912000100_writer_jwt_subject.sql']) await db.exec(read(`supabase/migrations/${f}`))
  await db.exec('revoke usage on schema auth from sd_attendance_writer')
  for (const f of ['20260913000000_multi_device_access.sql', '20261019000000_attendance_reminder.sql', '20261023000000_team_code.sql']) await db.exec(strip(read(`supabase/migrations/${f}`)))
  await db.query(`insert into auth.users(id) select unnest($1::uuid[])`, [Object.values(U)])
  await db.exec(`insert into public.events(id,event_date,title,start_time,end_time,location) values
    ('future',(now() at time zone 'Asia/Tokyo')::date+2,'架空練習','08:00','12:00','架空会場'),
    ('past',(now() at time zone 'Asia/Tokyo')::date-7,'架空試合','08:00','12:00','架空会場')`)
  // --- Production today, built with the current screens' payloads (no `confirmed`, no `playerId` on review).
  await api(U.coach, 'initializeAdmin', { salt: 'b'.repeat(64), proof: 'c'.repeat(64), token })
  await api(U.coach, 'rotateTeamCode', { salt: SALT, proof: PROOF }, token)
  const owners: [string, string][] = [[U.p1, '架空 一郎'], [U.p1, '架空 一子'], [U.p2, '架空 二郎'], [U.p3, '架空 三郎'], [U.p4, '架空 四郎'], [U.lostDevice, '架空 五郎'], [U.retiredFamily, '架空 退団']]
  for (const [user, name] of owners) players[name] = (await api(user, 'registerPlayer', { name })).player.id
  expect(Object.keys(players)).toHaveLength(7)
  await api(U.coach, 'setPlayerActive', { playerId: players['架空 退団'], active: false }, token)
  // Approved second device (grandma), a device whose access was revoked (lost phone), a code viewer, a revoked viewer.
  const g = await api(U.grandma, 'requestRegistration', { playerId: players['架空 一郎'], applicantName: '架空 祖母', relation: '祖父母', accessModel: 'multi-device' })
  await api(U.coach, 'reviewRegistration', { requestId: g.notification.requestId, decision: 'approved', accessModel: 'multi-device' }, token)
  const lost = (await one<{ id: string }>('select id from public.player_access where auth_user_id=$1', [U.lostDevice])).id
  await api(U.coach, 'revokeDeviceAccess', { accessId: lost, accessModel: 'multi-device' }, token)
  await api(U.codeViewer, 'teamCodePrepare'); await api(U.codeViewer, 'verifyTeamCode', { proof: PROOF, label: '架空' })
  await api(U.revokedViewer, 'teamCodePrepare'); await api(U.revokedViewer, 'verifyTeamCode', { proof: PROOF, label: '架空' })
  const rv = (await one<{ id: string }>('select id from private.team_members where user_id=$1', [U.revokedViewer])).id
  await api(U.coach, 'revokeTeamMember', { memberId: rv }, token)
  await db.query("insert into private.team_members(user_id,method) values($1,'existing_access') on conflict do nothing", [U.p1]) // backfilled earlier (10/28)
  // The long-standing pending request (stands in for the 9/15 one): must stay pending and untouched.
  const pr = await api(U.pending, 'requestRegistration', { playerId: players['架空 二郎'], applicantName: '架空 保留', relation: '母', accessModel: 'multi-device' })
  pendingRequestId = pr.notification.requestId
  await db.query("update public.re_registration_requests set notification_status='sent' where request_id=$1", [pendingRequestId])
  await write(U.p1, players['架空 一郎']!, 'attend'); await write(U.p2, players['架空 二郎']!, 'absent')
}, 60000)
afterAll(async () => { await db?.close() })

describe('release rehearsal', () => {
  let before: Awaited<ReturnType<typeof fingerprint>>

  it('4-F2 refuses to run before 4-F and changes nothing', async () => {
    before = await fingerprint()
    await expect(db.exec(F2)).rejects.toThrow('APPLY_20261030000000_REGISTRATION_GUARD_FIRST')
    expect(await fingerprint()).toEqual(before)
    expect((await one<{ n: number }>("select count(*)::int n from information_schema.columns where table_name='players' and column_name='verified_at'")).n).toBe(0)
  })

  it('after 4-F SQL (Edge/Pages not yet updated): no data changes; current screens keep viewing, requesting and saving', async () => {
    await db.exec(F)
    expect(await fingerprint()).toEqual(before)
    expect((await api(U.p3, 'getData')).players.length).toBeGreaterThan(0)
    await write(U.p3, players['架空 三郎']!, 'late')
    const r = await api(U.later1, 'requestRegistration', { playerId: players['架空 三郎'], applicantName: '架空 祖父', relation: '祖父母', accessModel: 'multi-device' })
    expect(Object.keys(r.notification).sort()).toEqual(['accessModel', 'applicantName', 'playerName', 'relation', 'requestId', 'requestedAt']) // LINE payload unchanged
    // Only registration and approval from an old screen ask for a reload; nothing is created or approved.
    await expect(api(U.later2, 'registerPlayer', { name: '架空 新顔' })).rejects.toThrow('CLIENT_UPDATE_REQUIRED')
    await expect(api(U.coach, 'reviewRegistration', { requestId: r.notification.requestId, decision: 'approved', accessModel: 'multi-device' }, token)).rejects.toThrow('CLIENT_UPDATE_REQUIRED')
    expect((await one<{ s: string }>('select status s from public.re_registration_requests where request_id=$1', [r.notification.requestId])).s).toBe('pending')
    await api(U.coach, 'reviewRegistration', { requestId: r.notification.requestId, playerId: players['架空 三郎'], decision: 'rejected', accessModel: 'multi-device' }, token)
    before = await fingerprint()
  })

  it('4-F2 confirms exactly the 7 existing players and grants nothing by itself', async () => {
    await db.exec(F2)
    expect(await fingerprint()).toEqual(before)
    expect((await one<{ n: number }>('select count(*)::int n from public.players where verified_at is not null')).n).toBe(7)
    const preview = (await api(U.coach, 'getData', {}, token)).admissionPreview
    // Not members yet with an active player: p2, p3, p4, grandma (p1 already a member; lostDevice revoked; retiredFamily retired only).
    expect(preview).toEqual({ admitted: 4, needsCode: 1 }) // needsCode: retiredFamily (its only player has left)
    expect(await isMember(U.p2)).toBe(false)
  })

  it('switching on: every existing member stays, legitimate editors are admitted, nobody else', async () => {
    await api(U.coach, 'setTeamCodeEnforcement', { enforcement: 'on' }, token)
    for (const u of [U.p1, U.codeViewer, U.p2, U.p3, U.p4, U.grandma]) expect(await isMember(u), u).toBe(true)
    for (const u of [U.revokedViewer, U.lostDevice, U.retiredFamily, U.pending, U.later2]) expect(await isMember(u), u).toBe(false)
    await write(U.grandma, players['架空 一郎']!, 'late'); await write(U.p4, players['架空 四郎']!, 'attend')
    await expect(write(U.lostDevice, players['架空 五郎']!)).rejects.toThrow('TEAM_CODE_REQUIRED')
    const pending = await one<any>('select status, notification_status, reviewed_at from public.re_registration_requests where request_id=$1', [pendingRequestId])
    expect(pending).toEqual({ status: 'pending', notification_status: 'sent', reviewed_at: null })
  })

  it('a newly registered player with two family devices: neither is admitted until the admin confirms; then both are', async () => {
    await api(U.coach, 'setTeamCodeEnforcement', { enforcement: 'off' }, token)
    const kid = (await api(U.later1, 'registerPlayer', { name: '架空 新入生', confirmed: true })).player.id
    const r = await api(U.later2, 'requestRegistration', { playerId: kid, applicantName: '架空 母', relation: '母', accessModel: 'multi-device' })
    await api(U.coach, 'reviewRegistration', { requestId: r.notification.requestId, playerId: kid, decision: 'approved', accessModel: 'multi-device' }, token)
    await api(U.coach, 'setTeamCodeEnforcement', { enforcement: 'on' }, token)
    for (const u of [U.later1, U.later2]) await expect(api(u, 'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
    // Revoke one device first: confirming must admit only devices that still have active edit rights.
    const access = (await one<{ id: string }>('select id from public.player_access where auth_user_id=$1 and player_id=$2', [U.later2, kid])).id
    await api(U.coach, 'revokeDeviceAccess', { accessId: access, accessModel: 'multi-device' }, token)
    await api(U.coach, 'verifyPlayer', { playerId: kid }, token)
    expect(await isMember(U.later1)).toBe(true)
    expect(await isMember(U.later2)).toBe(false)
    expect(await isMember(U.lostDevice)).toBe(false) // confirming one player never admits unrelated devices
  })

  it('rolling back 4-F2 then 4-F loses no viewing, editing or attendance; the current screens work again', async () => {
    const mid = await fingerprint()
    const editors = (await one<{ n: number }>('select count(*)::int n from public.player_access where active')).n
    const members = (await one<{ n: number }>('select count(*)::int n from private.team_members where revoked_at is null')).n
    await db.exec(F2_DOWN)
    await db.exec(F_DOWN)
    expect(await fingerprint()).toEqual(mid)
    expect((await one<{ n: number }>('select count(*)::int n from public.player_access where active')).n).toBe(editors)
    expect((await one<{ n: number }>('select count(*)::int n from private.team_members where revoked_at is null')).n).toBe(members)
    await write(U.p1, players['架空 一郎']!, 'absent')
    expect((await api(U.codeViewer, 'getData')).players.length).toBeGreaterThan(0)
    const old = await api(U.p2, 'registerPlayer', { name: '架空 復旧後' }) // the previous behaviour, as before the release
    expect(old.duplicate).toBe(false)
    expect((await one<any>('select status from public.re_registration_requests where request_id=$1', [pendingRequestId])).status).toBe('pending')
  })
})
