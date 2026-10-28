import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'

// Supabase loads `safeupdate` for API connections: DELETE/UPDATE without WHERE fails with 21000.
// Already-applied migrations are history and are not checked; new ones (from the team code release) are.
const FIRST_CHECKED = '20261023000000'
export function unsafeStatements(sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, '')
  const found: string[] = []
  for (const statement of code.split(';')) {
    const pattern = /\b(delete\s+from\s+[\w."]+|(?<!do\s)update\s+[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set)\b/gi
    for (const match of statement.matchAll(pattern)) {
      if (!/\bwhere\b/i.test(statement.slice(match.index))) found.push(statement.slice(match.index).trim().replace(/\s+/g, ' ').slice(0, 80))
    }
  }
  return found
}

it('the checker catches the statement that broke admin setup and password change', () => {
  expect(unsafeStatements('begin\n  delete from private.admin_sessions;\nend')).toHaveLength(1)
  expect(unsafeStatements('update private.team_code set enforcement=1;')).toHaveLength(1)
  expect(unsafeStatements('delete from private.admin_sessions where true;')).toEqual([])
  expect(unsafeStatements('insert into t values(1) on conflict(id) do update set a=excluded.a;')).toEqual([])
  expect(unsafeStatements('select * into v from t where id=1 for update;')).toEqual([])
  expect(unsafeStatements('update private.team_code set\n  a=1,\n  b=2\nwhere id;')).toEqual([])
  expect(unsafeStatements('update private.team_members m set revoked_at=now() where m.revoked_at is null;')).toEqual([])
})

it('new migrations contain no DELETE/UPDATE without WHERE', () => {
  const files = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f.slice(0, 14) >= FIRST_CHECKED)
  expect(files).toContain('20261023000000_team_code.sql')
  for (const file of files) expect(unsafeStatements(readFileSync(`supabase/migrations/${file}`, 'utf8')), file).toEqual([])
})

it('the rollback SQL and setup.sql additions contain no DELETE/UPDATE without WHERE', () => {
  expect(unsafeStatements(readFileSync('supabase/rollback/20261023000000_team_code_down.sql', 'utf8'))).toEqual([])
  const setup = readFileSync('supabase/setup.sql', 'utf8')
  expect(unsafeStatements(setup.slice(setup.indexOf('-- ---- 20261019000000_attendance_reminder.sql')))).toEqual([])
})
