import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Viewing (team code membership) and editing (player_access) are separate rights.
// A device that only entered the team code can view, but can never edit a player it has no
// player_access for. Edit rights come only from registering a new player or admin approval.
// Fictitious data only.
const strip = (sql: string) => sql.replace(/^begin;$/im, '').replace(/^commit;$/im, '')
const read = (p: string) => readFileSync(p, 'utf8')
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = id(1), mother = id(2), coach = id(3), codeOnly = id(4), stranger = id(5), lateParent = id(6)
const token = 'a'.repeat(64), SALT = '1'.repeat(64), PROOF = '2'.repeat(64)
let db: PGlite
let p1 = '', p2 = ''

async function api(user: string, action: string, payload: unknown = {}, adminToken = '') {
  await db.exec('set role service_role')
  try { return (await db.query<{ r: any }>('select public.team_api($1,$2,$3,$4) as r', [user, action, JSON.stringify(payload), adminToken])).rows[0]!.r }
  finally { await db.exec('reset role') }
}
// Attendance writes go through save_own_attendance as the signed-in user (same as the Edge Function).
async function write(user: string, player: string, status = 'absent', request: string | null = null) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  try { await db.query("select public.save_own_attendance('future',$1,$2,'',$3)", [player, status, request]) } finally { await db.exec('reset role') }
}
const enforce = (on: boolean) => api(coach, 'setTeamCodeEnforcement', { enforcement: on ? 'on' : 'off' }, token)
const enterCode = async (user: string) => { await api(user, 'teamCodePrepare'); return api(user, 'verifyTeamCode', { proof: PROOF, label: '架空' }) }
const accessRows = async (user: string) => (await db.query<{ n: number }>('select count(*)::int n from public.player_access where auth_user_id=$1', [user])).rows[0]!.n
const attendanceOf = async (player: string) => (await db.query<{ status: string }>("select status from public.attendance where event_id='future' and player_id=$1", [player])).rows[0]?.status

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
  for (const f of ['20260913000000_multi_device_access.sql', '20261019000000_attendance_reminder.sql', '20261023000000_team_code.sql']) await db.exec(strip(read(`supabase/migrations/${f}`)))
  await db.query('insert into auth.users(id) values($1),($2),($3),($4),($5),($6)', [owner, mother, coach, codeOnly, stranger, lateParent])
  await db.exec(`insert into public.events(id,event_date,title,start_time,end_time,location) values ('future',(now() at time zone 'Asia/Tokyo')::date+2,'架空練習','08:00','12:00','架空会場')`)
  await api(coach, 'initializeAdmin', { salt: 'b'.repeat(64), proof: 'c'.repeat(64), token })
  p1 = (await api(owner, 'registerPlayer', { name: '架空 一郎' })).player.id
  p2 = (await api(owner, 'registerPlayer', { name: '架空 二郎' })).player.id
  const req = await api(mother, 'requestRegistration', { playerId: p1, applicantName: '架空 花子', relation: '母', accessModel: 'multi-device' })
  await api(coach, 'reviewRegistration', { requestId: req.notification.requestId, decision: 'approved', accessModel: 'multi-device' }, token)
  await api(coach, 'rotateTeamCode', { salt: SALT, proof: PROOF }, token)
}, 60000)
afterAll(async () => { await db?.close() })

describe('a device that only entered the team code', () => {
  it('becomes a viewer, never an editor', async () => {
    await enforce(true)
    expect(await enterCode(codeOnly)).toMatchObject({ verified: true })
    expect(await accessRows(codeOnly)).toBe(0)
    const data = await api(codeOnly, 'getData')
    expect(data.players.map((p: any) => p.name).sort()).toEqual(['架空 一郎', '架空 二郎'])
    expect(data.myPlayerIds).toEqual([])
  })

  it.each([true, false])("cannot change another family's attendance (restriction %s)", async on => {
    await enforce(on)
    const before = await attendanceOf(p1)
    await expect(write(codeOnly, p1)).rejects.toThrow('FORBIDDEN')
    await expect(write(codeOnly, p2)).rejects.toThrow('FORBIDDEN')
    expect(await attendanceOf(p1)).toBe(before)
  })

  it('cannot gain edit rights by registering an existing name (any spacing) or a retired player', async () => {
    await enforce(true)
    for (const name of ['架空 一郎', '架空一郎', '架空　一郎', ' 架空  一郎 ']) {
      const r = await api(codeOnly, 'registerPlayer', { name })
      expect(r.duplicate).toBe(true)
    }
    const retired = (await api(owner, 'registerPlayer', { name: '架空 退団' })).player.id
    await api(coach, 'setPlayerActive', { playerId: retired, active: false }, token)
    expect((await api(codeOnly, 'registerPlayer', { name: '架空 退団' })).duplicate).toBe(true)
    expect(await accessRows(codeOnly)).toBe(0)
  })

  it('gets edit rights to an existing child only after admin approval', async () => {
    await enforce(true)
    const req = await api(codeOnly, 'requestRegistration', { playerId: p2, applicantName: '架空 祖母', relation: '祖父母', accessModel: 'multi-device' })
    await expect(write(codeOnly, p2)).rejects.toThrow('FORBIDDEN') // pending is not approved
    await expect(write(codeOnly, p2, 'absent', req.notification.requestId)).rejects.toThrow('APPROVAL_REQUIRED') // no pending answers
    for (const t of ['', 'f'.repeat(64)]) {
      await expect(api(codeOnly, 'reviewRegistration', { requestId: req.notification.requestId, decision: 'approved', accessModel: 'multi-device' }, t)).rejects.toThrow('UNAUTHORIZED')
    }
    expect(await accessRows(codeOnly)).toBe(0)
    await api(coach, 'reviewRegistration', { requestId: req.notification.requestId, decision: 'rejected', accessModel: 'multi-device' }, token)
    await expect(write(codeOnly, p2)).rejects.toThrow('FORBIDDEN')
  })

  it('registering a brand-new name gives rights to that new record only', async () => {
    await enforce(true)
    const variant = (await api(codeOnly, 'registerPlayer', { name: '架空 一朗' })).player.id // a typo creates a separate record
    expect(variant).not.toBe(p1)
    await write(codeOnly, variant, 'attend')
    await expect(write(codeOnly, p1)).rejects.toThrow('FORBIDDEN')
  })
})

