const action=process.argv[2]
if(!['health','cleanup'].includes(action)) throw Error('Specify health or cleanup')
const url=process.env.SUPABASE_URL, key=process.env.MAINTENANCE_KEY
if(!url || !key) throw Error('Set SUPABASE_URL and MAINTENANCE_KEY')
const response=await fetch(`${url.replace(/\/$/,'')}/functions/v1/maintenance`,{
  method:'POST',headers:{'Content-Type':'application/json','x-maintenance-key':key},
  body:JSON.stringify({action,dryRun:process.env.CLEANUP_APPLY!=='true'}),signal:AbortSignal.timeout(60000),
})
if(!response.ok) throw Error(`Maintenance failed: HTTP ${response.status}`)
const result=await response.json()
if(!result.ok || (action==='health' && !result.database)) throw Error('Database check failed')
console.log(JSON.stringify(result))
if(process.env.GITHUB_STEP_SUMMARY) {
  const {appendFileSync}=await import('node:fs')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## ${action}\n\n${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(result,null,2)}\n\`\`\`\n`)
}
