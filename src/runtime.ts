import {
  createRuntime,
  type InstrumentationEvent,
  type JsonObject,
  type SolidObjectsRuntime,
} from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

import { MatchLog } from "./actors/match-log.ts"
import { GameRoom, type DeckResult, type GameViewer } from "./actors/game-room.ts"
import { createArchidektClient, type ArchidektClient } from "./archidekt/client.ts"
import { isPlayerInRoom } from "./game/room-snapshot.ts"

const ACTION_METRICS_TABLE = "game_action_counts"
const LEGACY_ACTION_METRICS_TABLE = "game_action_metrics"
const METRICS_BUCKET_MILLISECONDS = 60 * 60 * 1_000
const DEFAULT_POLLING_INTERVAL_MILLISECONDS = 500
const MESSAGE_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000
const INSTANCE_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000

export type ShuffleRuntimeOptions = {
  databasePath: string
  pollingIntervalMilliseconds?: number
  workerCount?: number
  instrumentation?: (event: InstrumentationEvent) => void
  archidekt?: ArchidektClient
}

export type ShuffleApplication = {
  runtime: SolidObjectsRuntime
  archidekt: ArchidektClient
  install(): Promise<void>
  actionMetrics(): Promise<ActionMetric[]>
  pruneActionMetrics(options: { olderThanMilliseconds: number }): Promise<void>
  close(): Promise<void>
}

export type ActionMetric = {
  roomCode: string
  actionType: string
  seat: number
  bucketStartMilliseconds: number
  actionCount: number
}

export function createShuffleApplication(options: ShuffleRuntimeOptions): ShuffleApplication {
  const database = sqlite({ path: options.databasePath, timeoutMilliseconds: 5_000 })
  const archidekt = options.archidekt ?? createArchidektClient()

  const runtime = createRuntime({
    database,
    pollingIntervalMilliseconds:
      options.pollingIntervalMilliseconds ?? DEFAULT_POLLING_INTERVAL_MILLISECONDS,
    workerCount: options.workerCount ?? 1,
    effectWorkerCount: 1,
    broadcastWorkerCount: 1,
    reminderSchedulerCount: 1,
    messageRetentionByActorType: {
      [GameRoom.actorType]: MESSAGE_RETENTION_MILLISECONDS,
      [MatchLog.actorType]: MESSAGE_RETENTION_MILLISECONDS,
    },
    instanceRetentionByActorType: {
      [GameRoom.actorType]: INSTANCE_RETENTION_MILLISECONDS,
      [MatchLog.actorType]: INSTANCE_RETENTION_MILLISECONDS,
    },
    ...(options.instrumentation ? { instrumentation: options.instrumentation } : {}),
    authorizeMessage: ({ actorType, actorId, authorizationContext }) =>
      authorizesActor({ actorType, actorId, authorizationContext }),
    authorizeQuery: ({ actorType, actorId, authorizationContext }) =>
      authorizesActor({ actorType, actorId, authorizationContext }),
    authorizeDestroy: () => false,
    authorizeAdministration: ({ authorizationContext }) => isOperator(authorizationContext),
    authorizeSubscription: async ({ actorType, actorId, authorizationContext }) => {
      if (!authorizesActor({ actorType, actorId, authorizationContext })) return false
      if (actorType !== GameRoom.actorType) return true

      const viewer = authorizationContext as GameViewer
      const snapshot = await runtime
        .ref(GameRoom, actorId)
        .snapshot({ authorizationContext: viewer })
      if (!snapshot.room) return false

      return isPlayerInRoom({ room: snapshot.room, sessionId: viewer.sessionId })
    },
  })

  runtime.register(GameRoom)
  runtime.register(MatchLog)

  runtime.registerEffect("fetchArchidektDeck", async (argumentsValue): Promise<DeckResult> => {
    const deck = await archidekt.deck(String(argumentsValue.deckId))
    return {
      deckName: deck.name,
      cards: deck.cards,
    }
  })

  runtime.registerCommitAction("recordActionMetric", async (argumentsValue, context) => {
    const now = await context.connection.nowMilliseconds()
    const bucketStart = Math.floor(now / METRICS_BUCKET_MILLISECONDS) * METRICS_BUCKET_MILLISECONDS

    await context.connection.run(
      `INSERT INTO ${ACTION_METRICS_TABLE}
         (room_code, action_type, seat, bucket_start_ms, action_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (room_code, action_type, seat, bucket_start_ms)
       DO UPDATE SET action_count = action_count + 1`,
      [
        String(argumentsValue.roomCode),
        String(argumentsValue.actionType),
        Number(argumentsValue.seat),
        bucketStart,
      ],
    )
  })

  return {
    runtime,
    archidekt,
    install: async () => {
      await runtime.install()
      await database.connection(async (connection) => {
        await connection.run(`DROP TABLE IF EXISTS ${LEGACY_ACTION_METRICS_TABLE}`)
        await connection.run(`CREATE TABLE IF NOT EXISTS ${ACTION_METRICS_TABLE} (
          room_code TEXT NOT NULL,
          action_type TEXT NOT NULL,
          seat INTEGER NOT NULL,
          bucket_start_ms INTEGER NOT NULL,
          action_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (room_code, action_type, seat, bucket_start_ms)
        )`)
      })
    },
    actionMetrics: async () =>
      database.connection(async (connection) => {
        const rows = await connection.all<{
          room_code: string
          action_type: string
          seat: bigint
          bucket_start_ms: bigint
          action_count: bigint
        }>(`SELECT room_code, action_type, seat, bucket_start_ms, action_count
            FROM ${ACTION_METRICS_TABLE} ORDER BY bucket_start_ms, action_type`)
        return rows.map((row) => ({
          roomCode: row.room_code,
          actionType: row.action_type,
          seat: Number(row.seat),
          bucketStartMilliseconds: Number(row.bucket_start_ms),
          actionCount: Number(row.action_count),
        }))
      }),
    pruneActionMetrics: async (options: { olderThanMilliseconds: number }) =>
      database.connection(async (connection) => {
        const now = await connection.nowMilliseconds()
        await connection.run(`DELETE FROM ${ACTION_METRICS_TABLE} WHERE bucket_start_ms < ?`, [
          now - options.olderThanMilliseconds,
        ])
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

  return options.actorType === GameRoom.actorType || options.actorType === MatchLog.actorType
}

function isViewer(value: unknown): value is GameViewer {
  if (!isRecord(value)) return false
  return typeof value.sessionId === "string" && typeof value.roomCode === "string"
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
