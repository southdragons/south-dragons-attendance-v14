import { scryptSync } from 'node:crypto'
import { expect, it } from 'vitest'
import { passwordProof, passwordSalt } from '../server/utils/password'
it('derives fixed scrypt proofs using independent sync crypto and unique salts', async () => {
  const salt = passwordSalt(), password = '日本語のパスワード⚾2026'
  expect(salt).toMatch(/^[a-f0-9]{64}$/)
  expect(passwordSalt()).not.toBe(salt)
  const expected = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex')
  expect(await passwordProof(password, salt)).toBe(expected)
  expect(await passwordProof(password + 'x', salt)).not.toBe(expected)
})
