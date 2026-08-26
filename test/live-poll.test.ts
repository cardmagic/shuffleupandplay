import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  SolidObjectsComponentRegistry,
  type ComponentApplication,
  type InvalidationEnvelope,
} from "solid-objects/browser"

import { GameRoom } from "../src/actors/game-room.ts"
import { componentDeclarations } from "../src/server/render/pages.ts"
import { jsonRequest, startTestServer, type TestClient, type TestServer } from "./support/server.ts"
import type { RoomPayload } from "../src/game/types.ts"

let server: TestServer
let shutdown: AbortController
let running: Promise<void>

beforeEach(async () => {
  server = await startTestServer()
  shutdown = new AbortController()
  running = server.harness.runtime.run(shutdown.signal)
})

afterEach(async () => {
  shutdown.abort()
  await running
  await server.close()
})

type ChangeEnvelope = {
  version: number
  kind: string
  actorType: string
  actorId: string
  instanceId: string
  revision: string
  observables: Record<string, unknown>
  invalidations: string[]
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

function changesUrl(options: { code: string; since: string; timeout: number }): string {
  return `/api/tables/${options.code}/changes?since=${options.since}&timeout=${options.timeout}`
}

describe("table change polling", () => {
  test("answers at once when the table already moved past the polled revision", async () => {
    const client = server.client()
    const code = await createRoom(client)

    const response = await client.fetch(changesUrl({ code, since: "0", timeout: 400 }))

    expect(response.status).toBe(200)
    const envelope = (await response.json()) as ChangeEnvelope
    expect(envelope.kind).toBe("invalidation")
    expect(envelope.actorType).toBe(GameRoom.actorType)
    expect(envelope.actorId).toBe(code)
    expect(BigInt(envelope.revision) > 0n).toBe(true)
  })

  test("names the same observables the socket names, so the registry refreshes the same components", async () => {
    const client = server.client()
    const code = await createRoom(client)

    const envelope = (await (
      await client.fetch(changesUrl({ code, since: "0", timeout: 400 }))
    ).json()) as ChangeEnvelope

    expect(Object.keys(envelope.observables).sort()).toEqual(["lifeTotals", "version"])
    expect(envelope.invalidations.sort()).toEqual(["seatOne", "seatTwo"])
    expect(envelope.instanceId).toMatch(/[0-9a-f-]{8}/)
  })

  test("waits for the table to move and then answers", async () => {
    const client = server.client()
    const code = await createRoom(client)
    const current = (await (
      await client.fetch(changesUrl({ code, since: "0", timeout: 400 }))
    ).json()) as ChangeEnvelope

    const waiting = client.fetch(changesUrl({ code, since: current.revision, timeout: 5_000 }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    await client.fetch(
      `/api/tables/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: -3 } }),
    )

    const response = await waiting
    expect(response.status).toBe(200)
    const envelope = (await response.json()) as ChangeEnvelope
    expect(BigInt(envelope.revision) > BigInt(current.revision)).toBe(true)
    expect(envelope.observables.lifeTotals).toEqual({ "1": 17 })
  })

  test("answers with no content when the table stays still", async () => {
    const client = server.client()
    const code = await createRoom(client)
    const current = (await (
      await client.fetch(changesUrl({ code, since: "0", timeout: 400 }))
    ).json()) as ChangeEnvelope

    const response = await client.fetch(
      changesUrl({ code, since: current.revision, timeout: 400 }),
    )

    expect(response.status).toBe(204)
  })

  test("refuses a session that does not hold a seat at that table", async () => {
    const owner = server.client()
    const code = await createRoom(owner)

    const stranger = server.client()
    await stranger.fetch("/")
    const response = await stranger.fetch(changesUrl({ code, since: "0", timeout: 400 }))

    expect(response.status).toBe(403)
  })

  test("keeps hidden cards out of the envelope", async () => {
    const client = server.client()
    const code = await createRoom(client)
    await client.fetch(`/api/tables/${code}/deck`, jsonRequest({ deckId: "42" }))
    await server.harness.runtime.testing.drain()
    await client.fetch(
      `/api/tables/${code}/actions`,
      jsonRequest({ action: { type: "drawCard", count: 1 } }),
    )

    const body = await (
      await client.fetch(changesUrl({ code, since: "0", timeout: 400 }))
    ).text()

    expect(body).not.toContain("Grizzly Bears")
    expect(body).not.toContain("Forest")
    expect(body).not.toContain("hidden-")
  })
})

describe("polling instead of a socket", () => {
  test("refreshes the same components the socket would refresh", async () => {
    const client = server.client()
    const code = await createRoom(client)

    const applications: ComponentApplication<string>[] = []
    const registry = new SolidObjectsComponentRegistry<string>({
      refresh: async ({ actorType, actorId, instanceId, revision, batch, components, signal }) => {
        const response = await client.fetch("/api/components/refresh", {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actorType, actorId, instanceId, revision, batch, components }),
        })
        return (await response.json()) as { target: string; rendered: string }[]
      },
      apply: (application) => applications.push(application),
    })

    for (const declaration of componentDeclarations(1)) {
      registry.register({
        actorType: GameRoom.actorType,
        actorId: code,
        target:
          declaration.key === undefined
            ? `component-${declaration.name}`
            : `component-${declaration.name}-${declaration.key}`,
        name: declaration.name,
        ...(declaration.key === undefined ? {} : { key: declaration.key }),
        observes: declaration.observes,
        ...(declaration.batch === undefined ? {} : { batch: declaration.batch }),
        strategy: declaration.strategy,
      })
    }

    const first = (await (
      await client.fetch(changesUrl({ code, since: "0", timeout: 400 }))
    ).json()) as ChangeEnvelope
    registry.invalidate(first as unknown as InvalidationEnvelope)

    await client.fetch(
      `/api/tables/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: -6 } }),
    )
    const second = (await (
      await client.fetch(changesUrl({ code, since: first.revision, timeout: 5_000 }))
    ).json()) as ChangeEnvelope
    registry.invalidate(second as unknown as InvalidationEnvelope)

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (applications.some((entry) => entry.rendered.includes('class="life-value">14'))) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const player = applications.findLast(
      (entry) => entry.component.name === "player" && entry.component.key === "1",
    )
    expect(player?.rendered).toContain('class="life-value">14')
    registry.close()
  })
})

describe("in-process live subscriptions", () => {
  test("receive no payload at all for the unauthenticated context", async () => {
    const client = server.client()
    const code = await createRoom(client)
    await client.fetch(`/api/tables/${code}/deck`, jsonRequest({ deckId: "42" }))
    await server.harness.runtime.testing.drain()

    const payloads = await server.harness.runtime.subscriptionPayloads({
      actorType: GameRoom.actorType,
      actorId: code,
      payloadNames: ["game"],
      authorizationContext: undefined,
    })

    expect(payloads).toEqual([])
  })

  test("project an empty table to a session that holds no seat", async () => {
    const client = server.client()
    const code = await createRoom(client)
    await client.fetch(`/api/tables/${code}/deck`, jsonRequest({ deckId: "42" }))
    await server.harness.runtime.testing.drain()

    const payloads = await server.harness.runtime.subscriptionPayloads({
      actorType: GameRoom.actorType,
      actorId: code,
      payloadNames: ["game"],
      authorizationContext: { sessionId: "a-session-with-no-seat", roomCode: code },
    })

    expect(payloads[0]?.payload).toEqual({ space: null, currentPlayerId: null })
  })
})
