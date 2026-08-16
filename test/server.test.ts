import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  formRequest,
  jsonRequest,
  startTestServer,
  type TestClient,
  type TestServer,
} from "./support/server.ts"
import type { RoomPayload } from "../src/game/types.ts"

let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})

afterEach(async () => {
  await server.close()
})

async function createRoom(client: TestClient, playerName = "Alice"): Promise<RoomPayload> {
  return client.json<RoomPayload>(
    "/api/spaces",
    jsonRequest({ playerName, spaceName: "Kitchen Table" }),
  )
}

function roomCodeOf(payload: RoomPayload): string {
  const code = payload.space?.code
  if (!code) throw new Error("expected a room code")
  return code
}

describe("health", () => {
  test("answers the proxy health check without a session", async () => {
    const client = server.client()
    const response = await client.fetch("/up")

    expect(response.status).toBe(200)
    expect(client.cookie).toBeNull()
  })
})

describe("sessions", () => {
  test("issues a signed session cookie on the first request", async () => {
    const client = server.client()
    const response = await client.fetch("/")

    expect(response.status).toBe(200)
    expect(client.cookie).toMatch(/^shuffleSession=/)
  })

  test("keeps the same session across requests", async () => {
    const client = server.client()
    await client.fetch("/")
    const first = client.cookie
    await client.fetch("/")

    expect(client.cookie).toBe(first)
  })
})

describe("operator dashboard", () => {
  test("is disabled unless explicitly mounted", async () => {
    const response = await server.client().fetch("/solid-objects/dashboard")

    expect(response.status).toBe(404)
  })

  test("renders application actors through the local mount", async () => {
    await server.close()
    server = await startTestServer({ operatorDashboard: { access: "public-read-only" } })
    await createRoom(server.client())

    const response = await server.client().fetch("/solid-objects/dashboard/instances", {
      headers: { accept: "text/html" },
    })
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain("GameRoom")
    expect(html).toContain("Instances")
    expect(html).toContain("Read only")
    expect(html).not.toContain("authenticity_token")
    expect(html).not.toContain("Pause instance")
    expect(response.headers.get("content-security-policy")).toContain("script-src")

    const instancePath = html.match(/href="([^"]+\/instances\/[^"]+)"/)?.[1]
    expect(instancePath).toBeDefined()
    const mutation = await server.client().fetch(`${instancePath}/pause`, { method: "POST" })
    expect(mutation.status).toBe(405)
  })
})

describe("space lifecycle over HTTP", () => {
  test("creates a space and returns the creator's projection", async () => {
    const payload = await createRoom(server.client())

    expect(payload.space?.code).toMatch(/^[A-Z0-9]{6}$/)
    expect(payload.space?.players).toHaveLength(1)
    expect(payload.currentPlayerId).toBe(payload.space?.players[0]?.id)
  })

  test("joins a space and shows both players", async () => {
    const alice = server.client()
    const bob = server.client()
    const created = await createRoom(alice)
    const code = roomCodeOf(created)

    const joined = await bob.json<RoomPayload>(
      `/api/spaces/${code}/join`,
      jsonRequest({ playerName: "Bob" }),
    )

    expect(joined.space?.players.map((player) => player.name)).toEqual(["Alice", "Bob"])
    expect(joined.currentPlayerId).toBe(joined.space?.players[1]?.id)
  })

  test("refuses a third player with a conflict", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))
    await server.client().fetch(`/api/spaces/${code}/join`, jsonRequest({ playerName: "Bob" }))

    const response = await server
      .client()
      .fetch(`/api/spaces/${code}/join`, jsonRequest({ playerName: "Carol" }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "roomFull" })
  })

  test("returns not found for an unknown space", async () => {
    const response = await server
      .client()
      .fetch("/api/spaces/ZZZZZZ/join", jsonRequest({ playerName: "Bob" }))

    expect(response.status).toBe(404)
  })

  test("creates and joins through server rendered forms", async () => {
    const alice = server.client()
    const created = await alice.fetch(
      "/api/spaces",
      formRequest({ playerName: "Alice", spaceName: "Kitchen Table" }),
    )

    expect(created.status).toBe(303)
    const location = created.headers.get("location") ?? ""
    expect(location).toMatch(/^\/spaces\/[A-Z0-9]{6}$/)

    const page = await alice.fetch(location, { headers: { accept: "text/html" } })
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain("data-game")
    expect(html).toContain("Kitchen Table")
    expect(html).toContain("Alice")

    const code = location.split("/").pop() ?? ""
    const bob = server.client()
    const joined = await bob.fetch(
      "/api/spaces/join",
      formRequest({ playerName: "Bob", spaceCode: code }),
    )
    expect(joined.status).toBe(303)
    expect(joined.headers.get("location")).toBe(`/spaces/${code}`)
  })

  test("sends a stranger back to the lobby", async () => {
    const code = roomCodeOf(await createRoom(server.client()))
    const stranger = server.client()

    const response = await stranger.fetch(`/spaces/${code}`, { headers: { accept: "text/html" } })

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`/?join=${code}`)
  })
})

