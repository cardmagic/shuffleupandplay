import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ArchidektDeck, DeckSearchResult } from "../src/archidekt/client.ts"
import { createShuffleApplication } from "../src/runtime.ts"
import { createShuffleServer } from "../src/server/app.ts"
import type { Card } from "../src/game/types.ts"

const PORT = Number(process.env.SHUFFLE_BROWSER_PORT ?? 4181)
const DECK_SIZE = 12

const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

const directory = mkdtempSync(join(tmpdir(), "shuffleupandplay-browser-"))

function deckCard(index: number): Card {
  return {
    instanceId: `card-${index}`,
    name: `Test Card ${index}`,
    scryfallId: `test-${index}`,
    imageUrl: TRANSPARENT_PIXEL,
    tapped: false,
    isManaSource: index % 3 === 0,
  }
}

const application = createShuffleApplication({
  databasePath: join(directory, "solid-objects.sqlite3"),
  pollingIntervalMilliseconds: 10,
  archidekt: {
    deck: async (deckId: string): Promise<ArchidektDeck> => ({
      name: `Test Deck ${deckId}`,
      cards: Array.from({ length: DECK_SIZE }, (_value, index) => deckCard(index + 1)),
    }),
    search: async (): Promise<DeckSearchResult[]> => [],
  },
})

await application.install()

const server = createShuffleServer({
  application,
  secret: "browser-suite-secret-that-is-long-enough",
})
await server.listen(PORT)

const shutdown = new AbortController()
const running = application.runtime.run(shutdown.signal)

async function stop(): Promise<void> {
  shutdown.abort()
  await running.catch(() => undefined)
  await server.close()
  await application.close()
  rmSync(directory, { recursive: true, force: true })
  process.exit(0)
}

process.once("SIGTERM", () => void stop())
process.once("SIGINT", () => void stop())

console.log(`browser suite listening on http://127.0.0.1:${PORT}`)
