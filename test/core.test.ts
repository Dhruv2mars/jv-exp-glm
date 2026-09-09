import { describe, expect, test, beforeAll } from 'bun:test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { cborDecode, cborEncode, type CborValue } from '../src/core/cbor.ts'
import { Oid, typedHash, hashBytes, oidReady } from '../src/core/oids.ts'
import { ObjectStore, objectCount } from '../src/core/objects.ts'

beforeAll(async () => {
  await oidReady()
})

describe('canonical cbor', () => {
  test('RFC 8949 appendix A vectors in profile', () => {
    const cases: Array<[string, CborValue]> = [
      ['00', 0],
      ['17', 23],
      ['1818', 24],
      ['1864', 100],
      ['1903e8', 1000],
      ['1a000f4240', 1000000],
      ['20', -1],
      ['3903e7', -1000],
    ]
    for (const [hex, value] of cases) {
      const bytes = Uint8Array.from(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
      expect(cborEncode(value)).toEqual(bytes)
      expect(cborDecode(bytes)).toEqual(value)
    }
  })

  test('text, bytes, arrays, maps, simple values', () => {
    expect(cborDecode(cborEncode('IETF'))).toBe('IETF')
    expect(cborDecode(cborEncode('a'))).toBe('a')
    expect(cborDecode(cborEncode(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]))
    expect(cborDecode(cborEncode([1, [2, 3], 'x']))).toEqual([1, [2, 3], 'x'])
    expect(cborDecode(cborEncode({ a: 1, b: [true, null] }))).toEqual({ a: 1, b: [true, null] })
  })

  test('map keys are sorted by encoded bytes, not length', () => {
    // "b" encodes as 0x6162, "aa" as 0x626161: "b" sorts first.
    const encoded = cborEncode({ aa: 1, b: 2 })
    expect(encoded[0]).toBe(0xa2)
    expect(encoded[1]).toBe(0x61) // text "b"
  })

  test('profile rejects floats; decoder rejects duplicate and non-string keys', () => {
    expect(() => cborEncode(1.5 as never)).toThrow()
    const dup = Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02])
    expect(() => cborDecode(dup)).toThrow()
    const numKey = Uint8Array.from([0xa1, 0x01, 0x01])
    expect(() => cborDecode(numKey)).toThrow()
  })
})

describe('typed object ids', () => {
  test('domain separation changes identity', () => {
    const payload = new TextEncoder().encode('hello')
    expect(typedHash('file', payload).ref).not.toBe(typedHash('tree', payload).ref)
    expect(hashBytes(payload).ref).not.toBe(typedHash('file', payload).ref)
  })

  test('hashing is deterministic', () => {
    const payload = new TextEncoder().encode('javelin')
    expect(typedHash('file', payload).hex).toBe(typedHash('file', payload).hex)
  })

  test('ids round-trip through the self-describing byte form', () => {
    const id = typedHash('world-version', new TextEncoder().encode('x'))
    expect(Oid.fromBytes(id.bytes).equals(id)).toBeTrue()
    expect(Oid.parse(id.ref).equals(id)).toBeTrue()
  })

  test('sha256 profile is explicit and distinct', () => {
    const payload = new TextEncoder().encode('javelin')
    const sha = typedHash('file', payload, 'sha256')
    expect(sha.algo).toBe('sha256')
    expect(Oid.fromBytes(sha.bytes).algo).toBe('sha256')
    expect(sha.ref).not.toBe(typedHash('file', payload).ref)
  })
})

describe('object store', () => {
  function newStore(): { store: ObjectStore; dir: string } {
    const dir = joinTmp(`objects-${Math.random().toString(36).slice(2)}`)
    return { store: ObjectStore.open(dir), dir }
  }

  test('put is idempotent and content-addressed', () => {
    const { store } = newStore()
    const a = store.put('file', new TextEncoder().encode('same'))
    const b = store.put('file', new TextEncoder().encode('same'))
    expect(a.ref).toBe(b.ref)
    expect(new TextDecoder().decode(store.get(a))).toBe('same')
  })

  test('records verify against their domain', () => {
    const { store } = newStore()
    const { id } = store.putRecord('world-version', { v: 1, seq: 3 })
    expect(store.verify('world-version', id)).toBeTrue()
    expect(store.verify('tree', id)).toBeFalse()
    const { record } = store.getRecord('world-version', id)
    expect(record).toEqual({ v: 1, seq: 3 })
  })

  test('corrupted payloads fail verification', () => {
    const { store, dir } = newStore()
    const id = store.put('file', new TextEncoder().encode('original'))
    const path = `${dir}/${id.hex.slice(0, 2)}/${id.hex.slice(2)}`
    const bytes = new Uint8Array(readFileSync(path))
    bytes[0] = bytes[0]! ^ 0xff
    writeFileSync(path, bytes)
    expect(store.verify('file', id)).toBeFalse()
  })

  test('object count reflects written objects', () => {
    const { store, dir } = newStore()
    expect(objectCount(dir)).toBe(0)
    store.put('file', new TextEncoder().encode('one'))
    store.put('file', new TextEncoder().encode('two'))
    expect(objectCount(dir)).toBe(2)
    store.put('file', new TextEncoder().encode('one'))
    expect(objectCount(dir)).toBe(2)
  })
})

function joinTmp(name: string): string {
  const path = `${import.meta.dir}/.tmp/${name}`
  mkdirSync(path, { recursive: true })
  return path
}
