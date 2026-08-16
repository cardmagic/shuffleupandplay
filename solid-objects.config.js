import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { createPlaymatApplication } from "./dist/runtime.js"

const databasePath = resolve(process.env.PLAYMAT_DATABASE_PATH ?? "storage/solid-objects.sqlite3")
mkdirSync(dirname(databasePath), { recursive: true })

const application = createPlaymatApplication({ databasePath })

export default application.runtime
