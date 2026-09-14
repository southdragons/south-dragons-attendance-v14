<script setup lang="ts">
import { ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardList, Clock3, Info, LogOut, MapPin, Plus, RefreshCw, Settings2, ShieldCheck, Users } from 'lucide-vue-next'
import type { AttendanceStatus, DeviceAccess, Player, TeamEvent } from '~/types/team'
import { countsFor, createId, dateLabel, localDate, normalizeName, statusOptions, visiblePlayers } from '~/utils/team'
const team = useTeam()
const { multiDeviceAccess, deviceAccess, data, ready, storageError, isDemo, isSupabase, busy, admin, adminConfigured, requests, pendingAttendance, myPendingRequests, pendingRequestCount } = team
const view = ref<'attendance' | 'admin'>('attendance')
watch(admin, value => { if (!value) view.value = 'attendance' })
const history = ref(false)
const onlyMine = ref(false)
const monthOffset = ref(0)
const today = localDate()
const month = computed(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + monthOffset.value, 1) })
const monthKey = computed(() => `${month.value.getFullYear()}-${String(month.value.getMonth() + 1).padStart(2, '0')}`)
const events = computed(() => data.value.events.filter(e => e.active && e.date.startsWith(monthKey.value) && (history.value ? e.date < today : e.date >= today)).sort((a,b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)))
const roster = computed(() => visiblePlayers(data.value.players, events.value, data.value.attendance, history.value))
const players = computed(() => roster.value.filter(p => !onlyMine.value || data.value.myPlayerIds.includes(p.id) || !!team.pendingRequest(p.id)))
const myPlayers = computed(() => data.value.players.filter(p => p.active && data.value.myPlayerIds.includes(p.id)))
const activePlayers = computed(() => data.value.players.filter(p => p.active))
const upcoming = computed(() => data.value.events.filter(e => e.active && e.date >= today).sort((a,b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))[0])
const selected = ref<{ player: Player; event: TeamEvent } | null>(null)
const detail = ref<TeamEvent | null>(null)
const registration = ref(false)
const name = ref('')
const applicantName = ref('')
const applicantRelation = ref('')
const devicePlayer = ref<Player | null>(null)
const selectedDeviceAccess = computed(() => deviceAccess.value.filter(a => a.playerId === devicePlayer.value?.id))
const duplicate = ref<Player | null>(null)
const formError = ref('')
const actionError = ref('')
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(noticeTimer))
function notify(message: string) { notice.value = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => notice.value = '', 4000) }
async function perform(work: () => Promise<void>) { actionError.value = ''; try { await work() } catch (error) { actionError.value = (error as Error).message } }
function status(eventId: string, playerId: string) {
  const pending = multiDeviceAccess.value ? undefined : team.pendingRequest(playerId)
  const draft = pendingAttendance.value.find(a => a.requestId === pending?.id && a.eventId === eventId)
  if (draft) return draft.status || undefined
  return data.value.attendance.find(a => a.eventId === eventId && a.playerId === playerId)?.status
}
function statusInfo(value: AttendanceStatus | undefined) { return statusOptions.find(s => s.value === value) }
function totals(eventId: string) { return countsFor(eventId, roster.value, data.value.attendance) }
async function saveStatus(value: AttendanceStatus | null) {
  if (!selected.value) return
  const selection = selected.value
  const provisional = !multiDeviceAccess.value && !!team.pendingRequest(selection.player.id) && !data.value.myPlayerIds.includes(selection.player.id)
  await perform(async () => { await team.saveAttendance(selection.event.id, selection.player.id, value); selected.value = null; notify(provisional ? '仮回答を保存しました。管理者の承認後に反映されます' : value ? '出欠を更新しました' : '未回答に戻しました') })
}
function openRegistration() { name.value = ''; applicantName.value = ''; applicantRelation.value = ''; duplicate.value = null; formError.value = ''; actionError.value = ''; registration.value = true }
async function register() {
  const normalized = normalizeName(name.value)
  if (!normalized || name.value.trim().length > 30) { formError.value = '名前を1〜30文字で入力してください。'; return }
  formError.value = ''
  await perform(async () => {
    const result = await team.registerName(name.value.trim())
    if (result.duplicate) duplicate.value = result.player
    else usePlayer(result.player)
  })
}
async function recoverPlayer(player: Player) {
  if (!isSupabase.value || data.value.myPlayerIds.includes(player.id)) { usePlayer(player); return }
  if (multiDeviceAccess.value && (!applicantName.value.trim() || applicantName.value.trim().length > 30 || !['父','母','祖父母','その他'].includes(applicantRelation.value))) { formError.value = '申請者のお名前と続柄を入力してください。'; return }
  formError.value = ''
  await perform(async () => { await team.requestRegistration(player.id, applicantName.value.trim(), applicantRelation.value); registration.value = false; notify(multiDeviceAccess.value ? '端末の追加を申請しました。承認後に出欠を入力できます' : '再登録を申請しました。承認待ちでも仮回答できます') })
}
function reviewRequest(id: string, playerName: string, decision: 'approved' | 'rejected') {
  confirmAction.value = { title: `${playerName}さんの申請を${decision === 'approved' ? '承認' : '却下'}しますか？`, message: multiDeviceAccess.value ? (decision === 'approved' ? 'この端末でも出欠を入力できるようにします。現在使っている端末の権限と出欠回答は、そのまま残ります。' : 'この端末に編集権限は付与しません。現在の端末と出欠回答は、そのまま残ります。') : decision === 'approved' ? '新しい端末に編集権限を移し、現在・未来の有効な予定への仮回答を正式に反映します。以前の端末は編集できなくなります。' : '現在の編集権限と正式な回答を保持します。仮回答は反映しません。', label: decision === 'approved' ? '承認する' : '却下する', action: async () => { await team.reviewRegistration(id, decision); notify('申請を処理しました') } }
}
function usePlayer(player: Player) { if (!player.active) return; team.rememberPlayer(player); registration.value = false; notify(`${player.name}さんを登録しました`) }
const adminEntry = ref(false)
const adminTab = ref<'events' | 'players' | 'requests' | 'password'>('events')
const showRetired = ref(false)
const managedPlayers = computed(() => data.value.players.filter(p => showRetired.value || p.active))
const adminMonth = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const adminMonthKey = computed(() => `${adminMonth.value.getFullYear()}-${String(adminMonth.value.getMonth() + 1).padStart(2, '0')}`)
function shiftAdminMonth(amount: number) { adminMonth.value = new Date(adminMonth.value.getFullYear(), adminMonth.value.getMonth() + amount, 1) }
function resetAdminMonth() { const now = new Date(); adminMonth.value = new Date(now.getFullYear(), now.getMonth(), 1) }
const managedEvents = computed(() => data.value.events.filter(event => event.date.startsWith(adminMonthKey.value)).sort((a,b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)))
const adminPassword = ref('')
const setupCode = ref('')
const initialPasswordAgain = ref('')
function openAdmin() { if (admin.value) { view.value = 'admin'; return }; adminPassword.value = ''; setupCode.value = ''; initialPasswordAgain.value = ''; actionError.value = ''; adminEntry.value = true }
async function enterAdmin() {
  if (!isDemo.value && !adminConfigured.value && adminPassword.value !== initialPasswordAgain.value) { actionError.value = '確認用パスワードが一致しません。'; return }
  await perform(async () => { await team.login(adminPassword.value, !isDemo.value && !adminConfigured.value ? setupCode.value : undefined); adminPassword.value = ''; setupCode.value = ''; initialPasswordAgain.value = ''; adminEntry.value = false; view.value = 'admin' })
}
async function logout() { await perform(async () => { await team.logout(); view.value = 'attendance'; notify('管理画面を終了しました') }) }
const currentPassword = ref('')
const newPassword = ref('')
const passwordAgain = ref('')
async function changePassword() {
  if (newPassword.value !== passwordAgain.value) { actionError.value = '確認用パスワードが一致しません。'; return }
  await perform(async () => { await team.changePassword(currentPassword.value, newPassword.value); currentPassword.value = ''; newPassword.value = ''; passwordAgain.value = ''; notify('パスワードを変更しました。新しいパスワードでログインしてください。') })
}
const eventEditor = ref(false)
const creatingEvent = ref(true)
const eventDraft = ref<TeamEvent>(emptyEvent())
function emptyEvent(): TeamEvent { return { id: createId(), date: localDate().startsWith(adminMonthKey.value) ? localDate() : `${adminMonthKey.value}-01`, title: '', startTime: '08:00', endTime: '12:00', location: '', note: '', createdByName: '', active: true } }
function editEvent(event?: TeamEvent) { creatingEvent.value = !event; eventDraft.value = event ? { ...event } : emptyEvent(); formError.value = ''; actionError.value = ''; eventEditor.value = true }
async function saveEvent() {
  if (!admin.value) return
  const draft = eventDraft.value
  if (!draft.title.trim() || !draft.date || !draft.startTime || !draft.endTime || !draft.location.trim()) { formError.value = '必須項目を入力してください。'; return }
  if (draft.endTime <= draft.startTime) { formError.value = '終了時間は開始時間より後にしてください。'; return }
  const record = { ...draft, title: draft.title.trim(), location: draft.location.trim(), createdByName: draft.createdByName.trim() }
  await perform(async () => { await team.saveEvent(record, creatingEvent.value); const [year, month] = record.date.split('-').map(Number); adminMonth.value = new Date(year!, month! - 1, 1); eventEditor.value = false; notify('予定を保存しました') })
}
function revokeDevice(access: DeviceAccess) {
  actionError.value = ''
  confirmAction.value = { title: 'この端末の編集権限を解除しますか？', message: `${devicePlayer.value?.name}さんの「${access.applicantName || '登録時の端末'}${access.relation ? '・' + access.relation : ''}」からは出欠を変更できなくなります。他の端末や兄弟の権限、出欠記録は残ります。${access.isCurrentDevice ? '今お使いの端末が対象です。' : ''}`, label: '権限を解除する', action: async () => { await team.revokeDeviceAccess(access.id); notify('この端末の編集権限を解除しました') } }
}
const confirmAction = ref<{ title: string; message: string; label: string; action: () => Promise<void> } | null>(null)
function toggleEvent(event: TeamEvent) {
  actionError.value = ''
  confirmAction.value = { title: event.active ? '予定を非表示にしますか？' : '予定を再表示しますか？', message: `${event.title}（${dateLabel(event.date)}）の出欠記録は残ります。`, label: event.active ? '非表示にする' : '再表示する', action: async () => { await team.setEventActive(event.id, !event.active); notify('予定の表示を変更しました') } }
}
function togglePlayer(player: Player) {
  actionError.value = ''
  confirmAction.value = { title: player.active ? `${player.name}さんを退団扱いにしますか？` : `${player.name}さんを在籍に戻しますか？`, message: player.active ? '今後の出欠入力画面には表示されません。過去の出欠履歴は残ります。' : '今後の出欠入力画面に再び表示されます。', label: player.active ? '退団にする' : '在籍に戻す', action: async () => { await team.setPlayerActive(player.id, !player.active); notify('在籍状況を変更しました') } }
}
async function confirmChange() { const change = confirmAction.value; if (change) await perform(async () => { await change.action(); confirmAction.value = null }) }
const editingPlayer = ref<Player | null>(null)
const editName = ref('')
async function saveName() {
  if (!admin.value || !editingPlayer.value) return
  const id = editingPlayer.value.id, normalized = normalizeName(editName.value)
  if (!normalized || editName.value.trim().length > 30) { formError.value = '名前を1〜30文字で入力してください。'; return }
  if (data.value.players.some(p => p.id !== id && normalizeName(p.name) === normalized)) { formError.value = '同じ名前の選手が登録されています。'; return }
  await perform(async () => { await team.renamePlayer(id, editName.value.trim()); editingPlayer.value = null; notify('名前を変更しました') })
}
</script>


