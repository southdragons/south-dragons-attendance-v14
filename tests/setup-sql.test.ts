import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// setup.sql builds an empty project in one transaction. It must stay identical to the migrations.
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const migrationBody = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8')
  .replace(/^\s*begin;\s*$/im, '').replace(/^\s*commit;\s*$/im, '').replace(/^notify pgrst, 'reload schema';\s*$/m, '')

it('setup.sql contains every migration verbatim (writer_auth_permissions is a Supabase no-op and omitted)', () => {
  const setup = norm(readFileSync('supabase/setup.sql', 'utf8'))
  for (const f of ['20260911000000_v14.sql', '20260911000100_import.sql', '20260912000100_writer_jwt_subject.sql',
    '20260913000000_multi_device_access.sql', '20261019000000_attendance_reminder.sql', '20261023000000_team_code.sql'])
    expect(setup.includes(norm(migrationBody(f))), f).toBe(true)
})

it('an empty project built from setup.sql has the reminder and team code, both disabled', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key,is_anonymous boolean default true,created_at timestamptz default now(),last_sign_in_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      grant execute on function auth.uid() to public;`)
    await db.exec(readFileSync('supabase/setup.sql', 'utf8'))
    expect((await db.query('select version, hash, enforcement from private.team_code')).rows).toEqual([{ version: 0, hash: null, enforcement: 'off' }])
    expect((await db.query('select name, enabled from private.feature_flags')).rows).toEqual([{ name: 'abuse_limits', enabled: false }])
    expect((await db.query("select to_regclass('public.attendance_reminder_deliveries') is not null as ok")).rows).toEqual([{ ok: true }])
    const user = '00000000-0000-4000-8000-000000000009'
    await db.query('insert into auth.users(id) values($1)', [user])
    const r = (await db.query<{ result: any }>("select team_api($1,'registerPlayer',$2) as result", [user, JSON.stringify({ name: '架空 太郎' })])).rows[0]!.result
    expect(r.snapshot.myPlayerIds).toEqual([r.player.id])
    expect((await db.query('select count(*)::int n from private.team_members')).rows).toEqual([{ n: 0 }]) // backfill ran before any player existed
  } finally { await db.close() }
})
