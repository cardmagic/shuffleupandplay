import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Rejected } from "solid-objects"

import { MatchLog } from "../src/actors/match-log.ts"
import { GameRoom, type GameViewer } from "../src/actors/game-room.ts"
import { startTestRuntime, type TestRuntime } from "./support/runtime.ts"
import { ArchidektRequestError } from "../src/archidekt/client.ts"
import type { RoomPayload } from "../src/game/types.ts"

let harness: TestRuntime

function viewer(sessionId: string, roomCode: string): GameViewer {
  return { sessionId, roomCode }
}

function roomReference(code: string) {
  return harness.runtime.ref(GameRoom, code)
}

async function createdRoom(options: { code: string; sessionId: string; name?: string }) {
  const reference = roomReference(options.code)
  await reference.with({ authorizationContext: viewer(options.sessionId, options.code) }).createRoom({
    code: options.code,
    roomName: options.name ?? "Kitchen Table",
    playerName: "Alice",
    sessionId: options.sessionId,
  })
  return reference
}

beforeEach(async () => {
  harness = await startTestRuntime()
})

afterEach(async () => {
  await harness.close()
})

describe("GameRoom lifecycle", () => {
  test("creates a room with the creator in seat one", async () => {
    const reference = await createdRoom({ code: "ABC123", sessionId: "session-1" })
    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "ABC123"),
    })

    expect(snapshot.room?.code).toBe("ABC123")
    expect(snapshot.room?.name).toBe("Kitchen Table")
    expect(snapshot.room?.version).toBe(1)
    expect(snapshot.room?.players).toHaveLength(1)
    expect(snapshot.room?.players[0]).toMatchObject({ name: "Alice", seat: 1, life: 20 })
  })

  test("rejects a second creation of the same room", async () => {
    const reference = await createdRoom({ code: "ABC123", sessionId: "session-1" })

    await expect(
      reference.with({ authorizationContext: viewer("session-2", "ABC123") }).createRoom({
        code: "ABC123",
        roomName: "Another Table",
        playerName: "Bob",
        sessionId: "session-2",
      }),
    ).rejects.toThrowError(Rejected)
  })

  test("falls back to default names", async () => {
    const reference = roomReference("ABC124")
    await reference.with({ authorizationContext: viewer("session-1", "ABC124") }).createRoom({
      code: "ABC124",
      roomName: "   ",
      playerName: "",
      sessionId: "session-1",
    })
    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "ABC124"),
    })

    expect(snapshot.room?.name).toBe("Gaming Table")
    expect(snapshot.room?.players[0]?.name).toBe("Player 1")
  })

  test("seats a second player and refuses a third", async () => {
    const reference = await createdRoom({ code: "ABC125", sessionId: "session-1" })

    const joined = await reference
      .with({ authorizationContext: viewer("session-2", "ABC125") })
      .join({ playerName: "Bob", sessionId: "session-2" })
    expect(joined).toBe("joined")

    const rejoined = await reference
      .with({ authorizationContext: viewer("session-2", "ABC125") })
      .join({ playerName: "Bob", sessionId: "session-2" })
    expect(rejoined).toBe("alreadyJoined")

    await expect(
      reference
        .with({ authorizationContext: viewer("session-3", "ABC125") })
        .join({ playerName: "Carol", sessionId: "session-3" }),
    ).rejects.toMatchObject({ code: "roomFull" })
  })

  test("rejects a join for a room that does not exist", async () => {
    await expect(
      roomReference("NOROOM")
        .with({ authorizationContext: viewer("session-1", "NOROOM") })
        .join({ playerName: "Bob", sessionId: "session-1" }),
    ).rejects.toMatchObject({ code: "roomNotFound" })
  })
})

