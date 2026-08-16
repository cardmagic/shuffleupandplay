import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { WebSocket as NodeWebSocket } from "ws"
import {
  SolidObjectsBrowserClient,
  SolidObjectsComponentRegistry,
  type ComponentApplication,
  type InvalidationEnvelope,
  type PayloadEnvelope,
} from "solid-objects/browser"

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

async function createRoom(client: TestClient): Promise<RoomPayload> {
  return client.json<RoomPayload>(
    "/api/spaces",
    jsonRequest({ playerName: "Alice", spaceName: "Kitchen Table" }),
  )
}

type Session = {
  invalidations: InvalidationEnvelope[]
  payloads: PayloadEnvelope[]
  applications: ComponentApplication<string>[]
  refreshRequests: { batch: string | undefined; targets: string[] }[]
  close(): void
}

function openSession(options: { client: TestClient; roomCode: string; seat: number }): Session {
  const invalidations: InvalidationEnvelope[] = []
  const payloads: PayloadEnvelope[] = []
  const applications: ComponentApplication<string>[] = []
  const refreshRequests: { batch: string | undefined; targets: string[] }[] = []

  const registry = new SolidObjectsComponentRegistry<string>({
    refresh: async ({ actorType, actorId, instanceId, revision, batch, components, signal }) => {
      refreshRequests.push({ batch, targets: components.map((entry) => entry.target) })
      const response = await options.client.fetch("/api/components/refresh", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorType, actorId, instanceId, revision, batch, components }),
      })
      if (!response.ok) throw new Error(`component refresh failed with ${response.status}`)
      return (await response.json()) as { target: string; rendered: string }[]
    },
    apply: (application) => applications.push(application),
  })

  for (const declaration of componentDeclarations(options.seat)) {
    registry.register({
      actorType: "GameRoom",
      actorId: options.roomCode,
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

  const url = new URL(server.origin)
  url.protocol = "ws:"
  url.pathname = "/solid-objects"
  url.searchParams.set("roomCode", options.roomCode)

  const client = new SolidObjectsBrowserClient({
    url,
    createWebSocket: (target) =>
      new NodeWebSocket(target, {
        headers: { cookie: options.client.cookie ?? "" },
      }) as unknown as WebSocket,
    onInvalidation: (envelope) => {
      invalidations.push(envelope)
      registry.invalidate(envelope)
    },
    onPayload: (envelope) => payloads.push(envelope),
  })

  client.subscribe({
    actorType: "GameRoom",
    actorId: options.roomCode,
    payloads: ["game"],
  })
  client.connect()

  return {
    invalidations,
    payloads,
    applications,
    refreshRequests,
    close: () => {
      registry.close()
      client.close()
    },
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("published browser client", () => {
  test("receives the replayed invalidation and payload after connecting", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    const session = openSession({ client: alice, roomCode: code, seat: 1 })

    await waitFor(() => session.invalidations.length > 0, "the replayed invalidation")
    await waitFor(() => session.payloads.length > 0, "the replayed payload")

    expect(session.invalidations[0]?.observables).toMatchObject({ version: 1 })
    expect(session.payloads[0]?.name).toBe("game")
    session.close()
  })

  test("refreshes the affected components through the application endpoint", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    const session = openSession({ client: alice, roomCode: code, seat: 1 })
    await waitFor(() => session.applications.length > 0, "the first component render")
    session.applications.length = 0
    session.refreshRequests.length = 0

    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: -6 } }),
    )

    await waitFor(
      () => session.applications.some((entry) => entry.rendered.includes("14")),
      "the refreshed player component",
    )

    const player = session.applications.find((entry) => entry.component.name === "player")
    expect(player?.component.key).toBe("1")
    expect(player?.rendered).toContain('class="life-value">14')
    session.close()
  })

  test("unions one batch of components into a single refresh request", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    const session = openSession({ client: alice, roomCode: code, seat: 1 })
    await waitFor(() => session.applications.length > 0, "the first component render")
    session.refreshRequests.length = 0

    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: -1 } }),
    )
    await waitFor(() => session.refreshRequests.length > 0, "a refresh request")
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(session.refreshRequests).toHaveLength(1)
    expect(session.refreshRequests[0]?.batch).toBe("game")
    expect(session.refreshRequests[0]?.targets.sort()).toEqual([
      "component-gameResult",
      "component-librarySearch-1",
      "component-player-1",
      "component-playerControls-1",
    ])
    session.close()
  })

  test("refreshes only the opponent component when the opponent moves", async () => {
    const alice = server.client()
    const bob = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    await bob.fetch(`/api/spaces/${code}/join`, jsonRequest({ playerName: "Bob" }))

    const session = openSession({ client: alice, roomCode: code, seat: 1 })
    await waitFor(() => session.applications.length > 0, "the first component render")
    session.applications.length = 0

    await bob.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: -2 } }),
    )

    await waitFor(
      () => session.applications.some((entry) => entry.component.key === "2"),
      "the opponent component",
    )
    await new Promise((resolve) => setTimeout(resolve, 200))

    const refreshedPlayers = session.applications
      .filter((entry) => entry.component.name === "player")
      .map((entry) => entry.component.key)
    expect(refreshedPlayers).toEqual(["2"])
    session.close()
  })

  test("never delivers opponent card names to the other seat", async () => {
    const alice = server.client()
    const bob = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    await bob.fetch(`/api/spaces/${code}/join`, jsonRequest({ playerName: "Bob" }))

    const bobSession = openSession({ client: bob, roomCode: code, seat: 2 })
    await waitFor(() => bobSession.applications.length > 0, "the first component render")

    await alice.fetch(`/api/spaces/${code}/deck`, jsonRequest({ deckId: "55" }))
    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "drawCard", count: 2 } }),
    )
    await waitFor(
      () => bobSession.payloads.some((entry) => entryHandCount(entry) === 2),
      "the opponent draw",
    )

    const everything = JSON.stringify({
      invalidations: bobSession.invalidations,
      payloads: bobSession.payloads,
      applications: bobSession.applications,
    })
    expect(everything).toContain("Hidden card")
    expect(everything).not.toContain("Grizzly Bears")
    bobSession.close()
  })
})

function entryHandCount(envelope: PayloadEnvelope): number {
  const payload = envelope.payload as unknown as RoomPayload
  return payload.space?.players.find((player) => player.seat === 1)?.hand.length ?? 0
}
