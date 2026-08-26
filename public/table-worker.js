import { createRuntime, registerTransmit, sharedSqliteWasm } from "/vendor/live/browser/host.js"
import { TableMirror } from "/shared/actors/table-mirror.ts"

const POLLING_INTERVAL_MILLISECONDS = 25
const MAXIMUM_DELIVERY_ATTEMPTS = 10000
const MAXIMUM_RETRY_SECONDS = 10

let table = null

self.onmessage = async (event) => {
  const { requestId, command } = event.data
  try {
    postMessage({ requestId, ok: true, value: await run(event.data) })
  } catch (error) {
    postMessage({
      requestId,
      ok: false,
      command,
      message: String(error?.message ?? error),
    })
  }
}

async function run(request) {
  if (request.command === "start") return start(request)
  if (request.command === "stop") return stop()

  const mirror = requireTable().mirror
  if (request.command === "seed") {
    return mirror.seed({ roomCode: requireTable().roomCode, player: request.player })
  }
  if (request.command === "apply") return mirror.apply({ action: request.action })
  if (request.command === "reconcile") return mirror.reconcile({ player: request.player })
  if (request.command === "seat") return mirror.seat()
  if (request.command === "forget") return mirror.forget()

  throw new Error(`unknown command ${request.command}`)
}

async function start({ roomCode, playerId }) {
  if (table) return table.roomCode

  const database = await sharedSqliteWasm({
    path: `shuffleupandplay-${roomCode}.sqlite3`,
    name: `shuffleupandplay-${roomCode}`,
    storage: "persistent",
  })
  const runtime = createRuntime({
    database,
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeSubscription: () => false,
    pollingIntervalMilliseconds: POLLING_INTERVAL_MILLISECONDS,
    syncPollingIntervalMilliseconds: POLLING_INTERVAL_MILLISECONDS,
    maxAttempts: MAXIMUM_DELIVERY_ATTEMPTS,
    retryDelayMilliseconds: (attempt) => Math.min(attempt, MAXIMUM_RETRY_SECONDS) * 1_000,
    workerCount: 0,
    effectWorkerCount: 1,
    broadcastWorkerCount: 0,
    reminderSchedulerCount: 0,
  })
  runtime.register(TableMirror)
  registerTransmit({ runtime, deliver: (envelope) => deliver({ roomCode, envelope }) })
  await runtime.install()

  const shutdown = new AbortController()
  const running = runtime.run(shutdown.signal)

  table = {
    roomCode,
    database,
    runtime,
    shutdown,
    running,
    mirror: runtime.ref(TableMirror, `${roomCode}:${playerId}`),
  }
  return roomCode
}

async function deliver({ roomCode, envelope }) {
  const response = await fetch(`/api/tables/${roomCode}/sync`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  })
  if (response.status === 400 || response.status === 403) return
  if (!response.ok) throw new Error(`sync failed with ${response.status}`)
}

async function stop() {
  const current = table
  if (!current) return "stopped"

  table = null
  current.shutdown.abort()
  await current.running.catch(() => undefined)
  await current.runtime.close()
  await current.database.close()
  return "stopped"
}

function requireTable() {
  if (!table) throw new Error("the table mirror has not started")
  return table
}
