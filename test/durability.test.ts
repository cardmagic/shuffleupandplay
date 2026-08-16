import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Rejected } from "solid-objects"

import { MatchLog } from "../src/actors/match-log.ts"
import { GameRoom, type GameViewer } from "../src/actors/game-room.ts"
import { startTestRuntime, type TestRuntime } from "./support/runtime.ts"

const OPERATOR = { source: "cli" }

let harness: TestRuntime

function viewer(sessionId: string, roomCode: string): GameViewer {
  return { sessionId, roomCode }
}

function room(code: string) {
  return harness.runtime.ref(GameRoom, code)
}

async function createdRoom(code: string) {
  const reference = room(code)
  await reference.with({ authorizationContext: viewer("session-1", code) }).createRoom({
    code,
    roomName: "Kitchen Table",
    playerName: "Alice",
    sessionId: "session-1",
  })
  return reference
}

beforeEach(async () => {
  harness = await startTestRuntime()
})

afterEach(async () => {
  await harness.close()
})

describe("mailbox ordering", () => {
  test("serializes many concurrent life changes on one actor", async () => {
    const reference = await createdRoom("DUR001")
    const invoker = reference.with({ authorizationContext: viewer("session-1", "DUR001") })

    await Promise.all(
      Array.from({ length: 25 }, () =>
        invoker.applyAction({ action: { type: "adjustLife", delta: -1 }, sessionId: "session-1" }),
      ),
    )

    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "DUR001"),
    })
    expect(snapshot.room?.players[0]?.life).toBe(0)
    expect(snapshot.room?.version).toBe(26)
  })

  test("keeps a draw and a shuffle from losing cards under concurrency", async () => {
    const reference = await createdRoom("DUR002")
    const invoker = reference.with({ authorizationContext: viewer("session-1", "DUR002") })
    await invoker.requestDeck({ deckId: "55", sessionId: "session-1" })
    await harness.runtime.testing.drain()

    await Promise.all([
      invoker.applyAction({ action: { type: "drawCard", count: 1 }, sessionId: "session-1" }),
      invoker.applyAction({ action: { type: "shuffleLibrary" }, sessionId: "session-1" }),
      invoker.applyAction({ action: { type: "drawCard", count: 1 }, sessionId: "session-1" }),
    ])

    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "DUR002"),
    })
    const player = snapshot.room?.players[0]
    expect((player?.library.length ?? 0) + (player?.hand.length ?? 0)).toBe(2)
    expect(player?.hand).toHaveLength(2)
  })

  test("runs different rooms concurrently", async () => {
    await Promise.all(
      ["DUR003", "DUR004", "DUR005"].map(async (code) => {
        const reference = await createdRoom(code)
        await reference
          .with({ authorizationContext: viewer("session-1", code) })
          .applyAction({ action: { type: "adjustLife", delta: -3 }, sessionId: "session-1" })
      }),
    )

    for (const code of ["DUR003", "DUR004", "DUR005"]) {
      const snapshot = await room(code).snapshot({
        authorizationContext: viewer("session-1", code),
      })
      expect(snapshot.room?.players[0]?.life).toBe(17)
    }
  })
})

describe("idempotency", () => {
  test("applies a repeated idempotency key exactly once", async () => {
    const reference = await createdRoom("DUR006")
    const invoker = () =>
      reference.with({
        authorizationContext: viewer("session-1", "DUR006"),
        idempotencyKey: "life-change-1",
      })

    await invoker().applyAction({
      action: { type: "adjustLife", delta: -5 },
      sessionId: "session-1",
    })
    await invoker().applyAction({
      action: { type: "adjustLife", delta: -5 },
      sessionId: "session-1",
    })

    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "DUR006"),
    })
    expect(snapshot.room?.players[0]?.life).toBe(15)
    expect(snapshot.room?.version).toBe(2)
  })
})

