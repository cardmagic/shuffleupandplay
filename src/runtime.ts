import {
  createRuntime,
  type InstrumentationEvent,
  type JsonObject,
  type SolidObjectsRuntime,
} from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

import { MatchLog } from "./actors/match-log.ts"
import { PlaymatRoom, type DeckResult, type PlaymatViewer } from "./actors/playmat-room.ts"
import { createArchidektClient, type ArchidektClient } from "./archidekt/client.ts"
import { isPlayerInRoom } from "./playmat/room-snapshot.ts"

const ACTION_METRICS_TABLE = "playmat_action_metrics"

export type PlaymatRuntimeOptions = {
  databasePath: string
  pollingIntervalMilliseconds?: number
  workerCount?: number
  instrumentation?: (event: InstrumentationEvent) => void
  archidekt?: ArchidektClient
}

export type PlaymatApplication = {
  runtime: SolidObjectsRuntime
  archidekt: ArchidektClient
  install(): Promise<void>
  actionMetrics(): Promise<ActionMetric[]>
  close(): Promise<void>
}

export type ActionMetric = {
  roomCode: string
  actionType: string
  seat: number
  recordedAtMilliseconds: number
}

export function createPlaymatApplication(options: PlaymatRuntimeOptions): PlaymatApplication {
  const database = sqlite({ path: options.databasePath, timeoutMilliseconds: 5_000 })
  const archidekt = options.archidekt ?? createArchidektClient()

  const runtime = createRuntime({
    database,
    pollingIntervalMilliseconds: options.pollingIntervalMilliseconds ?? 20,
    workerCount: options.workerCount ?? 1,
    effectWorkerCount: 1,
    broadcastWorkerCount: 1,
    reminderSchedulerCount: 1,
    messageRetentionByActorType: { [PlaymatRoom.actorType]: 24 * 60 * 60 * 1_000 },
    instanceRetentionByActorType: { [PlaymatRoom.actorType]: 7 * 24 * 60 * 60 * 1_000 },
    ...(options.instrumentation ? { instrumentation: options.instrumentation } : {}),
    authorizeMessage: ({ actorType, actorId, authorizationContext }) =>
      authorizesActor({ actorType, actorId, authorizationContext }),
    authorizeQuery: ({ actorType, actorId, authorizationContext }) =>
      authorizesActor({ actorType, actorId, authorizationContext }),
    authorizeDestroy: () => false,
    authorizeAdministration: ({ authorizationContext }) => isOperator(authorizationContext),
    authorizeSubscription: async ({ actorType, actorId, authorizationContext }) => {
      if (!authorizesActor({ actorType, actorId, authorizationContext })) return false
      if (actorType !== PlaymatRoom.actorType) return true

      const viewer = authorizationContext as PlaymatViewer
      const snapshot = await runtime
        .ref(PlaymatRoom, actorId)
        .snapshot({ authorizationContext: viewer })
      if (!snapshot.room) return false

      return isPlayerInRoom({ room: snapshot.room, sessionId: viewer.sessionId })
    },
  })

  runtime.register(PlaymatRoom)
  runtime.register(MatchLog)

  runtime.registerEffect("fetchArchidektDeck", async (argumentsValue): Promise<DeckResult> => {
    const deck = await archidekt.deck(String(argumentsValue.deckId))
    return {
      deckName: deck.name,
      cards: deck.cards,
    }
  })

  runtime.registerCommitAction("recordActionMetric", async (argumentsValue, context) => {
    await context.connection.run(
      `INSERT INTO ${ACTION_METRICS_TABLE} (room_code, action_type, seat, recorded_at_ms)
       VALUES (?, ?, ?, ?)`,
      [
        String(argumentsValue.roomCode),
        String(argumentsValue.actionType),
        Number(argumentsValue.seat),
        await context.connection.nowMilliseconds(),
      ],
    )
  })

  return {
    runtime,
    archidekt,
    install: async () => {
      await runtime.install()
      await database.connection(async (connection) => {
        await connection.run(`CREATE TABLE IF NOT EXISTS ${ACTION_METRICS_TABLE} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_code TEXT NOT NULL,
          action_type TEXT NOT NULL,
          seat INTEGER NOT NULL,
          recorded_at_ms INTEGER NOT NULL
        )`)
      })
    },
    actionMetrics: async () =>
      database.connection(async (connection) => {
        const rows = await connection.all<{
          room_code: string
          action_type: string
          seat: bigint
          recorded_at_ms: bigint
        }>(`SELECT room_code, action_type, seat, recorded_at_ms
            FROM ${ACTION_METRICS_TABLE} ORDER BY id`)
        return rows.map((row) => ({
          roomCode: row.room_code,
          actionType: row.action_type,
          seat: Number(row.seat),
          recordedAtMilliseconds: Number(row.recorded_at_ms),
        }))
      }),
    close: async () => {
      await runtime.close()
    },
  }
}

export function isOperator(authorizationContext: unknown): boolean {
  return isRecord(authorizationContext) && authorizationContext.source === "cli"
}

function authorizesActor(options: {
  actorType: string
  actorId: string
  authorizationContext: unknown
}): boolean {
  const viewer = options.authorizationContext
  if (!isViewer(viewer)) return false
  if (viewer.roomCode !== options.actorId) return false

  return options.actorType === PlaymatRoom.actorType || options.actorType === MatchLog.actorType
}

function isViewer(value: unknown): value is PlaymatViewer {
  if (!isRecord(value)) return false
  return typeof value.sessionId === "string" && typeof value.roomCode === "string"
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
