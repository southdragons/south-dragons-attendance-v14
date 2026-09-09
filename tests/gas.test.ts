import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'

// Execute the actual deployable GAS source against in-memory Google service doubles.
// This checks API logic, not Google's deployment, permissions, or cell rendering.
function harness() {
  const properties: Record<string, string> = {}
  const sheets = new Map<string, Sheet>()
  class Sheet {
    values: any[][] = []
    constructor(public name: string) {}
    getLastRow() { return this.values.length }
    setFrozenRows() { return this }
    getRange(row: number, col: number, height: number, width: number) {
      const owner = this
      const range = {
        getDisplayValues: () => Array.from({ length: height }, (_, ri) => Array.from({ length: width }, (_, ci) => String(owner.values[row - 1 + ri]?.[col - 1 + ci] ?? '').replace(/^'(?=[\s]*[=+\-@])/, ''))),
        setValues: (values: any[][]) => { values.forEach((r, ri) => { owner.values[row - 1 + ri] ||= []; r.forEach((v, ci) => owner.values[row - 1 + ri]![col - 1 + ci] = v) }); return range },
        setNumberFormat: () => range, setBackground: () => range, setFontColor: () => range, setFontWeight: () => range,
      }
      return range
    }
    deleteRow(row: number) { this.values.splice(row - 1, 1) }
  }
  const spreadsheet = { getId: () => 'sheet-test', getSheetByName: (name: string) => sheets.get(name), insertSheet: (name: string) => { const s = new Sheet(name); sheets.set(name, s); return s }, setSpreadsheetTimeZone: () => {} }
  const props = { getProperty: (key: string) => properties[key] || null, setProperty: (key: string, value: string) => { properties[key] = value }, deleteProperty: (key: string) => { delete properties[key] }, getProperties: () => ({ ...properties }) }
  let held = false
  const context = createContext({
    console: { log: () => {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, openById: () => spreadsheet, flush: () => {} },
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ waitLock: () => { held = true }, tryLock: () => { held = true; return true }, hasLock: () => held, releaseLock: () => { held = false } }) },
    Utilities: { getUuid: randomUUID, DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (_algorithm: string, text: string) => Array.from(createHash('sha256').update(text).digest()), formatDate: () => '2026-09-08' },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ setMimeType: () => text }) },
  })
  runInContext(readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8'), context)
  const call = (action: string, payload = {}, token = '', key = properties.API_KEY) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ apiKey: key, action, payload, adminToken: token }) } }))
  const setup = () => context.setupSouthDragons()
  const initialize = () => call('initializeAdmin', { setupCode: properties.ADMIN_SETUP_CODE, salt: 'a'.repeat(64), proof: 'b'.repeat(64) }).data.token as string
  return { properties, sheets, call, setup, initialize, context }
}
let h: ReturnType<typeof harness>
beforeEach(() => { h = harness(); h.setup() })
const event = () => ({ id: randomUUID(), date: '2026-09-12', title: '通常練習', startTime: '08:00', endTime: '12:00', location: '南小学校', note: '', createdByName: '山田', active: true })
describe('GAS setup and authorization', () => {
  it('creates four sheets idempotently, preserves rows and secrets', () => {
    const key = h.properties.API_KEY
    h.call('registerPlayer', { name: '山田 太郎' }); h.setup()
    expect(h.sheets.size).toBe(4); expect(h.properties.API_KEY).toBe(key)
    expect(h.call('getData').data.players).toHaveLength(1)
  })
  it('rejects malformed existing headers without overwriting them', () => {
    h.sheets.get('players')!.values[0]![0] = 'wrong'
    expect(() => h.setup()).toThrow()
    expect(h.sheets.get('players')!.values[0]![0]).toBe('wrong')
  })
  it('rejects missing API keys and never exposes settings or secrets in a snapshot', () => {
    expect(h.call('getData', {}, '', 'wrong').error.code).toBe('FORBIDDEN')
    const result = h.call('getData')
    expect(result.data.adminConfigured).toBe(false)
    expect(JSON.stringify(result)).not.toContain(h.properties.API_KEY)
    expect(result.data.settings).toBeUndefined()
  })
  it('protects management operations even when called directly', () => {
    for (const action of ['saveEvent', 'setEventActive', 'renamePlayer', 'setPlayerActive', 'changeAdminPassword']) expect(h.call(action).error.code).toBe('UNAUTHORIZED')
  })
  it('sets initial credentials once, authenticates, and invalidates every session on password change', () => {
    const token = h.initialize()
    expect(h.properties.ADMIN_SETUP_CODE).toBeUndefined()
    expect(h.call('initializeAdmin').error.code).toBe('CONFLICT')
    expect(h.call('adminLogin', { proof: 'wrong' }).error.code).toBe('UNAUTHORIZED')
    const second = h.call('adminLogin', { proof: 'b'.repeat(64) }).data.token
    expect(h.call('changeAdminPassword', { currentProof: 'b'.repeat(64), salt: 'c'.repeat(64), proof: 'd'.repeat(64) }, token).ok).toBe(true)
    expect(h.call('getData', {}, token).error.code).toBe('UNAUTHORIZED')
    expect(h.call('getData', {}, second).error.code).toBe('UNAUTHORIZED')
    expect(h.call('adminLogin', { proof: 'd'.repeat(64) }).ok).toBe(true)
  })
  it('revokes logout tokens and throttles repeated password guesses', () => {
    const token = h.initialize()
    expect(h.call('adminLogout', {}, token).ok).toBe(true)
    expect(h.call('getData', {}, token).error.code).toBe('UNAUTHORIZED')
    for (let i = 0; i < 10; i++) expect(h.call('adminLogin', { proof: 'wrong' }).error.code).toBe('UNAUTHORIZED')
    expect(h.call('adminLogin', { proof: 'b'.repeat(64) }).error.code).toBe('RATE_LIMITED')
  })
})
describe('GAS mutations', () => {
  it('normalizes registration, preserves retirement, supports restoration', () => {
    const p = h.call('registerPlayer', { name: '山田 太郎' }).data.player
    expect(h.call('registerPlayer', { name: '山田　太郎' }).data.duplicate).toBe(true)
    const token = h.initialize()
    h.call('setPlayerActive', { playerId: p.id, active: false }, token)
    expect(h.call('registerPlayer', { name: '山田太郎' }).data.player.active).toBe(false)
    h.call('setPlayerActive', { playerId: p.id, active: true }, token)
    expect(h.call('getData').data.players[0].retiredAt).toBe(null)
  })
  it('creates events idempotently, hides without deleting attendance, and validates dates', () => {
    const token = h.initialize(), ev = event()
    expect(h.call('saveEvent', { event: ev, create: true }, token).ok).toBe(true)
    expect(h.call('saveEvent', { event: ev, create: true }, token).data.snapshot.events).toHaveLength(1)
    const p = h.call('registerPlayer', { name: '佐藤' }).data.player
    h.call('saveAttendance', { eventId: ev.id, playerId: p.id, status: 'attend' })
    h.call('setEventActive', { eventId: ev.id, active: false }, token)
    expect(h.call('getData').data.events).toHaveLength(0)
    expect(h.call('getData', {}, token).data.attendance).toHaveLength(1)
    expect(h.call('saveAttendance', { eventId: ev.id, playerId: p.id, status: 'late' }).error.code).toBe('CONFLICT')
    expect(h.call('saveEvent', { event: { ...event(), date: '2026-02-30' }, create: true }, token).error.code).toBe('BAD_REQUEST')
  })
  it('upserts answers, resets to unanswered, rejects retired players and past events', () => {
    const token = h.initialize(), ev = event(), p = h.call('registerPlayer', { name: '鈴木' }).data.player
    h.call('saveEvent', { event: ev, create: true }, token)
    const answer = { eventId: ev.id, playerId: p.id, status: 'attend' }
    h.call('saveAttendance', answer); h.call('saveAttendance', { ...answer, status: 'late' })
    expect(h.call('getData').data.attendance).toHaveLength(1)
    expect(h.call('getData').data.attendance[0].status).toBe('late')
    h.call('saveAttendance', { ...answer, status: null })
    expect(h.call('getData').data.attendance).toHaveLength(0)
    h.call('setPlayerActive', { playerId: p.id, active: false }, token)
    expect(h.call('saveAttendance', answer).error.code).toBe('CONFLICT')
    h.call('setPlayerActive', { playerId: p.id, active: true }, token)
    h.call('saveEvent', { event: { ...ev, date: '2026-09-01' }, create: false }, token)
    expect(h.call('saveAttendance', answer).error.code).toBe('BAD_REQUEST')
  })
  it('checks session validity before attendance writes', () => {
    const token = h.initialize(), ev = event(), p = h.call('registerPlayer', { name: '高橋' }).data.player
    h.call('saveEvent', { event: ev, create: true }, token)
    const result = h.call('saveAttendance', { eventId: ev.id, playerId: p.id, status: 'attend' }, 'f'.repeat(64))
    expect(result.error.code).toBe('UNAUTHORIZED'); expect(h.call('getData').data.attendance).toHaveLength(0)
  })
  it('escapes formulas when writing user-controlled cells', () => {
    h.call('registerPlayer', { name: '=1+1' })
    expect(h.sheets.get('players')!.values[1]![1]).toBe("'=1+1")
  })
})
