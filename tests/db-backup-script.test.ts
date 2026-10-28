import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

// scripts/db-backup.sh with fake psql / pg_dump / pg_restore: no database, no network.
const SCRIPT = resolve('scripts/db-backup.sh')
const HOST = 'aws-0-ap-southeast-2.pooler.supabase.com'
const PASSWORD = 'Fake-Pass:word\\42'
const APP = ['public players', 'public events', 'public attendance', 'public pending_attendance', 'public re_registration_requests', 'public settings', 'public player_access', 'public attendance_reminder_deliveries', 'private admin_sessions', 'private rate_limits', 'private user_activity']
const AUTH = ['auth users', 'auth identities']

const FAKE = String.raw`#!/bin/bash
name=$(basename "$0")
{ echo "CALL $name $*"; echo "ENV PGPASSFILE=$PGPASSFILE"; env | grep -v '^PGPASSFILE=' | sed 's/^/ENV /'; } >> "$FAKE_LOG"
case " $FAKE_FAIL " in *" $name "*) exit 2 ;; esac
case "$name" in
  psql)
    sql="$*"
    if [[ "$sql" == *to_regclass* ]]; then echo "$FAKE_MISSING"; else
      for t in players events; do echo "public.$t|3"; done; fi ;;
  pg_dump)
    [[ "$1" == --version ]] && { echo 'pg_dump (PostgreSQL) 18.6'; exit 0; }
    out=''; kind=app; while [[ $# -gt 0 ]]; do [[ "$1" == -f ]] && out="$2"; [[ "$1" == --schema=auth ]] && kind=auth; shift; done
    case " $FAKE_FAIL " in *" pg_dump_$kind "*) exit 1 ;; esac
    echo "fake-$kind" > "$out" ;;
  pg_restore)
    case " $FAKE_FAIL " in *" pg_restore_list "*) exit 1 ;; esac
    if grep -q fake-auth "$2"; then tables="$FAKE_AUTH"; else tables="$FAKE_APP"; fi
    i=1; while IFS= read -r t; do [[ -n "$t" && "$t" != "$FAKE_DROP" ]] && echo "$i; 0 0 TABLE DATA $t postgres" && i=$((i+1)); done <<< "$tables" ;;
esac
`

let dir: string, bin: string, root: string, log: string, tmp: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sd-backup-test-'))
  bin = join(dir, 'bin'); root = join(dir, 'backups'); log = join(dir, 'calls.log'); tmp = join(dir, 'tmp')
  for (const d of [bin, tmp]) spawnSync('mkdir', ['-p', d])
  for (const b of ['psql', 'pg_dump', 'pg_restore']) { writeFileSync(join(bin, b), FAKE); chmodSync(join(bin, b), 0o755) }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(args: string[], opts: { input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    input: opts.input ?? `${HOST}\n${PASSWORD}\n`, encoding: 'utf8',
    env: { PATH: process.env.PATH!, HOME: dir, TMPDIR: tmp, SD_PG_BIN: bin, SD_BACKUP_ROOT: root, FAKE_LOG: log,
      FAKE_APP: APP.join('\n'), FAKE_AUTH: AUTH.join('\n'), FAKE_FAIL: '', FAKE_MISSING: '', FAKE_DROP: '', ...opts.env },
  })
  return { code: r.status, out: r.stdout + r.stderr }
}
const day = () => new Date().toLocaleDateString('sv-SE').replaceAll('-', '')
const entries = () => (existsSync(root) ? readdirSync(root) : [])
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
const passfiles = () => readdirSync(tmp)

function expectNothingLeft(r: { code: number | null; out: string }) {
  expect(r.code).not.toBe(0)
  expect(entries()).toEqual([]) // no final folder, no .inprogress folder, so no COMPLETE
  expect(passfiles()).toEqual([])
}

it('creates a dated folder with dumps, counts, checksums and COMPLETE, and never exposes the password', () => {
  const r = run(['before-team-code'])
  expect(r.code, r.out).toBe(0)
  const dest = join(root, `${day()}-before-team-code`)
  expect(entries()).toEqual([`${day()}-before-team-code`])
  expect(readdirSync(dest).sort()).toEqual(['COMPLETE', 'SHA256SUMS', 'app.dump', 'app.dump.list', 'auth-data.dump', 'auth-data.dump.list', 'counts.txt'])
  const complete = readFileSync(join(dest, 'COMPLETE'), 'utf8')
  expect(complete).toContain('project=cuhkjnuwozgnqqqvqhnl')
  expect(complete).toContain('work=before-team-code')
  expect(complete).toContain('auth_included=1')
  expect(readFileSync(join(dest, 'SHA256SUMS'), 'utf8')).toMatch(/app\.dump[\s\S]*auth-data\.dump[\s\S]*counts\.txt/)
  // connection: fixed project user, pooler host, read-only target check before any dump
  const log = calls()
  expect(log).toContain('user=postgres.cuhkjnuwozgnqqqvqhnl')
  expect(log.indexOf('CALL psql')).toBeLessThan(log.indexOf('CALL pg_dump'))
  expect(log).toContain('begin transaction read only')
  expect(log).toContain('ENV PGPASSFILE=' + tmp)
  // the password never appears in arguments, environment or output; the password file is removed
  expect(log).not.toContain('Fake-Pass')
  expect(r.out).not.toContain('Fake-Pass')
  expect(passfiles()).toEqual([])
  expect(run(['--verify', dest]).code).toBe(0)
})

