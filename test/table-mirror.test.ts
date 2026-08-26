import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createRuntime, registerTransmit, type SolidObjectsRuntime } from "solid-objects"
import { sqlite } from "solid-objects/database/sqlite"

import { GameRoom } from "../src/actors/game-room.ts"
import { TableMirror } from "../src/actors/table-mirror.ts"
import type { PublicCard, PublicPlayer } from "../src/game/types.ts"

const ROOM_CODE = "ABC123"

type Delivered = {
  effectId: string
  actorType: string
  actorId: string
  operation: string
  arguments: Record<string, unknown>
}

let directory: string
let runtime: SolidObjectsRuntime
let delivered: Delivered[]
let shutdown: AbortController
let running: Promise<void>

function card(name: string): PublicCard {
  return {
    instanceId: `${name}-1`,
    name,
    scryfallId: name,
    imageUrl: `https://example.com/${name}.jpg`,
    tapped: false,
    isManaSource: false,
  }
}

function seatedPlayer(overrides: Partial<PublicPlayer> = {}): PublicPlayer {
  return {
    id: "player-1",
    name: "Alice",
    seat: 1,
    life: 20,
    deckName: "Test Deck",
    deckStatus: "loaded",
    library: [card("Forest"), card("Bear")],
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    isSearchingDeck: false,
    appliedMove: 0,
    ...overrides,
  }
}

async function startMirror(): Promise<void> {
  runtime = createRuntime({
    database: sqlite({ path: join(directory, "mirror.sqlite3") }),
    authorizeMessage: () => true,
    authorizeQuery: () => true,
    authorizeDestroy: () => true,
    authorizeSubscription: () => true,
    pollingIntervalMilliseconds: 5,
    syncPollingIntervalMilliseconds: 5,
    workerCount: 1,
    effectWorkerCount: 1,
  })
  runtime.register(TableMirror)
  registerTransmit({
    runtime,
    deliver: async (envelope) => {
      delivered.push(envelope as Delivered)
    },
  })
  await runtime.install()
  shutdown = new AbortController()
  running = runtime.run(shutdown.signal)
}

function mirror() {
  return runtime.ref(TableMirror, `${ROOM_CODE}:player-1`)
}

async function seeded(player: PublicPlayer = seatedPlayer()) {
  return mirror().seed({ roomCode: ROOM_CODE, player })
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "shuffle-mirror-"))
  delivered = []
  await startMirror()
})

afterEach(async () => {
  shutdown.abort()
  await running
  await runtime.close()
  rmSync(directory, { recursive: true, force: true })
})

describe("the local table mirror", () => {
  test("projects the seeded seat before any move", async () => {
    const seat = await seeded()

    expect(seat.pendingCount).toBe(0)
    expect(seat.player?.life).toBe(20)
    expect(seat.player?.library).toHaveLength(2)
  })

  test("applies a move at once and returns the projected seat", async () => {
    await seeded()

    const seat = await mirror().apply({ action: { type: "drawCard", count: 1 } })

    expect(seat.player?.hand).toHaveLength(1)
    expect(seat.player?.library).toHaveLength(1)
    expect(seat.pendingCount).toBe(1)
  })

  test("numbers each move so the table can report what it applied", async () => {
    await seeded()

    await mirror().apply({ action: { type: "adjustLife", delta: -1 } })
    const seat = await mirror().apply({ action: { type: "adjustLife", delta: -1 } })

    expect(seat.moveNumber).toBe(2)
    expect(seat.player?.life).toBe(18)
  })

  test("transmits each move to the table", async () => {
    await seeded()
    await mirror().apply({ action: { type: "adjustLife", delta: -4 } })

    await waitFor(() => delivered.length === 1, "the transmitted move")

    expect(delivered[0]?.actorType).toBe(GameRoom.actorType)
    expect(delivered[0]?.actorId).toBe(ROOM_CODE)
    expect(delivered[0]?.operation).toBe("applyAction")
    expect(delivered[0]?.arguments).toEqual({
      action: { type: "adjustLife", delta: -4 },
      moveNumber: 1,
    })
  })

  test("never transmits a session id", async () => {
    await seeded()
    await mirror().apply({ action: { type: "adjustLife", delta: -1 } })
    await waitFor(() => delivered.length === 1, "the transmitted move")

    expect(JSON.stringify(delivered[0])).not.toContain("sessionId")
  })

  test("replays the moves the table has not applied on top of the table's seat", async () => {
    await seeded()
    await mirror().apply({ action: { type: "adjustLife", delta: -5 } })
    await mirror().apply({ action: { type: "adjustLife", delta: -5 } })

    const seat = await mirror().reconcile({ player: seatedPlayer({ life: 15, appliedMove: 1 }) })

    expect(seat.player?.life).toBe(10)
    expect(seat.pendingCount).toBe(1)
  })

  test("drops the moves the table reports applied", async () => {
    await seeded()
    await mirror().apply({ action: { type: "adjustLife", delta: -5 } })
    await mirror().apply({ action: { type: "adjustLife", delta: -5 } })

    const seat = await mirror().reconcile({ player: seatedPlayer({ life: 10, appliedMove: 2 }) })

    expect(seat.player?.life).toBe(10)
    expect(seat.pendingCount).toBe(0)
  })

  test("refuses an action the rule does not know", async () => {
    await seeded()

    await expect(mirror().apply({ action: { type: "summonDragon" } })).rejects.toThrow()
    expect((await mirror().seat()).pendingCount).toBe(0)
  })

  test("keeps its queue across a restart", async () => {
    await seeded()
    await mirror().apply({ action: { type: "adjustLife", delta: -7 } })

    shutdown.abort()
    await running
    await runtime.close()
    await startMirror()

    const seat = await mirror().seat()
    expect(seat.pendingCount).toBe(1)
    expect(seat.player?.life).toBe(13)
  })
})

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("counters the browser adds", () => {
  test("carry the identifier the browser chose, so the table agrees", async () => {
    await seeded(
      seatedPlayer({
        library: [],
        battlefield: [{ ...card("Bear"), x: 10, y: 10, counters: [] }],
      }),
    )

    const seat = await mirror().apply({
      action: { type: "addCounter", instanceId: "Bear-1", x: 8, y: 8, counterId: "counter-9" },
    })

    expect(seat.player?.battlefield[0]?.counters[0]?.id).toBe("counter-9")
    await waitFor(() => delivered.length === 1, "the transmitted move")
    expect(delivered[0]?.arguments.action).toMatchObject({ counterId: "counter-9" })
  })

  test("let a later move find the counter the browser just added", async () => {
    await seeded(
      seatedPlayer({
        library: [],
        battlefield: [{ ...card("Bear"), x: 10, y: 10, counters: [] }],
      }),
    )
    await mirror().apply({
      action: { type: "addCounter", instanceId: "Bear-1", x: 8, y: 8, counterId: "counter-9" },
    })

    const seat = await mirror().apply({
      action: {
        type: "updateCounterValue",
        instanceId: "Bear-1",
        counterId: "counter-9",
        delta: 2,
      },
    })

    expect(seat.player?.battlefield[0]?.counters[0]?.value).toBe(2)
  })
})
