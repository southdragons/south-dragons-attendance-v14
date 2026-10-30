import { callSupabase } from '~/utils/supabase'
import type { RegistrationRequest, PendingAttendance, DeviceAccess, TeamCodeStatus, TeamMember, TeamMemberCounts } from '~/types/team'
import type { AttendanceStatus, Player, TeamData, TeamEvent } from '~/types/team'
import { createDemoData, createId, normalizeName, parseStoredData, setAnswer } from '~/utils/team'
import { similarPlayers } from '~/utils/names'
const STORAGE_KEY = 'south-dragons-demo-v1'
const MY_PLAYERS_KEY = 'south-dragons-my-players-v1'
type Snapshot = TeamData & { admin: boolean; adminConfigured: boolean; requests?: RegistrationRequest[]; pendingAttendance?: PendingAttendance[]; accessModel?: string; deviceAccess?: DeviceAccess[]
  teamCode?: TeamCodeStatus; teamMembers?: TeamMember[]; teamMemberCounts?: TeamMemberCounts; featureFlags?: Record<string, boolean> }
export type TeamError = Error & { code?: string; statusCode?: number }
/** registerName: an exact match, a request for the final confirmation, or the created player. */
export type RegisterResult =
  | { duplicate: true; player: Player }
  | { duplicate: false; needsConfirmation: true; similar: Pick<Player, 'id' | 'name'>[]; similarVisible: boolean }
  | { duplicate: false; needsConfirmation?: false; player: Player }
