// South Dragons attendance reminder, independent of the existing `team` function.
// Deploy only after review with verify_jwt=false; a separate long random shared secret
// is verified BEFORE any privileged query. Never expose this function from the browser.
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'
import { buildReminderText } from './message.mjs'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  {auth:{persistSession:false,autoRefreshToken:false}},
)
const encoder = new TextEncoder()
function equals(a:string,b:string) {
  const x=encoder.encode(a),y=encoder.encode(b)
  let diff=x.length^y.length
  for(let i=0;i<Math.max(x.length,y.length);i++) diff |= (x[i]||0)^(y[i]||0)
  return diff===0
}
function tokyoNow(date:Date) {
  const parts = new Intl.DateTimeFormat('en-US',{
    timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',
    weekday:'short',hour:'2-digit',hourCycle:'h23',minute:'2-digit',
  }).formatToParts(date)
  const get=(type:string)=>parts.find(x=>x.type===type)?.value||''
  const today=`${get('year')}-${get('month')}-${get('day')}`
  const tomorrow=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10)
  return {today,tomorrow,weekday:get('weekday'),hour:Number(get('hour'))}
}
type Event={id:string;title:string;start_time:string;event_date:string}
type Answer={event_id:string;player_id:string;status:string|null}
type Player={id:string;name:string;active:boolean}

Deno.serve(async(req:Request)=>{
  const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{
    status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
  })
  if(req.method!=='POST') return reply({error:'METHOD_NOT_ALLOWED'},405)
  const secret=Deno.env.get('REMINDER_CRON_SECRET')||''
  const presented=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')||''
  if(!secret || secret.length<32 || !equals(secret,presented)) return reply({error:'UNAUTHORIZED'},401)
  try {
    // The testing destination is deliberately separate from production credentials.
    const destination=Deno.env.get('REMINDER_DESTINATION')||'test'
    if(destination!=='test' && destination!=='production') throw new Error('Invalid destination')
    // Two independent switches are required before production delivery is possible.
    if(destination==='production' && Deno.env.get('REMINDER_PRODUCTION_ENABLED')!=='true') {
      return reply({error:'PRODUCTION_NOT_ENABLED'},403)
    }
    const token=Deno.env.get(destination==='test'?'REMINDER_TEST_LINE_TOKEN':'REMINDER_PROD_LINE_TOKEN')
    const to=Deno.env.get(destination==='test'?'REMINDER_TEST_LINE_TARGET':'REMINDER_PROD_LINE_TARGET')
    if(!token || !to) throw new Error('LINE notification is not configured')
    // Guard against a test configuration that accidentally points at production LINE.
    if(destination==='test' && (token===Deno.env.get('REMINDER_PROD_LINE_TOKEN') || to===Deno.env.get('REMINDER_PROD_LINE_TARGET'))) {
      throw new Error('Test destination must not reuse production LINE settings')
    }
    const local=tokyoNow(new Date())
    // Normal run: only Friday/Saturday, after 19:00 JST. 23:xx delayed jobs still work.
    const normal=local.weekday==='Fri'||local.weekday==='Sat'
    const body=await req.json().catch(()=>({})) as {testDate?:string;dryRun?:boolean}
    const isTestDate=destination==='test' && typeof body.testDate==='string'
    const targetDate=isTestDate?body.testDate!:local.tomorrow
    if(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || Number.isNaN(Date.parse(targetDate)) || new Date(targetDate+'T00:00:00Z').toISOString().slice(0,10)!==targetDate) return reply({error:'BAD_DATE'},400)
    if(destination==='production' && (!normal || local.hour<19)) return reply({skipped:'outside schedule'})
    if(destination==='test' && !isTestDate && (!normal || local.hour<19)) return reply({skipped:'outside schedule'})

    const {data:events,error:eventError}=await supabase.from('events')
      .select('id,title,start_time,event_date')
      .eq('event_date',targetDate).eq('active',true).order('start_time')
    if(eventError) throw eventError
    const items=(events||[]) as Event[]
    if(items.length===0) return reply({skipped:'no events',date:targetDate})
    if(items.length>100) throw new Error('Too many events for automatic notification')
    const ids=items.map(e=>e.id)
    const [{data:answers,error:answerError},{data:players,error:playerError}]=await Promise.all([
      supabase.from('attendance').select('event_id,player_id,status').in('event_id',ids).eq('status','absent'),
      supabase.from('players').select('id,name,active').eq('active',true),
    ])
    if(answerError) throw answerError
    if(playerError) throw playerError
    const playerList=(players||[]) as Player[]
    const absent=(answers||[]) as Answer[]
    const text=buildReminderText(targetDate,items,absent,playerList)
    if(!text) return reply({skipped:'no absences',date:targetDate})
    if(text.length>4900) throw new Error('Message is too long')
    // dryRun never sends, whatever the destination.
    if(body.dryRun===true) return reply({dryRun:true,destination,date:targetDate,message:text})

    const {data:claim,error:claimError}=await supabase.rpc('claim_attendance_reminder',{
      p_date:targetDate,p_destination:destination,
    })
    if(claimError) throw claimError
    const state=Array.isArray(claim)?claim[0]:claim
    if(!state?.should_send) return reply({skipped:'already sent or processing',date:targetDate})
    const key=String(state.retry_key)
    let status=0,success=false,reason=''
    try {
      const result=await fetch('https://api.line.me/v2/bot/message/push',{
        method:'POST',
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Line-Retry-Key':key},
        body:JSON.stringify({to,messages:[{type:'text',text}]}),signal:AbortSignal.timeout(12000),
      })
      status=result.status
      if (result.status===409) {
        const duplicate=await result.json().catch(()=>null) as {message?:string}|null
        success=typeof duplicate?.message==='string' && duplicate.message.toLowerCase().includes('retry key')
      } else success=result.ok
      if(!success) reason=`LINE returned HTTP ${status}`
    } catch {reason='LINE network request failed'}
    const {error:finishError}=await supabase.rpc('finish_attendance_reminder',{
      p_date:targetDate,p_destination:destination,p_retry_key:key,
      p_success:success,p_status:status||null,p_error:reason||null,
    })
    if(finishError) throw finishError
    return reply({date:targetDate,sent:success,status:status||null},success?200:502)
  } catch(e) {
    console.error('attendance_reminder_error',e instanceof Error?e.message:'unknown')
    return reply({error:'REMINDER_FAILED'},502)
  }
})
