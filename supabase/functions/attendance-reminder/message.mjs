/** Pure formatting logic; no external credentials or database access. */
export function buildReminderText(targetDate, events, attendance, players) {
  const playerMap = new Map(players.filter(p => p.active).map(p => [p.id, p.name]))
  const absentByEvent = new Map()
  for (const answer of attendance) {
    if (answer.status !== 'absent') continue
    const name = playerMap.get(answer.player_id)
    if (!name) continue
    const current = absentByEvent.get(answer.event_id) || new Set()
    current.add(name)
    absentByEvent.set(answer.event_id, current)
  }
  const sections = events
    .map(event => ({event, names: [...(absentByEvent.get(event.id) || [])].sort((a,b)=>a.localeCompare(b,'ja'))}))
    .filter(section => section.names.length)
  if (!sections.length) return null
  const d = new Date(`${targetDate}T00:00:00Z`)
  const weekday = ['日','月','火','水','木','金','土'][d.getUTCDay()]
  return `⚾ South Dragons 出欠連絡\n${targetDate}（${weekday}）の欠席情報\n\n` +
    sections.map(section => `【${section.event.title}】\n❌ 欠席：${section.names.length}人\n${section.names.join('\n')}`).join('\n\n')
}
