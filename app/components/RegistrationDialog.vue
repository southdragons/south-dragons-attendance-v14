<script setup lang="ts">
// Phase 4-F registration: two separate entrances so a mistyped name never silently becomes a new player.
//  - New player: name -> server check -> final confirmation (similar names are a warning only) -> create.
//  - Device for a registered player: team-code devices and admins pick from the roster; other devices
//    enter the team code, or type the exact name (no lists or hints are shown to them).
import { Check, KeyRound, Plus, Search, Smartphone, TriangleAlert, Users } from 'lucide-vue-next'
import type { Player } from '~/types/team'
import type { DeviceCandidate, TeamError } from '~/composables/useTeam'
import { normalizeName } from '~/utils/team'

const props = defineProps<{ open: boolean; team: ReturnType<typeof useTeam> }>()
const emit = defineEmits<{ close: []; done: [message: string] }>()
const team = props.team
const { busy, data, isSupabase, multiDeviceAccess } = team

type Step = 'choose' | 'new-name' | 'new-confirm' | 'device' | 'request' | 'retired'
const step = ref<Step>('choose')
const name = ref('')
const similar = ref<Pick<Player, 'id' | 'name'>[]>([])
const similarVisible = ref(false)
const nameChecked = ref(false)
const candidates = ref<DeviceCandidate[]>([])
const rosterAllowed = ref<boolean | null>(null)
const filter = ref('')
const exactName = ref('')
const codeInput = ref('')
const codeLabel = ref('')
const target = ref<Pick<Player, 'id' | 'name'> | null>(null)
const targetWasDuplicate = ref(false)
const applicantName = ref('')
const applicantRelation = ref('')
const error = ref('')

function reset() {
  step.value = 'choose'; name.value = ''; similar.value = []; similarVisible.value = false; nameChecked.value = false
  candidates.value = []; rosterAllowed.value = null; filter.value = ''; exactName.value = ''; codeInput.value = ''; codeLabel.value = ''
  target.value = null; targetWasDuplicate.value = false; applicantName.value = ''; applicantRelation.value = ''; error.value = ''
}
watch(() => props.open, open => { if (open) reset() })
const title = computed(() => ({ choose: 'お子さまの登録', 'new-name': '新しい選手を登録', 'new-confirm': '登録内容の確認', device: '登録済み選手の端末を追加', request: 'この端末の利用を申請', retired: 'お子さまの登録' })[step.value])
const mine = (id: string) => data.value.myPlayerIds.includes(id)
async function run(work: () => Promise<void>) { error.value = ''; try { await work() } catch (e) { error.value = (e as Error).message } }

// --- New player
async function checkName() {
  const trimmed = name.value.trim()
  if (!normalizeName(trimmed) || trimmed.length > 30) { error.value = '名前を1〜30文字で入力してください。'; return }
  await run(async () => {
    const result = await team.registerName(trimmed, false)
    if (result.duplicate) { openTarget(result.player, true); return }
    if ('needsConfirmation' in result && result.needsConfirmation) {
      similar.value = result.similar; similarVisible.value = result.similarVisible; nameChecked.value = false; step.value = 'new-confirm'
    }
  })
}
async function createPlayer() {
  if (!nameChecked.value) { error.value = '名前に間違いがないことを確認してください。'; return }
  await run(async () => {
    const result = await team.registerName(name.value.trim(), true)
    if (result.duplicate) { openTarget(result.player, true); return }
    if ('player' in result && result.player) { team.rememberPlayer(result.player); emit('done', `${result.player.name}さんを登録しました`) }
  })
}

// --- Device for a registered player
async function openDevice() {
  step.value = 'device'; error.value = ''
  await run(async () => { const r = await team.listDeviceCandidates(); rosterAllowed.value = r.allowed; candidates.value = r.players })
}
const filtered = computed(() => { const f = normalizeName(filter.value); return f ? candidates.value.filter(c => normalizeName(c.name).includes(f)) : candidates.value })
function codeMessage(e: TeamError) {
  if (e.code === 'TEAM_CODE_INVALID') return 'チームコードが正しくありません。チームLINEのお知らせを確認して、もう一度入力してください。'
  if (e.code === 'RATE_LIMITED') return '入力の回数が多すぎます。15分ほど待ってから、もう一度お試しください。'
  return e.message
}
async function submitCode() {
  if (!codeInput.value.trim()) { error.value = 'チームコードを入力してください。'; return }
  error.value = ''
  try { await team.verifyTeamCode(codeInput.value, codeLabel.value.trim()); codeInput.value = ''; await openDevice() }
  catch (e) { error.value = codeMessage(e as TeamError) }
}
async function findExact() {
  const trimmed = exactName.value.trim()
  if (!normalizeName(trimmed) || trimmed.length > 30) { error.value = '名前を1〜30文字で入力してください。'; return }
  await run(async () => {
    const r = await team.findPlayerForDevice(trimmed)
    if (r.limited) { error.value = '入力の回数が多すぎます。15分ほど待ってから、もう一度お試しください。'; return }
    if (!r.found || !r.player) { error.value = '登録どおりの名前で見つかりませんでした。名前を確認するか、チームコードを入力してください。'; return }
    openTarget(r.player, false)
  })
}

