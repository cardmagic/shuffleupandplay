import { Signal } from "signal-polyfill"
import type { SolidObjectsRuntime } from "solid-objects"
import type { LiveSignal } from "solid-objects/signals"

import { GameRoom } from "../actors/game-room.ts"

const DEFAULT_LIMIT = 50
const OPERATOR_CONTEXT = { source: "cli" }

export type LiveTable = {
  roomCode: string
  revision: string
  version: number | null
  lifeTotals: Record<string, number> | null
  seats: number
}

export type LiveTablesView = {
  tables(): Promise<LiveTable[]>
  close(): void
}

type WatchedTable = {
  watcher: InstanceType<typeof Signal.subtle.Watcher>
  version: LiveSignal<unknown>
  lifeTotals: LiveSignal<unknown>
}

export function createLiveTables(options: {
  runtime: SolidObjectsRuntime
  limit?: number
}): LiveTablesView {
  const { runtime } = options
  const limit = options.limit ?? DEFAULT_LIMIT
  const watched = new Map<string, WatchedTable>()

  const watch = (roomCode: string): WatchedTable => {
    const existing = watched.get(roomCode)
    if (existing) return existing

    const reference = runtime.ref(GameRoom, roomCode)
    const version = reference.live.version as LiveSignal<unknown>
    const lifeTotals = reference.live.lifeTotals as LiveSignal<unknown>
    const watcher = new Signal.subtle.Watcher(() => {
      queueMicrotask(() => rewatch({ watcher, version, lifeTotals }))
    })
    watcher.watch(version as never, lifeTotals as never)
    version.get()
    lifeTotals.get()

    const entry = { watcher, version, lifeTotals }
    watched.set(roomCode, entry)
    return entry
  }

  const forget = (roomCode: string): void => {
    const entry = watched.get(roomCode)
    if (!entry) return

    entry.watcher.unwatch(entry.version as never, entry.lifeTotals as never)
    watched.delete(roomCode)
  }

  return {
    tables: async () => {
      const page = await runtime.reconciliation.active({
        actorType: GameRoom.actorType,
        limit,
        authorizationContext: OPERATOR_CONTEXT,
      })
      const active = new Set(page.items.map((item) => item.actorId))
      for (const roomCode of [...watched.keys()]) {
        if (!active.has(roomCode)) forget(roomCode)
      }

      return page.items.map((item) => {
        const entry = watch(item.actorId)
        const lifeTotals = asLifeTotals(entry.lifeTotals.get())

        return {
          roomCode: item.actorId,
          revision: item.revision,
          version: asVersion(entry.version.get()),
          lifeTotals,
          seats: lifeTotals ? Object.keys(lifeTotals).length : 0,
        }
      })
    },
    close: () => {
      for (const roomCode of [...watched.keys()]) forget(roomCode)
    },
  }
}

function rewatch(entry: WatchedTable): void {
  entry.watcher.watch(entry.version as never, entry.lifeTotals as never)
  entry.version.get()
  entry.lifeTotals.get()
}

function asVersion(value: unknown): number | null {
  return typeof value === "number" ? value : null
}

function asLifeTotals(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null

  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.every(([, life]) => typeof life === "number")) return null

  return Object.fromEntries(entries) as Record<string, number>
}
