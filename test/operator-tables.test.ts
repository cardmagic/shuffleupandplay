import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { jsonRequest, startTestServer, type TestClient, type TestServer } from "./support/server.ts"
import type { RoomPayload } from "../src/game/types.ts"

let server: TestServer
let shutdown: AbortController
let running: Promise<void>

beforeEach(async () => {
  server = await startTestServer({ operatorDashboard: { access: "authorized" } })
  shutdown = new AbortController()
  running = server.harness.runtime.run(shutdown.signal)
})

afterEach(async () => {
  shutdown.abort()
  await running
  await server.close()
})

type LiveTable = {
  roomCode: string
  revision: string
  version: number | null
  lifeTotals: Record<string, number> | null
  seats: number
}

async function createRoom(client: TestClient): Promise<string> {
  const payload = await client.json<RoomPayload>(
    "/api/tables",
    jsonRequest({ playerName: "Alice", tableName: "Kitchen Table" }),
  )
  const code = payload.space?.code
  if (!code) throw new Error("expected a table code")
  return code
}

async function operatorTables(client: TestClient): Promise<LiveTable[]> {
  const body = await client.json<{ tables: LiveTable[] }>("/api/operator/tables")
  return body.tables
}

async function tableWhen(options: {
  client: TestClient
  code: string
  ready: (table: LiveTable) => boolean
}): Promise<LiveTable> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const table = (await operatorTables(options.client)).find(
      (candidate) => candidate.roomCode === options.code,
    )
    if (table && options.ready(table)) return table
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for table ${options.code}`)
}

describe("live operator table view", () => {
  test("lists an active table with its revision and life totals", async () => {
    const player = server.client()
    const code = await createRoom(player)

    const table = await tableWhen({
      client: server.client(),
      code,
      ready: (candidate) => candidate.lifeTotals !== null,
    })

    expect(table.seats).toBe(1)
    expect(table.version).toBe(1)
    expect(table.lifeTotals).toEqual({ "1": 20 })
    expect(BigInt(table.revision) > 0n).toBe(true)
  })

  test("follows the table as it moves", async () => {
    const player = server.client()
    const code = await createRoom(player)
    const operator = server.client()
    await tableWhen({ client: operator, code, ready: (candidate) => candidate.version === 1 })

    await player.fetch(
      `/api/tables/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: -8 } }),
    )

    const table = await tableWhen({
      client: operator,
      code,
      ready: (candidate) => candidate.version === 2,
    })
    expect(table.lifeTotals).toEqual({ "1": 12 })
  })

  test("names no card and no session", async () => {
    const player = server.client()
    const code = await createRoom(player)
    await player.fetch(`/api/tables/${code}/deck`, jsonRequest({ deckId: "42" }))
    await server.harness.runtime.testing.drain()

    const operator = server.client()
    await tableWhen({ client: operator, code, ready: (candidate) => candidate.lifeTotals !== null })
    const body = await (await operator.fetch("/api/operator/tables")).text()

    expect(body).not.toContain("Grizzly Bears")
    expect(body).not.toContain("sessionId")
    expect(body).not.toContain("hidden-")
  })
})

describe("live operator table view without the operator surface", () => {
  test("is absent when the operator dashboard is off", async () => {
    const plain = await startTestServer()
    try {
      const response = await plain.client().fetch("/api/operator/tables")
      expect(response.status).toBe(404)
    } finally {
      await plain.close()
    }
  })
})
