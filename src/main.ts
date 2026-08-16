import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { DashboardAccess } from "solid-objects/web"

import { PlaymatRoom } from "./actors/playmat-room.ts"
import { createPlaymatApplication } from "./runtime.ts"
import { createPlaymatServer } from "./server/app.ts"

const databasePath = resolve(
  process.env.PLAYMAT_DATABASE_PATH ?? "storage/solid-objects.sqlite3",
)
const secret = process.env.PLAYMAT_SECRET
if (!secret || secret.length < 32) {
  throw new Error("PLAYMAT_SECRET must be set to at least 32 characters")
}
const operatorDashboardAccess = dashboardAccess(process.env.PLAYMAT_OPERATOR_DASHBOARD)
if (
  operatorDashboardAccess &&
  operatorDashboardAccess !== "public-read-only" &&
  process.env.NODE_ENV === "production"
) {
  throw new Error("PLAYMAT_OPERATOR_DASHBOARD cannot be enabled in production")
}

mkdirSync(dirname(databasePath), { recursive: true })

const application = createPlaymatApplication({
  databasePath,
  instrumentation: (event) => {
    if (!event.name.endsWith(".failed")) return
    console.warn(JSON.stringify({ event: event.name, ...event.attributes }))
  },
})
await application.install()

const server = createPlaymatServer({
  application,
  secret,
  secureCookies: process.env.NODE_ENV === "production",
  ...(operatorDashboardAccess
    ? { operatorDashboard: { access: operatorDashboardAccess } }
    : {}),
})

const port = await server.listen(Number(process.env.PORT ?? 3000))
console.log(`MTG Playmat listening on http://localhost:${port}`)
console.log(`Actor type: ${PlaymatRoom.actorType}`)

const shutdown = new AbortController()
let shuttingDown = false

async function stop(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  shutdown.abort()
  await server.close()
  await application.close()
}

process.once("SIGTERM", () => void stop())
process.once("SIGINT", () => void stop())

await application.runtime.run(shutdown.signal)
await stop()

function dashboardAccess(value: string | undefined): DashboardAccess | undefined {
  if (!value || value === "false") return undefined
  if (value === "true" || value === "authorized") return "authorized"
  if (value === "authorized-read-only") return value
  if (value === "public-read-only") return value
  throw new Error(`unsupported PLAYMAT_OPERATOR_DASHBOARD mode ${value}`)
}
