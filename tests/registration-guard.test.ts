import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { keysSimilar, nameKey } from '../app/utils/names'

// Phase 4-F: confirmed registration, similar-name warnings, roster picker limited to team-code devices,
// and approvals checked against the player the screen showed. Fictitious data only.
const strip = (sql: string) => sql.replace(/^begin;$/im, '').replace(/^commit;$/im, '')
const read = (p: string) => readFileSync(p, 'utf8')
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const parent = id(1), member = id(2), stranger = id(3), coach = id(4), grandma = id(5), aunt = id(6), sibling = id(7), outsider = id(8)
const token = 'a'.repeat(64), SALT = '1'.repeat(64), PROOF = '2'.repeat(64)
let db: PGlite
let taro = '', jiro = '', retired = ''

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
const count = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params)).rows[0]!.n
const players = () => count('select count(*)::int n from public.players')
const accessOf = (user: string, player: string) => count('select count(*)::int n from public.player_access where auth_user_id=$1 and player_id=$2 and active', [user, player])
const enforce = (on: boolean) => api(coach, 'setTeamCodeEnforcement', { enforcement: on ? 'on' : 'off' }, token)
const enterCode = async (user: string) => { await api(user, 'teamCodePrepare'); return api(user, 'verifyTeamCode', { proof: PROOF, label: '架空' }) }
const withoutSnapshot = (r: any) => { const { snapshot, ...rest } = r; return rest }
const request = (user: string, player: string, applicantName = '架空 申請者') =>
  api(user, 'requestRegistration', { playerId: player, applicantName, relation: '母', accessModel: 'multi-device' })
const review = (requestId: string, playerId: string, decision: 'approved' | 'rejected') =>
  api(coach, 'reviewRegistration', { requestId, playerId, decision, accessModel: 'multi-device' }, token)

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
  for (const f of ['20260913000000_multi_device_access.sql', '20261019000000_attendance_reminder.sql', '20261023000000_team_code.sql', '20261030000000_registration_guard.sql'])
    await db.exec(strip(read(`supabase/migrations/${f}`)))
  await db.query('insert into auth.users(id) values($1),($2),($3),($4),($5),($6),($7),($8)', [parent, member, stranger, coach, grandma, aunt, sibling, outsider])
  await db.exec(`insert into public.events(id,event_date,title,start_time,end_time,location) values ('future',(now() at time zone 'Asia/Tokyo')::date+2,'架空練習','08:00','12:00','架空会場')`)
  await api(coach, 'initializeAdmin', { salt: 'b'.repeat(64), proof: 'c'.repeat(64), token })
  await api(coach, 'rotateTeamCode', { salt: SALT, proof: PROOF }, token)
  taro = (await api(parent, 'registerPlayer', { name: '架空 太郎', confirmed: true })).player.id
  retired = (await api(parent, 'registerPlayer', { name: '架空 退団', confirmed: true })).player.id
  await api(coach, 'setPlayerActive', { playerId: retired, active: false }, token)
  expect((await enterCode(member)).verified).toBe(true)
}, 60000)
afterAll(async () => { await db?.close() })
beforeEach(async () => { await enforce(false) })

describe('the comparison key matches between the screen and the database', () => {
  const samples = ['架空 太郎', '架空　太郎', 'ｶｸｳ ﾀﾛｳ', 'カクウ タロウ', 'かくう たろう', 'ＴＡＲＯ', 'taro', '架空・太郎', '架空-太郎', 'カクウ・タロー', '架空太朗', '鈴木 花子', '']
  it.each(samples)('name_key(%s)', async s => {
    expect((await db.query<{ k: string }>('select private.name_key($1) k', [s])).rows[0]!.k).toBe(nameKey(s))
  })
  it('names_similar agrees with keysSimilar for every pair', async () => {
    for (const a of samples) for (const b of samples) {
      const sql = (await db.query<{ s: boolean }>('select private.names_similar(private.name_key($1),private.name_key($2)) s', [a, b])).rows[0]!.s
      expect(sql, `${a} / ${b}`).toBe(keysSimilar(nameKey(a), nameKey(b)))
    }
  })
  it('folds width, kana and separators; one-character typos are similar; different names are not', () => {
    expect(nameKey('ｶｸｳ ﾀﾛｳ')).toBe(nameKey('かくう たろう'))
    expect(nameKey('ＴＡＲＯ')).toBe('taro')
    expect(keysSimilar(nameKey('架空 太郎'), nameKey('架空 太朗'))).toBe(true)
    expect(keysSimilar(nameKey('架空 太郎'), nameKey('架空'))).toBe(true)
    expect(keysSimilar(nameKey('架空 太郎'), nameKey('鈴木 花子'))).toBe(false)
  })
})

