import { Signal } from "signal-polyfill"
import type { SolidObjectsRuntime } from "solid-objects"
import { configureLiveSignals, type LiveSignal } from "solid-objects/signals"

import { GameRoom, type GameViewer } from "../actors/game-room.ts"
import { broadcastObservables } from "../game/room-snapshot.ts"
import type { Room } from "../game/types.ts"

const MINIMUM_TIMEOUT_MILLISECONDS = 250
const MAXIMUM_TIMEOUT_MILLISECONDS = 30_000
const DEFAULT_TIMEOUT_MILLISECONDS = 25_000
const SESSION_LINGER_MILLISECONDS = 30_000

configureLiveSignals({ lingerMilliseconds: SESSION_LINGER_MILLISECONDS })

export type ChangeEnvelope = {
  version: 1
  kind: "invalidation"
  actorType: string
  actorId: string
  instanceId: string
  revision: string
  observables: Record<string, unknown>
  invalidations: string[]
}

export function pollTimeoutMilliseconds(value: string | null): number {
  const requested = Number(value)
  if (!Number.isFinite(requested)) return DEFAULT_TIMEOUT_MILLISECONDS

  return Math.min(Math.max(requested, MINIMUM_TIMEOUT_MILLISECONDS), MAXIMUM_TIMEOUT_MILLISECONDS)
}

export function pollRevision(value: string | null): bigint {
  if (!value || !/^\d{1,20}$/.test(value)) return -1n

  return BigInt(value)
}

export async function waitForTableChange(options: {
  runtime: SolidObjectsRuntime
  roomCode: string
  viewer: GameViewer
  sinceRevision: bigint
  timeoutMilliseconds: number
  abortSignal: AbortSignal
}): Promise<ChangeEnvelope | null> {
  const { runtime, roomCode, viewer, sinceRevision, abortSignal } = options
  const reference = runtime.ref(GameRoom, roomCode)

  const settled = await currentEnvelope({ runtime, roomCode, viewer, sinceRevision })
  if (settled) return settled

  const signal = reference.live.version as LiveSignal<unknown>
  const deadline = Date.now() + options.timeoutMilliseconds

  while (Date.now() < deadline && !abortSignal.aborted) {
    await nextChange({ signal, timeoutMilliseconds: deadline - Date.now(), abortSignal })
    if (abortSignal.aborted) return null

    const envelope = await currentEnvelope({ runtime, roomCode, viewer, sinceRevision })
    if (envelope) return envelope
  }

  return null
}

async function currentEnvelope(options: {
  runtime: SolidObjectsRuntime
  roomCode: string
  viewer: GameViewer
  sinceRevision: bigint
}): Promise<ChangeEnvelope | null> {
  const { runtime, roomCode, viewer } = options
  const reference = runtime.ref(GameRoom, roomCode)
  const incarnation = await runtime.snapshotWithIncarnation(reference, {
    authorizationContext: viewer,
  })
  if (BigInt(incarnation.revision) <= options.sinceRevision) return null

  const room = incarnation.snapshot.room as Room | null

  return {
    version: 1,
    kind: "invalidation",
    actorType: GameRoom.actorType,
    actorId: roomCode,
    instanceId: incarnation.instanceId,
    revision: incarnation.revision,
    observables: { ...broadcastObservables(room) },
    invalidations: ["seatOne", "seatTwo"],
  }
}

function nextChange(options: {
  signal: LiveSignal<unknown>
  timeoutMilliseconds: number
  abortSignal: AbortSignal
}): Promise<void> {
  const { signal, abortSignal } = options

  return new Promise<void>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      abortSignal.removeEventListener("abort", finish)
      watcher.unwatch(signal as never)
      resolve()
    }

    const watcher = new Signal.subtle.Watcher(finish)
    timer = setTimeout(finish, Math.max(0, options.timeoutMilliseconds))
    abortSignal.addEventListener("abort", finish, { once: true })

    watcher.watch(signal as never)
    signal.get()
  })
}
