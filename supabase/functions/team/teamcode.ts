// Team code flows for the `team` Edge Function. Runs in Deno (production) and Node (tests).
// The code itself never leaves this module except once, to the admin who issued it.
import { createHmac, randomBytes, randomInt, scrypt } from 'node:crypto'

// No 0/O, 1/I/L. 31 symbols, 8 characters: about 40 bits.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 8

export type Rpc = (action: string, payload?: Record<string, unknown>) => Promise<any>
export type Proof = (secret: string, salt: string) => Promise<string>

// Same scrypt parameters as the admin password.
export const scryptProof: Proof = (secret, salt) => new Promise((resolve, reject) =>
  scrypt(secret, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key.toString('hex'))))

export function generateTeamCode(): { display: string; canonical: string } {
  let canonical = ''
  for (let i = 0; i < CODE_LENGTH; i++) canonical += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return { canonical, display: `SD-${canonical.slice(0, 4)}-${canonical.slice(4)}` }
}

// Accepts "SD-ABCD-EFGH", "abcd efgh", full-width input, etc. Anything else still goes through
// hashing (so malformed and wrong codes cost the same and answer the same).
export function normalizeTeamCode(input: unknown): string {
  const s = typeof input === 'string' ? input.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '') : ''
  return (s.length === CODE_LENGTH + 2 && s.startsWith('SD') ? s.slice(2) : s).slice(0, 64)
}

export class TeamCodeError extends Error {}

// Optional IP bucket. Used only when an operator has verified which header the platform sets
// and configured both values; otherwise no IP is read and no IP limit applies.
export async function ipKeyFrom(request: Request, env: (key: string) => string | undefined): Promise<string | undefined> {
  const header = env('TEAM_CODE_IP_HEADER'), key = env('TEAM_CODE_IP_HMAC_KEY')
  if (!header || !key || key.length < 32) return undefined
  const raw = request.headers.get(header)?.split(',')[0]?.trim()
  if (!raw || raw.length > 64) return undefined
  return createHmac('sha256', key).update(raw).digest('hex')
}

// verifyTeamCode: count (committed) -> hash -> compare. Every failure is the same TEAM_CODE_INVALID.
export async function verifyTeamCode(rpc: Rpc, payload: Record<string, unknown>, ipKey?: string, proof: Proof = scryptProof) {
  const label = typeof payload.label === 'string' ? payload.label.trim() : ''
  if (label.length > 30 || (payload.code !== undefined && typeof payload.code !== 'string') || String(payload.code ?? '').length > 64) throw new TeamCodeError('BAD_REQUEST')
  const prepared = await rpc('teamCodePrepare', ipKey ? { ipKey } : {})
  if (prepared?.limited) throw new TeamCodeError('RATE_LIMITED')
  if (typeof prepared?.salt !== 'string') throw new Error('TEAM_CODE_PREPARE_FAILED')
  const secret = normalizeTeamCode(payload.code)
  const input: Record<string, unknown> = { proof: await proof(secret, prepared.salt), label }
  if (typeof prepared.previousSalt === 'string') input.previousProof = await proof(secret, prepared.previousSalt)
  const result = await rpc('verifyTeamCode', input)
  if (!result?.verified) throw new TeamCodeError('TEAM_CODE_INVALID')
  return { snapshot: result.snapshot }
}

// rotateTeamCode: the server generates the code; only salt + proof reach the database.
export async function rotateTeamCode(rpc: Rpc, payload: Record<string, unknown>, proof: Proof = scryptProof) {
  const graceHours = payload.graceHours ?? 0
  if (!Number.isInteger(graceHours) || (graceHours as number) < 0 || (graceHours as number) > 24) throw new TeamCodeError('BAD_REQUEST')
  const code = generateTeamCode(), salt = randomBytes(32).toString('hex')
  const result = await rpc('rotateTeamCode', { salt, proof: await proof(code.canonical, salt), graceHours })
  return { teamCode: code.display, snapshot: result.snapshot }
}