describe('new player registration', () => {
  it('old screens without `confirmed` are asked to reload and nothing is created', async () => {
    const before = await players()
    await expect(api(stranger, 'registerPlayer', { name: '架空 新人' })).rejects.toThrow('CLIENT_UPDATE_REQUIRED')
    await expect(api(stranger, 'registerPlayer', { name: '架空 新人', confirmed: 'yes' })).rejects.toThrow('CLIENT_UPDATE_REQUIRED')
    expect(await players()).toBe(before)
  })

  it('the check step never creates a player; only the confirmed call does', async () => {
    const before = await players()
    const check = await api(stranger, 'registerPlayer', { name: '架空 新人', confirmed: false })
    expect(check).toMatchObject({ duplicate: false, needsConfirmation: true })
    expect(await players()).toBe(before)
    const created = await api(stranger, 'registerPlayer', { name: '架空 新人', confirmed: true })
    expect(created).toMatchObject({ duplicate: false, player: { name: '架空 新人' } })
    expect(await players()).toBe(before + 1)
    expect(await accessOf(stranger, created.player.id)).toBe(1)
  })

  it.each(['架空 太郎', '架空太郎', '架空　太郎', ' 架空  太郎 '])('an exact match (%s) is a duplicate even when confirmed', async name => {
    const before = await players()
    for (const confirmed of [false, true]) {
      const r = await api(stranger, 'registerPlayer', { name, confirmed })
      expect(r).toMatchObject({ duplicate: true, player: { id: taro } })
    }
    expect(await players()).toBe(before)
    expect(await accessOf(stranger, taro)).toBe(0)
  })

  it.each(['ｶｸｳ ﾀﾛｳ', '架空 太朗', '架空', '架空・太郎'])('a similar name (%s) is listed for a team-code device', async name => {
    if (name === 'ｶｸｳ ﾀﾛｳ') await api(parent, 'registerPlayer', { name: 'カクウ タロウ', confirmed: true })
    const r = await api(member, 'registerPlayer', { name, confirmed: false })
    expect(r.similarVisible).toBe(true)
    expect(r.similar.length).toBeGreaterThan(0)
    expect(r.similar.every((p: any) => Object.keys(p).sort().join() === 'id,name')).toBe(true)
  })

  it('a device without the team code gets the same answer whether or not a similar name exists', async () => {
    const near = withoutSnapshot(await api(stranger, 'registerPlayer', { name: '架空 太朗', confirmed: false }))
    const far = withoutSnapshot(await api(stranger, 'registerPlayer', { name: '鈴木 花子', confirmed: false }))
    expect(near).toEqual({ duplicate: false, needsConfirmation: true, similarVisible: false, similar: [] })
    expect(far).toEqual(near)
  })

  it('a different name has no similar names, and retired players are never listed as similar', async () => {
    const r = await api(member, 'registerPlayer', { name: '鈴木 花子', confirmed: false })
    expect(r.similar).toEqual([])
    const r2 = await api(member, 'registerPlayer', { name: '架空 退団者', confirmed: false })
    expect(r2.similar.map((p: any) => p.id)).not.toContain(retired)
  })

  it('a sibling with a near-identical name is warned about but can still be registered', async () => {
    const warn = await api(member, 'registerPlayer', { name: '架空 次郎', confirmed: false })
    expect(warn.similar.map((p: any) => p.id)).toContain(taro)
    jiro = (await api(sibling, 'registerPlayer', { name: '架空 次郎', confirmed: true })).player.id
    expect(jiro).not.toBe(taro)
    expect(await accessOf(sibling, jiro)).toBe(1)
    expect(await accessOf(sibling, taro)).toBe(0)
  })

  it('admins see similar names too', async () => {
    const r = await api(coach, 'registerPlayer', { name: '架空 太朗', confirmed: false }, token)
    expect(r.similarVisible).toBe(true)
    expect(r.similar.map((p: any) => p.id)).toContain(taro)
  })
})

