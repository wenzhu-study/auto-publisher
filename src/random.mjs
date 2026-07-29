import { createHash, randomBytes } from 'node:crypto'

export function createSeed() {
  return randomBytes(12).toString('hex')
}

export function chooseDeterministically(items, seed, namespace) {
  if (!Array.isArray(items) || items.length === 0) return null

  const digest = createHash('sha256')
    .update(String(seed))
    .update('\0')
    .update(String(namespace))
    .digest()
  const number = digest.readUIntBE(0, 6)
  return items[number % items.length]
}
