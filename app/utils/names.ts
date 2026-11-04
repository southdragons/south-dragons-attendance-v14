// Similar-name check for new registrations (Phase 4-F). Same rules as private.name_key / names_similar
// in supabase/migrations/20261030000000_registration_guard.sql (tests compare the two).
// Used directly in demo / GAS mode; in Supabase mode the server decides and filters what it returns.
import type { Player } from '~/types/team'

const KATAKANA_START = 0x30a1, KATAKANA_END = 0x30f6

/** NFKC, lower case, katakana -> hiragana, spaces / middle dots / dashes removed. The long vowel mark stays. */
export function nameKey(name: string) {
  const folded = (name || '').normalize('NFKC').replace(/[\s・·.‐‑–—_-]+/gu, '').toLowerCase()
  let out = ''
  for (const ch of folded) {
    const code = ch.codePointAt(0)!
    out += code >= KATAKANA_START && code <= KATAKANA_END ? String.fromCodePoint(code - 0x60) : ch
  }
  return out
}

export function editDistance(a: string, b: string) {
  const x = [...a], y = [...b]
  if (!x.length) return y.length
  if (!y.length) return x.length
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    for (let j = 1; j <= y.length; j++) cur.push(Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1)))
    prev = cur
  }
  return prev[y.length]!
}

/** Same key, one contains the other (2+ characters), or one character different. */
export function keysSimilar(a: string, b: string) {
  if (!a || !b) return false
  if (a === b) return true
  const la = [...a].length, lb = [...b].length
  if (Math.min(la, lb) >= 2 && (a.includes(b) || b.includes(a))) return true
  if (Math.abs(la - lb) > 1) return false
  return editDistance(a, b) <= 1
}

export function similarPlayers(players: Player[], name: string, limit = 5) {
  const key = nameKey(name)
  return players.filter(p => p.active && keysSimilar(nameKey(p.name), key))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id)).slice(0, limit)
}
