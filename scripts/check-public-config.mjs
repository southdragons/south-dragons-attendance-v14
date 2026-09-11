import { readFileSync, existsSync } from 'node:fs'
// Nuxt loads .env later. Mirror only public build settings for this validation.
const config={}
if(existsSync('.env')) for(const line of readFileSync('.env','utf8').split('\n')) {
  const m=line.match(/^([A-Z_]+)=(.*)$/);if(m)config[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'')
}
Object.assign(config,process.env)
if(config.NUXT_PUBLIC_DATA_BACKEND==='demo' && config.ALLOW_DEMO_BUILD==='1') process.exit(0)
if((config.NUXT_PUBLIC_DATA_BACKEND || 'supabase')!=='supabase') throw Error('GitHub Pages requires the Supabase backend')
const url=config.NUXT_PUBLIC_SUPABASE_URL, key=config.NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || ''
if(!url || !/^https:\/\/[^/]+\.supabase\.co\/?$/.test(url)) throw Error('Set NUXT_PUBLIC_SUPABASE_URL')
let publicKey=key.startsWith('sb_publishable_')
if(key.startsWith('eyJ')) { try { publicKey=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role==='anon' } catch {} }
if(!publicKey) throw Error('Only a Supabase publishable/anon key is allowed in the static build')
console.log('Public connection settings validated')
