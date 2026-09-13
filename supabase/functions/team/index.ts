import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const url = Deno.env.get('SUPABASE_URL')!
const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
const actions = new Set(['getData','registerPlayer','saveAttendance','savePendingAttendance','requestRegistration','reviewRegistration','revokeDeviceAccess','saveEvent','setEventActive','renamePlayer','setPlayerActive','adminLogin','initializeAdmin','changeAdminPassword','adminLogout'])
const errors: Record<string, [number,string]> = {
  UNAUTHORIZED: [401,'管理画面への再ログイン、またはページの再読み込みをお願いします。'],
  FORBIDDEN: [403,'この端末では、この選手の出欠を変更できません。利用申請の承認状況を確認してください。'],
  APPROVAL_REQUIRED: [403,'管理者の承認後に出欠を入力できます。ページを再読み込みしてください。'],
  CLIENT_UPDATE_REQUIRED: [409,'機能が更新されました。ページを再読み込みしてから操作してください。'],
  BAD_PASSWORD: [400,'管理パスワードが正しくありません。'],
  BAD_REQUEST: [400,'入力内容を確認してください。'],
  CONFLICT: [409,'状態が変更されています。更新して確認してください。'],
  REQUEST_EXISTS: [409,'この選手の再登録申請は既に届いています。管理者へ確認してください。'],
  ALREADY_OWNED: [409,'この端末で登録済みです。更新してください。'],
  NOT_EDITABLE: [409,'過去の予定、非表示の予定、退団した選手には回答できません。'],
  NOT_FOUND: [404,'対象が見つかりません。'],
  RATE_LIMITED: [429,'試行回数が多いため、時間をおいて再試行してください。'],
}
function equal(a: string, b: string) { const x=new TextEncoder().encode(a), y=new TextEncoder().encode(b); return x.length===y.length && timingSafeEqual(x,y) }
function proof(password: string, salt: string): Promise<string> {
  return new Promise((resolve,reject) => scrypt(password,salt,32,{ N:32768,r:8,p:3,maxmem:64*1024*1024 },(error,key)=>error?reject(error):resolve(key.toString('hex'))))
}
async function rpc(actor: string, action: string, payload: Record<string,unknown> = {}, token = '') {
  const {data,error}=await service.rpc('team_api',{actor,action,payload,admin_token:token})
  if(error) throw error
  return data
}
async function notifyAdmin(notification: {requestId:string;playerName:string;requestedAt:string;applicantName?:string;relation?:string;accessModel?:string}) {
  const token=Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN'), to=Deno.env.get('LINE_ADMIN_TARGET_ID')
  let status='unconfigured'
  if(token && to) {
    try {
      const when=new Date(notification.requestedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})
      const response=await fetch('https://api.line.me/v2/bot/message/push',{
        method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Line-Retry-Key':notification.requestId},
        body:JSON.stringify({to,messages:[{type:'text',text:`【South Dragons ${notification.accessModel === 'multi-device' ? '端末追加申請' : '再登録申請'}】\n${notification.playerName}さん\n${notification.accessModel === 'multi-device' ? `申請者：${notification.applicantName}（${notification.relation}）\n` : ''}申請日時：${when}\n管理画面で承認・却下を確認してください。\n${Deno.env.get('APP_URL') || ''}`}]}),signal:AbortSignal.timeout(8000),
      })
      status=response.ok || response.status===409 ? 'sent':'failed'
    } catch {status='failed'}
  }
  const {error}=await service.rpc('record_notification',{p_request:notification.requestId,p_status:status})
  if(error) console.error('notification_status_update_failed')
}

Deno.serve(async (request: Request) => {
  const origin=request.headers.get('origin') || ''
  const allowed=(Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(x=>x.trim()).filter(Boolean)
  const cors: Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'}
  if(origin && allowed.includes(origin)) {
    cors['Access-Control-Allow-Origin']=origin
    cors['Access-Control-Allow-Headers']='authorization, apikey, content-type, x-client-info, traceparent, tracestate, baggage'
    cors['Access-Control-Allow-Methods']='POST, OPTIONS'
  }
  const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:cors})
  if(origin && !allowed.includes(origin)) return response({message:'このアクセス元は許可されていません。'},403)
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors})
  if(request.method!=='POST') return response({message:'POSTを使用してください。'},405)
  try {
    if(!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('BAD_REQUEST')
    const raw=await request.text()
    if(raw.length>12000) throw new Error('BAD_REQUEST')
    const body=JSON.parse(raw)
    if(!body || !actions.has(body.action) || (body.payload && (typeof body.payload!=='object' || Array.isArray(body.payload)))) throw new Error('BAD_REQUEST')
    const jwt=request.headers.get('authorization')?.replace(/^Bearer /i,'') || ''
    const {data:{user},error}=await service.auth.getUser(jwt)
    if(error || !user?.is_anonymous) throw new Error('UNAUTHORIZED')
    const action=body.action, p=body.payload || {}, token=typeof body.adminToken==='string'?body.adminToken:''
    let result
    if(action==='saveAttendance' || action==='savePendingAttendance') {
      // User-scoped RPC: a non-bypass role enforces device access using the verified JWT subject.
      const scoped=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:`Bearer ${jwt}`}},auth:{persistSession:false,autoRefreshToken:false}})
      const {error}=await scoped.rpc('save_own_attendance',{p_event:p.eventId,p_player:p.playerId,p_status:p.status,p_comment:p.comment || '',p_request:action==='savePendingAttendance'?p.requestId:null})
      if(error) throw error
      result={snapshot:await rpc(user.id,'getData',{},token)}
    } else if(['adminLogin','initializeAdmin','changeAdminPassword'].includes(action)) {
      if(typeof p.password!=='string' || p.password.length>128 || p.password.length<(action==='adminLogin'?1:12)) throw new Error('BAD_REQUEST')
      const config=await rpc(user.id,'authPrepare')
      if(config.limited) throw new Error('RATE_LIMITED')
      if(action==='initializeAdmin') {
        const setup=Deno.env.get('ADMIN_SETUP_CODE')
        if(config.configured) throw new Error('CONFLICT')
        if(!setup || typeof p.setupCode!=='string' || !equal(setup,p.setupCode)) throw new Error('FORBIDDEN')
      } else if(!config.configured || !/^[a-f0-9]{64}$/.test(config.salt)) throw new Error('CONFLICT')
      const salt=action==='adminLogin'?config.salt:randomBytes(32).toString('hex')
      const input: Record<string,unknown>={salt,proof:await proof(p.password,salt)}
      if(action==='changeAdminPassword') {
        if(typeof p.currentPassword!=='string' || !p.currentPassword || p.currentPassword.length>128) throw new Error('BAD_REQUEST')
        input.currentProof=await proof(p.currentPassword,config.salt)
      } else input.token=randomBytes(32).toString('hex')
      result=await rpc(user.id,action,input,token)
      if(action!=='changeAdminPassword') result.adminToken=input.token
    } else {
      result=await rpc(user.id,action,p,token)
      if(result.notification) {
        await notifyAdmin(result.notification)
        delete result.notification
      }
    }
    return response(result)
  } catch(error) {
    const e=error as {message?:string;code?:string}
    const known=errors[e.message || ''] || (['23514','23502','22007','22008','22P02','22001'].includes(e.code || '')?errors.BAD_REQUEST:e.code==='23505'?errors.CONFLICT:e.code==='42501'?errors.FORBIDDEN:undefined)
    if(!known) console.error('team_request_failed',e.code || 'unknown')
    return response({message:known?.[1] || '通信結果を確認できません。更新して保存結果を確認してください。'},known?.[0] || 502)
  }
})
