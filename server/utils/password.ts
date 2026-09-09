import { randomBytes, scrypt } from 'node:crypto'

// Fixed parameters. The GAS API only accepts proofs from this trusted server.
export function passwordProof(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key.toString('hex'))
    })
  })
}
export function passwordSalt() { return randomBytes(32).toString('hex') }
