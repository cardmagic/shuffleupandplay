import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SolidObjectsRuntime } from "solid-objects"

import { createShuffleApplication, type ShuffleApplication } from "../../src/runtime.ts"
import type { ArchidektDeck, DeckSearchResult } from "../../src/archidekt/client.ts"

export type TestRuntime = {
  application: ShuffleApplication
  runtime: SolidObjectsRuntime
  instrumentation: string[]
  deckRequests: string[]
  databasePath: string
  restart(options?: TestRuntimeOptions): Promise<TestRuntime>
  close(): Promise<void>
}

export type TestRuntimeOptions = {
  deck?: (deckId: string) => Promise<ArchidektDeck>
  directory?: string
  pollingIntervalMilliseconds?: number
}

export async function startTestRuntime(options: TestRuntimeOptions = {}): Promise<TestRuntime> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "shuffleupandplay-"))
  const databasePath = join(directory, "solid-objects.sqlite3")
  const instrumentation: string[] = []
  const deckRequests: string[] = []

  const application = createShuffleApplication({
    databasePath,
    pollingIntervalMilliseconds: options.pollingIntervalMilliseconds ?? 10,
    instrumentation: (event) => instrumentation.push(event.name),
    archidekt: {
      deck: async (deckId: string) => {
        deckRequests.push(deckId)
        const loader = options.deck ?? defaultDeck
        return loader(deckId)
      },
      search: async (): Promise<DeckSearchResult[]> => [],
    },
  })

  await application.install()

  return {
    application,
    runtime: application.runtime,
    instrumentation,
    deckRequests,
    databasePath,
    restart: async (next: TestRuntimeOptions = {}) => {
      await application.close()
      return startTestRuntime({ ...options, ...next, directory })
    },
    close: async () => {
      await application.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

async function defaultDeck(deckId: string): Promise<ArchidektDeck> {
  return {
    name: `Deck ${deckId}`,
    cards: [
      {
        instanceId: "forest-1",
        name: "Forest",
        scryfallId: "forest",
        imageUrl: "https://example.com/forest.jpg",
        tapped: false,
        isManaSource: true,
      },
      {
        instanceId: "bear-1",
        name: "Grizzly Bears",
        scryfallId: "bear",
        imageUrl: "https://example.com/bear.jpg",
        tapped: false,
        isManaSource: false,
      },
    ],
  }
}
