import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 4-F2: switching the view restriction on admits only devices of players an admin has confirmed.
// A device that registered a made-up name while the restriction was off must not read the roster.
// Legitimate families (players that existed when this ships, and players the admin confirms) keep working.
// Fictitious data only.
const strip = (sql: string) => sql.replace(/^begin;$/im, '').replace(/^commit;$/im, '')
const read = (p: string) => readFileSync(p, 'utf8')
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const BASE = ['20260913000000_multi_device_access.sql', '20261019000000_attendance_reminder.sql', '20261023000000_team_code.sql', '20261030000000_registration_guard.sql']
const GUARD = '20261031000000_member_admission.sql'
const parent = id(1), grandma = id(2), coach = id(3), faker = id(4), newcomer = id(5), mixed = id(6), viewer = id(7), revoked = id(8)
const token = 'a'.repeat(64), SALT = '1'.repeat(64), PROOF = '2'.repeat(64)

async function makeDb(withGuard: boolean) {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean default true,created_at timestamptz default now(),last_sign_in_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to public;`)
  for (const f of ['20260911000000_v14.sql', '20260911000100_import.sql', '20260912000100_writer_jwt_subject.sql']) await db.exec(read(`supabase/migrations/${f}`))
  await db.exec('revoke usage on schema auth from sd_attendance_writer')
  for (const f of BASE) await db.exec(strip(read(`supabase/migrations/${f}`)))
  await db.query('insert into auth.users(id) values($1),($2),($3),($4),($5),($6),($7),($8)', [parent, grandma, coach, faker, newcomer, mixed, viewer, revoked])
  await db.exec(`insert into public.events(id,event_date,title,start_time,end_time,location) values ('future',(now() at time zone 'Asia/Tokyo')::date+2,'架空練習','08:00','12:00','架空会場')`)
  const api = async (user: string, action: string, payload: unknown = {}, adminToken = '') => {
    await db.exec('set role service_role')
    try { return (await db.query<{ r: any }>('select public.team_api($1,$2,$3,$4) as r', [user, action, JSON.stringify(payload), adminToken])).rows[0]!.r }
    finally { await db.exec('reset role') }
  }
  await api(coach, 'initializeAdmin', { salt: 'b'.repeat(64), proof: 'c'.repeat(64), token })
  await api(coach, 'rotateTeamCode', { salt: SALT, proof: PROOF }, token)
  // Families that exist before the guard ships: a registered parent and an approved second device.
  const taro = (await api(parent, 'registerPlayer', { name: '架空 太郎', confirmed: true })).player.id
  const req = await api(grandma, 'requestRegistration', { playerId: taro, applicantName: '架空 祖母', relation: '祖父母', accessModel: 'multi-device' })
  await api(coach, 'reviewRegistration', { requestId: req.notification.requestId, playerId: taro, decision: 'approved', accessModel: 'multi-device' }, token)
  if (withGuard) await db.exec(strip(read(`supabase/migrations/${GUARD}`)))
  return { db, api, taro }
}

describe('before the fix (reproduction)', () => {
  it('a device that registered a made-up name while the restriction was off can read the roster after it is switched on', async () => {
    const { db, api } = await makeDb(false)
    try {
      await api(faker, 'registerPlayer', { name: '架空 偽物', confirmed: true })
      await api(coach, 'setTeamCodeEnforcement', { enforcement: 'on' }, token)
      const data = await api(faker, 'getData')
      expect(data.players.map((p: any) => p.name)).toContain('架空 太郎') // another family's child
      expect((await api(faker, 'listDeviceCandidates')).allowed).toBe(true)
    } finally { await db.close() }
  })
})

describe('with the fix', () => {
  let db: PGlite, api: Awaited<ReturnType<typeof makeDb>>['api'], taro = '', fake = '', fresh = '', other = ''
  const write = async (user: string, player: string, status = 'attend') => {
    await db.exec('set role authenticated')
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, role: 'authenticated' })])
    try { await db.query("select public.save_own_attendance('future',$1,$2,'',null)", [player, status]) } finally { await db.exec('reset role') }
  }
  const enforce = (on: boolean) => api(coach, 'setTeamCodeEnforcement', { enforcement: on ? 'on' : 'off' }, token)
  const verified = async (player: string) => (await db.query<{ v: string | null }>('select verified_at v from public.players where id=$1', [player])).rows[0]!.v
  const members = async () => (await db.query<{ n: number }>('select count(*)::int n from private.team_members')).rows[0]!.n

  beforeAll(async () => {
    ({ db, api, taro } = await makeDb(true))
    // After the guard ships, with the restriction still off:
    fake = (await api(faker, 'registerPlayer', { name: '架空 偽物', confirmed: true })).player.id
    fresh = (await api(newcomer, 'registerPlayer', { name: '架空 新入', confirmed: true })).player.id
    other = (await api(mixed, 'registerPlayer', { name: '架空 別人', confirmed: true })).player.id
    // `mixed` also gets approved for the confirmed player (e.g. a relative who also registered another child).
    const r = await api(mixed, 'requestRegistration', { playerId: taro, applicantName: '架空 叔父', relation: 'その他', accessModel: 'multi-device' })
    await api(coach, 'reviewRegistration', { requestId: r.notification.requestId, playerId: taro, decision: 'approved', accessModel: 'multi-device' }, token)
    await api(viewer, 'teamCodePrepare'); expect((await api(viewer, 'verifyTeamCode', { proof: PROOF, label: '架空' })).verified).toBe(true)
  }, 60000)
  afterAll(async () => { await db?.close() })

  it('confirms the players that existed when it shipped, once; later registrations stay unconfirmed', async () => {
    expect(await verified(taro)).not.toBeNull()
    for (const p of [fake, fresh, other]) expect(await verified(p)).toBeNull()
    await db.exec(strip(read(`supabase/migrations/${GUARD}`))) // re-running is harmless
    for (const p of [fake, fresh, other]) expect(await verified(p)).toBeNull()
  })

  it('the admin sees which players are unconfirmed and what switching on would do; parents do not', async () => {
    const admin = await api(coach, 'getData', {}, token)
    expect(admin.unverifiedPlayerIds.sort()).toEqual([fake, fresh, other].sort())
    // not members yet: parent, grandma, mixed (confirmed player) -> admitted; faker, newcomer -> need the code
    expect(admin.admissionPreview).toEqual({ admitted: 3, needsCode: 2 })
    const parentView = await api(parent, 'getData')
    expect(parentView.unverifiedPlayerIds).toBeUndefined()
    expect(parentView.admissionPreview).toBeUndefined()
  })

  it('switching on keeps legitimate families working', async () => {
    const before = await members()
    await enforce(true)
    expect(await members()).toBe(before + 3)
    for (const user of [parent, grandma, mixed, viewer]) expect((await api(user, 'getData')).players.length).toBeGreaterThan(0)
    await write(parent, taro, 'attend'); await write(grandma, taro, 'late'); await write(mixed, taro, 'absent')
    await write(mixed, other, 'attend') // its own (unconfirmed) child too: the device is a member
    expect((await api(parent, 'listDeviceCandidates')).allowed).toBe(true)
  })

  it('a device that only registered a name cannot read or probe the roster, nor write', async () => {
    for (const action of ['getData', 'listDeviceCandidates']) await expect(api(faker, action)).rejects.toThrow('TEAM_CODE_REQUIRED')
    await expect(api(faker, 'findPlayerForDevice', { name: '架空 太郎' })).rejects.toThrow('TEAM_CODE_REQUIRED')
    await expect(api(faker, 'registerPlayer', { name: '架空 太朗', confirmed: false })).rejects.toThrow('TEAM_CODE_REQUIRED')
    await expect(api(faker, 'requestRegistration', { playerId: taro, applicantName: '架空', relation: '父', accessModel: 'multi-device' })).rejects.toThrow('TEAM_CODE_REQUIRED')
    await expect(write(faker, fake)).rejects.toThrow('TEAM_CODE_REQUIRED')
  })

  it('switching off and on again admits nobody new', async () => {
    const before = await members()
    await enforce(false); await enforce(true)
    expect(await members()).toBe(before)
    await expect(api(faker, 'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
  })

  it('only an admin can confirm a player; unknown players are not found', async () => {
    await expect(api(parent, 'verifyPlayer', { playerId: fresh })).rejects.toThrow('UNAUTHORIZED')
    await expect(api(coach, 'verifyPlayer', { playerId: 'no-such-player' }, token)).rejects.toThrow('NOT_FOUND')
    expect(await verified(fresh)).toBeNull()
  })

  it('confirming a real newcomer admits its device right away while the restriction is on', async () => {
    await expect(api(newcomer, 'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
    await api(coach, 'verifyPlayer', { playerId: fresh }, token)
    const at = await verified(fresh)
    expect(at).not.toBeNull()
    expect((await api(newcomer, 'getData')).myPlayerIds).toEqual([fresh])
    await write(newcomer, fresh, 'attend')
    await api(coach, 'verifyPlayer', { playerId: fresh }, token) // idempotent: keeps the first time
    expect(await verified(fresh)).toEqual(at)
    await expect(api(faker, 'getData')).rejects.toThrow('TEAM_CODE_REQUIRED') // still not the made-up one
  })

  it('a revoked viewer is not readmitted by confirming a player', async () => {
    await db.query("insert into private.team_members(user_id,method,revoked_at) values($1,'existing_access',now())", [revoked])
    await db.query('insert into public.player_access(player_id,auth_user_id) values($1,$2)', [taro, revoked])
    await api(coach, 'verifyPlayer', { playerId: taro }, token)
    await enforce(false); await enforce(true)
    await expect(api(revoked, 'getData')).rejects.toThrow('TEAM_CODE_REQUIRED')
  })

  it('a registered device can still get in the normal way: by entering the team code', async () => {
    await api(faker, 'teamCodePrepare')
    expect((await api(faker, 'verifyTeamCode', { proof: PROOF, label: '架空' })).verified).toBe(true)
    expect((await api(faker, 'getData')).players.length).toBeGreaterThan(0)
  })

  it('confirming while the restriction is off admits the device at switch-on', async () => {
    await enforce(false)
    const late = id(9)
    await db.query('insert into auth.users(id) values($1)', [late])
    const p = (await api(late, 'registerPlayer', { name: '架空 後日', confirmed: true })).player.id
    await api(coach, 'verifyPlayer', { playerId: p }, token)
    expect(await db.query('select 1 from private.team_members where user_id=$1', [late]).then(r => r.rows.length)).toBe(0) // nothing yet while off
    await enforce(true)
    expect((await api(late, 'getData')).myPlayerIds).toEqual([p])
  })
})

describe('rollback', () => {
  it('restores the previous functions exactly and changes no data', async () => {
    const down = read('supabase/rollback/20261031000000_member_admission_down.sql')
    const tc = read('supabase/migrations/20261023000000_team_code.sql'), guard = read('supabase/migrations/20261030000000_registration_guard.sql')
    const fn = (s: string, name: string) => { const a = s.indexOf(`create or replace function ${name}`); return s.slice(a, s.indexOf('$$;', s.indexOf('$$', s.indexOf('$$', a) + 2)) + 3) }
    expect(fn(down, 'private.backfill_team_members()')).toBe(fn(tc, 'private.backfill_team_members()'))
    expect(fn(down, 'private.team_code_admin(actor uuid)')).toBe(fn(tc, 'private.team_code_admin(actor uuid)'))
    const api = (s: string) => s.slice(s.indexOf('create or replace function public.team_api('), s.indexOf('grant execute on function public.team_api(uuid,text,jsonb,text) to service_role;'))
    expect(api(down)).toBe(api(guard))
    const { db, api: call } = await makeDb(true)
    try {
      const n = async () => (await db.query<{ n: number }>("select (select count(*) from public.players)+(select count(*) from public.player_access)+(select count(*) from private.team_members) n")).rows[0]!.n
      const before = await n()
      await db.exec(strip(down))
      expect(await n()).toBe(before)
      await expect(call(coach, 'verifyPlayer', { playerId: 'x' }, token)).rejects.toThrow('BAD_REQUEST') // action gone
    } finally { await db.close() }
  })
})