export type DeviceCandidate = { id: string; name: string; mine: boolean; pending: boolean }
const emptyData = (): TeamData => ({ version: 1, players: [], events: [], attendance: [], myPlayerIds: [] })
// Re-check view access when the app comes back to the foreground, at most once per minute.
export const RESUME_RECHECK_MS = 60_000
export const PARENT_SESSION_MESSAGE = 'この端末の確認ができませんでした。ページを再読み込みしてください。直らない場合は、チームの運営者にお知らせください。'
let resumeListenersAttached = false
export function useTeam() {
  const data = useState<TeamData>('team-data', emptyData)
  const ready = useState('team-ready', () => false)
  const storageError = useState('storage-error', () => '')
  const mode = useState<'demo' | 'gas' | 'supabase' | null>('team-mode', () => null)
  const admin = useState('team-admin', () => false)
  const adminConfigured = useState('admin-configured', () => false)
  const busy = ref(false)
  const requests = useState<RegistrationRequest[]>('registration-requests', () => [])
  const pendingAttendance = useState<PendingAttendance[]>('pending-attendance', () => [])
  const multiDeviceAccess = useState('multi-device-access', () => false)
  const deviceAccess = useState<DeviceAccess[]>('device-access', () => [])
  // Team code: true while this device must enter the code. All roster data is cleared meanwhile.
  const teamCodeRequired = useState('team-code-required', () => false)
  const teamCode = useState<TeamCodeStatus | null>('team-code-status', () => null)
  const teamMembers = useState<TeamMember[]>('team-members', () => [])
  const teamMemberCounts = useState<TeamMemberCounts | null>('team-member-counts', () => null)
  const featureFlags = useState<Record<string, boolean>>('feature-flags', () => ({}))
  const lastServerContact = useState('last-server-contact', () => 0)
  const isSupabase = computed(() => mode.value === 'supabase')
  const myPendingRequests = computed(() => requests.value.filter(r => r.isMine && r.status === 'pending'))
  const pendingRequestCount = computed(() => requests.value.filter(r => r.status === 'pending').length)
  function pendingRequest(playerId: string) { return myPendingRequests.value.find(r => r.playerId === playerId) }
  function canEdit(playerId: string) { return !isSupabase.value || data.value.myPlayerIds.includes(playerId) || (!multiDeviceAccess.value && !!pendingRequest(playerId)) }
  const isDemo = computed(() => mode.value === 'demo')
  async function api<T>(action: string, payload: Record<string, unknown> = {}) {
    lastServerContact.value = Date.now()
    const wasAdmin = admin.value
    try {
      if (isSupabase.value) return await callSupabase<T>(action, payload)
      return await $fetch<T>('/api/team', { method: 'POST', body: { action, payload }, headers: { 'X-South-Dragons': '1' }, retry: 0, timeout: 55000 }) }
    catch (error: any) {
      if (error.statusCode === 401 || error.status === 401) admin.value = false
      const code = error.data?.code as string | undefined
      if (code === 'TEAM_CODE_REQUIRED') lockForTeamCode()
      // The server's 401 text speaks to admins; parents get a plain instruction instead.
      const parentAuth = isSupabase.value && code === 'UNAUTHORIZED' && !wasAdmin
      throw Object.assign(new Error(parentAuth ? PARENT_SESSION_MESSAGE : error.data?.message || error.data?.statusMessage || (isSupabase.value && error.message) || '通信結果を確認できません。再読み込みしてから再試行してください。'), { code, statusCode: error.statusCode ?? error.status }) as TeamError
    }
  }
  function lockForTeamCode() {
    // Drop everything the device saw before; nothing about the team stays on screen.
    teamCodeRequired.value = true; admin.value = false
    data.value = emptyData(); requests.value = []; pendingAttendance.value = []; deviceAccess.value = []
    teamCode.value = null; teamMembers.value = []; teamMemberCounts.value = null; featureFlags.value = {}
    // Enforcement can only be on after an admin issued a code, so admin sign-in is configured.
    adminConfigured.value = true; ready.value = true; storageError.value = ''
  }
  function apply(snapshot: Snapshot) {
    const ids = isSupabase.value ? snapshot.myPlayerIds : data.value.myPlayerIds
    const next = parseStoredData(JSON.stringify({ ...snapshot, myPlayerIds: ids }))
    data.value = next; admin.value = snapshot.admin; adminConfigured.value = snapshot.adminConfigured
    requests.value = snapshot.requests || []; pendingAttendance.value = snapshot.pendingAttendance || []
    multiDeviceAccess.value = snapshot.accessModel === 'multi-device'
    deviceAccess.value = snapshot.admin ? snapshot.deviceAccess || [] : []
    teamCodeRequired.value = false
    teamCode.value = snapshot.admin ? snapshot.teamCode || null : null
    teamMembers.value = snapshot.admin ? snapshot.teamMembers || [] : []
    teamMemberCounts.value = snapshot.admin ? snapshot.teamMemberCounts || null : null
    featureFlags.value = snapshot.admin ? snapshot.featureFlags || {} : {}
  }
  function persist() {
    try {
      if (isDemo.value) localStorage.setItem(STORAGE_KEY, JSON.stringify(data.value))
      else if (!isSupabase.value) localStorage.setItem(MY_PLAYERS_KEY, JSON.stringify(data.value.myPlayerIds))
      storageError.value = ''
    } catch { storageError.value = isDemo.value ? 'このブラウザに保存できませんでした。ページを閉じると変更が失われます。' : '自分の選手をこのブラウザに記憶できませんでした。チームの出欠は共有先に保存されています。' }
  }
  async function refresh() {
    if (busy.value) return
    busy.value = true
    try {
      if (!mode.value) {
        const backend = useRuntimeConfig().public.dataBackend
        if (backend === 'supabase' || backend === 'demo') mode.value = backend
        else if (backend === 'gas') mode.value = (await $fetch<{ mode: 'demo' | 'gas' }>('/api/team-mode', { retry: 0 })).mode
        else throw new Error('接続設定を確認してください。')
      }
      if (isDemo.value) {
        if (!ready.value) {
          const raw = localStorage.getItem(STORAGE_KEY)
          data.value = raw ? parseStoredData(raw) : createDemoData()
        }
      } else {
        if (!ready.value && !isSupabase.value) {
          try {
            const ids = JSON.parse(localStorage.getItem(MY_PLAYERS_KEY) || '[]')
            data.value.myPlayerIds = Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
          } catch { data.value.myPlayerIds = [] }
        }
        apply(await api<Snapshot>('getData'))
      }
      ready.value = true; storageError.value = ''
    } catch (error: any) { if (!teamCodeRequired.value) storageError.value = error.message || 'データを読み込めませんでした。再読み込みしてください。' }
    finally { busy.value = false }
  }
  async function mutation<T>(work: () => Promise<T>) {
    if (busy.value) throw new Error('保存中です。しばらくお待ちください。')
    busy.value = true
    try { return await work() } finally { busy.value = false }
  }
  // Phase 4-F: a new player is created only when `confirmed` is true (the screen's final confirmation).
  async function registerName(name: string, confirmed = false): Promise<RegisterResult> {
    return mutation(async () => {
      if (!isSupabase.value) {
        // Demo / GAS: the roster is already on this device, so the same check runs here.
        const existing = data.value.players.find(p => normalizeName(p.name) === normalizeName(name))
        if (existing) return { duplicate: true, player: existing }
        if (!confirmed) return { duplicate: false, needsConfirmation: true, similar: similarPlayers(data.value.players, name).map(p => ({ id: p.id, name: p.name })), similarVisible: true }
        if (isDemo.value) {
          const player: Player = { id: createId(), name: name.trim(), active: true, joinedAt: new Date().toISOString(), retiredAt: null }
          data.value.players.push(player); persist(); return { duplicate: false, player }
        }
      }
      const result = await api<RegisterResult & { snapshot: Snapshot }>('registerPlayer', isSupabase.value ? { name, confirmed } : { name })
      apply(result.snapshot); return result
    })
  }
  // Existing players this device may pick. Supabase: only team-code devices and admins (`allowed`).
  async function listDeviceCandidates(): Promise<{ allowed: boolean; players: DeviceCandidate[] }> {
    if (!isSupabase.value) return { allowed: true, players: data.value.players.filter(p => p.active).map(p => ({ id: p.id, name: p.name, mine: data.value.myPlayerIds.includes(p.id), pending: !!pendingRequest(p.id) })) }
    const result = await api<{ allowed: boolean; players?: DeviceCandidate[] }>('listDeviceCandidates')
    return { allowed: !!result.allowed, players: result.allowed ? result.players || [] : [] }
  }
  // Exact name only, for devices that cannot pick from the roster.
  async function findPlayerForDevice(name: string): Promise<{ found: boolean; limited?: boolean; player?: Pick<Player, 'id' | 'name'> }> {
    if (!isSupabase.value) { const p = data.value.players.find(x => x.active && normalizeName(x.name) === normalizeName(name)); return p ? { found: true, player: { id: p.id, name: p.name } } : { found: false } }
    return api('findPlayerForDevice', { name })
  }
  async function requestRegistration(playerId: string, applicantName = '', relation = '') {
    return mutation(async () => { apply((await api<{snapshot: Snapshot}>('requestRegistration', {playerId, ...(multiDeviceAccess.value ? {applicantName, relation, accessModel: 'multi-device'} : {})})).snapshot) })
  }
  // The server re-checks that the request is still pending and belongs to the player the screen showed.
  async function reviewRegistration(requestId: string, playerId: string, decision: 'approved' | 'rejected') {
    return mutation(async () => { apply((await api<{snapshot: Snapshot}>('reviewRegistration', {requestId, playerId, decision, ...(multiDeviceAccess.value ? {accessModel: 'multi-device'} : {})})).snapshot) })
  }
  function rememberPlayer(player: Player) {
    if (!player.active || isSupabase.value) return
    if (!data.value.myPlayerIds.includes(player.id)) data.value.myPlayerIds.push(player.id)
    persist()
  }
  async function saveAttendance(eventId: string, playerId: string, status: AttendanceStatus | null) {
    return mutation(async () => {
      if (isDemo.value) { setAnswer(data.value, eventId, playerId, status); persist() }
      else {
        const pending = pendingRequest(playerId)
        const action = isSupabase.value && !multiDeviceAccess.value && pending && !data.value.myPlayerIds.includes(playerId) ? 'savePendingAttendance' : 'saveAttendance'
        apply((await api<{ snapshot: Snapshot }>(action, { eventId, playerId, status, requestId: multiDeviceAccess.value ? undefined : pending?.id })).snapshot)
      }
    })
  }
  async function adminMutation(action: string, payload: Record<string, unknown>, demo: () => void) {
    return mutation(async () => {
      if (!admin.value) throw new Error('管理画面にログインしてください。')
      if (isDemo.value) { demo(); persist() }
      else apply((await api<{ snapshot: Snapshot }>(action, payload)).snapshot)
    })
  }
  async function revokeDeviceAccess(accessId: string) {
    return adminMutation('revokeDeviceAccess', {accessId, accessModel: 'multi-device'}, () => {})
  }
  async function saveEvent(event: TeamEvent, create: boolean) {
    return adminMutation('saveEvent', { event, create }, () => {
      const index = data.value.events.findIndex(e => e.id === event.id)
      if (index >= 0) data.value.events[index] = { ...event }; else data.value.events.push({ ...event })
    })
  }
  async function setEventActive(eventId: string, active: boolean) {
    return adminMutation('setEventActive', { eventId, active }, () => { const event = data.value.events.find(e => e.id === eventId); if (event) event.active = active })
  }
  async function setPlayerActive(playerId: string, active: boolean) {
    return adminMutation('setPlayerActive', { playerId, active }, () => { const player = data.value.players.find(p => p.id === playerId); if (player) { player.active = active; player.retiredAt = active ? null : new Date().toISOString() } })
  }
  async function renamePlayer(playerId: string, name: string) {
    return adminMutation('renamePlayer', { playerId, name }, () => { const player = data.value.players.find(p => p.id === playerId); if (player) player.name = name })
  }
  async function login(password: string, setupCode?: string) {
    await mutation(async () => {
      if (isDemo.value) { admin.value = true; return }
      await api(setupCode === undefined ? 'adminLogin' : 'initializeAdmin', { password, setupCode })
      apply(await api<Snapshot>('getData'))
    })
  }
  async function logout() {
    await mutation(async () => {
      if (!isDemo.value) await api('adminLogout')
      admin.value = false
      if (!isDemo.value) {
        try { apply(await api<Snapshot>('getData')) }
        catch (error) { if ((error as TeamError).code !== 'TEAM_CODE_REQUIRED') throw error } // device is not a member: code screen
      }
    })
  }
  async function verifyTeamCode(code: string, label = '') {
    return mutation(async () => { apply((await api<{ snapshot: Snapshot }>('verifyTeamCode', { code, label })).snapshot) })
  }
  // The issued code is returned to the caller only and never kept in shared state.
  async function rotateTeamCode(graceHours: number) {
    return mutation(async () => {
      if (!admin.value) throw new Error('管理画面にログインしてください。')
      const result = await api<{ teamCode: string; snapshot: Snapshot }>('rotateTeamCode', { graceHours })
      apply(result.snapshot); return result.teamCode
    })
  }
  const setTeamCodeEnforcement = (on: boolean) => adminMutation('setTeamCodeEnforcement', { enforcement: on ? 'on' : 'off' }, () => {})
  const revokeTeamMembers = (scope: 'unbound' | 'all') => adminMutation('revokeTeamMembers', { scope }, () => {})
  const revokeTeamMember = (memberId: string) => adminMutation('revokeTeamMember', { memberId }, () => {})
  const addCurrentDeviceAsMember = () => adminMutation('addCurrentDeviceAsMember', {}, () => {})
  const setAbuseLimits = (enabled: boolean) => adminMutation('setFeatureFlag', { name: 'abuse_limits', enabled }, () => {})
  async function changePassword(currentPassword: string, password: string) {
    await mutation(async () => {
      if (isDemo.value) throw new Error('パスワード変更は共有先への接続後に利用できます。')
      await api('changeAdminPassword', { currentPassword, password })
      admin.value = false
    })
  }
  // Background re-check (app resumed). Only a definite TEAM_CODE_REQUIRED changes the screen (api() locks it);
  // network/server failures leave what is shown untouched, so going offline never looks like a revocation.
  async function revalidate(now = Date.now()) {
    if (!isSupabase.value || !ready.value || busy.value || teamCodeRequired.value) return false
    if (now - lastServerContact.value < RESUME_RECHECK_MS) return false
    busy.value = true
    try { apply(await api<Snapshot>('getData')) } catch {}
    finally { busy.value = false }
    return true
  }
  onMounted(() => {
    refresh()
    if (resumeListenersAttached || typeof document === 'undefined') return
    resumeListenersAttached = true
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') revalidate() })
    window.addEventListener('pageshow', event => { if ((event as PageTransitionEvent).persisted) revalidate() })
  })
  return { revalidate, teamCodeRequired, teamCode, teamMembers, teamMemberCounts, featureFlags, verifyTeamCode, rotateTeamCode, setTeamCodeEnforcement, revokeTeamMembers, revokeTeamMember, addCurrentDeviceAsMember, setAbuseLimits,
    isSupabase, multiDeviceAccess, deviceAccess, revokeDeviceAccess, requests, pendingAttendance, myPendingRequests, pendingRequestCount, pendingRequest, canEdit, requestRegistration, reviewRegistration, listDeviceCandidates, findPlayerForDevice, data, ready, storageError, mode, isDemo, busy, admin, adminConfigured, refresh, registerName, rememberPlayer, saveAttendance, saveEvent, setEventActive, setPlayerActive, renamePlayer, login, logout, changePassword }
}