describe('devices that already had edit rights', () => {
  it.each([true, false])('keep editing their own child and nobody else (restriction %s)', async on => {
    await enforce(on)
    await write(owner, p1, 'attend'); expect(await attendanceOf(p1)).toBe('attend')
    await write(mother, p1, 'late'); expect(await attendanceOf(p1)).toBe('late')
    await write(owner, p2, 'absent'); expect(await attendanceOf(p2)).toBe('absent')
    await expect(write(mother, p2)).rejects.toThrow('FORBIDDEN') // mother shares p1 only
  })

  it('lose editing when the admin revokes their player access, even while still a viewer', async () => {
    await enforce(true)
    const accessId = (await db.query<{ id: string }>('select id from public.player_access where auth_user_id=$1 and player_id=$2', [mother, p1])).rows[0]!.id
    await api(coach, 'revokeDeviceAccess', { accessId, accessModel: 'multi-device' }, token)
    expect((await api(mother, 'getData')).players.length).toBeGreaterThan(0) // still views
    await expect(write(mother, p1)).rejects.toThrow('FORBIDDEN')
  })

  it('cannot edit while the restriction is on and their viewer membership is revoked', async () => {
    await enforce(true)
    const member = (await db.query<{ id: string }>('select id from private.team_members where user_id=$1', [owner])).rows[0]!.id
    await api(coach, 'revokeTeamMember', { memberId: member }, token)
    expect(await accessRows(owner)).toBeGreaterThan(0) // edit rights are kept...
    await expect(write(owner, p1)).rejects.toThrow('TEAM_CODE_REQUIRED') // ...but unusable until the code is entered again
    await enterCode(owner)
    await write(owner, p1, 'attend')
  })
})

describe('no other way to edit', () => {
  it('admin "add this device" grants viewing only', async () => {
    await enforce(true)
    await api(lateParent, 'addCurrentDeviceAsMember', {}, '').catch(() => undefined) // not admin: refused
    expect((await db.query('select 1 from private.team_members where user_id=$1', [lateParent])).rows).toHaveLength(0)
    await api(coach, 'addCurrentDeviceAsMember', {}, token)
    expect(await accessRows(coach)).toBe(0)
    await expect(write(coach, p1)).rejects.toThrow('FORBIDDEN')
  })

  it('API roles have no direct table access; the only callable function is save_own_attendance', async () => {
    const tables = ['public.players', 'public.attendance', 'public.player_access', 'public.events', 'public.re_registration_requests', 'public.pending_attendance', 'private.team_members', 'private.team_code']
    for (const r of ['anon', 'authenticated']) for (const t of tables) for (const p of ['select', 'insert', 'update', 'delete']) {
      expect((await db.query<{ ok: boolean }>('select has_table_privilege($1,$2,$3) ok', [r, t, p])).rows[0]!.ok, `${r} ${p} ${t}`).toBe(false)
    }
    const fns = (await db.query<{ f: string }>(`select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))`)).rows.map(r => r.f)
    expect(fns).toEqual(['save_own_attendance(text,text,text,text,uuid)'])
  })

  it('a stranger with no code and no rights can neither view (restriction on) nor edit', async () => {
    await enforce(true)
    await expect(api(stranger, 'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
    await expect(write(stranger, p1)).rejects.toThrow('TEAM_CODE_REQUIRED')
    await enforce(false)
    await expect(write(stranger, p1)).rejects.toThrow('FORBIDDEN')
  })
})
