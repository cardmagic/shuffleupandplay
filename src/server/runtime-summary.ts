import type { SolidObjectsRuntime } from "solid-objects"

import { GameRoom } from "../actors/game-room.ts"
import type { ShuffleApplication } from "../runtime.ts"

const CACHE_MILLISECONDS = 5_000
const MOVE_KINDS_SHOWN = 12

export type RuntimeSummary = {
  tables: { active: number }
  messages: { total: number; failed: number }
  effects: { total: number }
  reminders: { scheduled: number }
  deadLetters: number
  moves: { type: string; count: number }[]
}

export type RuntimeSummaryView = {
  read(): Promise<RuntimeSummary>
}

export function createRuntimeSummary(options: {
  application: ShuffleApplication
}): RuntimeSummaryView {
  const { application } = options
  let cached: { at: number; summary: RuntimeSummary } | undefined
  let reading: Promise<RuntimeSummary> | undefined

  const fresh = async (): Promise<RuntimeSummary> => {
    const summary = await collect(application)
    cached = { at: Date.now(), summary }
    return summary
  }

  return {
    read: async () => {
      if (cached && Date.now() - cached.at < CACHE_MILLISECONDS) return cached.summary
      reading ??= fresh().finally(() => {
        reading = undefined
      })

      return reading
    },
  }
}

async function collect(application: ShuffleApplication): Promise<RuntimeSummary> {
  const runtime = application.runtime

  const [counts, moves] = await Promise.all([
    tableCounts(runtime),
    moveCounts(application),
  ])

  return { ...counts, moves }
}

async function tableCounts(
  runtime: SolidObjectsRuntime,
): Promise<Omit<RuntimeSummary, "moves">> {
  const instances = runtime.repository.table("instances")
  const messages = runtime.repository.table("messages")
  const effects = runtime.repository.table("effects")
  const reminders = runtime.repository.table("reminders")
  const deadLetters = runtime.repository.table("dead_letters")

  return runtime.settings.database.connection(async (connection) => {
    const total = async (sql: string, parameters: readonly unknown[] = []) => {
      const row = await connection.get<{ total: number | bigint }>(sql, parameters)
      return Number(row?.total ?? 0)
    }

    return {
      tables: {
        active: await total(
          `SELECT COUNT(*) AS total FROM ${instances} WHERE actor_type = ? AND state_revision > 0`,
          [GameRoom.actorType],
        ),
      },
      messages: {
        total: await total(`SELECT COUNT(*) AS total FROM ${messages}`),
        failed: await total(
          `SELECT COUNT(*) AS total FROM ${messages} WHERE rejection IS NOT NULL OR error IS NOT NULL`,
        ),
      },
      effects: { total: await total(`SELECT COUNT(*) AS total FROM ${effects}`) },
      reminders: { scheduled: await total(`SELECT COUNT(*) AS total FROM ${reminders}`) },
      deadLetters: await total(`SELECT COUNT(*) AS total FROM ${deadLetters}`),
    }
  })
}

async function moveCounts(
  application: ShuffleApplication,
): Promise<{ type: string; count: number }[]> {
  const metrics = await application.actionMetrics()
  const totals = new Map<string, number>()
  for (const metric of metrics) {
    totals.set(metric.actionType, (totals.get(metric.actionType) ?? 0) + metric.actionCount)
  }

  return [...totals.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((first, second) => second.count - first.count)
    .slice(0, MOVE_KINDS_SHOWN)
}