describe('picking a registered player for a device', () => {
  it('a device without the team code gets no roster (restriction off)', async () => {
    const r = await api(stranger, 'listDeviceCandidates')
    expect(r).toEqual({ allowed: false })
  })

  it('edit rights alone (a self-registered name) do not unlock the roster', async () => {
    expect(await count('select count(*)::int n from public.player_access where auth_user_id=$1 and active', [stranger])).toBeGreaterThan(0)
    expect(await api(stranger, 'listDeviceCandidates')).toEqual({ allowed: false })
  })

  it.each([false, true])('a team-code device sees active players with its own flags (restriction %s)', async on => {
    await enforce(on)
    const r = await api(member, 'listDeviceCandidates')
    expect(r.allowed).toBe(true)
    const ids = r.players.map((p: any) => p.id)
    expect(ids).toContain(taro)
    expect(ids).not.toContain(retired)
    expect(Object.keys(r.players[0]).sort().join()).toBe('id,mine,name,pending')
    expect(r.snapshot).toBeUndefined()
  })

  it('with the restriction on, a device without the code is stopped by the team code gate', async () => {
    await enforce(true)
    await expect(api(outsider, 'listDeviceCandidates')).rejects.toThrow('TEAM_CODE_REQUIRED')
    await expect(api(outsider, 'findPlayerForDevice', { name: '架空 太郎' })).rejects.toThrow('TEAM_CODE_REQUIRED')
    await expect(api(outsider, 'registerPlayer', { name: '架空 太朗', confirmed: false })).rejects.toThrow('TEAM_CODE_REQUIRED')
  })

  // State after Phase 4-F alone (this file does not load 20261031000000_member_admission.sql): switching the
  // restriction on makes every device with edit rights a member. Fixed in Phase 4-F2; see member-admission.test.ts.
  it('documents: switching the restriction on admits devices that already had edit rights', async () => {
    await enforce(true)
    expect((await api(stranger, 'listDeviceCandidates')).allowed).toBe(true)
    expect(await count("select count(*)::int n from private.team_members where user_id=$1 and method='existing_access'", [stranger])).toBe(1)
  })

  it('admins may pick', async () => {
    expect((await api(coach, 'listDeviceCandidates', {}, token)).allowed).toBe(true)
  })

  it('marks players this device can already edit, or has a pending request for', async () => {
    const r = await api(member, 'listDeviceCandidates')
    expect(r.players.find((p: any) => p.id === taro)).toMatchObject({ mine: false, pending: false })
    await request(member, taro, '架空 祖父')
    const after = await api(member, 'listDeviceCandidates')
    expect(after.players.find((p: any) => p.id === taro)).toMatchObject({ mine: false, pending: true })
  })

  it('exact-name lookup finds only an exact, active match and never hints at others', async () => {
    expect(await api(grandma, 'findPlayerForDevice', { name: '架空　太郎' })).toEqual({ found: true, player: { id: taro, name: '架空 太郎' } })
    for (const name of ['架空 太朗', 'ｶｸｳ ﾀﾛｳ', '架空 退団']) expect(await api(grandma, 'findPlayerForDevice', { name })).toEqual({ found: false })
    await expect(api(grandma, 'findPlayerForDevice', { name: '' })).rejects.toThrow('BAD_REQUEST')
  })

  it('exact-name lookups are limited per device', async () => {
    let last: any
    for (let i = 0; i < 21; i++) last = await api(aunt, 'findPlayerForDevice', { name: `架空 存在しない${i}` })
    expect(last).toEqual({ found: false, limited: true })
  })
})