// --- Request (or, outside multi-device mode, use the player on this device)
function openTarget(player: Pick<Player, 'id' | 'name'> & { active?: boolean }, duplicate: boolean) {
  if (player.active === false) { target.value = player; step.value = 'retired'; return }
  target.value = player; targetWasDuplicate.value = duplicate; error.value = ''; step.value = 'request'
}
async function submitRequest() {
  const player = target.value
  if (!player) return
  if (!isSupabase.value || mine(player.id)) {
    const full = data.value.players.find(p => p.id === player.id)
    if (full) team.rememberPlayer(full)
    emit('done', `${player.name}さんを登録しました`); return
  }
  if (multiDeviceAccess.value && (!applicantName.value.trim() || applicantName.value.trim().length > 30 || !['父', '母', '祖父母', 'その他'].includes(applicantRelation.value))) { error.value = '申請者のお名前と続柄を入力してください。'; return }
  await run(async () => {
    await team.requestRegistration(player.id, applicantName.value.trim(), applicantRelation.value)
    emit('done', multiDeviceAccess.value ? '端末の追加を申請しました。承認後に出欠を入力できます' : '再登録を申請しました。承認待ちでも仮回答できます')
  })
}
</script>

<template>
  <AppModal :busy="busy" :error="error" :open="open" :title="title" @close="emit('close')">
    <!-- 1. Two entrances -->
    <div v-if="step === 'choose'" class="registration-choice">
      <p class="form-description">お子さまの状況に合わせて選んでください。</p>
      <button class="choice-card" data-testid="choose-new" @click="step = 'new-name'; error = ''"><Plus :size="22" /><span><strong>新しい選手を登録する</strong><small>チームに新しく入ったお子さまを、初めて登録します。</small></span></button>
      <button class="choice-card" data-testid="choose-device" @click="openDevice"><Smartphone :size="22" /><span><strong>登録済み選手の端末を追加する</strong><small>すでに登録されているお子さまを、この端末でも入力できるようにします（ご家族の端末・機種変更など）。</small></span></button>
    </div>

    <!-- 2a. New player: name -->
    <form v-else-if="step === 'new-name'" class="event-form" @submit.prevent="checkName">
      <p class="form-description">登録の前に、同じ・似た名前がないか確認します。兄弟がいる場合は、ひとりずつ登録してください。</p>
      <label class="form-field">お子さまの名前<input v-model="name" class="input w-full" placeholder="例：山田 太郎" autocomplete="off" maxlength="40" required /></label>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" @click="step = 'choose'; error = ''">戻る</button><button class="btn btn-primary" type="submit">次へ</button></div>
    </form>

    <!-- 2b. New player: final confirmation (nothing is created before this) -->
    <div v-else-if="step === 'new-confirm'" class="event-form" data-testid="new-confirm">
      <p class="form-description">次の名前で、<strong>新しい選手</strong>として登録します。</p>
      <p class="confirm-name">{{ name.trim() }}</p>
      <div v-if="similar.length" class="alert alert-warning" role="alert" data-testid="similar-warning">
        <TriangleAlert :size="20" />
        <div><strong>似た名前の選手が登録されています</strong><p>同じお子さまの場合は、新しく登録せず「この選手の端末を追加」を選んでください。兄弟など別のお子さまの場合は、このまま登録できます。</p>
          <ul class="similar-list"><li v-for="p in similar" :key="p.id"><span>{{ p.name }}</span><button class="btn btn-xs btn-outline" @click="openTarget(p, true)">この選手の端末を追加</button></li></ul></div>
      </div>
      <div v-else-if="!similarVisible" class="alert alert-info" role="note" data-testid="similar-hidden"><Users :size="20" /><p>すでに登録されているお子さまの場合は、ここで登録せず、最初の画面の「登録済み選手の端末を追加する」から申請してください。</p></div>
      <label class="confirm-check"><input v-model="nameChecked" type="checkbox" class="checkbox checkbox-primary checkbox-sm" data-testid="name-checked" />名前に間違いがなく、新しく入ったお子さまであることを確認しました</label>
      <div class="modal-actions"><button class="btn btn-ghost" @click="step = 'new-name'; error = ''">名前を直す</button><button class="btn btn-primary" data-testid="create-player" :disabled="!nameChecked" @click="createPlayer">新しい選手として登録する</button></div>
    </div>

    <!-- 3. Device for a registered player -->
    <div v-else-if="step === 'device'" class="event-form">
      <p v-if="rosterAllowed === null" class="py-4">確認しています…</p>
      <template v-else-if="rosterAllowed">
        <p class="form-description">この端末で出欠を入力したいお子さまを選んでください。管理者の承認後に入力できます。</p>
        <label v-if="candidates.length > 8" class="form-field"><span class="sr-only">名前で絞り込む</span><span class="search-field"><Search :size="16" /><input v-model="filter" class="input w-full" placeholder="名前で絞り込む" autocomplete="off" /></span></label>
        <ul class="candidate-list" data-testid="candidate-list">
          <li v-for="c in filtered" :key="c.id"><span>{{ c.name }}</span>
            <span v-if="c.mine" class="badge badge-ghost">この端末で入力できます</span>
            <span v-else-if="c.pending" class="badge badge-ghost">承認待ち</span>
            <button v-else class="btn btn-sm btn-outline" @click="openTarget(c, false)">選ぶ</button></li>
          <li v-if="!filtered.length" class="py-2">該当するお子さまがいません。</li>
        </ul>
      </template>
      <template v-else>
        <p class="form-description">登録済みのお子さまを選ぶには、チームコードの入力が必要です。</p>
        <form class="event-form" @submit.prevent="submitCode">
          <label class="form-field">チームコード<input v-model="codeInput" class="input" placeholder="SD-XXXX-XXXX" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="24" /></label>
          <label class="form-field">お名前・続柄 <span class="optional">任意</span><input v-model="codeLabel" class="input" maxlength="30" placeholder="例：山田（母）" autocomplete="off" /></label>
          <button class="btn btn-primary" type="submit"><KeyRound :size="17" />チームコードを確認する</button>
        </form>
        <details class="exact-name" data-testid="exact-name">
          <summary>チームコードが分からない場合</summary>
          <form class="event-form mt-3" @submit.prevent="findExact">
            <p class="text-sm">お子さまの名前を、<strong>登録されているとおりに</strong>入力してください（候補は表示されません）。</p>
            <label class="form-field">お子さまの名前<input v-model="exactName" class="input w-full" autocomplete="off" maxlength="40" /></label>
            <button class="btn btn-outline" type="submit">この名前で探す</button>
          </form>
        </details>
      </template>
      <div class="modal-actions"><button class="btn btn-ghost" @click="step = 'choose'; error = ''">戻る</button></div>
    </div>

    <!-- 4. Request -->
    <div v-else-if="step === 'request' && target" class="event-form" data-testid="request-step">
      <div class="duplicate-note"><Users :size="30" /><h3>{{ target.name }}さん</h3>
        <p>{{ targetWasDuplicate ? 'すでに登録されています。' : '' }}{{ isSupabase && !mine(target.id) ? (multiDeviceAccess ? 'この端末の利用を申請します。管理者の承認後、今お使いの端末と一緒に使えます。' : '再登録を申請します。管理者の承認後に編集権限を引き継ぎます。') : 'この端末で、このお子さまを使用します。' }}</p></div>
      <template v-if="isSupabase && multiDeviceAccess && !mine(target.id)">
        <label class="form-field">申請者のお名前<input v-model="applicantName" class="input" autocomplete="name" maxlength="30" placeholder="例：山田 花子" /></label>
        <label class="form-field">お子さまとの続柄<select v-model="applicantRelation" class="select"><option disabled value="">選択してください</option><option v-for="relation in ['父','母','祖父母','その他']" :key="relation">{{ relation }}</option></select></label>
        <p class="text-sm">承認後に出欠を入力できます。現在の出欠回答はそのまま残ります。</p>
      </template>
      <div class="modal-actions"><button class="btn btn-ghost" @click="step = 'choose'; error = ''">戻る</button><button class="btn btn-primary" data-testid="submit-request" @click="submitRequest"><Check :size="17" />{{ isSupabase && !mine(target.id) ? (multiDeviceAccess ? 'この端末の利用を申請する' : '再登録を申請する') : 'この選手を使用する' }}</button></div>
    </div>

    <!-- Retired -->
    <div v-else-if="step === 'retired' && target" class="duplicate-note"><Users :size="30" /><h3>{{ target.name }}さんは<br />すでに登録されています。</h3><p>退団扱いになっています。運営者に在籍への復帰を依頼してください。</p><button class="btn btn-ghost" @click="step = 'choose'">戻る</button></div>
  </AppModal>
</template>
