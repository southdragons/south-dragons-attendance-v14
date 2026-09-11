import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import { timingSafeEqual } from 'node:crypto'
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}})
Deno.serve(async (req:Request)=>{
  const expected=Deno.env.get('MAINTENANCE_KEY') || '', supplied=req.headers.get('x-maintenance-key') || ''
  const a=new TextEncoder().encode(expected),b=new TextEncoder().encode(supplied)
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})
  if(!expected || a.length!==b.length || !timingSafeEqual(a,b)) return reply({ok:false},401)
  if(req.method!=='POST') return reply({ok:false},405)
  try {
    const body=await req.json()
    if(body.action==='health') {
      const {data,error}=await db.rpc('team_health')
      if(error || !data?.ok || !data?.database) return reply({ok:false},503)
      return reply(data)
    }
    if(body.action!=='cleanup') return reply({ok:false},400)
    const dryRun=body.dryRun!==false
    const {data,error}=await db.rpc('cleanup_candidates',{dry_run:dryRun})
    if(error) throw error
    let deleted=0
    if(!dryRun) for(const row of data || []) {
      const {error}=await db.auth.admin.deleteUser(row.user_id)
      if(error) throw error // FK RESTRICT remains the final race protection.
      deleted++
    }
    return reply({ok:true,dryRun,candidates:data.length,deleted})
  } catch {console.error('maintenance_failed');return reply({ok:false},503)}
})
