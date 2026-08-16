import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { WebSocket } from "ws"

import { jsonRequest, startTestServer, type TestClient, type TestServer } from "./support/server.ts"
import type { RoomPayload } from "../src/game/types.ts"

let server: TestServer
let shutdown: AbortController
let running: Promise<void>

type Envelope = {
  kind: "invalidation" | "payload"
  actorType: string
  actorId: string
  instanceId: string
  revision: string
  observables?: Record<string, unknown>
  invalidations?: string[]
  name?: string
  payload?: RoomPayload
}

type Subscriber = {
  envelopes: Envelope[]
  closed: Promise<number>
  waitFor(match: (envelope: Envelope) => boolean): Promise<Envelope>
  close(): void
}

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

async function subscribe(options: {
  client: TestClient
  roomCode: string
  payloads?: string[]
}): Promise<Subscriber> {
  const url = new URL(server.origin)
  url.protocol = "ws:"
  url.pathname = "/live"
  url.searchParams.set("roomCode", options.roomCode)

  const socket = new WebSocket(url, { headers: { cookie: options.client.cookie ?? "" } })
  const envelopes: Envelope[] = []
  const waiters: { match: (envelope: Envelope) => boolean; resolve: (value: Envelope) => void }[] =
    []

  socket.on("message", (data) => {
    const envelope = JSON.parse(String(data)) as Envelope
    envelopes.push(envelope)
    for (const waiter of [...waiters]) {
      if (!waiter.match(envelope)) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(envelope)
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
    socket.once("close", (code) => reject(new Error(`socket closed with ${code}`)))
  })

  const closed = new Promise<number>((resolve) => socket.once("close", resolve))

  socket.send(
    JSON.stringify({
      version: 1,
      action: "subscribe",
      actorType: "GameRoom",
      actorId: options.roomCode,
      ...(options.payloads ? { payloads: options.payloads } : {}),
    }),
  )

  return {
    envelopes,
    closed,
    waitFor: (match) =>
      new Promise((resolve, reject) => {
        const found = envelopes.find(match)
        if (found) return resolve(found)

        const timer = setTimeout(() => reject(new Error("timed out waiting for an envelope")), 5_000)
        waiters.push({
          match,
          resolve: (envelope) => {
            clearTimeout(timer)
            resolve(envelope)
          },
        })
      }),
    close: () => socket.close(),
  }
}

describe("realtime subscriptions", () => {
  test("replays the committed observables on subscribe", async () => {
    const alice = server.client()
    const created = await createRoom(alice)
    const code = created.space?.code ?? ""

    const subscriber = await subscribe({ client: alice, roomCode: code })
    const envelope = await subscriber.waitFor((entry) => entry.kind === "invalidation")

    expect(envelope.actorId).toBe(code)
    expect(envelope.observables).toMatchObject({ version: 1, lifeTotals: { "1": 20 } })
    expect(envelope.invalidations).toEqual(["seatOne", "seatTwo"])
    expect(envelope.observables).not.toHaveProperty("seatOne")
    subscriber.close()
  })

  test("invalidates the seat when a battlefield card taps", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    await alice.fetch(`/api/spaces/${code}/deck`, jsonRequest({ deckId: "55" }))
    await server.harness.runtime.testing.drain()
    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "drawCard", count: 1 } }),
    )
    const drawn = await alice.json<RoomPayload>(`/api/spaces/${code}/state`)
    const instanceId = drawn.space?.players[0]?.hand[0]?.instanceId ?? ""
    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "playFromHand", instanceId } }),
    )

    const played = await alice.json<RoomPayload>(`/api/spaces/${code}/state`)
    const tappedVersion = (played.space?.version ?? 0) + 1

    const subscriber = await subscribe({ client: alice, roomCode: code })
    await subscriber.waitFor((entry) => entry.kind === "invalidation")

    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "toggleTap", instanceId } }),
    )

    const envelope = await subscriber.waitFor(
      (entry) => entry.kind === "invalidation" && entry.observables?.version === tappedVersion,
    )

    expect(envelope.invalidations).toContain("seatOne")
    subscriber.close()
  })

  test("pushes an invalidation after a committed action", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    const subscriber = await subscribe({ client: alice, roomCode: code })
    await subscriber.waitFor((entry) => entry.kind === "invalidation")

    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "adjustLife", delta: -4 } }),
    )

    const envelope = await subscriber.waitFor(
      (entry) => entry.kind === "invalidation" && entry.observables?.version === 2,
    )

    expect(envelope.observables).toMatchObject({ lifeTotals: { "1": 16 } })
    expect(envelope.invalidations).toEqual(["seatOne"])
    subscriber.close()
  })

  test("delivers a seat filtered payload alongside the invalidation", async () => {
    const alice = server.client()
    const bob = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    await bob.fetch(`/api/spaces/${code}/join`, jsonRequest({ playerName: "Bob" }))

    const aliceSubscriber = await subscribe({
      client: alice,
      roomCode: code,
      payloads: ["game"],
    })
    const bobSubscriber = await subscribe({ client: bob, roomCode: code, payloads: ["game"] })

    await alice.fetch(`/api/spaces/${code}/deck`, jsonRequest({ deckId: "55" }))
    await alice.fetch(
      `/api/spaces/${code}/actions`,
      jsonRequest({ action: { type: "drawCard", count: 2 } }),
    )

    const aliceEnvelope = await aliceSubscriber.waitFor(
      (entry) =>
        entry.kind === "payload" &&
        (entry.payload?.space?.players.find((player) => player.seat === 1)?.hand.length ?? 0) === 2,
    )
    const bobEnvelope = await bobSubscriber.waitFor(
      (entry) =>
        entry.kind === "payload" &&
        (entry.payload?.space?.players.find((player) => player.seat === 1)?.hand.length ?? 0) === 2,
    )

    expect(JSON.stringify(aliceEnvelope)).toContain("Grizzly Bears")
    expect(JSON.stringify(bobEnvelope)).not.toContain("Grizzly Bears")
    expect(JSON.stringify(bobEnvelope)).toContain("Hidden card")

    aliceSubscriber.close()
    bobSubscriber.close()
  })

  test("never puts a card name into an invalidation envelope", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    const subscriber = await subscribe({ client: alice, roomCode: code })
    await subscriber.waitFor((entry) => entry.kind === "invalidation")

    await alice.fetch(`/api/spaces/${code}/deck`, jsonRequest({ deckId: "55" }))
    await subscriber.waitFor(
      (entry) => entry.kind === "invalidation" && entry.observables?.version === 3,
    )

    const invalidations = subscriber.envelopes.filter((entry) => entry.kind === "invalidation")
    expect(JSON.stringify(invalidations)).not.toContain("Grizzly Bears")
    expect(JSON.stringify(invalidations)).not.toContain("sessionId")
    subscriber.close()
  })

  test("closes a socket without a session cookie", async () => {
    const code = (await createRoom(server.client())).space?.code ?? ""
    const url = new URL(server.origin)
    url.protocol = "ws:"
    url.pathname = "/live"
    url.searchParams.set("roomCode", code)

    const socket = new WebSocket(url)
    const closeCode = await new Promise<number>((resolve, reject) => {
      socket.once("close", resolve)
      socket.once("error", reject)
    })

    expect(closeCode).toBe(1008)
  })

  test("refuses a subscription from a session with no seat", async () => {
    const code = (await createRoom(server.client())).space?.code ?? ""
    const stranger = server.client()
    await stranger.fetch("/")

    const subscriber = await subscribe({ client: stranger, roomCode: code })
    const closeCode = await subscriber.closed

    expect(closeCode).toBe(1008)
    expect(subscriber.envelopes).toEqual([])
  })
})

