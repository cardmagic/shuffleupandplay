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

describe("asset fingerprints", () => {
  test("stamps every asset filename so a deploy invalidates caches", async () => {
    const client = server.client()
    const response = await client.fetch("/", { headers: { accept: "text/html" } })
    const html = await response.text()

    expect(html).toMatch(/\/assets\/application\.[a-f0-9]{12}\.css/)
    expect(html).toMatch(/\/assets\/shuffle\.[a-f0-9]{12}\.js/)
  })

  test("serves a fingerprinted asset with an immutable cache and no cookie", async () => {
    const client = server.client()
    const html = await (await client.fetch("/", { headers: { accept: "text/html" } })).text()
    const asset = /\/assets\/shuffle\.[a-f0-9]{12}\.js/.exec(html)?.[0] ?? ""

    const response = await client.fetch(asset)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(response.headers.getSetCookie()).toEqual([])
  })

  test("stamps the modules an asset imports, so a stale copy cannot load", async () => {
    const client = server.client()
    const html = await (await client.fetch("/", { headers: { accept: "text/html" } })).text()
    const asset = /\/assets\/shuffle\.[a-f0-9]{12}\.js/.exec(html)?.[0] ?? ""

    const source = await (await client.fetch(asset)).text()

    expect(source).toMatch(/from "\/assets\/drag-math\.[a-f0-9]{12}\.js"/)
    expect(source).toMatch(/from "\/assets\/morph\.[a-f0-9]{12}\.js"/)
    expect(source).not.toContain('from "./drag-math.js"')
    expect(source).not.toContain('from "./morph.js"')
  })

  test("serves an imported module immutably under its stamped name", async () => {
    const client = server.client()
    const html = await (await client.fetch("/", { headers: { accept: "text/html" } })).text()
    const shuffle = /\/assets\/shuffle\.[a-f0-9]{12}\.js/.exec(html)?.[0] ?? ""
    const source = await (await client.fetch(shuffle)).text()
    const dependency = /\/assets\/drag-math\.[a-f0-9]{12}\.js/.exec(source)?.[0] ?? ""

    const response = await client.fetch(dependency)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(await response.text()).toContain("export function cardPoint")
  })

  test("serves an unfingerprinted asset without creating a session", async () => {
    const response = await server.client().fetch("/assets/shuffle.js")

    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()).toEqual([])
  })
})

describe("counter tokens", () => {
  async function tableWithBattlefieldCard(client: TestClient) {
    const code = roomCodeOf(await createRoom(client))
    await client.fetch(`/api/tables/${code}/deck`, jsonRequest({ deckId: "55" }))
    await server.harness.runtime.testing.drain()
    await client.fetch(
      `/api/tables/${code}/actions`,
      jsonRequest({ action: { type: "drawCard", count: 1 } }),
    )
    const drawn = await client.json<RoomPayload>(`/api/tables/${code}/state`)
    const instanceId = drawn.space?.players[0]?.hand[0]?.instanceId ?? ""
    await client.fetch(
      `/api/tables/${code}/actions`,
      jsonRequest({ action: { type: "playFromHand", instanceId } }),
    )
    return { code, instanceId }
  }

  test("offers a counter button on each of your own battlefield cards", async () => {
    const alice = server.client()
    const { code, instanceId } = await tableWithBattlefieldCard(alice)

    const html = await (
      await alice.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
    ).text()

    expect(html).toContain("addCounter")
    expect(html).toMatch(/aria-label="Add a counter to [^"]+"/)
    expect(html).toContain(instanceId)
  })

  test("adds a counter through that button without any dragging", async () => {
    const alice = server.client()
    const { code, instanceId } = await tableWithBattlefieldCard(alice)

    await alice.fetch(
      `/api/tables/${code}/actions`,
      jsonRequest({ action: { type: "addCounter", instanceId, x: 8, y: 8 } }),
    )

    const state = await alice.json<RoomPayload>(`/api/tables/${code}/state`)
    expect(state.space?.players[0]?.battlefield[0]?.counters).toHaveLength(1)
  })

  test("names every card tool for a screen reader instead of an emoji", async () => {
    const alice = server.client()
    const { code } = await tableWithBattlefieldCard(alice)

    const html = await (
      await alice.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
    ).text()

    for (const label of ["to hand", "into library", "to graveyard", "to exile"]) {
      expect(html).toContain(label)
    }

    const emojiButtons = html.match(/<button[^>]*class="card-tool"[^>]*>/g) ?? []
    expect(emojiButtons.length).toBeGreaterThan(0)
    expect(emojiButtons.every((button) => button.includes("aria-label="))).toBe(true)
  })

  test("labels each tool for an instant tooltip rather than the slow browser one", async () => {
    const alice = server.client()
    const { code } = await tableWithBattlefieldCard(alice)

    const html = await (
      await alice.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
    ).text()

    const tools = html.match(/<button[^>]*class="card-tool"[^>]*>/g) ?? []
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every((tool) => tool.includes("data-tooltip="))).toBe(true)
    expect(tools.some((tool) => tool.includes("title="))).toBe(false)
  })
})

