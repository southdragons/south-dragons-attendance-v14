import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Phase 4-F screen rules, checked in the source (the test environment does not render Vue).
const dialog = readFileSync('app/components/RegistrationDialog.vue', 'utf8')
const app = readFileSync('app/app.vue', 'utf8')
const composable = readFileSync('app/composables/useTeam.ts', 'utf8')

it('offers two separate entrances: a new player, or a device for a registered player', () => {
  expect(dialog).toContain('新しい選手を登録する')
  expect(dialog).toContain('登録済み選手の端末を追加する')
  expect(app).toContain('<RegistrationDialog :open="registration" :team="team"')
  expect(app).not.toContain('title="お子さまの名前を登録"') // the old single-step dialog is gone
})

it('creates a player only from the final confirmation, after the name was confirmed', () => {
  expect(dialog.split('team.registerName(').length - 1).toBe(2)
  expect(dialog).toContain('team.registerName(trimmed, false)')
  expect(dialog).toContain('team.registerName(name.value.trim(), true)')
  const create = dialog.slice(dialog.indexOf('async function createPlayer'), dialog.indexOf('// --- Device for a registered player'))
  expect(create).toContain("if (!nameChecked.value) { error.value = '名前に間違いがないことを確認してください。'; return }")
  expect(dialog).toContain('data-testid="create-player" :disabled="!nameChecked"')
  expect(composable).toContain("isSupabase.value ? { name, confirmed } : { name }")
})

it('shows similar names only when the server allows it, and a neutral note otherwise', () => {
  expect(dialog).toContain('v-if="similar.length"')
  expect(dialog).toContain('v-else-if="!similarVisible"')
  // Devices without the team code may only look up an exact name; no list, no suggestions.
  expect(dialog).toContain("team.findPlayerForDevice(trimmed)")
  expect(dialog).toContain('（候補は表示されません）')
})

it('the approval dialog shows player, applicant, relation, time, request ID and other pending requests', () => {
  const review = app.slice(app.indexOf('function reviewRequest('), app.indexOf('const adminEntry'))
  for (const label of ['対象の選手', '申請者', '続柄', '申請日時', '申請ID']) expect(review).toContain(`label: '${label}'`)
  expect(review).toContain("r.status === 'pending' && r.playerId === request.playerId && r.id !== request.id")
  expect(review).toContain('team.reviewRegistration(request.id, request.playerId, decision)')
  expect(app).toContain('data-testid="confirm-details"')
  expect(app).toContain('data-testid="confirm-warning"')
  expect(composable).toContain("'reviewRegistration', {requestId, playerId, decision,")
})

it('rollback restores the previous team_api exactly; data is untouched', async () => {
  const down = readFileSync('supabase/rollback/20261030000000_registration_guard_down.sql', 'utf8')
  const prev = readFileSync('supabase/migrations/20261023000000_team_code.sql', 'utf8')
  const body = (s: string) => s.slice(s.indexOf('create or replace function public.team_api('), s.indexOf('grant execute on function public.team_api(uuid,text,jsonb,text) to service_role;'))
  expect(body(down)).toBe(body(prev))
  // Outside the restored function body there are no data changes.
  expect(down.replace(body(down), '')).not.toMatch(/\b(delete|update|insert|drop|truncate)\b/i)
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key,is_anonymous boolean default true,created_at timestamptz default now(),last_sign_in_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to public;`)
    const strip = (s: string) => s.replace(/^begin;$/im, '').replace(/^commit;$/im, '')
    for (const f of ['20260911000000_v14.sql', '20260911000100_import.sql', '20260912000100_writer_jwt_subject.sql']) await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'))
    await db.exec('revoke usage on schema auth from sd_attendance_writer')
    for (const f of ['20260913000000_multi_device_access.sql', '20261019000000_attendance_reminder.sql', '20261023000000_team_code.sql', '20261030000000_registration_guard.sql'])
      await db.exec(strip(readFileSync(`supabase/migrations/${f}`, 'utf8')))
    const user = '00000000-0000-4000-8000-000000000001'
    await db.query('insert into auth.users(id) values($1)', [user])
    const call = (payload: object) => db.query<{ r: any }>("select team_api($1,'registerPlayer',$2) r", [user, JSON.stringify(payload)])
    await expect(call({ name: '架空 一郎' })).rejects.toThrow('CLIENT_UPDATE_REQUIRED')
    await call({ name: '架空 一郎', confirmed: true })
    await db.exec(strip(down))
    expect((await call({ name: '架空 二郎' })).rows[0]!.r.duplicate).toBe(false) // previous behaviour: registers at once
    expect((await db.query<{ n: number }>('select count(*)::int n from public.players')).rows[0]!.n).toBe(2) // rows from before the rollback remain
  } finally { await db.close() }
})
