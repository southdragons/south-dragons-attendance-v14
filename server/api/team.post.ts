import { callGas } from '../utils/gas'
import { passwordProof, passwordSalt } from '../utils/password'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  if (getRequestHeader(event, 'x-south-dragons') !== '1' || !getRequestHeader(event, 'content-type')?.startsWith('application/json')) throw createError({ statusCode: 403, message: 'アプリから操作してください。' })
  const origin = getRequestHeader(event, 'origin')
  if (getRequestHeader(event, 'sec-fetch-site') === 'cross-site' || (origin && origin !== getRequestURL(event).origin)) throw createError({ statusCode: 403, message: 'このアクセス元からは操作できません。' })
  const raw = await readRawBody(event)
  if (!raw || raw.length > 12000) throw createError({ statusCode: 400, message: '入力データが大きすぎます。' })
  let body: { action?: string; payload?: Record<string, any> }
  try { body = JSON.parse(raw) } catch { throw createError({ statusCode: 400, message: '入力形式が正しくありません。' }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw createError({ statusCode: 400, message: '入力形式が正しくありません。' })
  const action = body.action, p = body.payload || {}
  const token = getCookie(event, 'sd_admin') || ''
  if (action === 'getData') return await callGas(event, 'getData', {}, token)
  if (action === 'adminLogout') {
    try { return await callGas(event, 'adminLogout', {}, token) }
    finally { deleteCookie(event, 'sd_admin', { path: '/' }) }
  }
  if (action === 'adminLogin' || action === 'initializeAdmin' || action === 'changeAdminPassword') {
    const password = p.password
    if (typeof password !== 'string' || password.length > 128 || password.length < (action === 'adminLogin' ? 1 : 12)) throw createError({ statusCode: 400, message: '新しい管理パスワードは12〜128文字で入力してください。' })
    const config = await callGas(event, 'getAuthConfig')
    let result: Record<string, any>
    if (action === 'adminLogin') {
      if (!config.configured || !/^[a-f0-9]{64}$/.test(config.salt)) throw createError({ statusCode: 409, message: '管理パスワードを初期設定してください。' })
      result = await callGas(event, action, { proof: await passwordProof(password, config.salt) })
    } else {
      const salt = passwordSalt(), proof = await passwordProof(password, salt)
      if (action === 'initializeAdmin') result = await callGas(event, action, { salt, proof, setupCode: p.setupCode })
      else {
        if (!token) throw createError({ statusCode: 401, message: '管理画面にログインしてください。' })
        if (!config.configured || typeof config.salt !== 'string' || typeof p.currentPassword !== 'string' || p.currentPassword.length < 1 || p.currentPassword.length > 128) throw createError({ statusCode: 400, message: '現在の管理パスワードを入力してください。' })
        result = await callGas(event, action, { salt, proof, currentProof: await passwordProof(p.currentPassword, config.salt) }, token)
        deleteCookie(event, 'sd_admin', { path: '/' })
        return result
      }
    }
    if (typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token)) throw createError({ statusCode: 502, message: '管理ログインを完了できませんでした。' })
    setCookie(event, 'sd_admin', result.token, { httpOnly: true, secure: getRequestURL(event).protocol === 'https:', sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 })
    return { authenticated: true }
  }
  // Whitelist both actions and fields; never accept an adminToken/proof/API key from the browser.
  let payload: Record<string, unknown>
  switch (action) {
    case 'registerPlayer': payload = { name: p.name }; break
    case 'saveAttendance': payload = { eventId: p.eventId, playerId: p.playerId, status: p.status }; break
    case 'saveEvent': payload = { event: p.event, create: p.create }; break
    case 'setEventActive': payload = { eventId: p.eventId, active: p.active }; break
    case 'renamePlayer': payload = { playerId: p.playerId, name: p.name }; break
    case 'setPlayerActive': payload = { playerId: p.playerId, active: p.active }; break
    default: throw createError({ statusCode: 400, message: '対応していない操作です。' })
  }
  return await callGas(event, action, payload, token)
})