<template>
  <div>
    <header class="site-header">
      <div class="header-inner">
        <button class="brand" aria-label="South Dragons 出欠確認へ" @click="view = 'attendance'"><span class="brand-mark">SD<span>★</span></span><span><strong>SOUTH DRAGONS</strong><small>みんなの予定を、ひとつに。</small></span></button>
        <button class="btn btn-ghost manage-link" @click="openAdmin" :disabled="!ready || busy"><Settings2 :size="18" /><span>管理</span></button>
      </div>
      <nav class="nav-inner" aria-label="メインメニュー"><button :class="{ active: view === 'attendance' }" @click="view = 'attendance'"><ClipboardList :size="18" />出欠確認</button><button :class="{ active: view === 'admin' }" @click="openAdmin" :disabled="!ready || busy"><ShieldCheck :size="18" />チーム管理</button><span class="season-label">少年野球チーム</span></nav>
    </header>

    <main class="page-shell">
      <div v-if="ready" class="demo-label"><span class="demo-dot" />{{ isDemo ? 'デモモード' : 'チーム共有' }}<span class="demo-description">{{ isDemo ? 'サンプルデータ・変更はこのブラウザ内に保存' : 'South Dragons_J.B.C. 出欠管理' }}</span><button v-if="!isDemo" class="btn btn-ghost btn-sm ml-auto" :disabled="busy" @click="team.refresh"><RefreshCw :size="15" />更新</button></div>
      <div v-if="storageError" role="alert" class="alert alert-warning mb-5"><span>{{ storageError }}</span><button class="btn btn-sm" :disabled="busy" @click="team.refresh">再読み込み</button></div>
      <div v-if="actionError && !adminEntry && !registration && !selected && !eventEditor && !editingPlayer && !confirmAction" role="alert" class="alert alert-warning mb-5">{{ actionError }}</div>
      <template v-if="view === 'attendance'">
        <section class="page-intro"><div><p class="eyebrow">TEAM SCHEDULE</p><h1>みんなの予定、<br class="mobile-break" />ここで確認。</h1><p class="intro-description">練習も、試合も。出欠をそろえて、次の一日に備えよう。</p></div><div class="intro-emblem" aria-hidden="true"><span>ONE TEAM</span><strong>SD.</strong><span>LET'S PLAY BALL</span></div></section>
        <section v-if="ready && !myPlayers.length" class="join-card card"><div class="join-icon"><Users :size="24" /></div><div><h2>はじめての方はこちら</h2><p>お子さまの名前を登録して、出欠を入力しましょう。</p></div><button class="btn btn-primary" @click="openRegistration"><Plus :size="18" />名前を登録する</button></section>
        <section v-else-if="ready" class="family-bar"><div><span class="family-label">登録中の選手</span><span v-for="player in myPlayers" :key="player.id" class="family-name">{{ player.name }}</span></div><button class="btn btn-ghost btn-sm" @click="openRegistration"><Plus :size="16" />兄弟・選手を追加</button></section>
        <section v-if="requests.some(r => r.isMine && r.status === 'rejected' && !data.myPlayerIds.includes(r.playerId) && !team.pendingRequest(r.playerId))" class="alert alert-warning mb-4"><p>{{ multiDeviceAccess ? '端末追加の申請が承認されなかった選手がいます。' : '再登録申請が承認されなかった選手がいます。' }}運営者に確認してください。</p></section>
        <section v-if="myPendingRequests.length" class="alert alert-info mb-4"><div><strong>{{ multiDeviceAccess ? '端末追加の承認待ち' : '再登録の承認待ち' }}</strong><p v-for="request in myPendingRequests" :key="request.id">{{ request.playerName }}さん：{{ multiDeviceAccess ? '管理者の承認後に、この端末でも出欠を入力できます。' : '仮回答を入力できます。集計には承認後に反映されます。' }}</p></div></section>
        <section v-if="upcoming" class="next-event" aria-label="次の予定"><div class="next-tag">NEXT UP <ArrowRight :size="15" /></div><button @click="detail = upcoming"><strong>{{ dateLabel(upcoming.date) }}</strong><span>{{ upcoming.title }}</span><span class="next-location"><MapPin :size="15" />{{ upcoming.location }}</span><ChevronRight :size="18" /></button></section>
        <section class="schedule-section" aria-labelledby="schedule-title">
          <div class="schedule-toolbar"><div class="month-controls"><h2 id="schedule-title">{{ month.getFullYear() }}年 <strong>{{ month.getMonth() + 1 }}</strong>月</h2><div><button class="btn btn-ghost btn-circle btn-sm" aria-label="前の月" @click="monthOffset--"><ChevronLeft :size="19" /></button><button class="btn btn-ghost btn-circle btn-sm" aria-label="次の月" @click="monthOffset++"><ChevronRight :size="19" /></button></div><button v-if="monthOffset" class="btn btn-ghost btn-sm" @click="monthOffset = 0">今月</button></div><div class="segmented"><button :class="{ selected: !history }" @click="history = false">これからの予定</button><button :class="{ selected: history }" @click="history = true">過去の予定</button></div></div>
          <div class="table-topline"><p><span class="live-dot" />{{ activePlayers.length }}名が在籍中<span class="subtle"> · {{ events.length }}件の予定</span></p><label v-if="myPlayers.length" class="mine-toggle"><input v-model="onlyMine" type="checkbox" class="checkbox checkbox-primary checkbox-sm" />自分の子どもだけ</label><span v-else-if="events.length > 1" class="scroll-hint">日程を横にスクロール <ArrowRight :size="14" /></span></div>
          <div v-if="!ready" class="empty-state"><span v-if="busy" class="loading loading-spinner" />{{ storageError ? '予定を読み込めませんでした。再読み込みをお試しください。' : '予定を読み込んでいます' }}</div>
          <div v-else-if="!events.length" class="empty-state"><CalendarDays :size="36" /><h3>この期間の予定はありません</h3><p>別の月を選ぶと、その月の予定を確認できます。</p></div>
          <div v-else class="table-scroll" tabindex="0" role="region" :aria-label="events.length > 1 ? '出欠一覧。日程を横にスクロールできます' : '出欠一覧'">
            <table class="attendance-table" :style="{ '--event-count': events.length }"><caption class="sr-only">{{ month.getMonth() + 1 }}月の出欠一覧。○参加、△10時参加、×欠席、未は未回答。セルを選択して変更できます。</caption><thead><tr><th class="player-column" scope="col"><span>選手名</span><small>{{ players.length }}名</small></th><th v-for="event in events" :key="event.id" scope="col"><button class="event-heading" @click="detail = event"><span class="event-date" :class="{ sunday: new Date(event.date + 'T12:00:00').getDay() === 0 }">{{ dateLabel(event.date) }}</span><strong>{{ event.title }}</strong><small>{{ event.startTime }}–{{ event.endTime }}<Info :size="13" /></small></button></th></tr></thead>
              <tbody><tr v-for="(player, index) in players" :key="player.id" :class="{ 'my-row': data.myPlayerIds.includes(player.id) || (!multiDeviceAccess && !!team.pendingRequest(player.id)) }"><th class="player-column" scope="row"><span class="player-index">{{ String(index + 1).padStart(2, '0') }}</span><span>{{ player.name }}<small v-if="!player.active">退団済み</small><small v-else-if="team.pendingRequest(player.id)" class="my-label">{{ multiDeviceAccess ? '承認待ち' : '承認待ち・仮回答' }}</small><small v-else-if="data.myPlayerIds.includes(player.id)" class="my-label">あなたの選手</small></span></th><td v-for="event in events" :key="event.id"><button :class="['answer-cell', status(event.id, player.id) || 'unanswered']" :disabled="!player.active || history || busy || !team.canEdit(player.id)" :aria-label="`${player.name}、${dateLabel(event.date)} ${event.title}、${statusInfo(status(event.id, player.id))?.label || '未回答'}${!history && team.canEdit(player.id) ? '、変更する' : '、閲覧のみ'}`" @click="actionError = ''; selected = { player, event }">{{ statusInfo(status(event.id, player.id))?.symbol || '未' }}</button></td></tr><tr v-if="!players.length"><td :colspan="events.length + 1" class="no-players">表示する選手がいません。名前を登録してください。</td></tr></tbody>
              <tfoot><tr class="total-row"><th class="player-column" scope="row">参加人数 <small>○＋△</small></th><td v-for="event in events" :key="event.id"><strong>{{ totals(event.id).attend + totals(event.id).late }}</strong><span>名</span></td></tr><tr v-for="row in [{ key: 'late' as const, label: 'うち10時参加' }, { key: 'absent' as const, label: '欠席' }, { key: 'unanswered' as const, label: '未回答' }]" :key="row.key"><th class="player-column" scope="row">{{ row.label }}</th><td v-for="event in events" :key="event.id">{{ totals(event.id)[row.key] }}</td></tr></tfoot>
            </table>
          </div>
          <div class="table-bottom"><div class="legend"><span v-for="option in statusOptions" :key="option.value"><b :class="option.value">{{ option.symbol }}</b>{{ option.label }}</span><span><b class="unanswered">未</b>未回答</span></div><p>{{ history ? '過去の記録は閲覧のみです' : '登録した選手のマークをタップして変更' }}<span v-if="onlyMine"> · 集計はチーム全員</span></p></div>
        </section>
        <div class="help-line"><Info :size="16" /><p>予定の詳しい内容は、日付をタップして確認できます。</p></div>
      </template>

      <template v-else-if="admin">
        <div class="admin-heading"><div><p class="eyebrow">TEAM MANAGEMENT</p><h1>チーム管理</h1><p class="intro-description">予定と選手を、チームのみんなで管理。</p></div><button class="btn btn-ghost" :disabled="busy" @click="logout"><LogOut :size="18" />終了</button></div>
        <div v-if="isDemo" class="admin-demo-note"><Info :size="18" />管理機能のお試し画面です。本番のパスワード認証は共有先への接続後に有効になります。</div>
        <button v-if="isSupabase" class="btn btn-outline mb-4" @click="adminTab = 'requests'">{{ multiDeviceAccess ? '端末追加申請' : '再登録申請' }} <span class="badge badge-primary">{{ pendingRequestCount }}件</span></button>
        <section v-if="adminTab === 'requests'" class="admin-panel card mb-4"><h2>{{ multiDeviceAccess ? '端末追加申請' : '再登録申請' }}</h2><p v-if="!requests.length" class="py-4">申請はありません。</p><div v-for="request in requests" :key="request.id" class="management-row"><div><h3>{{ request.playerName }}</h3><p v-if="multiDeviceAccess">申請者：{{ request.applicantName || '旧方式の申請（名前未入力）' }}<span v-if="request.relation">（{{ request.relation }}）</span></p><p>{{ new Date(request.requestedAt).toLocaleString('ja-JP') }} · {{ request.status === 'pending' ? '承認待ち' : request.status === 'approved' ? '承認済み' : '却下済み' }}</p><p v-if="request.status === 'pending' && request.notificationStatus !== 'sent'" class="text-sm">LINE通知：{{ request.notificationStatus === 'unconfigured' ? '未設定' : request.notificationStatus === 'failed' ? '送信失敗' : '未送信' }}</p></div><div v-if="request.status === 'pending'" class="row-actions"><button class="btn btn-sm btn-primary" :disabled="busy" @click="reviewRequest(request.id, request.playerName, 'approved')">承認</button><button class="btn btn-sm btn-outline" :disabled="busy" @click="reviewRequest(request.id, request.playerName, 'rejected')">却下</button></div></div></section>
        <div class="admin-menu"><button v-for="item in [{ id: 'events' as const, title: 'イベント管理', desc: '予定の追加・編集', icon: CalendarDays }, { id: 'players' as const, title: '参加者管理', desc: '名前の編集・退団・復帰', icon: Users }, { id: 'password' as const, title: '管理パスワード', desc: '運営者の共通パスワード', icon: ShieldCheck }]" :key="item.id" class="card" :class="{ chosen: adminTab === item.id }" @click="adminTab = item.id"><component :is="item.icon" :size="23" /><strong>{{ item.title }}</strong><span>{{ item.desc }}</span></button></div>
        <section v-if="adminTab === 'events'" class="admin-panel card"><div class="panel-heading"><h2>イベント一覧</h2><button class="btn btn-primary" @click="editEvent()"><Plus :size="18" />予定を追加</button></div><div class="month-controls admin-month-controls"><h2 aria-live="polite">{{ adminMonth.getFullYear() }}年 <strong>{{ adminMonth.getMonth() + 1 }}</strong>月</h2><div><button class="btn btn-ghost btn-circle btn-sm" aria-label="イベント一覧を前月に切り替える" @click="shiftAdminMonth(-1)"><ChevronLeft :size="19" /></button><button class="btn btn-ghost btn-circle btn-sm" aria-label="イベント一覧を翌月に切り替える" @click="shiftAdminMonth(1)"><ChevronRight :size="19" /></button></div><button class="btn btn-ghost btn-sm" @click="resetAdminMonth">今月</button></div><div v-for="event in managedEvents" :key="event.id" class="management-row"><div><span class="meta">{{ dateLabel(event.date, true) }} · {{ event.startTime }}–{{ event.endTime }}</span><h3>{{ event.title }}<span v-if="!event.active" class="badge badge-ghost">非表示</span></h3><p>{{ event.location }}</p></div><div class="row-actions"><button class="btn btn-sm btn-ghost" @click="editEvent(event)">編集</button><button class="btn btn-sm btn-outline" @click="toggleEvent(event)">{{ event.active ? '非表示' : '再表示' }}</button></div></div><p v-if="!managedEvents.length" class="empty-state">この月の予定はありません。</p></section>
        <section v-if="adminTab === 'players'" class="admin-panel card"><div class="panel-heading"><h2>選手一覧</h2><label class="mine-toggle"><input v-model="showRetired" type="checkbox" class="checkbox checkbox-sm" />退団者を表示</label></div><div v-for="player in managedPlayers" :key="player.id" class="management-row"><div><h3>{{ player.name }}</h3><p>{{ player.active ? '在籍中' : '退団済み' }}</p></div><div class="row-actions"><button v-if="isSupabase && multiDeviceAccess" class="btn btn-sm btn-outline" @click="devicePlayer = player; actionError = ''">利用端末</button><button class="btn btn-sm btn-ghost" @click="editingPlayer = player; editName = player.name; formError = ''; actionError = ''">編集</button><button class="btn btn-sm btn-outline" @click="togglePlayer(player)">{{ player.active ? '退団' : '在籍に戻す' }}</button></div></div></section>
        <section v-if="adminTab === 'password'" class="admin-panel card"><h2 class="text-lg font-bold mb-4">管理パスワードの変更</h2><p v-if="isDemo">共有先への接続後に利用できます。</p><form v-else class="event-form max-w-md" @submit.prevent="changePassword"><fieldset :disabled="busy" class="event-form"><label class="form-field">現在のパスワード<input v-model="currentPassword" type="password" class="input" autocomplete="current-password" required maxlength="128" /></label><label class="form-field">新しいパスワード（12文字以上）<input v-model="newPassword" type="password" class="input" autocomplete="new-password" required minlength="12" maxlength="128" /></label><label class="form-field">新しいパスワード（確認）<input v-model="passwordAgain" type="password" class="input" autocomplete="new-password" required minlength="12" maxlength="128" /></label><p class="text-sm text-gray-500">変更すると、ほかの運営者も再ログインが必要になります。</p><button class="btn btn-primary" type="submit">{{ busy ? '変更中…' : 'パスワードを変更する' }}</button></fieldset></form></section>
      </template>
      <footer class="site-footer"><span class="footer-brand">SOUTH DRAGONS</span><span>ひとつのチームで、次の一球へ。</span><span>TEAM ATTENDANCE</span></footer>
    </main>

    <AppModal :busy="busy" :error="actionError" :open="registration" title="お子さまの名前を登録" @close="registration = false">
      <template v-if="duplicate"><div class="duplicate-note"><Users :size="30" /><h3>{{ duplicate.name }}さんは<br />すでに登録されています。</h3><p>{{ duplicate.active ? (isSupabase && !data.myPlayerIds.includes(duplicate.id) ? (multiDeviceAccess ? 'ご家族の追加や機種変更の場合は、この端末の利用を申請してください。管理者の承認後、現在の端末と一緒に使えます。' : '以前登録した参加者ですか？ 端末を変更した場合は再登録を申請してください。管理者の承認後に編集権限を引き継ぎます。') : 'この選手を使用しますか？') : '退団扱いになっています。運営者に在籍への復帰を依頼してください。' }}</p></div><div v-if="multiDeviceAccess && duplicate.active && !data.myPlayerIds.includes(duplicate.id)" class="event-form mt-4"><label class="form-field">申請者のお名前<input v-model="applicantName" class="input" autocomplete="name" maxlength="30" placeholder="例：山田 花子" /></label><label class="form-field">お子さまとの続柄<select v-model="applicantRelation" class="select"><option disabled value="">選択してください</option><option v-for="relation in ['父','母','祖父母','その他']" :key="relation">{{ relation }}</option></select></label><p class="text-sm">承認後に出欠を入力できます。現在の出欠回答はそのまま残ります。</p><p v-if="formError" class="field-error" role="alert">{{ formError }}</p></div><div class="modal-actions"><button class="btn btn-ghost" @click="duplicate = null">戻る</button><button v-if="duplicate.active" class="btn btn-primary" @click="recoverPlayer(duplicate)">{{ isSupabase && !data.myPlayerIds.includes(duplicate.id) ? (multiDeviceAccess ? 'この端末の利用を申請する' : '再登録を申請する') : 'この選手を使用する' }}</button></div></template>
      <form v-else @submit.prevent="register"><p class="form-description">名前を入力するだけで登録できます。<br />兄弟がいる場合は、ひとりずつ追加してください。</p><label class="form-field">お子さまの名前<input v-model="name" class="input w-full" placeholder="例：山田 太郎" autocomplete="off" maxlength="40" required /></label><p v-if="formError" class="field-error" role="alert">{{ formError }}</p><button class="btn btn-primary w-full mt-6" type="submit"><Plus :size="18" />登録する</button></form>
    </AppModal>
    <AppModal :busy="busy" :error="actionError" :open="!!selected" title="出欠を入力" @close="selected = null"><template v-if="selected"><div class="answer-person"><span class="avatar-letter">{{ selected.player.name.charAt(0) }}</span><div><h3>{{ selected.player.name }}</h3><p>{{ dateLabel(selected.event.date, true) }} · {{ selected.event.title }}</p></div></div><div class="answer-options"><button v-for="option in statusOptions" :key="option.value" :class="['answer-option', option.value, { current: status(selected.event.id, selected.player.id) === option.value }]" @click="saveStatus(option.value)"><span>{{ option.symbol }}</span><strong>{{ option.label }}</strong><Check v-if="status(selected.event.id, selected.player.id) === option.value" :size="20" /></button></div><button class="btn btn-ghost w-full mt-3" @click="saveStatus(null)">未回答に戻す</button><p class="save-hint">{{ !multiDeviceAccess && team.pendingRequest(selected.player.id) ? '仮回答として保存します。管理者の承認後に正式な出欠へ反映されます。' : '選ぶと出欠が保存されます。' }}</p></template></AppModal>
    <AppModal :busy="busy" :error="actionError" :open="!!detail" title="予定の詳細" @close="detail = null"><template v-if="detail"><p class="detail-date">{{ dateLabel(detail.date, true) }}</p><h3 class="detail-title">{{ detail.title }}</h3><dl class="event-details"><div><dt><Clock3 :size="18" />時間</dt><dd>{{ detail.startTime }}〜{{ detail.endTime }}</dd></div><div><dt><MapPin :size="18" />場所</dt><dd>{{ detail.location }}</dd></div><div><dt><ClipboardList :size="18" />備考</dt><dd class="whitespace-pre-wrap">{{ detail.note || '備考はありません' }}</dd></div></dl><button class="btn btn-primary w-full" @click="detail = null">閉じる</button></template></AppModal>
    <AppModal :busy="busy" :error="actionError" :open="adminEntry" title="チーム管理" @close="adminEntry = false"><template v-if="isDemo"><div class="admin-welcome"><ShieldCheck :size="38" /><h3>管理画面を試してみる</h3><p>予定の追加や、選手の退団・復帰を試せます。<br />変更はこのブラウザのみに保存されます。</p><div class="admin-demo-note">デモではパスワード認証を行いません。</div></div><button class="btn btn-primary w-full" @click="enterAdmin">デモ管理画面を開く<ArrowRight :size="18" /></button></template><form v-else class="event-form" @submit.prevent="enterAdmin"><p class="form-description">{{ adminConfigured ? '運営者の共通管理パスワードを入力してください。' : '最初の運営者が共通管理パスワードを設定してください。' }}</p><label v-if="!adminConfigured" class="form-field">初期設定コード<input v-model="setupCode" type="password" class="input" autocomplete="off" required /><span class="text-xs font-normal">初期設定時に用意したコードを入力</span></label><label class="form-field">{{ adminConfigured ? '管理パスワード' : '管理パスワード（12文字以上）' }}<input v-model="adminPassword" type="password" class="input" :autocomplete="adminConfigured ? 'current-password' : 'new-password'" :minlength="adminConfigured ? 1 : 12" maxlength="128" required /></label><label v-if="!adminConfigured" class="form-field">管理パスワード（確認）<input v-model="initialPasswordAgain" type="password" class="input" autocomplete="new-password" minlength="12" maxlength="128" required /></label><button class="btn btn-primary" type="submit">{{ adminConfigured ? 'ログイン' : 'パスワードを設定する' }}</button></form></AppModal>
    <AppModal :busy="busy" :error="actionError" :open="eventEditor" :title="creatingEvent ? '予定を追加' : '予定を編集'" @close="eventEditor = false"><form class="event-form" @submit.prevent="saveEvent"><label class="form-field">予定名<input v-model="eventDraft.title" class="input" placeholder="通常練習" required maxlength="60" /></label><label class="form-field">開催日<input v-model="eventDraft.date" type="date" class="input" required /></label><div class="form-columns"><label class="form-field">開始時間<input v-model="eventDraft.startTime" type="time" class="input" required /></label><label class="form-field">終了時間<input v-model="eventDraft.endTime" type="time" class="input" required /></label></div><label class="form-field">場所<input v-model="eventDraft.location" class="input" placeholder="南小学校グラウンド" required maxlength="100" /></label><label class="form-field">備考 <span class="optional">任意</span><textarea v-model="eventDraft.note" class="textarea" rows="3" placeholder="集合時間・持ち物など" maxlength="1000" /></label><label class="form-field">登録者名 <span class="optional">任意</span><input v-model="eventDraft.createdByName" class="input" placeholder="山田" maxlength="30" /></label><p v-if="formError" class="field-error" role="alert">{{ formError }}</p><button type="submit" class="btn btn-primary w-full">{{ creatingEvent ? '予定を登録する' : '変更を保存する' }}</button></form></AppModal>
    <AppModal :busy="busy" :error="actionError" :open="!!editingPlayer" title="選手名を編集" @close="editingPlayer = null"><form @submit.prevent="saveName"><label class="form-field">名前<input v-model="editName" class="input" required maxlength="40" /></label><p v-if="formError" class="field-error" role="alert">{{ formError }}</p><button class="btn btn-primary w-full mt-5" type="submit">保存する</button></form></AppModal>
    <AppModal :busy="busy" :error="actionError" :open="!!devicePlayer && admin" title="利用端末" @close="devicePlayer = null"><template v-if="devicePlayer"><h3 class="text-lg font-bold">{{ devicePlayer.name }}</h3><p class="form-description">ここに表示された端末から出欠を入力できます。紛失した端末や使わなくなった端末は、編集権限を解除してください。</p><p v-if="!selectedDeviceAccess.length" class="py-4">利用できる端末はありません。保護者からの利用申請を承認してください。</p><div v-for="access in selectedDeviceAccess" :key="access.id" class="management-row"><div><h3>{{ access.applicantName || '登録時の端末' }}<span v-if="access.relation">（{{ access.relation }}）</span><span v-if="access.isCurrentDevice" class="badge badge-ghost">この端末</span></h3><p>登録：{{ new Date(access.grantedAt).toLocaleString('ja-JP') }}</p><p v-if="access.lastSeenAt">最終利用：{{ new Date(access.lastSeenAt).toLocaleString('ja-JP') }}</p></div><button class="btn btn-sm btn-outline" @click="revokeDevice(access)">権限を解除</button></div><button class="btn btn-ghost w-full mt-4" @click="devicePlayer = null">閉じる</button></template></AppModal>
    <AppModal :busy="busy" :error="actionError" :open="!!confirmAction" :title="confirmAction?.title || ''" @close="confirmAction = null"><p class="form-description">{{ confirmAction?.message }}</p><div class="modal-actions"><button class="btn btn-ghost" @click="confirmAction = null">キャンセル</button><button class="btn btn-primary" @click="confirmChange">{{ confirmAction?.label }}</button></div></AppModal>
    <div v-if="notice" class="toast toast-center" role="status"><div class="notice"><Check :size="18" />{{ notice }}</div></div>
  </div>
</template>