describe("GameRoom actions", () => {
  test("serializes mutations and advances the room version", async () => {
    const reference = await createdRoom({ code: "ABC126", sessionId: "session-1" })
    const invoker = reference.with({ authorizationContext: viewer("session-1", "ABC126") })

    await Promise.all([
      invoker.applyAction({ action: { type: "adjustLife", delta: -1 }, sessionId: "session-1" }),
      invoker.applyAction({ action: { type: "adjustLife", delta: -1 }, sessionId: "session-1" }),
      invoker.applyAction({ action: { type: "adjustLife", delta: -1 }, sessionId: "session-1" }),
    ])

    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "ABC126"),
    })
    expect(snapshot.room?.players[0]?.life).toBe(17)
    expect(snapshot.room?.version).toBe(4)
  })

  test("rejects a malformed action without advancing the version", async () => {
    const reference = await createdRoom({ code: "ABC127", sessionId: "session-1" })
    const invoker = reference.with({ authorizationContext: viewer("session-1", "ABC127") })

    await expect(
      invoker.applyAction({
        action: { type: "moveBattlefieldCard", instanceId: "missing" },
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({ code: "invalidAction" })

    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "ABC127"),
    })
    expect(snapshot.room?.version).toBe(1)
  })

  test("rejects an action from a session that holds no seat", async () => {
    const reference = await createdRoom({ code: "ABC128", sessionId: "session-1" })

    await expect(
      reference
        .with({ authorizationContext: viewer("session-9", "ABC128") })
        .applyAction({ action: { type: "resetLife" }, sessionId: "session-9" }),
    ).rejects.toMatchObject({ code: "notAPlayer" })
  })
})

describe("GameRoom observables", () => {
  test("replays seat dependencies without their values", async () => {
    await createdRoom({ code: "ABC129", sessionId: "session-1" })

    const event = await subscriptionSnapshot("ABC129", "session-1")

    expect(event.invalidations).toEqual(["seatOne", "seatTwo"])
    expect(event.observables).not.toHaveProperty("seatOne")
    expect(event.observables).not.toHaveProperty("seatTwo")
  })

  test("keeps card identity out of every observable", async () => {
    const reference = await createdRoom({ code: "ABC130", sessionId: "session-1" })
    await loadDeck({ reference, code: "ABC130", sessionId: "session-1" })

    const event = await subscriptionSnapshot("ABC130", "session-1")

    expect(JSON.stringify(event)).not.toContain("Grizzly Bears")
    expect(JSON.stringify(event)).not.toContain("session-1")
    expect(event.invalidations).toContain("seatOne")
  })
})

describe("GameRoom payloads", () => {
  test("projects a different room for each seat", async () => {
    const reference = await createdRoom({ code: "ABC131", sessionId: "session-1" })
    await reference
      .with({ authorizationContext: viewer("session-2", "ABC131") })
      .join({ playerName: "Bob", sessionId: "session-2" })
    await loadDeck({ reference, code: "ABC131", sessionId: "session-1" })
    await reference
      .with({ authorizationContext: viewer("session-1", "ABC131") })
      .applyAction({ action: { type: "drawCard", count: 2 }, sessionId: "session-1" })

    const alice = await payloadFor("ABC131", "session-1")
    const bob = await payloadFor("ABC131", "session-2")

    expect(alice.currentPlayerId).not.toBe(bob.currentPlayerId)
    expect(JSON.stringify(alice)).toContain("Grizzly Bears")
    expect(JSON.stringify(bob)).not.toContain("Grizzly Bears")
    expect(bob.space?.players.find((player) => player.seat === 1)?.hand).toHaveLength(2)
  })

  test("projects an empty room for a session with no seat", async () => {
    await createdRoom({ code: "ABC132", sessionId: "session-1" })

    const payload = await payloadFor("ABC132", "session-9")

    expect(payload).toEqual({ space: null, currentPlayerId: null })
  })
})

