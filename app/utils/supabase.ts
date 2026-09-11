import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | undefined
let signingIn: Promise<void> | undefined
let adminToken = '' // Memory only; never store the shared password or admin token on disk.
function getClient() {
  if (client) return client
  const config = useRuntimeConfig().public
  const url = String(config.supabaseUrl || ''), key = String(config.supabasePublishableKey || '')
  let allowed = key.startsWith('sb_publishable_')
  if (key.startsWith('eyJ')) {
    try { allowed = JSON.parse(atob(key.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon' } catch { allowed = false }
  }
  if (!url || !allowed) throw new Error('Supabaseの接続設定がまだ完了していません。運営者へお知らせください。')
  client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
  return client
}
async function ensureSession(db: SupabaseClient) {
  if (!signingIn) signingIn = (async () => {
    const { data, error } = await db.auth.getSession()
    if (error) throw error
    if (!data.session) {
      const { error } = await db.auth.signInAnonymously()
      if (error) throw new Error('端末の登録ができませんでした。時間をおいて再読み込みしてください。')
    }
  })().finally(() => { signingIn = undefined })
  await signingIn
}
export async function callSupabase<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const db = getClient()
  await ensureSession(db)
  const { data, error } = await db.functions.invoke('team', { body: { action, payload, adminToken } })
  if (error) {
    let message = '通信結果を確認できません。更新して保存結果を確認してください。'
    const status = error.context?.status
    try { message = (await error.context?.json())?.message || message } catch {}
    if (status === 401) adminToken = ''
    throw Object.assign(new Error(message), { statusCode: status, data: { message } })
  }
  if (typeof data?.adminToken === 'string') adminToken = data.adminToken
  if (action === 'adminLogout' || action === 'changeAdminPassword' || (action === 'getData' && !data.admin)) adminToken = ''
  return data as T
}