describe("background delivery", () => {
  test("resolves a sent message once the actors role drains", async () => {
    const reference = await createdRoom("DUR007")

    const message = await reference.send
      .with({ authorizationContext: viewer("session-1", "DUR007") })
      .applyAction({ action: { type: "adjustLife", delta: -2 }, sessionId: "session-1" })

    const operator = { authorizationContext: viewer("session-1", "DUR007") }
    expect(await message.status(operator)).toBe("ready")

    await harness.runtime.testing.drain({ roles: ["actors"] })

    expect(await message.status(operator)).toBe("completed")
    expect(await message.result(operator)).toBe("applied")
  })

  test("records a rejected background message without blocking later work", async () => {
    const reference = await createdRoom("DUR008")
    const invoker = reference.with({ authorizationContext: viewer("session-1", "DUR008") })

    const rejected = await reference.send
      .with({ authorizationContext: viewer("session-1", "DUR008") })
      .applyAction({ action: { type: "notAnAction" }, sessionId: "session-1" })
    await harness.runtime.testing.drain({ roles: ["actors"] })

    const operator = { authorizationContext: viewer("session-1", "DUR008") }
    expect(await rejected.status(operator)).toBe("rejected")
    await expect(rejected.wait(operator)).rejects.toThrowError(Rejected)

    const applied = await invoker.applyAction({
      action: { type: "adjustLife", delta: -1 },
      sessionId: "session-1",
    })
    expect(applied).toBe("applied")
  })
})

describe("actor to actor delivery", () => {
  test("commits the match log entry with the room turn", async () => {
    const reference = await createdRoom("DUR009")
    await reference
      .with({ authorizationContext: viewer("session-2", "DUR009") })
      .join({ playerName: "Bob", sessionId: "session-2" })
    await harness.runtime.testing.drain({ roles: ["actors"] })

    const log = await harness.runtime
      .ref(MatchLog, "DUR009")
      .snapshot({ authorizationContext: viewer("session-1", "DUR009") })

    expect(log.entries.map((entry) => entry.event)).toEqual(["roomCreated", "playerJoined"])
    expect(log.entries.map((entry) => entry.detail)).toEqual(["Alice", "Bob"])
  })

  test("discards the staged log entry when the room turn is rejected", async () => {
    await createdRoom("DUR010")
    await harness.runtime.testing.drain({ roles: ["actors"] })

    await expect(
      room("DUR010")
        .with({ authorizationContext: viewer("session-9", "DUR010") })
        .applyAction({ action: { type: "resetLife" }, sessionId: "session-9" }),
    ).rejects.toThrowError(Rejected)
    await harness.runtime.testing.drain({ roles: ["actors"] })

    const log = await harness.runtime
      .ref(MatchLog, "DUR010")
      .snapshot({ authorizationContext: viewer("session-1", "DUR010") })
    expect(log.entries).toHaveLength(1)
  })
})

describe("terminal failures", () => {
  test("ignores an effect callback whose result never arrived", async () => {
    const reference = await createdRoom("DUR011")

    const result = await reference
      .with({ authorizationContext: viewer("session-1", "DUR011") })
      .deckLoaded({
        effectId: "made-up",
        arguments: { deckId: "55", sessionId: "session-1" },
        result: null,
      })

    expect(result).toBeNull()

    const deadLetters = await harness.runtime.deadLetters.all({ authorizationContext: OPERATOR })
    expect(deadLetters).toEqual([])
  })

  test("refuses an unknown operation at the reference instead of enqueueing it", async () => {
    await createdRoom("DUR012")

    const invoker = room("DUR012").with({
      authorizationContext: viewer("session-1", "DUR012"),
    }) as unknown as Record<string, unknown>

    expect(typeof invoker.notAnOperation).not.toBe("function")
  })

  test("keeps a healthy room out of the terminal failure path", async () => {
    const reference = await createdRoom("DUR013")

    await expect(
      reference
        .with({ authorizationContext: viewer("session-1", "DUR013") })
        .applyAction({ action: { type: "untapAll" }, sessionId: "session-1" }),
    ).resolves.toBe("applied")
    await expect(
      harness.runtime.deadLetters.all({ authorizationContext: OPERATOR }),
    ).resolves.toEqual([])
  })
})

describe("reminders", () => {
  test("fires the idle sweep through the reminder scheduler", async () => {
    const reference = await createdRoom("DUR014")
    await reference
      .with({ authorizationContext: viewer("session-1", "DUR014") })
      .applyAction({ action: { type: "openDeckSearch" }, sessionId: "session-1" })

    const scheduled = await harness.runtime.reminders.all({ authorizationContext: OPERATOR })
    const reminder = scheduled.items[0]
    expect(reminder?.operation).toBe("sweepIdleState")
    expect(reminder?.status).toBe("scheduled")

    await harness.runtime.testing.runDueReminders({
      now: new Date(reminder?.runAt.getTime() ?? Date.now()),
    })
    await harness.runtime.testing.drain()

    const snapshot = await reference.snapshot({
      authorizationContext: viewer("session-1", "DUR014"),
    })
    expect(snapshot.room?.players[0]?.isSearchingDeck).toBe(false)
  })
})