describe("waiting for an opponent", () => {
  test("shows the waiting panel while the host sits alone", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const html = await (
      await alice.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
    ).text()

    expect(html).toContain("Waiting for your opponent")
  })

  test("drops the waiting panel once the opponent takes a seat", async () => {
    const alice = server.client()
    const bob = server.client()
    const code = roomCodeOf(await createRoom(alice))
    await bob.fetch(`/api/tables/${code}/join`, jsonRequest({ playerName: "Bob" }))

    const html = await (
      await alice.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
    ).text()

    expect(html).not.toContain("Waiting for your opponent")
  })

  test("refreshes the waiting panel as a component so it can disappear live", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const html = await (
      await alice.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
    ).text()

    const declarations = /data-components="([^"]*)"/.exec(html)?.[1] ?? ""
    expect(declarations).toContain("tableStatus")
    expect(html).toContain('id="component-tableStatus"')
  })
})

describe("idempotency over HTTP", () => {
  test("applies a retried action with the same key only once", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))
    const request = () =>
      alice.fetch(`/api/tables/${code}/actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "gesture-1",
        },
        body: JSON.stringify({ action: { type: "adjustLife", delta: -5 } }),
      })

    await request()
    await request()

    const state = await alice.json<RoomPayload>(`/api/tables/${code}/state`)
    expect(state.space?.players[0]?.life).toBe(15)
  })

  test("applies two gestures that carry different keys", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))
    const request = (key: string) =>
      alice.fetch(`/api/tables/${code}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ action: { type: "adjustLife", delta: -5 } }),
      })

    await request("gesture-1")
    await request("gesture-2")

    const state = await alice.json<RoomPayload>(`/api/tables/${code}/state`)
    expect(state.space?.players[0]?.life).toBe(10)
  })
})

describe("request limits", () => {
  test("refuses a burst of table creations from one session", async () => {
    const alice = server.client()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await alice.fetch(
        "/api/tables",
        jsonRequest({ playerName: "Alice", tableName: "Kitchen Table" }),
      )
      statuses.push(response.status)
    }

    expect(statuses).toContain(429)
  })

  test("refuses a body larger than the small request cap", async () => {
    const alice = server.client()
    const response = await alice.fetch(
      "/api/tables",
      jsonRequest({ playerName: "Alice", tableName: "x".repeat(64 * 1024) }),
    )

    expect(response.status).toBe(413)
  })
})

describe("invite links", () => {
  test("honours the forwarded protocol so the invite link stays https", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const html = await (
      await alice.fetch(`/tables/${code}`, {
        headers: { accept: "text/html", "x-forwarded-proto": "https" },
      })
    ).text()

    const shareUrl = /data-copy-text="([^"]+)"/.exec(html)?.[1] ?? ""
    expect(shareUrl).toMatch(/^https:\/\//)
    expect(shareUrl).toContain(`/tables/${code}`)
  })

  test("uses the configured public origin when one is set", async () => {
    process.env.SHUFFLE_PUBLIC_ORIGIN = "https://example.test"
    try {
      const alice = server.client()
      const code = roomCodeOf(await createRoom(alice))

      const html = await (
        await alice.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
      ).text()

      const shareUrl = /data-copy-text="([^"]+)"/.exec(html)?.[1] ?? ""
      expect(shareUrl).toBe(`https://example.test/tables/${code}`)
    } finally {
      delete process.env.SHUFFLE_PUBLIC_ORIGIN
    }
  })
})

describe("product language", () => {
  const FRAMEWORK_TERMS = /solid.?objects|data-actor|\bdemo\b|example application|framework/i

  test("keeps framework and demo terminology out of the lobby", async () => {
    const html = await (
      await server.client().fetch("/", { headers: { accept: "text/html" } })
    ).text()

    expect(html).not.toMatch(FRAMEWORK_TERMS)
    expect(html).toContain("Play Magic remotely with an Archidekt deck")
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1)
  })

  test("keeps framework terminology and versions off the table page", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const html = await (
      await alice.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
    ).text()

    expect(html).not.toMatch(FRAMEWORK_TERMS)
    expect(html).not.toMatch(/version\s*<?span?[^>]*>?\s*\d/i)
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1)
    expect(html).toContain("Table code")
  })

  test("marks a private table page noindex and a public page indexable", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))

    const table = await (
      await alice.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
    ).text()
    const lobby = await (
      await server.client().fetch("/", { headers: { accept: "text/html" } })
    ).text()

    expect(table).toContain('content="noindex, nofollow"')
    expect(table).not.toContain(`og:title" content="${code}`)
    expect(lobby).toContain('content="index, follow"')
  })
})

