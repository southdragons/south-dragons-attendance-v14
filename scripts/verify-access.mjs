import { createClient } from '@supabase/supabase-js'
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_PUBLISHABLE_KEY
if(!url || !key) throw Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY; use the staging project first')
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
const tables=['players','events','attendance','settings','re_registration_requests','pending_attendance']
async function probe(jwt) {
  for(const table of tables) for(const method of ['GET','POST','PATCH','DELETE']) {
    const id=table==='settings'?'key':table.includes('registration') || table==='pending_attendance'?'request_id':'id'
    const value=id==='request_id'?'00000000-0000-4000-8000-000000000000':'__permission_probe__'
    const path=`${url}/rest/v1/${table}${method==='GET'?'?select=*&limit=1':method==='PATCH'||method==='DELETE'?`?${id}=eq.${value}`:''}`
    const response=await fetch(path,{method,headers:{apikey:key,...(jwt?{Authorization:`Bearer ${jwt}`} : {}),'Content-Type':'application/json'},body:['POST','PATCH'].includes(method)?JSON.stringify({[id]:value}):undefined,signal:AbortSignal.timeout(15000)})
    const result=await response.json()
    if(response.ok || result.code!=='42501') throw Error(`Expected privilege denial: ${table} ${method} HTTP ${response.status}`)
  }
}
await probe(null)
const {data,error}=await db.auth.signInAnonymously()
if(error || !data.session) throw Error('Anonymous Auth is not configured')
await probe(data.session.access_token)
const {error: privileged}=await db.rpc('team_api',{actor:data.user.id,action:'getData'})
if(privileged?.code!=='42501') throw Error('Service-only function is accessible to browser role')
console.log('Passed: public-key anon/authenticated table CRUD and privileged RPC denials (one unreferenced anonymous test user created)')