describe("actions over HTTP", () => {
  test("applies an action and returns the updated projection", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const payload = await alice.json<RoomPayload>(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: -3 } }),
    )

    expect(payload.space?.players[0]?.life).toBe(17)
    expect(payload.space?.version).toBe(2)
  })

  test("accepts an asynchronous action without waiting", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const response = await alice.fetch(`/api/spaces/${code}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", prefer: "respond-async" },
      body: JSON.stringify({ action: { type: "adjustLife", delta: -1 } }),
    })

    expect(response.status).toBe(202)
    await server.harness.runtime.testing.drain({ roles: ["actors"] })

    const state = await alice.json<RoomPayload>(`/api/spaces/${code}/state`)
    expect(state.space?.players[0]?.life).toBe(19)
  })

  test("refuses a malformed action", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const response = await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "moveBattlefieldCard", instanceId: "missing" } }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: "invalidAction" })
  })

  test("refuses an action from a session with no seat", async () => {
    const code = roomCodeOf(await createRoom(server.client()))

    const response = await server
      .client()
      .fetch(`/api/spaces/${code}/actions`, jsonRequest({ action: { type: "resetLife" } }))

    expect(response.status).toBe(403)
  })

  test("records a metric row for every applied action", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))
    await alice.fetch(`/api/spaces/${code}/actions`, jsonRequest({ action: { type: "untapAll" } }))
    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: 1 } }),
    )

    const metrics = await server.harness.application.actionMetrics()

    expect(metrics.map((metric) => metric.actionType)).toEqual(["untapAll", "adjustLife"])
    expect(metrics.every((metric) => metric.roomCode === code)).toBe(true)
    expect(metrics.every((metric) => metric.seat === 1)).toBe(true)
  })
})

describe("state polling", () => {
  test("returns no content when the caller already has the version", async () => {
    const alice = server.client()
    const created = await createRoom(alice)
    const code = roomCodeOf(created)

    const response = await alice.fetch(
      `/api/spaces/${code}/state?sinceVersion=${created.space?.version}`,
    )

    expect(response.status).toBe(204)
  })

  test("returns the projection when the version moved on", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))
    await alice.fetch(`/api/spaces/${code}/actions`, jsonRequest({ action: { type: "untapAll" } }))

    const response = await alice.fetch(`/api/spaces/${code}/state?sinceVersion=1`)

    expect(response.status).toBe(200)
  })
})

describe("hidden information over HTTP", () => {
  test("never sends an opponent hand or library", async () => {
    const alice = server.client()
    const bob = server.client()
    const code = roomCodeOf(await createRoom(alice))
    await bob.fetch(`/api/spaces/${code}/join`, jsonRequest({ playerName: "Bob" }))

    await alice.fetch(`/api/spaces/${code}/deck`, jsonRequest({ deckId: "55" }))
    await server.harness.runtime.testing.drain()
    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "drawCard", count: 2 } }),
    )

    const aliceState = await alice.fetch(`/api/spaces/${code}/state`)
    const bobState = await bob.fetch(`/api/spaces/${code}/state`)
    const aliceBody = await aliceState.text()
    const bobBody = await bobState.text()

    expect(aliceBody).toContain("Grizzly Bears")
    expect(bobBody).not.toContain("Grizzly Bears")
    expect(bobBody).toContain("Hidden card")
  })

  test("never renders opponent card names into the page", async () => {
    const alice = server.client()
    const bob = server.client()
    const code = roomCodeOf(await createRoom(alice))
    await bob.fetch(`/api/spaces/${code}/join`, jsonRequest({ playerName: "Bob" }))
    await alice.fetch(`/api/spaces/${code}/deck`, jsonRequest({ deckId: "55" }))
    await server.harness.runtime.testing.drain()
    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "drawCard", count: 2 } }),
    )

    const page = await bob.fetch(`/spaces/${code}`, { headers: { accept: "text/html" } })
    const html = await page.text()

    expect(html).toContain("Alice")
    expect(html).not.toContain("Grizzly Bears")
  })
})

describe("deck loading over HTTP", () => {
  test("requests a deck through the effect worker", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const response = await alice.fetch(`/api/spaces/${code}/deck`, jsonRequest({ deckId: "55" }))
    expect(response.status).toBe(202)

    await server.harness.runtime.testing.drain()

    const state = await alice.json<RoomPayload>(`/api/spaces/${code}/state`)
    expect(state.space?.players[0]?.deckName).toBe("Deck 55")
    expect(state.space?.players[0]?.library).toHaveLength(2)
    expect(server.harness.deckRequests).toEqual(["55"])
  })

  test("accepts an Archidekt deck URL", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    await alice.fetch(
      `/api/spaces/${code}/deck`,
      jsonRequest({ deckId: "https://archidekt.com/decks/12345/my-deck" }),
    )
    await server.harness.runtime.testing.drain()

    expect(server.harness.deckRequests).toEqual(["12345"])
  })

  test("refuses a deck request without an identifier", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const response = await alice.fetch(`/api/spaces/${code}/deck`, jsonRequest({ deckId: "abc" }))

    expect(response.status).toBe(400)
  })
})

describe("component refresh endpoint", () => {
  test("renders the requested components for a seated player", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))
    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: -1 } }),
    )

    const frames = await alice.json<{ target: string; rendered: string }[]>(
      "/api/components/refresh",
      jsonRequest({
        actorType: "GameRoom",
        actorId: code,
        instanceId: "unused",
        revision: "2",
        batch: "game",
        components: [
          { name: "player", key: "1", target: "component-player-1", observes: ["seatOne"] },
        ],
      }),
    )

    expect(frames).toHaveLength(1)
    expect(frames[0]?.target).toBe("component-player-1")
    expect(frames[0]?.rendered).toContain("19")
  })

  test("refuses a refresh from a session with no seat", async () => {
    const code = roomCodeOf(await createRoom(server.client()))

    const response = await server.client().fetch(
      "/api/components/refresh",
      jsonRequest({
        actorType: "GameRoom",
        actorId: code,
        instanceId: "unused",
        revision: "2",
        components: [
          { name: "player", key: "1", target: "component-player-1", observes: ["seatOne"] },
        ],
      }),
    )

    expect(response.status).toBe(403)
  })

  test("ignores a component whose target does not match its name and key", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const frames = await alice.json<unknown[]>(
      "/api/components/refresh",
      jsonRequest({
        actorType: "GameRoom",
        actorId: code,
        instanceId: "unused",
        revision: "1",
        components: [
          { name: "player", key: "1", target: "component-player-2", observes: ["seatOne"] },
        ],
      }),
    )

    expect(frames).toEqual([])
  })
})

describe("static assets", () => {
  test("serves the browser entry point of the published package", async () => {
    const response = await server.client().fetch("/vendor/solid-objects/browser/index.js")
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/javascript")
    expect(body).toContain("SolidObjectsBrowserClient")
  })

  test("refuses a traversal outside the asset root", async () => {
    const response = await server.client().fetch("/assets/../../package.json")

    expect(response.status).toBe(404)
  })
})
