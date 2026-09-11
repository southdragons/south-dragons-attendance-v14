import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { scrypt } from 'node:crypto'
import { promisify } from 'node:util'
const [action,filename]=process.argv.slice(2)
if(!['export','plan','apply'].includes(action) || !filename) throw Error('Usage: node --env-file=.env --env-file=.env.migration scripts/migrate-gas.mjs export|plan|apply backups/snapshot.json')
const counts=data=>({players:data.players.length,events:data.events.length,attendance:data.attendance.length})
if(action==='export') {
  const url=process.env.NUXT_GAS_WEB_APP_URL,key=process.env.NUXT_GAS_API_KEY,password=process.env.GAS_ADMIN_PASSWORD
  if(!url || !key || !password) throw Error('Set GAS connection and GAS_ADMIN_PASSWORD in private .env.migration')
  const call=async(action,payload={},adminToken='')=>{
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key,action,payload,adminToken}),signal:AbortSignal.timeout(60000)})
    const data=await response.json()
    if(!response.ok || !data.ok) throw Error('GAS export request failed; verify configuration/password')
    return data.data
  }
  const config=await call('getAuthConfig')
  if(!config.configured || !/^[a-f0-9]{64}$/.test(config.salt)) throw Error('GAS admin is not configured')
  const hash=(await promisify(scrypt)(password,config.salt,32,{N:32768,r:8,p:3,maxmem:64*1024*1024})).toString('hex')
  const login=await call('adminLogin',{proof:hash})
  let snapshot
  try {snapshot=await call('getData',{},login.token)} finally {await call('adminLogout',{},login.token)}
  if(!snapshot.admin) throw Error('Full admin snapshot required')
  delete snapshot.myPlayerIds
  const backup={exportedAt:new Date().toISOString(),snapshot,credential:{algorithm:'scrypt-N32768-r8-p3-v1',salt:config.salt,hash}}
  mkdirSync(dirname(filename),{recursive:true,mode:0o700})
  writeFileSync(filename,JSON.stringify(backup,null,2),{mode:0o600,flag:'wx'})
  console.log(JSON.stringify({exported:true,...counts(snapshot)}))
} else {
  const backup=JSON.parse(readFileSync(filename,'utf8')), data=backup.snapshot
  if(data?.version!==1 || ![data.players,data.events,data.attendance].every(Array.isArray)) throw Error('Invalid snapshot')
  const normalized=data.players.map(p=>p.name.replace(/[\s\u3000]+/g,''))
  if(new Set(normalized).size!==normalized.length) throw Error('Duplicate normalized names: reconcile in GAS before export')
  const report=counts(data)
  if(action==='plan') {console.log(JSON.stringify({dryRun:true,...report,owners:'All imported players require an approved registration request'}));process.exit(0)}
  const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY
  if(!url || !key) throw Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in private .env.migration')
  const response=await fetch(`${url.replace(/\/$/,'')}/rest/v1/rpc/import_legacy_snapshot`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({snapshot:data,credential:backup.credential}),signal:AbortSignal.timeout(60000)})
  if(!response.ok) throw Error(`Import rejected (HTTP ${response.status}); destination must be empty and all records valid`)
  const imported=await response.json()
  for(const k of Object.keys(report)) if(imported[k]!==report[k]) throw Error('Imported record count mismatch')
  console.log(JSON.stringify({imported:true,...imported}))
}
