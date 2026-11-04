import { computed, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTeam } from '../app/composables/useTeam'
import { callSupabase } from '../app/utils/supabase'
vi.mock('../app/utils/supabase', () => ({ callSupabase: vi.fn() }))
const api = vi.mocked(callSupabase)

const player = { id: 'p1', name: '山田 太郎', active: true, joinedAt: '2026-09-01T00:00:00Z', retiredAt: null }
const event = { id: 'e1', date: '2026-12-05', title: '練習', startTime: '08:00', endTime: '12:00', location: '学校', note: '', createdByName: '', active: true }
function snapshot(extra: Record<string, unknown> = {}) {
  return { version: 1, accessModel: 'multi-device', players: [player], events: [event], attendance: [{ eventId: 'e1', playerId: 'p1', status: 'attend', updatedAt: '2026-11-01T00:00:00Z' }], myPlayerIds: ['p1'], admin: false, adminConfigured: true, requests: [], pendingAttendance: [], deviceAccess: [], ...extra }
}
const adminSnapshot = (extra: Record<string, unknown> = {}) => snapshot({
  admin: true,
  teamCode: { issued: true, version: 2, enforcement: 'on', updatedAt: '2026-11-01T00:00:00Z', previousValidUntil: null },
  teamMembers: [{ id: 'm1', method: 'code', label: '祖母', verifiedAt: '2026-11-01T00:00:00Z', lastSeenAt: null, isCurrentDevice: false, players: [] }],
  teamMemberCounts: { code: 1, existingAccess: 0, admin: 0, revoked: 0 },
  featureFlags: { abuse_limits: false }, ...extra,
})
// Same shape as callSupabase's thrown errors.
const fail = (code: string | undefined, status: number | undefined, message = 'server message') =>
  Object.assign(new Error(message), { statusCode: status, data: { message, code } })

let states: Map<string, unknown>
beforeEach(() => {
  api.mockReset()
  states = new Map()
  vi.stubGlobal('useState', (key: string, init: () => unknown) => { if (!states.has(key)) states.set(key, ref(init())); return states.get(key) })
  vi.stubGlobal('ref', ref); vi.stubGlobal('computed', computed); vi.stubGlobal('onMounted', () => {})
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { dataBackend: 'supabase' } }))
})
afterEach(() => vi.unstubAllGlobals())

