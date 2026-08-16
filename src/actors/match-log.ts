import { Actor } from "solid-objects"

const MAXIMUM_ENTRIES = 200

export type MatchLogEntry = {
  event: string
  detail: string
  recordedAt: string
}

export class MatchLog extends Actor {
  static override readonly actorType = "MatchLog"

  entries: MatchLogEntry[] = []

  get entryCount(): number {
    return this.entries.length
  }

  get latestEvent(): string | null {
    return this.entries.at(-1)?.event ?? null
  }

  override observables(): Record<string, unknown> {
    return { entryCount: this.entryCount, latestEvent: this.latestEvent }
  }

  record(options: { event: string; detail: string }): number {
    const entry: MatchLogEntry = {
      event: options.event,
      detail: options.detail,
      recordedAt: new Date().toISOString(),
    }
    this.entries = [...this.entries, entry].slice(-MAXIMUM_ENTRIES)
    return this.entries.length
  }
}