it('refuses to overwrite an existing backup', () => {
  expect(run(['before-team-code']).code).toBe(0)
  const dest = join(root, `${day()}-before-team-code`)
  const before = readFileSync(join(dest, 'SHA256SUMS'), 'utf8') + readFileSync(join(dest, 'COMPLETE'), 'utf8')
  const r = run(['before-team-code'])
  expect(r.code).not.toBe(0)
  expect(r.out).toContain('上書きしません')
  expect(entries()).toEqual([`${day()}-before-team-code`])
  expect(readFileSync(join(dest, 'SHA256SUMS'), 'utf8') + readFileSync(join(dest, 'COMPLETE'), 'utf8')).toBe(before)
})

it.each([
  ['pg_dump of app fails', { FAKE_FAIL: 'pg_dump_app' }, 'pg_dump（app）'],
  ['pg_dump of auth fails', { FAKE_FAIL: 'pg_dump_auth' }, 'pg_dump（auth）'],
  ['pg_restore --list fails', { FAKE_FAIL: 'pg_restore_list' }, 'app.dump の検証'],
  ['the reminder table is missing from the dump', { FAKE_DROP: 'public attendance_reminder_deliveries' }, 'attendance_reminder_deliveries'],
  ['auth.users is missing from the auth dump', { FAKE_DROP: 'auth users' }, 'auth.users'],
  ['the connection fails', { FAKE_FAIL: 'psql' }, '接続先の確認に失敗'],
])('leaves no backup and no COMPLETE when %s', (_, env, message) => {
  const r = run(['before-team-code'], { env })
  expectNothingLeft(r)
  expect(r.out).toContain(message)
  expect(r.out).not.toContain('Fake-Pass')
})

it('stops before dumping when the database is not this app', () => {
  const r = run(['before-team-code'], { env: { FAKE_MISSING: 'public.player_access' } })
  expectNothingLeft(r)
  expect(r.out).toContain('このアプリのDBではありません')
  expect(calls()).not.toContain('CALL pg_dump')
})

it.each([
  ['a non-pooler host', ['before-team-code'], `db.cuhkjnuwozgnqqqvqhnl.supabase.co\n${PASSWORD}\n`, 'ホスト名'],
  ['a pooler in another region', ['before-team-code'], `aws-0-us-east-1.pooler.supabase.com\n${PASSWORD}\n`, 'ホスト名'],
  ['an empty password', ['before-team-code'], `${HOST}\n\n`, 'パスワードが空'],
  ['an invalid work name', ['../escape'], undefined, '作業名'],
  ['no work name', [], undefined, '使い方'],
  ['an unknown option', ['before-team-code', '--all'], undefined, '不明なオプション'],
])('rejects %s without connecting', (_, args, input, message) => {
  const r = run(args, { input })
  expectNothingLeft(r)
  expect(r.out).toContain(message)
  expect(calls()).toBe('')
})

it('the connection guard rejects anything but the new project', () => {
  const guard = (conn: string) => spawnSync('bash', ['-c', `source "${SCRIPT}"; sd_validate_conn "$1" && echo PASS`, '_', conn], { encoding: 'utf8' })
  expect(guard(`host=${HOST} port=5432 dbname=postgres user=postgres.cuhkjnuwozgnqqqvqhnl`).stdout).toContain('PASS')
  expect(guard(`host=${HOST} port=5432 dbname=postgres user=postgres.flwwmfehxdmtomgkcdxm`).stderr).toContain('旧Supabase')
  expect(guard(`host=${HOST} port=5432 dbname=postgres user=postgres.otherproject`).stderr).toContain('新Supabaseではありません')
})

it('--without-auth stores app data only and verifies', () => {
  expect(run(['app-only', '--without-auth']).code).toBe(0)
  const dest = join(root, `${day()}-app-only`)
  expect(readdirSync(dest)).not.toContain('auth-data.dump')
  expect(readFileSync(join(dest, 'COMPLETE'), 'utf8')).toContain('auth_included=0')
  expect(run(['--verify', dest]).code).toBe(0)
})

it('--verify rejects incomplete, altered or foreign backups', () => {
  expect(run(['before-team-code']).code).toBe(0)
  const dest = join(root, `${day()}-before-team-code`)
  writeFileSync(join(dest, 'counts.txt'), 'public.players|999\n')
  expect(run(['--verify', dest]).out).toContain('チェックサムが一致しません')
  spawnSync('rm', [join(dest, 'COMPLETE')])
  expect(run(['--verify', dest]).out).toContain('COMPLETE がありません')
  writeFileSync(join(dest, 'COMPLETE'), 'project=flwwmfehxdmtomgkcdxm\n')
  expect(run(['--verify', dest]).out).toContain('新Supabaseのバックアップではありません')
  expect(run(['--verify', join(root, 'missing')]).code).not.toBe(0)
})
