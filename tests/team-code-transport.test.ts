import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// callSupabase must forward the server's `code` and mark unanswered requests as NETWORK.
const invoke = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 't' } }, error: null }), signInAnonymously: vi.fn() },
    functions: { invoke },
  }),
}))
beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'sb_publishable_test' } }))
})
afterEach(() => vi.unstubAllGlobals())

it('forwards the error code from the Edge response', async () => {
  const { callSupabase } = await import('../app/utils/supabase')
  invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ message: 'チームコードの入力が必要です。', code: 'TEAM_CODE_REQUIRED' }), { status: 403 }) } })
  const error: any = await callSupabase('getData').catch(e => e)
  expect(error.message).toBe('チームコードの入力が必要です。')
  expect(error.statusCode).toBe(403)
  expect(error.data).toEqual({ message: 'チームコードの入力が必要です。', code: 'TEAM_CODE_REQUIRED' })
})
it('keeps old responses without a code working, and labels unanswered requests as NETWORK', async () => {
  const { callSupabase } = await import('../app/utils/supabase')
  invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ message: '入力内容を確認してください。' }), { status: 400 }) } })
  expect((await callSupabase('getData').catch(e => e)).data).toEqual({ message: '入力内容を確認してください。', code: undefined })
  invoke.mockResolvedValueOnce({ data: null, error: { message: 'Failed to send a request', context: new TypeError('fetch failed') } })
  const offline: any = await callSupabase('getData').catch(e => e)
  expect(offline.statusCode).toBeUndefined()
  expect(offline.data.code).toBe('NETWORK')
})
it('does not show gateway/platform 5xx text to users, but keeps our own coded messages', async () => {
  const { callSupabase } = await import('../app/utils/supabase')
  invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ message: 'name resolution failed' }), { status: 503 }) } })
  const gateway: any = await callSupabase('getData').catch(e => e)
  expect(gateway.message).toBe('通信結果を確認できません。更新して保存結果を確認してください。')
  expect(gateway.statusCode).toBe(503)
  expect(gateway.data.code).toBeUndefined()
  invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ message: '試行回数が多いため、時間をおいて再試行してください。', code: 'RATE_LIMITED' }), { status: 429 }) } })
  expect((await callSupabase('verifyTeamCode').catch(e => e)).message).toContain('試行回数')
})
