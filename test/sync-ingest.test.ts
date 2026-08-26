import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { GameRoom } from "../src/actors/game-room.ts"
import { jsonRequest, startTestServer, type TestClient, type TestServer } from "./support/server.ts"
import type { RoomPayload } from "../src/game/types.ts"

let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})

afterEach(async () => {
  await server.close()
})

async function createRoom(client: TestClient, playerName = "Alice"): Promise<string> {
  const payload = await client.json<RoomPayload>(
    "/api/tables",
    jsonRequest({ playerName, tableName: "Kitchen Table" }),
  )
  const code = payload.space?.code
  if (!code) throw new Error("expected a table code")
  return code
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effectId: "01930000-0000-7000-8000-000000000001",
    actorType: "GameRoom",
    actorId: "IGNORED",
    operation: "applyAction",
    arguments: { action: { type: "adjustLife", delta: -3 }, moveNumber: 1 },
    ...overrides,
  }
}

async function sync(options: {
  client: TestClient
  code: string
  body: Record<string, unknown>
}): Promise<Response> {
  return options.client.fetch(`/api/tables/${options.code}/sync`, jsonRequest(options.body))
}

async function seatOf(options: { client: TestClient; code: string; name: string }) {
  const payload = await options.client.json<RoomPayload>(`/api/tables/${options.code}/state`)
  return payload.space?.players.find((player) => player.name === options.name)
}

describe("transmitted move ingest", () => {
  test("applies a transmitted move to the sender's own seat", async () => {
    const client = server.client()
    const code = await createRoom(client)

    const response = await sync({ client, code, body: envelope({ actorId: code }) })
    await server.harness.runtime.testing.drain()

    expect(response.status).toBe(202)
    expect((await seatOf({ client, code, name: "Alice" }))?.life).toBe(17)
  })

  test("records the move number so the browser can drop what landed", async () => {
    const client = server.client()
    const code = await createRoom(client)

    await sync({ client, code, body: envelope({ actorId: code }) })
    await server.harness.runtime.testing.drain()

    expect((await seatOf({ client, code, name: "Alice" }))?.appliedMove).toBe(1)
  })

  test("applies a replayed envelope exactly once", async () => {
    const client = server.client()
    const code = await createRoom(client)
    const body = envelope({ actorId: code })

    await sync({ client, code, body })
    await sync({ client, code, body })
    await sync({ client, code, body })
    await server.harness.runtime.testing.drain()

    expect((await seatOf({ client, code, name: "Alice" }))?.life).toBe(17)
  })

  test("keeps one sender's effect id from silencing another sender", async () => {
    const alice = server.client()
    const code = await createRoom(alice)
    const bob = server.client()
    await bob.fetch(`/api/tables/${code}/join`, jsonRequest({ playerName: "Bob" }))

    await sync({ client: alice, code, body: envelope({ actorId: code }) })
    await sync({ client: bob, code, body: envelope({ actorId: code }) })
    await server.harness.runtime.testing.drain()

    expect((await seatOf({ client: alice, code, name: "Alice" }))?.life).toBe(17)
    expect((await seatOf({ client: alice, code, name: "Bob" }))?.life).toBe(17)
  })

  test("uses the server's session rather than one named in the envelope", async () => {
    const alice = server.client()
    const code = await createRoom(alice)
    const bob = server.client()
    await bob.fetch(`/api/tables/${code}/join`, jsonRequest({ playerName: "Bob" }))

    const aliceSeat = await seatOf({ client: alice, code, name: "Alice" })
    await sync({
      client: bob,
      code,
      body: envelope({
        actorId: code,
        arguments: {
          action: { type: "adjustLife", delta: -9 },
          moveNumber: 1,
          sessionId: aliceSeat?.id,
        },
      }),
    })
    await server.harness.runtime.testing.drain()

    expect((await seatOf({ client: alice, code, name: "Alice" }))?.life).toBe(20)
    expect((await seatOf({ client: alice, code, name: "Bob" }))?.life).toBe(11)
  })

  test("refuses an envelope aimed at another actor type", async () => {
    const client = server.client()
    const code = await createRoom(client)

    const response = await sync({
      client,
      code,
      body: envelope({ actorId: code, actorType: "MatchLog" }),
    })

    expect(response.status).toBe(400)
  })

  test("refuses an envelope aimed at another table", async () => {
    const client = server.client()
    const code = await createRoom(client)

    const response = await sync({ client, code, body: envelope({ actorId: "ZZZZZZ" }) })

    expect(response.status).toBe(400)
  })

  test("refuses an operation other than applying an action", async () => {
    const client = server.client()
    const code = await createRoom(client)

    const response = await sync({
      client,
      code,
      body: envelope({ actorId: code, operation: "createRoom" }),
    })

    expect(response.status).toBe(400)
  })

  test("refuses an envelope with no usable effect id", async () => {
    const client = server.client()
    const code = await createRoom(client)

    const response = await sync({ client, code, body: envelope({ actorId: code, effectId: "" }) })

    expect(response.status).toBe(400)
  })

  test("refuses a session that holds no seat at the table", async () => {
    const owner = server.client()
    const code = await createRoom(owner)

    const stranger = server.client()
    await stranger.fetch("/")
    const response = await sync({ client: stranger, code, body: envelope({ actorId: code }) })

    expect(response.status).toBe(403)
  })

  test("never lets a transmitted move reach an actor the table does not own", async () => {
    const client = server.client()
    const code = await createRoom(client)

    await sync({
      client,
      code,
      body: envelope({ actorId: code, actorType: GameRoom.actorType, operation: "destroy" }),
    })
    await server.harness.runtime.testing.drain()

    expect((await seatOf({ client, code, name: "Alice" }))?.life).toBe(20)
  })
})
