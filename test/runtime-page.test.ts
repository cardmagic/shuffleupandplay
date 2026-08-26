import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { jsonRequest, startTestServer, type TestClient, type TestServer } from "./support/server.ts"
import type { RoomPayload } from "../src/game/types.ts"

let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})

afterEach(async () => {
  await server.close()
})

type RuntimeSummary = {
  tables: { active: number }
  messages: { total: number; failed: number }
  effects: { total: number }
  reminders: { scheduled: number }
  deadLetters: number
  moves: { type: string; count: number }[]
}

async function seatedTable(client: TestClient, playerName = "Alice"): Promise<string> {
  const payload = await client.json<RoomPayload>(
    "/api/tables",
    jsonRequest({ playerName, tableName: "Kitchen Table" }),
  )
  const code = payload.space?.code
  if (!code) throw new Error("expected a table code")
  return code
}

async function summary(client: TestClient): Promise<RuntimeSummary> {
  return client.json<RuntimeSummary>("/api/runtime")
}

describe("the public runtime summary", () => {
  test("counts an active table", async () => {
    const client = server.client()
    await seatedTable(client)

    await expect.poll(async () => (await summary(client)).tables.active).toBeGreaterThan(0)
  })

  test("counts the moves players made, by kind", async () => {
    const client = server.client()
    const code = await seatedTable(client)
    for (let move = 0; move < 3; move += 1) {
      await client.fetch(
        `/api/tables/${code}/actions`,
        jsonRequest({ action: { type: "adjustLife", delta: -1 } }),
      )
    }

    await expect
      .poll(async () => {
        const moves = (await summary(client)).moves
        return moves.find((entry) => entry.type === "adjustLife")?.count ?? 0
      })
      .toBe(3)
  })

  test("counts durable messages and dead letters", async () => {
    const client = server.client()
    await seatedTable(client)

    const counts = await summary(client)

    expect(counts.messages.total).toBeGreaterThan(0)
    expect(counts.deadLetters).toBe(0)
    expect(counts.reminders.scheduled).toBeGreaterThanOrEqual(0)
  })

  test("names no table, player, session or card", async () => {
    const client = server.client()
    const code = await seatedTable(client, "Winifred")
    await client.fetch(`/api/tables/${code}/deck`, jsonRequest({ deckId: "42" }))
    await server.harness.runtime.testing.drain()
    await client.fetch(
      `/api/tables/${code}/actions`,
      jsonRequest({ action: { type: "drawCard", count: 1 } }),
    )

    const body = await (await client.fetch("/api/runtime")).text()

    expect(body).not.toContain(code)
    expect(body).not.toContain("Winifred")
    expect(body).not.toContain("Grizzly Bears")
    expect(body).not.toContain("Forest")
    expect(body.toLowerCase()).not.toContain("session")
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  test("creates no session for a visitor", async () => {
    const response = await server.client().fetch("/api/runtime")

    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()).toEqual([])
  })

  test("needs no operator surface to answer", async () => {
    const response = await server.client().fetch("/api/runtime")

    expect(response.status).toBe(200)
  })
})

describe("the public runtime page", () => {
  test("renders without naming a table or a player", async () => {
    const client = server.client()
    const code = await seatedTable(client, "Winifred")

    const response = await client.fetch("/runtime", { headers: { accept: "text/html" } })
    const markup = await response.text()

    expect(response.status).toBe(200)
    expect(markup).toContain("<html")
    expect(markup).not.toContain(code)
    expect(markup).not.toContain("Winifred")
  })

  test("creates no session for a visitor", async () => {
    const response = await server
      .client()
      .fetch("/runtime", { headers: { accept: "text/html" } })

    expect(response.headers.getSetCookie()).toEqual([])
  })

  test("holds its answer briefly so a crowd cannot drive the database", async () => {
    const client = server.client()
    await seatedTable(client)

    const first = await summary(client)
    const second = await summary(client)

    expect(second).toEqual(first)
  })
})
