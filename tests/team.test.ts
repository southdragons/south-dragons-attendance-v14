import { describe, expect, it } from 'vitest'
import { countsFor, createDemoData, createId, normalizeName, parseStoredData, setAnswer, visiblePlayers } from '../app/utils/team'
describe('出欠データ', () => {
  it('選手と予定に重複しないUUIDを発行する', () => {
    const id = createId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(createId()).not.toBe(id)
  })
  it('半角・全角スペースを同一視し、かな変換はしない', () => {
    expect(normalizeName(' 山田　太郎 ')).toBe(normalizeName('山田太郎'))
    expect(normalizeName('やまだたろう')).not.toBe(normalizeName('山田太郎'))
  })
  it('回答を上書きでき、未回答へ戻すと記録が除去される', () => {
    const d = createDemoData(); setAnswer(d, 'e1', 'p1', 'attend'); setAnswer(d, 'e1', 'p1', 'late')
    expect(d.attendance.filter(a => a.eventId === 'e1' && a.playerId === 'p1')).toHaveLength(1)
    expect(d.attendance.find(a => a.eventId === 'e1' && a.playerId === 'p1')?.status).toBe('late')
    setAnswer(d, 'e1', 'p1', null)
    expect(d.attendance.find(a => a.eventId === 'e1' && a.playerId === 'p1')).toBeUndefined()
  })
  it('退団者は通常一覧から除外し、過去の回答は保持する', () => {
    const d = createDemoData(); setAnswer(d, 'e1', 'p1', 'attend'); d.players[0]!.active = false
    expect(visiblePlayers(d.players, d.events, d.attendance, false).some(p => p.id === 'p1')).toBe(false)
    expect(visiblePlayers(d.players, d.events, d.attendance, true).some(p => p.id === 'p1')).toBe(true)
    expect(() => setAnswer(d, 'e1', 'p1', 'absent')).toThrow()
    expect(d.attendance.find(a => a.playerId === 'p1')?.status).toBe('attend')
  })
  it('全ステータスと未回答の集計が在籍人数と一致する', () => {
    const d = createDemoData(); const c = countsFor('e1', d.players, d.attendance)
    expect(c.attend + c.late + c.absent + c.unanswered).toBe(d.players.length)
  })
  it('非表示の予定への入力を拒否する', () => {
    const d = createDemoData(); d.events[0]!.active = false
    expect(() => setAnswer(d, 'e1', 'p1', 'attend')).toThrow()
  })
  it('保存済みデータの形式を検証する', () => {
    const d = createDemoData(); expect(parseStoredData(JSON.stringify(d))).toEqual(d)
    expect(() => parseStoredData('{"version":1}')).toThrow()
    d.attendance[0]!.status = 'broken' as never
    expect(() => parseStoredData(JSON.stringify(d))).toThrow()
  })
  it('月末にも正しい開催日を作る', () => {
    const d = createDemoData(new Date('2026-09-30T12:00:00'))
    expect(d.events[0]!.date).toBe('2026-10-03')
    expect(d.events[1]!.date).toBe('2026-10-04')
  })
})
