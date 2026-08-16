import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { createPlaymatApplication } from "./runtime.ts"

const databasePath = resolve(process.env.PLAYMAT_DATABASE_PATH ?? "storage/solid-objects.sqlite3")
mkdirSync(dirname(databasePath), { recursive: true })

const application = createPlaymatApplication({ databasePath })
await application.install()

const report = await application.runtime.doctor.run()
for (const check of report.checks) {
  console.log(`${check.status.padEnd(4)} ${check.name.padEnd(16)} ${check.message}`)
}

if (!report.healthy) process.exitCode = 1
await application.close()