it('behaves exactly as before when the team code is not enforced', async () => {
  const team = useTeam()
  api.mockResolvedValueOnce(snapshot()); await team.refresh()
  expect(team.teamCodeRequired.value).toBe(false)
  expect(team.ready.value).toBe(true)
  expect(team.data.value.players).toHaveLength(1)
  expect(team.storageError.value).toBe('')
  expect(team.teamCode.value).toBeNull()
  expect(api).toHaveBeenCalledWith('getData', {})
})
it('shows the code screen and clears every piece of team data when the code is required', async () => {
  const team = useTeam()
  api.mockResolvedValueOnce(adminSnapshot()); await team.refresh() // data previously on screen
  api.mockRejectedValueOnce(fail('TEAM_CODE_REQUIRED', 403)); await team.refresh()
  expect(team.teamCodeRequired.value).toBe(true)
  expect(team.ready.value).toBe(true)
  expect(team.storageError.value).toBe('')
  expect(team.adminConfigured.value).toBe(true)
  expect(team.admin.value).toBe(false)
  expect(team.data.value).toEqual({ version: 1, players: [], events: [], attendance: [], myPlayerIds: [] })
  expect(team.requests.value).toEqual([]); expect(team.deviceAccess.value).toEqual([])
  expect(team.teamMembers.value).toEqual([]); expect(team.teamCode.value).toBeNull()
})
it('a verified code restores the normal screen and later loads need no code', async () => {
  const team = useTeam()
  api.mockRejectedValueOnce(fail('TEAM_CODE_REQUIRED', 403)); await team.refresh()
  api.mockResolvedValueOnce({ snapshot: snapshot() })
  await team.verifyTeamCode('sd-abcd-efgh', '祖母')
  expect(api).toHaveBeenLastCalledWith('verifyTeamCode', { code: 'sd-abcd-efgh', label: '祖母' })
  expect(team.teamCodeRequired.value).toBe(false)
  expect(team.data.value.players).toHaveLength(1)
  api.mockResolvedValueOnce(snapshot()); await team.refresh()
  expect(team.teamCodeRequired.value).toBe(false)
})
it('passes the error code through for wrong code, rate limit and network failures', async () => {
  const team = useTeam()
  api.mockRejectedValueOnce(fail('TEAM_CODE_REQUIRED', 403)); await team.refresh() // the code screen is only reachable after loading
  for (const [code, status] of [['TEAM_CODE_INVALID', 400], ['RATE_LIMITED', 429], ['NETWORK', undefined]] as const) {
    api.mockRejectedValueOnce(fail(code, status))
    const error = await team.verifyTeamCode('x').catch(e => e)
    expect(error.code).toBe(code)
    expect(error.statusCode).toBe(status)
  }
  expect(team.teamCodeRequired.value).toBe(true) // still on the code screen; these errors change nothing else
})
it('returns an issued code to the caller only and never keeps it in shared state', async () => {
  const team = useTeam()
  api.mockResolvedValueOnce(adminSnapshot()); await team.refresh()
  api.mockResolvedValueOnce({ teamCode: 'SD-ABCD-EFGH', snapshot: adminSnapshot() })
  expect(await team.rotateTeamCode(24)).toBe('SD-ABCD-EFGH')
  expect(api).toHaveBeenLastCalledWith('rotateTeamCode', { graceHours: 24 })
  expect(JSON.stringify([...states.values()].map(s => (s as any).value))).not.toContain('ABCD')
})
it('sends the admin team code and abuse_limits operations with the expected payloads', async () => {
  const team = useTeam()
  api.mockResolvedValueOnce(adminSnapshot()); await team.refresh()
  expect(team.teamCode.value?.enforcement).toBe('on')
  expect(team.featureFlags.value).toEqual({ abuse_limits: false })
  api.mockResolvedValue({ snapshot: adminSnapshot() })
  await team.setTeamCodeEnforcement(false); expect(api).toHaveBeenLastCalledWith('setTeamCodeEnforcement', { enforcement: 'off' })
  await team.revokeTeamMembers('unbound'); expect(api).toHaveBeenLastCalledWith('revokeTeamMembers', { scope: 'unbound' })
  await team.revokeTeamMember('m1'); expect(api).toHaveBeenLastCalledWith('revokeTeamMember', { memberId: 'm1' })
  await team.addCurrentDeviceAsMember(); expect(api).toHaveBeenLastCalledWith('addCurrentDeviceAsMember', {})
  await team.setAbuseLimits(true); expect(api).toHaveBeenLastCalledWith('setFeatureFlag', { name: 'abuse_limits', enabled: true })
})
it('drops admin-only team code details from an ordinary snapshot and blocks admin calls', async () => {
  const team = useTeam()
  api.mockResolvedValueOnce(snapshot({ teamMembers: [{ id: 'm1' }], featureFlags: { abuse_limits: true } })); await team.refresh()
  expect(team.teamMembers.value).toEqual([]); expect(team.featureFlags.value).toEqual({})
  const calls = api.mock.calls.length
  await expect(team.setAbuseLimits(true)).rejects.toThrow('管理画面にログイン')
  await expect(team.rotateTeamCode(0)).rejects.toThrow('管理画面にログイン')
  expect(api.mock.calls).toHaveLength(calls)
})
it('admin sign-out on a non-member device returns to the code screen without an error', async () => {
  const team = useTeam()
  api.mockResolvedValueOnce(adminSnapshot()); await team.refresh()
  api.mockResolvedValueOnce({ authenticated: false }).mockRejectedValueOnce(fail('TEAM_CODE_REQUIRED', 403))
  await team.logout()
  expect(team.admin.value).toBe(false)
  expect(team.teamCodeRequired.value).toBe(true)
  expect(team.data.value.players).toEqual([])
})
it('any action that meets TEAM_CODE_REQUIRED (e.g. after revocation) locks the screen', async () => {
  const team = useTeam()
  api.mockResolvedValueOnce(snapshot()); await team.refresh()
  api.mockRejectedValueOnce(fail('TEAM_CODE_REQUIRED', 403))
  await expect(team.saveAttendance('e1', 'p1', 'absent')).rejects.toThrow()
  expect(team.teamCodeRequired.value).toBe(true)
  expect(team.data.value.attendance).toEqual([])
})