describe("GameRoom deck loading", () => {
  test("loads a deck through an effect and records it in the match log", async () => {
    const reference = await createdRoom({ code: "ABC133", sessionId: "session-1" })

    await reference
      .with({ authorizationContext: viewer("session-1", "ABC133") })
      .requestDeck({ deckId: "55", sessionId: "session-1" })

    const loading = await reference.snapshot({
      authorizationContext: viewer("session-1", "ABC133"),
    })
    expect(loading.room?.players[0]?.deckStatus).toBe("loading")

    await harness.runtime.testing.drain()

    const loaded = await reference.snapshot({
      authorizationContext: viewer("session-1", "ABC133"),
    })
    expect(harness.deckRequests).toEqual(["55"])
    expect(loaded.room?.players[0]?.deckStatus).toBe("loaded")
    expect(loaded.room?.players[0]?.deckName).toBe("Deck 55")
    expect(loaded.room?.players[0]?.library).toHaveLength(2)

    const log = await harness.runtime
      .ref(MatchLog, "ABC133")
      .snapshot({ authorizationContext: viewer("session-1", "ABC133") })
    expect(log.entries.map((entry) => entry.event)).toEqual([
      "roomCreated",
      "deckRequested",
      "deckLoaded",
    ])
  })

  test("fails only the player whose effect exhausts its attempts", async () => {
    await harness.close()
    harness = await startTestRuntime({
      deck: async (deckId) => {
        if (deckId !== "55") {
          return {
            name: `Deck ${deckId}`,
            cards: [],
          }
        }
        throw new ArchidektRequestError("Archidekt is down")
      },
    })
    const reference = await createdRoom({ code: "ABC134", sessionId: "session-1" })
    await reference
      .with({ authorizationContext: viewer("session-2", "ABC134") })
      .join({ playerName: "Bob", sessionId: "session-2" })

    await reference
      .with({ authorizationContext: viewer("session-1", "ABC134") })
      .requestDeck({ deckId: "55", sessionId: "session-1" })
    await reference
      .with({ authorizationContext: viewer("session-2", "ABC134") })
      .requestDeck({ deckId: "66", sessionId: "session-2" })
    await harness.runtime.testing.drain()

    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "ABC134"),
    })
    expect(snapshot.room?.players[0]?.deckStatus).toBe("failed")
    expect(snapshot.room?.players[1]?.deckStatus).toBe("loaded")
    expect(snapshot.room?.players[1]?.deckName).toBe("Deck 66")
    expect(harness.instrumentation).toContain("solid_objects.effect.failed")
  })

  test("ignores a success callback from a superseded deck request", async () => {
    const reference = await createdRoom({ code: "ABC140", sessionId: "session-1" })
    const context = { authorizationContext: viewer("session-1", "ABC140") }

    await reference.with(context).requestDeck({ deckId: "55", sessionId: "session-1" })
    const first = await reference.snapshot(context)
    const supersededRequestId = first.room?.players[0]?.deckRequestId ?? ""
    expect(supersededRequestId).not.toBe("")

    await reference.with(context).requestDeck({ deckId: "66", sessionId: "session-1" })
    await harness.runtime.testing.drain()

    const current = await reference.snapshot(context)
    expect(current.room?.players[0]?.deckName).toBe("Deck 66")

    await reference.with(context).deckLoaded({
      effectId: "superseded-effect",
      arguments: {
        deckId: "55",
        sessionId: "session-1",
        deckRequestId: supersededRequestId,
      },
      result: { deckName: "Deck 55", cards: [] },
    })

    const settled = await reference.snapshot(context)
    expect(settled.room?.players[0]?.deckName).toBe("Deck 66")
    expect(settled.room?.players[0]?.deckStatus).toBe("loaded")
  })

  test("ignores a failure callback from a superseded deck request", async () => {
    const reference = await createdRoom({ code: "ABC141", sessionId: "session-1" })
    const context = { authorizationContext: viewer("session-1", "ABC141") }

    await reference.with(context).requestDeck({ deckId: "55", sessionId: "session-1" })
    const first = await reference.snapshot(context)
    const supersededRequestId = first.room?.players[0]?.deckRequestId ?? ""

    await reference.with(context).requestDeck({ deckId: "66", sessionId: "session-1" })
    await harness.runtime.testing.drain()

    await reference.with(context).deckFailed({
      effectId: "superseded-effect",
      arguments: {
        deckId: "55",
        sessionId: "session-1",
        deckRequestId: supersededRequestId,
      },
      error: { message: "Archidekt is down" },
    })

    const settled = await reference.snapshot(context)
    expect(settled.room?.players[0]?.deckStatus).toBe("loaded")
    expect(settled.room?.players[0]?.deckName).toBe("Deck 66")
  })
})