describe("reconnect recovery", () => {
  test("gives a reconnected player the latest state once and no opponent cards", async () => {
    const alice = server.client()
    const bob = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""
    await bob.fetch(`/api/tables/${code}/join`, jsonRequest({ playerName: "Bob" }))

    await alice.fetch(`/api/tables/${code}/deck`, jsonRequest({ deckId: "55" }))
    await server.harness.runtime.testing.drain()
    await alice.fetch(
      `/api/tables/${code}/actions`,
      jsonRequest({ action: { type: "drawCard", count: 2 } }),
    )

    const firstSession = await subscribe({ client: bob, roomCode: code, payloads: ["game"] })
    await firstSession.waitFor((entry) => entry.kind === "payload")
    firstSession.close()
    await firstSession.closed

    for (const delta of [-1, -2, -3]) {
      await alice.fetch(
        `/api/tables/${code}/actions`,
        jsonRequest({ action: { type: "adjustLife", delta } }),
      )
    }

    const secondSession = await subscribe({ client: bob, roomCode: code, payloads: ["game"] })
    const replay = await secondSession.waitFor((entry) => entry.kind === "payload")

    const seatOne = replay.payload?.space?.players.find((player) => player.seat === 1)
    expect(seatOne?.life).toBe(14)
    expect(seatOne?.hand).toHaveLength(2)
    expect(JSON.stringify(replay)).not.toContain("Grizzly Bears")
    expect(JSON.stringify(replay)).toContain("Hidden card")

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(secondSession.envelopes.filter((entry) => entry.kind === "payload")).toHaveLength(1)
    secondSession.close()
  })
})

describe("realtime hardening", () => {
  function socketUrl(roomCode: string): URL {
    const url = new URL(server.origin)
    url.protocol = "ws:"
    url.pathname = "/live"
    url.searchParams.set("roomCode", roomCode)
    return url
  }

  test("refuses a connection from a foreign origin", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""

    const socket = new WebSocket(socketUrl(code), {
      headers: { cookie: alice.cookie ?? "", origin: "https://attacker.example" },
    })
    const envelopes: string[] = []
    socket.on("message", (data) => envelopes.push(String(data)))

    const closeCode = await new Promise<number>((resolve) => {
      socket.once("close", resolve)
      socket.once("error", () => resolve(1008))
    })

    expect(closeCode).toBe(1008)
    expect(envelopes).toEqual([])
  })

  test("accepts a connection from its own origin", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""

    const socket = new WebSocket(socketUrl(code), {
      headers: { cookie: alice.cookie ?? "", origin: server.origin },
    })
    const outcome = await new Promise<string>((resolve, reject) => {
      socket.once("open", () => resolve("open"))
      socket.once("close", () => resolve("closed"))
      socket.once("error", reject)
    })
    socket.close()

    expect(outcome).toBe("open")
  })

  test("drops a socket that sends an oversized frame", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""

    const socket = new WebSocket(socketUrl(code), { headers: { cookie: alice.cookie ?? "" } })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })

    socket.send(JSON.stringify({ action: "subscribe", padding: "x".repeat(64 * 1024) }))
    const closeCode = await new Promise<number>((resolve) => socket.once("close", resolve))

    expect(closeCode).toBe(1009)
  })

  test("drops a socket that floods messages", async () => {
    const alice = server.client()
    const code = (await createRoom(alice)).space?.code ?? ""

    const socket = new WebSocket(socketUrl(code), { headers: { cookie: alice.cookie ?? "" } })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })

    const closed = new Promise<number>((resolve) => socket.once("close", resolve))
    for (let attempt = 0; attempt < 200; attempt += 1) {
      socket.send(JSON.stringify({ version: 1, action: "subscribe", actorType: "GameRoom", actorId: code }))
    }

    expect(await closed).toBe(1008)
  })
})
