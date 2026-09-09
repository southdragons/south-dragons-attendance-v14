import type { AttendanceStatus, Player, TeamData, TeamEvent } from '~/types/team'
import { createDemoData, createId, normalizeName, parseStoredData, setAnswer } from '~/utils/team'
const STORAGE_KEY = 'south-dragons-demo-v1'
const MY_PLAYERS_KEY = 'south-dragons-my-players-v1'
type Snapshot = TeamData & { admin: boolean; adminConfigured: boolean }
const emptyData = (): TeamData => ({ version: 1, players: [], events: [], attendance: [], myPlayerIds: [] })
export function useTeam() {
  const data = useState<TeamData>('team-data', emptyData)
  const ready = useState('team-ready', () => false)
  const storageError = useState('storage-error', () => '')
  const mode = useState<'demo' | 'gas' | null>('team-mode', () => null)
  const admin = useState('team-admin', () => false)
  const adminConfigured = useState('admin-configured', () => false)
  const busy = ref(false)
  const isDemo = computed(() => mode.value === 'demo')
  async function api<T>(action: string, payload: Record<string, unknown> = {}) {
    try { return await $fetch<T>('/api/team', { method: 'POST', body: { action, payload }, headers: { 'X-South-Dragons': '1' }, retry: 0, timeout: 55000 }) }
    catch (error: any) {
      if (error.statusCode === 401 || error.status === 401) admin.value = false
      throw new Error(error.data?.message || error.data?.statusMessage || '通信結果を確認できません。再読み込みしてから再試行してください。')
    }
  }
  function apply(snapshot: Snapshot) {
    const ids = data.value.myPlayerIds
    const next = parseStoredData(JSON.stringify({ ...snapshot, myPlayerIds: ids }))
    data.value = next; admin.value = snapshot.admin; adminConfigured.value = snapshot.adminConfigured
  }
  function persist() {
    try {
      if (isDemo.value) localStorage.setItem(STORAGE_KEY, JSON.stringify(data.value))
      else localStorage.setItem(MY_PLAYERS_KEY, JSON.stringify(data.value.myPlayerIds))
      storageError.value = ''
    } catch { storageError.value = isDemo.value ? 'このブラウザに保存できませんでした。ページを閉じると変更が失われます。' : '自分の選手をこのブラウザに記憶できませんでした。チームの出欠は共有先に保存されています。' }
  }
  async function refresh() {
    if (busy.value) return
    busy.value = true
    try {
      if (!mode.value) mode.value = (await $fetch<{ mode: 'demo' | 'gas' }>('/api/team-mode', { retry: 0 })).mode
      if (isDemo.value) {
        if (!ready.value) {
          const raw = localStorage.getItem(STORAGE_KEY)
          data.value = raw ? parseStoredData(raw) : createDemoData()
        }
      } else {
        if (!ready.value) {
          try {
            const ids = JSON.parse(localStorage.getItem(MY_PLAYERS_KEY) || '[]')
            data.value.myPlayerIds = Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
          } catch { data.value.myPlayerIds = [] }
        }
        apply(await api<Snapshot>('getData'))
      }
      ready.value = true; storageError.value = ''
    } catch (error: any) { storageError.value = error.message || 'データを読み込めませんでした。再読み込みしてください。' }
    finally { busy.value = false }
  }
  async function mutation<T>(work: () => Promise<T>) {
    if (busy.value) throw new Error('保存中です。しばらくお待ちください。')
    busy.value = true
    try { return await work() } finally { busy.value = false }
  }
  async function registerName(name: string) {
    return mutation(async () => {
      if (isDemo.value) {
        const existing = data.value.players.find(p => normalizeName(p.name) === normalizeName(name))
        if (existing) return { duplicate: true, player: existing }
        const player: Player = { id: createId(), name: name.trim(), active: true, joinedAt: new Date().toISOString(), retiredAt: null }
        data.value.players.push(player); persist(); return { duplicate: false, player }
      }
      const result = await api<{ duplicate: boolean; player: Player; snapshot: Snapshot }>('registerPlayer', { name })
      apply(result.snapshot); return result
    })
  }
  function rememberPlayer(player: Player) {
    if (!player.active) return
    if (!data.value.myPlayerIds.includes(player.id)) data.value.myPlayerIds.push(player.id)
    persist()
  }
  async function saveAttendance(eventId: string, playerId: string, status: AttendanceStatus | null) {
    return mutation(async () => {
      if (isDemo.value) { setAnswer(data.value, eventId, playerId, status); persist() }
      else apply((await api<{ snapshot: Snapshot }>('saveAttendance', { eventId, playerId, status })).snapshot)
    })
  }
  async function adminMutation(action: string, payload: Record<string, unknown>, demo: () => void) {
    return mutation(async () => {
      if (!admin.value) throw new Error('管理画面にログインしてください。')
      if (isDemo.value) { demo(); persist() }
      else apply((await api<{ snapshot: Snapshot }>(action, payload)).snapshot)
    })
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
      if (!isDemo.value) apply(await api<Snapshot>('getData'))
    })
  }
  async function changePassword(currentPassword: string, password: string) {
    await mutation(async () => {
      if (isDemo.value) throw new Error('パスワード変更はGAS接続後に利用できます。')
      await api('changeAdminPassword', { currentPassword, password })
      admin.value = false
    })
  }
  onMounted(refresh)
  return { data, ready, storageError, mode, isDemo, busy, admin, adminConfigured, refresh, registerName, rememberPlayer, saveAttendance, saveEvent, setEventActive, setPlayerActive, renamePlayer, login, logout, changePassword }
}