describe('approval and rejection', () => {
  it('old admin screens without the player are asked to reload; nothing changes', async () => {
    const r = await request(grandma, taro)
    await expect(api(coach, 'reviewRegistration', { requestId: r.notification.requestId, decision: 'approved', accessModel: 'multi-device' }, token)).rejects.toThrow('CLIENT_UPDATE_REQUIRED')
    expect(await accessOf(grandma, taro)).toBe(0)
  })

  it('a request is never decided for a different player than the one shown', async () => {
    const reqId = (await db.query<{ id: string }>("select request_id id from public.re_registration_requests where new_owner_id=$1 and status='pending'", [grandma])).rows[0]!.id
    await expect(review(reqId, jiro, 'approved')).rejects.toThrow('CONFLICT')
    await expect(review(reqId, 'no-such-player', 'rejected')).rejects.toThrow('CONFLICT')
    expect(await accessOf(grandma, taro)).toBe(0)
    expect(await accessOf(grandma, jiro)).toBe(0)
    expect(await count("select count(*)::int n from public.re_registration_requests where request_id=$1 and status='pending'", [reqId])).toBe(1)
  })

  it('approving twice (a second admin, or a stale screen) changes nothing the second time', async () => {
    const reqId = (await db.query<{ id: string }>("select request_id id from public.re_registration_requests where new_owner_id=$1 and status='pending'", [grandma])).rows[0]!.id
    const results = await Promise.allSettled([review(reqId, taro, 'approved'), review(reqId, taro, 'approved'), review(reqId, taro, 'rejected')])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected').every(r => String((r as PromiseRejectedResult).reason).includes('CONFLICT'))).toBe(true)
    expect(await count('select count(*)::int n from public.player_access where auth_user_id=$1 and player_id=$2', [grandma, taro])).toBe(1)
    expect(await count("select count(*)::int n from public.re_registration_requests where request_id=$1 and status='approved'", [reqId])).toBe(1)
  })

  it('the approved device edits only that player; existing devices keep their rights', async () => {
    await write(grandma, taro, 'late')
    await expect(write(grandma, jiro)).rejects.toThrow('FORBIDDEN')
    await write(parent, taro, 'attend')
    await write(sibling, jiro, 'absent')
  })

  it('rejecting gives no rights, and a rejected request cannot be approved afterwards', async () => {
    const r = await request(aunt, jiro, '架空 叔母')
    await review(r.notification.requestId, jiro, 'rejected')
    await expect(review(r.notification.requestId, jiro, 'approved')).rejects.toThrow('CONFLICT')
    await expect(write(aunt, jiro)).rejects.toThrow('FORBIDDEN')
  })

  it('revoking the approved device leaves the original device untouched', async () => {
    const accessId = (await db.query<{ id: string }>('select id from public.player_access where auth_user_id=$1 and player_id=$2 and active', [grandma, taro])).rows[0]!.id
    await api(coach, 'revokeDeviceAccess', { accessId, accessModel: 'multi-device' }, token)
    await expect(write(grandma, taro)).rejects.toThrow('FORBIDDEN')
    await write(parent, taro, 'attend')
  })
})

describe('unchanged behaviour', () => {
  it('a new request still returns one LINE notification payload; asking again returns none', async () => {
    const first = await request(stranger, taro, '架空 父')
    expect(Object.keys(first.notification).sort()).toEqual(['accessModel', 'applicantName', 'playerName', 'relation', 'requestId', 'requestedAt'])
    const again = await request(stranger, taro, '架空 父')
    expect(again.notification).toBeUndefined()
    expect(await count("select count(*)::int n from public.re_registration_requests where new_owner_id=$1 and player_id=$2", [stranger, taro])).toBe(1)
  })

  it('API roles still have no direct table access; the only callable function is save_own_attendance', async () => {
    const fns = (await db.query<{ f: string }>(`select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))`)).rows.map(r => r.f)
    expect(fns).toEqual(['save_own_attendance(text,text,text,text,uuid)'])
    for (const fn of ['private.name_key(text)', 'private.names_similar(text,text)', 'private.similar_players_json(text)', 'private.edit_distance(text,text)'])
      for (const role of ['anon', 'authenticated']) expect((await db.query<{ ok: boolean }>('select has_function_privilege($1,$2,$3) ok', [role, fn, 'execute'])).rows[0]!.ok, `${role} ${fn}`).toBe(false)
  })

  it('the unique constraint on normalized names is unchanged', async () => {
    const def = (await db.query<{ d: string }>("select pg_get_expr(adbin, adrelid) d from pg_attrdef where adrelid='public.players'::regclass and adnum=(select attnum from pg_attribute where attrelid='public.players'::regclass and attname='normalized_name')")).rows[0]!.d
    expect(def).toContain("regexp_replace(name, '[[:space:]　]+'")
    await expect(db.query("insert into public.players(name) values('架空太郎')")).rejects.toThrow(/unique|duplicate/)
  })
})
