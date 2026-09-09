import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cborEncode, type CborValue } from './cbor.ts'
import { typedHash, Oid } from './oids.ts'

// The timeline is a small typed event log: meaningful VCS events with stable
// content-derived ids. Raw editor writes are workspace state; native agent
// events are context; the timeline connects them without duplicating either.
// Derived views (history, show) are built on World versions and these events.

export const EVENT_TYPES = [
  'world.initialized',
  'layer.created',
  'layer.cloned',
  'agent.session.started',
  'subagent.recorded',
  'layer.sealed',
  'layers.stacked',
  'publish.rejected',
  'layer.published',
  'world.version.created',
  'layer.deleted',
  'verification.failed',
  'context.missing.override',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export interface TimelineEvent {
  seq: number
  id: string
  type: EventType
  at: string
  refs: Record<string, string>
}

export class Timeline {
  constructor(readonly root: string) {}

  private get path(): string {
    return join(this.root, 'timeline.jsonl')
  }

  append(type: EventType, refs: Record<string, string>): TimelineEvent {
    const existing = this.read()
    const last = existing[existing.length - 1]
    const seq = (last?.seq ?? 0) + 1
    const body = { v: 1, seq, type, at: new Date().toISOString(), refs }
    const id = typedHash('timeline-event', cborEncode(body as unknown as CborValue))
    const event: TimelineEvent = { seq, id: id.ref, type: body.type as EventType, at: body.at, refs }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`)
    return event
  }

  // A torn final line (crash mid-append) is truncated; corruption anywhere
  // earlier still throws.
  read(limit?: number): TimelineEvent[] {
    if (!existsSync(this.path)) return []
    const lines = readFileSync(this.path, 'utf8').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const all: TimelineEvent[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (line === '') continue
      try {
        all.push(JSON.parse(line) as TimelineEvent)
      } catch (e) {
        if (i === lines.length - 1) break
        throw e
      }
    }
    return limit === undefined ? all : all.slice(-limit)
  }

  count(): number {
    return this.read().length
  }

  find(idOrShort: string): TimelineEvent | null {
    return this.read().find((e) => e.id === idOrShort || e.id.endsWith(idOrShort)) ?? null
  }

  findRef(ref: Oid): TimelineEvent | null {
    return this.find(ref.ref)
  }
}
