import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let handler: (event: any) => Promise<any>
let headers: Record<string, string>
let body: object
let cookie = ''
const upstream = vi.fn()
const cookieSet = vi.fn(), cookieDelete = vi.fn()
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: any) => fn)
  vi.stubGlobal('setResponseHeader', vi.fn())
  vi.stubGlobal('getRequestHeader', (_event: any, name: string) => headers[name])
  vi.stubGlobal('getRequestURL', () => new URL('https://dragons.example/api/team'))
  vi.stubGlobal('readRawBody', async () => JSON.stringify(body))
  vi.stubGlobal('getCookie', () => cookie)
  vi.stubGlobal('setCookie', cookieSet)
  vi.stubGlobal('deleteCookie', cookieDelete)
  vi.stubGlobal('createError', (input: any) => Object.assign(new Error(input.message), input))
  vi.stubGlobal('useRuntimeConfig', () => ({ gasWebAppUrl: 'https://script.google.com/macros/s/test-deployment/exec', gasApiKey: 'server-secret' }))
  vi.stubGlobal('$fetch', upstream)
  handler = (await import('../server/api/team.post')).default as any
})
beforeEach(() => {
  headers = { 'content-type': 'application/json', 'x-south-dragons': '1', origin: 'https://dragons.example' }
  body = { action: 'getData' }; cookie = ''; upstream.mockReset(); cookieSet.mockClear(); cookieDelete.mockClear()
  upstream.mockResolvedValue({ ok: true, data: { version: 1 } })
})
afterAll(() => vi.unstubAllGlobals())
describe('Nuxt GAS proxy boundary', () => {
  it('rejects cross-origin and non-app writes without contacting GAS', async () => {
    headers.origin = 'https://outside.example'
    await expect(handler({})).rejects.toMatchObject({ statusCode: 403 })
    headers.origin = 'https://dragons.example'; delete headers['x-south-dragons']
    await expect(handler({})).rejects.toMatchObject({ statusCode: 403 })
    expect(upstream).not.toHaveBeenCalled()
  })
  it('does not expose internal GAS auth operations', async () => {
    body = { action: 'getAuthConfig' }
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(upstream).not.toHaveBeenCalled()
  })
  it('takes secrets and sessions only from server configuration and cookies', async () => {
    body = { action: 'saveAttendance', apiKey: 'injected', adminToken: 'injected', payload: { eventId: 'e1', playerId: 'p1', status: 'late', adminToken: 'injected', proof: 'injected' } }
    cookie = 'real-session'
    await handler({})
    const options = upstream.mock.calls[0]![1]
    expect(options.body).toEqual({ action: 'saveAttendance', apiKey: 'server-secret', adminToken: 'real-session', payload: { eventId: 'e1', playerId: 'p1', status: 'late' } })
    expect(options.retry).toBe(0)
  })
  it('clears expired sessions and propagates actionable errors', async () => {
    upstream.mockResolvedValue({ ok: false, error: { code: 'UNAUTHORIZED', message: '再ログインしてください。' } })
    await expect(handler({})).rejects.toMatchObject({ statusCode: 401 })
    expect(cookieDelete).toHaveBeenCalled()
  })
  it('rejects HTML deployment responses instead of pretending to save', async () => {
    upstream.mockResolvedValue('<html>Sign in to Google</html>')
    await expect(handler({})).rejects.toMatchObject({ statusCode: 502 })
  })
  it('stores a login token in an HttpOnly cookie and never returns it to JavaScript', async () => {
    body = { action: 'adminLogin', payload: { password: 'test-password-only' } }
    upstream.mockResolvedValueOnce({ ok: true, data: { configured: true, salt: 'a'.repeat(64) } })
    upstream.mockResolvedValueOnce({ ok: true, data: { token: 'b'.repeat(64) } })
    expect(await handler({})).toEqual({ authenticated: true })
    expect(cookieSet.mock.calls[0]![3]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'strict', maxAge: 28800 })
    const sent = upstream.mock.calls[1]![1].body
    expect(sent.payload.proof).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(sent)).not.toContain('test-password-only')
  })
})