describe("trust and metadata", () => {
  test("serves the manifest, robots and security policy", async () => {
    const manifest = await server.client().fetch("/manifest.webmanifest")
    const robots = await server.client().fetch("/robots.txt")
    const security = await server.client().fetch("/.well-known/security.txt")

    expect(manifest.status).toBe(200)
    expect(await manifest.json()).toMatchObject({ name: "Shuffle Up and Play" })
    expect(await robots.text()).toContain("Disallow: /tables/")
    expect(security.status).toBe(200)
  })

  test("serves privacy and credits with the required attribution", async () => {
    const privacy = await (
      await server.client().fetch("/privacy", { headers: { accept: "text/html" } })
    ).text()
    const credits = await (
      await server.client().fetch("/credits", { headers: { accept: "text/html" } })
    ).text()

    expect(privacy).toContain("no account")
    expect(credits).toContain("Archidekt")
    expect(credits).toContain("Scryfall")
    expect(credits).toContain("Fan Content Policy")
    expect(credits).toContain("not approved or endorsed by Wizards")
  })

  test("answers an unknown page with a branded 404", async () => {
    const response = await server
      .client()
      .fetch("/not-a-page", { headers: { accept: "text/html" } })
    const html = await response.text()

    expect(response.status).toBe(404)
    expect(html).toContain("That page is not here")
    expect(html).toContain("Go to the lobby")
  })
})

describe("security headers", () => {
  test("allows the inline styles that position cards on the table", async () => {
    const response = await server.client().fetch("/", { headers: { accept: "text/html" } })
    const policy = response.headers.get("content-security-policy") ?? ""
    const styleSrc = /style-src ([^;]*)/.exec(policy)?.[1] ?? ""

    expect(styleSrc).toContain("'unsafe-inline'")
  })

  test("keeps script-src strict even though styles are inline", async () => {
    const response = await server.client().fetch("/", { headers: { accept: "text/html" } })
    const policy = response.headers.get("content-security-policy") ?? ""
    const scriptSrc = /script-src ([^;]*)/.exec(policy)?.[1] ?? ""

    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })

  test("sends a restrictive policy set on every response", async () => {
    const response = await server.client().fetch("/", { headers: { accept: "text/html" } })

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(response.headers.get("content-security-policy")).toContain("cards.scryfall.io")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    expect(response.headers.get("permissions-policy")).toContain("camera=()")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
  })
})

describe("health", () => {
  test("answers the proxy health check without a session", async () => {
    const client = server.client()
    const response = await client.fetch("/up")

    expect(response.status).toBe(200)
    expect(client.cookie).toBeNull()
  })

  test("answers a HEAD health check without a session", async () => {
    const client = server.client()
    const response = await client.fetch("/up", { method: "HEAD" })

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
    expect(location).toMatch(/^\/tables\/[A-Z0-9]{6}$/)

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
    expect(joined.headers.get("location")).toBe(`/tables/${code}`)
  })

  test("sends a stranger back to the lobby", async () => {
    const code = roomCodeOf(await createRoom(server.client()))
    const stranger = server.client()

    const response = await stranger.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })

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

  test("counts applied actions per type instead of storing one row each", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))
    await alice.fetch(`/api/spaces/${code}/actions`, jsonRequest({ action: { type: "untapAll" } }))
    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: 1 } }),
    )

    const metrics = await server.harness.application.actionMetrics()

    expect(metrics.map((metric) => metric.actionType).sort()).toEqual(["adjustLife", "untapAll"])
    expect(metrics.every((metric) => metric.roomCode === code)).toBe(true)
    expect(metrics.every((metric) => metric.seat === 1)).toBe(true)
    expect(metrics.every((metric) => metric.actionCount === 1)).toBe(true)
  })

  test("keeps repeated actions in one bucket rather than growing without bound", async () => {
    const alice = server.client()
    const code = roomCodeOf(await createRoom(alice))
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await alice.fetch(
        `/api/spaces/${code}/actions`,
        jsonRequest({ action: { type: "untapAll" } }),
      )
    }

    const metrics = await server.harness.application.actionMetrics()

    expect(metrics).toHaveLength(1)
    expect(metrics[0]?.actionType).toBe("untapAll")
    expect(metrics[0]?.actionCount).toBe(12)
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

    const page = await bob.fetch(`/tables/${code}`, { headers: { accept: "text/html" } })
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
  test("serves the live client from a neutral vendor path", async () => {
    const response = await server.client().fetch("/vendor/live/browser/index.js")
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