describe("GameRoom reminders", () => {
  test("arms an idle sweep that closes an open deck search", async () => {
    const reference = await createdRoom({ code: "ABC135", sessionId: "session-1" })
    await reference
      .with({ authorizationContext: viewer("session-1", "ABC135") })
      .applyAction({ action: { type: "openDeckSearch" }, sessionId: "session-1" })

    const reminders = await harness.runtime.reminders.all({
      authorizationContext: { source: "cli" },
    })
    expect(reminders.items.map((reminder) => reminder.operation)).toEqual(["sweepIdleState"])

    await reference.with({ authorizationContext: viewer("session-1", "ABC135") }).sweepIdleState()

    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "ABC135"),
    })
    expect(snapshot.room?.players[0]?.isSearchingDeck).toBe(false)
  })
})

describe("GameRoom authorization", () => {
  test("refuses a call without an authorization context", async () => {
    await expect(
      roomReference("ABC136").createRoom({
        code: "ABC136",
        roomName: "Kitchen Table",
        playerName: "Alice",
        sessionId: "session-1",
      }),
    ).rejects.toThrowError(/authoriz/i)
  })

  test("refuses a call whose room code does not match the actor", async () => {
    await expect(
      roomReference("ABC137")
        .with({ authorizationContext: viewer("session-1", "OTHER1") })
        .createRoom({
          code: "ABC137",
          roomName: "Kitchen Table",
          playerName: "Alice",
          sessionId: "session-1",
        }),
    ).rejects.toThrowError(/authoriz/i)
  })

  test("refuses destruction", async () => {
    const reference = await createdRoom({ code: "ABC138", sessionId: "session-1" })

    await expect(
      reference.destroy({ authorizationContext: viewer("session-1", "ABC138") }),
    ).rejects.toThrowError(/authoriz/i)
  })

  test("refuses a subscription from a session with no seat", async () => {
    await createdRoom({ code: "ABC139", sessionId: "session-1" })

    await expect(
      harness.runtime.subscriptionSnapshot({
        actorType: GameRoom.actorType,
        actorId: "ABC139",
        authorizationContext: viewer("session-9", "ABC139"),
      }),
    ).rejects.toThrowError(/authoriz/i)
  })
})

describe("GameRoom operations surface", () => {
  test("exposes only the intended durable operations", async () => {
    expect([...roomReference("ABC140").operations].sort()).toEqual([
      "applyAction",
      "createRoom",
      "deckFailed",
      "deckLoaded",
      "join",
      "reconcile",
      "requestDeck",
      "sweepIdleState",
    ])
  })

  test("keeps helper state out of the persisted fields", async () => {
    const reference = await createdRoom({ code: "ABC141", sessionId: "session-1" })
    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "ABC141"),
    })

    expect(Object.keys(snapshot).sort()).toEqual(["playerCount", "room", "roomName"])
  })
})

async function loadDeck(options: {
  reference: ReturnType<typeof roomReference>
  code: string
  sessionId: string
}) {
  await options.reference
    .with({ authorizationContext: viewer(options.sessionId, options.code) })
    .requestDeck({ deckId: "55", sessionId: options.sessionId })
  await harness.runtime.testing.drain()
}

async function subscriptionSnapshot(code: string, sessionId: string) {
  return harness.runtime.subscriptionSnapshot({
    actorType: GameRoom.actorType,
    actorId: code,
    authorizationContext: viewer(sessionId, code),
  })
}

async function payloadFor(code: string, sessionId: string): Promise<RoomPayload> {
  const payloads = await harness.runtime.subscriptionPayloads({
    actorType: GameRoom.actorType,
    actorId: code,
    payloadNames: ["game"],
    authorizationContext: viewer(sessionId, code),
  })
  const payload = payloads[0]
  if (!payload) throw new Error("expected a game payload")
  return payload.payload as unknown as RoomPayload
}
