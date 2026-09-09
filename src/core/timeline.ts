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
    const seq = this.count() + 1
    const body = { v: 1, seq, type, at: new Date().toISOString(), refs }
    const id = typedHash('timeline-event', cborEncode(body as unknown as CborValue))
    const event: TimelineEvent = { seq, id: id.ref, type: body.type as EventType, at: body.at, refs }
    appendFileSync(this.path, `${JSON.stringify(event)}\n`)
    return event
  }

  read(limit?: number): TimelineEvent[] {
    if (!existsSync(this.path)) return []
    const all = readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as TimelineEvent)
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
