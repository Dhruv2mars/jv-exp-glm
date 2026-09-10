// Canonical CBOR per RFC 8949 section 4.2, restricted to the Javelin profile:
// definite lengths only, shortest integer encodings, map keys sorted by the
// bytewise order of their encoded form, no floats, no tags, no indefinite
// items, no duplicate keys. Allowed value types: null, boolean, integer,
// string, Uint8Array, array, plain object.

export type CborValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue }

const MAJOR_UINT = 0
const MAJOR_NEG = 1
const MAJOR_BYTES = 2
const MAJOR_TEXT = 3
const MAJOR_ARRAY = 4
const MAJOR_MAP = 5
const MAJOR_SIMPLE = 7

class Writer {
  private chunks: Uint8Array[] = []
  private len = 0

  byte(b: number): void {
    this.push(new Uint8Array([b]))
  }

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.len += bytes.length
  }

  head(major: number, value: number): void {
    const m = major << 5
    if (value < 24) {
      this.byte(m | value)
    } else if (value < 0x100) {
      this.byte(m | 24)
      this.byte(value)
    } else if (value < 0x10000) {
      this.byte(m | 25)
      this.push(new Uint8Array([(value >> 8) & 0xff, value & 0xff]))
    } else if (value < 0x100000000) {
      this.byte(m | 26)
      this.push(
        new Uint8Array([
          (value >>> 24) & 0xff,
          (value >>> 16) & 0xff,
          (value >>> 8) & 0xff,
          value & 0xff,
        ]),
      )
    } else {
      this.byte(m | 27)
      const big = BigInt(value)
      this.push(
        new Uint8Array([
          Number((big >> 56n) & 0xffn),
          Number((big >> 48n) & 0xffn),
          Number((big >> 40n) & 0xffn),
          Number((big >> 32n) & 0xffn),
          Number((big >> 24n) & 0xffn),
          Number((big >> 16n) & 0xffn),
          Number((big >> 8n) & 0xffn),
          Number(big & 0xffn),
        ]),
      )
    }
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.len)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }
}

const textEncoder = new TextEncoder()

function encodeInto(w: Writer, value: CborValue): void {
  if (value === null) {
    w.byte((MAJOR_SIMPLE << 5) | 22)
    return
  }
  switch (typeof value) {
    case 'boolean':
      w.byte((MAJOR_SIMPLE << 5) | (value ? 21 : 20))
      return
    case 'number': {
      if (!Number.isInteger(value)) {
        throw new TypeError('canonical cbor profile forbids non-integer numbers')
      }
      if (value >= 0) {
        w.head(MAJOR_UINT, value)
      } else {
        w.head(MAJOR_NEG, -1 - value)
      }
      return
    }
    case 'string': {
      const bytes = textEncoder.encode(value)
      w.head(MAJOR_TEXT, bytes.length)
      w.push(bytes)
      return
    }
    case 'object':
      break
    default:
      throw new TypeError(`canonical cbor profile forbids ${typeof value}`)
  }
  if (value instanceof Uint8Array) {
    w.head(MAJOR_BYTES, value.length)
    w.push(value)
    return
  }
  if (Array.isArray(value)) {
    w.head(MAJOR_ARRAY, value.length)
    for (const item of value) encodeInto(w, item)
    return
  }
  const keys = Object.keys(value)
  // RFC 8949 core deterministic rule: order by the bytewise comparison of
  // the fully encoded keys, not the raw text.
  const encodedKeys = keys.map((k) => ({ key: k, bytes: encodeKey(textEncoder.encode(k)) }))
  encodedKeys.sort((a, b) => compareBytes(a.bytes, b.bytes))
  w.head(MAJOR_MAP, encodedKeys.length)
  for (const { key, bytes } of encodedKeys) {
    w.push(bytes)
    encodeInto(w, value[key]!)
  }
}

function encodeKey(text: Uint8Array): Uint8Array {
  const w = new Writer()
  w.head(MAJOR_TEXT, text.length)
  w.push(text)
  return w.finish()
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  }
  return a.length - b.length
}

export function cborEncode(value: CborValue): Uint8Array {
  const w = new Writer()
  encodeInto(w, value)
  return w.finish()
}

class Reader {
  off = 0
  constructor(readonly buf: Uint8Array) {}

  byte(): number {
    if (this.off >= this.buf.length) throw new Error('cbor: unexpected end')
    return this.buf[this.off++]!
  }

  take(n: number): Uint8Array {
    if (this.off + n > this.buf.length) throw new Error('cbor: unexpected end')
    const out = this.buf.subarray(this.off, this.off + n)
    this.off += n
    return out
  }

  head(): { major: number; value: number } {
    const first = this.byte()
    const major = first >> 5
    const info = first & 0x1f
    if (info < 24) return { major, value: info }
    if (info === 24) return { major, value: this.byte() }
    if (info === 25) {
      const b = this.take(2)
      return { major, value: (b[0]! << 8) | b[1]! }
    }
    if (info === 26) {
      const b = this.take(4)
      return {
        major,
        value: ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0,
      }
    }
    if (info === 27) {
      const b = this.take(8)
      let v = 0n
      for (const x of b) v = (v << 8n) | BigInt(x!)
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: integer too large')
      return { major, value: Number(v) }
    }
    if (info === 31) throw new Error('cbor: indefinite lengths are not allowed')
    throw new Error(`cbor: unsupported additional info ${info}`)
  }
}

const textDecoder = new TextDecoder('utf-8', { fatal: true })

export function cborDecode(buf: Uint8Array): CborValue {
  const r = new Reader(buf)
  const value = decodeItem(r)
  if (r.off !== buf.length) throw new Error('cbor: trailing bytes')
  return value
}

function decodeItem(r: Reader): CborValue {
  const { major, value } = r.head()
  switch (major) {
    case MAJOR_UINT:
      return value
    case MAJOR_NEG:
      return -1 - value
    case MAJOR_BYTES:
      return new Uint8Array(r.take(value))
    case MAJOR_TEXT: {
      const bytes = r.take(value)
      try {
        return textDecoder.decode(bytes)
      } catch {
        throw new Error('cbor: invalid utf-8')
      }
    }
    case MAJOR_ARRAY: {
      const out: CborValue[] = []
      for (let i = 0; i < value; i++) out.push(decodeItem(r))
      return out
    }
    case MAJOR_MAP: {
      const out: { [key: string]: CborValue } = {}
      for (let i = 0; i < value; i++) {
        const keyHead = r.head()
        if (keyHead.major !== MAJOR_TEXT) throw new Error('cbor: non-string map key')
        const key = textDecoder.decode(r.take(keyHead.value))
        if (key in out) throw new Error('cbor: duplicate map key')
        out[key] = decodeItem(r)
      }
      return out
    }
    case MAJOR_SIMPLE:
      if (value === 20) return false
      if (value === 21) return true
      if (value === 22) return null
      if (value === 23) throw new Error('cbor: undefined is not allowed')
      throw new Error(`cbor: unsupported simple value ${value}`)
    default:
      throw new Error(`cbor: unsupported major type ${major}`)
  }
}
