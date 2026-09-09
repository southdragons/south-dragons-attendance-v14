import type { Attendance, AttendanceStatus, Player, TeamData, TeamEvent } from '../types/team'
export const statusOptions = [
  { value: 'attend' as const, symbol: '○', label: '参加', short: '参加' },
  { value: 'late' as const, symbol: '△', label: '10時参加', short: '10時参加' },
  { value: 'absent' as const, symbol: '×', label: '欠席', short: '欠席' },
]
export function normalizeName(name: string) { return name.replace(/[\s\u3000]+/g, '') }
export function createId() {
  // LAN HTTP previews do not expose crypto.randomUUID in every browser.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function localDate(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export function dateLabel(date: string, full = false) {
  return new Intl.DateTimeFormat('ja-JP', { month: full ? 'long' : 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(`${date}T12:00:00`))
}
export function visiblePlayers(players: Player[], events: TeamEvent[], attendance: Attendance[], history: boolean) {
  if (!history) return players.filter(p => p.active)
  return players.filter(p => p.active || attendance.some(a => a.playerId === p.id && events.some(e => e.id === a.eventId)))
}
export function countsFor(eventId: string, players: Player[], attendance: Attendance[]) {
  const counts = { attend: 0, late: 0, absent: 0, unanswered: 0 }
  for (const player of players) {
    const answer = attendance.find(a => a.eventId === eventId && a.playerId === player.id)
    if (answer) counts[answer.status]++; else counts.unanswered++
  }
  return counts
}
export function setAnswer(data: TeamData, eventId: string, playerId: string, status: AttendanceStatus | null) {
  if (!data.players.some(p => p.id === playerId && p.active) || !data.events.some(e => e.id === eventId && e.active)) throw new Error('この選手または予定は現在入力できません。')
  data.attendance = data.attendance.filter(a => !(a.eventId === eventId && a.playerId === playerId))
  if (status) data.attendance.push({ eventId, playerId, status, updatedAt: new Date().toISOString() })
}
export function parseStoredData(raw: string): TeamData {
  const d = JSON.parse(raw)
  const str = (v: unknown) => typeof v === 'string'
  if (d?.version !== 1 || !Array.isArray(d.players) || !Array.isArray(d.events) || !Array.isArray(d.attendance) || !Array.isArray(d.myPlayerIds)) throw new Error('保存データを読み込めません。')
  if (!d.players.every((p: Player) => p && str(p.id) && str(p.name) && typeof p.active === 'boolean' && str(p.joinedAt) && (p.retiredAt === null || str(p.retiredAt))) ||
    !d.events.every((e: TeamEvent) => e && ['id', 'date', 'title', 'startTime', 'endTime', 'location', 'note', 'createdByName'].every(k => str(e[k as keyof TeamEvent])) && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && typeof e.active === 'boolean') ||
    !d.attendance.every((a: Attendance) => a && str(a.eventId) && str(a.playerId) && str(a.updatedAt) && ['attend', 'late', 'absent'].includes(a.status)) || !d.myPlayerIds.every(str)) throw new Error('保存データの形式が正しくありません。')
  return d as TeamData
}
export function createDemoData(now = new Date()): TeamData {
  const saturday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  saturday.setDate(saturday.getDate() + (6 - saturday.getDay() + 7) % 7)
  const names = ['山田 太郎', '山田 次郎', '佐藤 一郎', '鈴木 蓮', '高橋 湊', '田中 悠真', '伊藤 大和', '渡辺 陽太', '中村 蒼', '小林 律', '加藤 晴', '吉田 樹']
  const players: Player[] = names.map((name, i) => ({ id: `p${i + 1}`, name, active: true, joinedAt: now.toISOString(), retiredAt: null }))
  const events: TeamEvent[] = [0, 1, 7, 8, 14, 15].map((offset, i) => {
    const day = new Date(saturday); day.setDate(day.getDate() + offset)
    return { id: `e${i + 1}`, date: localDate(day), title: ['通常練習', '練習試合', '秋季大会', '通常練習', '通常練習', '練習試合'][i]!, startTime: i === 1 ? '07:30' : '08:00', endTime: i === 1 ? '13:00' : '12:00', location: i === 2 ? '市民球場' : '南小学校グラウンド', note: i === 1 ? '7:15集合。ユニフォーム着用、昼食・水筒を持参してください。' : '帽子・水筒・タオルを忘れずに。雨天時は別途お知らせします。', createdByName: '山田', active: true }
  })
  const attendance: Attendance[] = []
  events.forEach((event, ei) => players.forEach((player, pi) => {
    if ((pi + ei) % 5 === 0 || ei > 3) return
    attendance.push({ eventId: event.id, playerId: player.id, status: (pi + ei) % 7 === 0 ? 'absent' : (pi + ei) % 4 === 0 ? 'late' : 'attend', updatedAt: now.toISOString() })
  }))
  return { version: 1, players, events, attendance, myPlayerIds: [] }
}
