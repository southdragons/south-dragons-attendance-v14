import type { H3Event } from 'h3'
export type GasReply = { ok: true; data: Record<string, any> } | { ok: false; error: { code: string; message: string } }
const statuses: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, BAD_PASSWORD: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, BUSY: 503, SCHEMA: 503, NOT_CONFIGURED: 503 }
export async function callGas(event: H3Event, action: string, payload: Record<string, unknown> = {}, adminToken = '') {
  const config = useRuntimeConfig(event)
  const url = config.gasWebAppUrl, key = config.gasApiKey
  if (!url || !key) throw createError({ statusCode: 503, message: 'GASの接続先と秘密キーを設定してください。' })
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) throw createError({ statusCode: 503, message: 'GASのデプロイURL（/execで終わるURL）を確認してください。' })
  let response: GasReply
  try {
    response = await $fetch<GasReply>(url, {
      method: 'POST', body: { apiKey: key, action, payload, adminToken },
      redirect: 'follow', retry: 0, timeout: 45000,
    })
  } catch {
    // A write may have succeeded even when its response was lost. Never auto-retry.
    throw createError({ statusCode: 502, message: '保存先から応答を確認できません。再読み込みで結果を確認してから再試行してください。' })
  }
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') throw createError({ statusCode: 502, message: 'GASの応答を読み込めません。デプロイの公開範囲とURLを確認してください。' })
  if (!response.ok) {
    if (response.error.code === 'UNAUTHORIZED') deleteCookie(event, 'sd_admin', { path: '/' })
    throw createError({ statusCode: statuses[response.error.code] || 502, message: response.error.message, data: { code: response.error.code } })
  }
  return response.data
}
