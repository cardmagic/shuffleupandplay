import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { createShuffleApplication } from "./dist/runtime.js"

const databasePath = resolve(process.env.SHUFFLE_DATABASE_PATH ?? "storage/solid-objects.sqlite3")
mkdirSync(dirname(databasePath), { recursive: true })

const application = createShuffleApplication({ databasePath })

export default application.runtime