// ---- re-check when the app returns to the foreground
import { PARENT_SESSION_MESSAGE, RESUME_RECHECK_MS } from '../app/composables/useTeam'
import { readFileSync } from 'node:fs'
it('re-checks on resume at most once per interval, counting any recent server contact', async () => {
  const team = useTeam()
  api.mockResolvedValueOnce(snapshot()); await team.refresh()
  const t0 = Date.now(), calls = api.mock.calls.length
  expect(await team.revalidate(t0 + 1_000)).toBe(false)
  expect(await team.revalidate(t0 + RESUME_RECHECK_MS - 1_000)).toBe(false)
  expect(api.mock.calls).toHaveLength(calls)
  api.mockResolvedValueOnce(snapshot())
  expect(await team.revalidate(t0 + RESUME_RECHECK_MS + 1_000)).toBe(true)
  expect(api).toHaveBeenLastCalledWith('getData', {})
  expect(await team.revalidate(Date.now() + 1_000)).toBe(false) // the re-check itself restarts the interval
  expect(team.busy.value).toBe(false)
})
it('does not re-check before the first load, while busy, on the code screen or outside Supabase mode', async () => {
  const later = Date.now() + 10 * RESUME_RECHECK_MS
  const fresh = useTeam(); expect(await fresh.revalidate(later)).toBe(false) // not ready yet
  api.mockRejectedValueOnce(fail('TEAM_CODE_REQUIRED', 403)); await fresh.refresh()
  expect(await fresh.revalidate(later)).toBe(false) // already on the code screen
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { dataBackend: 'demo' } }))
  states.clear(); vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  const demo = useTeam(); await demo.refresh()
  expect(await demo.revalidate(later)).toBe(false)
  expect(api).toHaveBeenCalledTimes(1)
})
it('a revoked device found on resume is locked: data cleared, code screen shown', async () => {
  const team = useTeam()
  api.mockResolvedValueOnce(snapshot()); await team.refresh()
  api.mockRejectedValueOnce(fail('TEAM_CODE_REQUIRED', 403))
  expect(await team.revalidate(Date.now() + RESUME_RECHECK_MS + 1)).toBe(true)
  expect(team.teamCodeRequired.value).toBe(true)
  expect(team.data.value.players).toEqual([]); expect(team.data.value.attendance).toEqual([])
})
it('network or server trouble on resume never counts as a revocation and shows no error', async () => {
  for (const [code, status] of [['NETWORK', undefined], [undefined, 503], [undefined, 502]] as const) {
    states.clear()
    const team = useTeam()
    api.mockResolvedValueOnce(snapshot()); await team.refresh()
    api.mockRejectedValueOnce(fail(code, status, 'name resolution failed'))
    expect(await team.revalidate(Date.now() + RESUME_RECHECK_MS + 1)).toBe(true)
    expect(team.teamCodeRequired.value).toBe(false)
    expect(team.data.value.players).toHaveLength(1) // what was shown stays
    expect(team.storageError.value).toBe('')
    expect(team.busy.value).toBe(false)
  }
})
it('parents get a plain message for an invalid session; admins keep the admin wording', async () => {
  const parent = useTeam()
  api.mockResolvedValueOnce(snapshot()); await parent.refresh()
  api.mockRejectedValueOnce(fail('UNAUTHORIZED', 401, '管理画面への再ログイン、またはページの再読み込みをお願いします。'))
  expect((await parent.saveAttendance('e1', 'p1', 'attend').catch(e => e)).message).toBe(PARENT_SESSION_MESSAGE)
  states.clear()
  const admin = useTeam()
  api.mockResolvedValueOnce(adminSnapshot()); await admin.refresh()
  api.mockRejectedValueOnce(fail('UNAUTHORIZED', 401, '管理画面への再ログイン、またはページの再読み込みをお願いします。'))
  const error = await admin.setAbuseLimits(true).catch(e => e)
  expect(error.message).toContain('管理画面への再ログイン')
  expect(admin.admin.value).toBe(false)
})
it('listens for resume events and explains the device count before enforcement', () => {
  const src = readFileSync('app/composables/useTeam.ts', 'utf8')
  expect(src).toContain("addEventListener('visibilitychange'")
  expect(src).toContain("addEventListener('pageshow'")
  const app = readFileSync('app/app.vue', 'utf8')
  // Phase 4-F2: only devices of confirmed players are added automatically when the restriction is switched on.
  expect(app).toMatch(/<p v-if="!enforced" class="team-code-note" data-testid="members-before-enforcement">[^<]*有効にした時点で、<strong>確認済みの選手<\/strong>の端末だけが自動的に追加/)
})
