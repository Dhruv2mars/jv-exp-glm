import { createBLAKE3, type IHasher } from 'hash-wasm'
import { createHash } from 'node:crypto'

// Object identity is self-describing: varint(algorithm code) ++
// varint(digest length) ++ digest. BLAKE3-256 is the default profile;
// SHA-256 exists as an explicit interoperability profile. Abbreviated
// digests are never valid ids.

export type Algo = 'blake3' | 'sha256'

const ALGO_CODE: Record<Algo, number> = { blake3: 0x01, sha256: 0x02 }
const CODE_ALGO: Record<number, Algo> = { 0x01: 'blake3', 0x02: 'sha256' }
const ALGO_LEN: Record<Algo, number> = { blake3: 32, sha256: 32 }

// Every hash input is domain-separated and versioned:
//   "JVL\0" ++ varint(FORMAT_MAJOR) ++ tag ++ varint(payload length) ++ payload
// so the same bytes under different domains never collide.
const FORMAT_MAJOR = 1
const PREIMAGE_PREFIX = new Uint8Array([0x4a, 0x56, 0x4c, 0x00]) // "JVL\0"

export class Oid {
  readonly algo: Algo
  readonly digest: Uint8Array
  private hexCache: string | undefined
  private bytesCache: Uint8Array | undefined

  constructor(algo: Algo, digest: Uint8Array) {
    if (digest.length !== ALGO_LEN[algo]) {
      throw new Error(`oid: ${algo} digest must be ${ALGO_LEN[algo]} bytes`)
    }
    this.algo = algo
    this.digest = digest
  }

  static fromBytes(bytes: Uint8Array): Oid {
    let off = 0
    const readVarint = (): number => {
      let shift = 0
      let value = 0
      for (;;) {
        if (off >= bytes.length) throw new Error('oid: truncated varint')
        const b = bytes[off++]!
        value |= (b & 0x7f) << shift
        if ((b & 0x80) === 0) break
        shift += 7
        if (shift > 28) throw new Error('oid: varint too large')
      }
      return value >>> 0
    }
    const code = readVarint()
    const algo = CODE_ALGO[code]
    if (!algo) throw new Error(`oid: unknown algorithm code ${code}`)
    const len = readVarint()
    if (len !== ALGO_LEN[algo]) throw new Error(`oid: unexpected digest length ${len}`)
    const digest = bytes.subarray(off, off + len)
    if (digest.length !== len) throw new Error('oid: truncated digest')
    return new Oid(algo, new Uint8Array(digest))
  }

  static parse(hex: string): Oid {
    const sep = hex.indexOf(':')
    const algo = sep === -1 ? 'blake3' : (hex.slice(0, sep) as Algo)
    const digestHex = sep === -1 ? hex : hex.slice(sep + 1)
    if (!(algo in ALGO_CODE) || !/^[0-9a-f]+$/.test(digestHex)) {
      throw new Error(`oid: cannot parse ${hex}`)
    }
    return new Oid(algo, Uint8Array.from(Buffer.from(digestHex, 'hex')))
  }

  get hex(): string {
    return (this.hexCache ??= Buffer.from(this.digest).toString('hex'))
  }

  get ref(): string {
    return `${this.algo}:${this.hex}`
  }

  get bytes(): Uint8Array {
    if (this.bytesCache) return this.bytesCache
    const out = new Uint8Array(2 + 2 + this.digest.length)
    let off = 0
    off = writeVarint(out, off, ALGO_CODE[this.algo])
    off = writeVarint(out, off, this.digest.length)
    out.set(this.digest, off)
    return (this.bytesCache = out)
  }

  equals(other: Oid): boolean {
    return this.algo === other.algo && compareDigest(this.digest, other.digest) === 0
  }
}

function writeVarint(buf: Uint8Array, off: number, value: number): number {
  let v = value
  for (;;) {
    const b = v & 0x7f
    v >>>= 7
    if (v === 0) {
      buf[off++] = b
      return off
    }
    buf[off++] = b | 0x80
  }
}

function compareDigest(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  }
  return 0
}

export function varintLen(value: number): number {
  let n = 0
  let v = value
  do {
    n++
    v >>>= 7
  } while (v !== 0)
  return n
}

let blake3: IHasher | undefined
const blake3Ready = createBLAKE3().then((h) => {
  blake3 = h
  return h
})

function digestWith(algo: Algo, payload: Uint8Array): Uint8Array {
  if (algo === 'sha256') {
    return Uint8Array.from(createHash('sha256').update(payload).digest())
  }
  if (!blake3) throw new Error('oid: blake3 not initialised yet; await oidReady() first')
  blake3.init()
  blake3.update(payload)
  return Uint8Array.from(blake3.digest('binary'))
}

export async function oidReady(): Promise<void> {
  await blake3Ready
}

export function typedHash(domain: string, payload: Uint8Array, algo: Algo = 'blake3'): Oid {
  const tag = new TextEncoder().encode(domain)
  const len =
    PREIMAGE_PREFIX.length + varintLen(FORMAT_MAJOR) + tag.length + varintLen(payload.length)
  const preimage = new Uint8Array(len + payload.length)
  let off = 0
  preimage.set(PREIMAGE_PREFIX, off)
  off += PREIMAGE_PREFIX.length
  off = writeVarint(preimage, off, FORMAT_MAJOR)
  preimage.set(tag, off)
  off += tag.length
  off = writeVarint(preimage, off, payload.length)
  preimage.set(payload, off)
  return new Oid(algo, digestWith(algo, preimage))
}

export function hashBytes(payload: Uint8Array, algo: Algo = 'blake3'): Oid {
  return new Oid(algo, digestWith(algo, payload))
}
