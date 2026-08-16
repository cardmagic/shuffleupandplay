import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { GameRoom, type GameViewer } from "../src/actors/game-room.ts"
import { ArchidektRequestError } from "../src/archidekt/client.ts"
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

describe("restart durability", () => {
  test("keeps committed table state across a close and reopen", async () => {
    await createdRoom("RST001")
    await room("RST001")
      .with({ authorizationContext: viewer("session-1", "RST001") })
      .applyAction({ action: { type: "adjustLife", delta: -6 }, sessionId: "session-1" })

    harness = await harness.restart()

    const snapshot = await room("RST001").snapshot({
      authorizationContext: viewer("session-1", "RST001"),
    })
    expect(snapshot.room?.name).toBe("Kitchen Table")
    expect(snapshot.room?.players[0]?.life).toBe(14)
  })

  test("applies an asynchronous action accepted before shutdown", async () => {
    await createdRoom("RST002")

    await harness.runtime
      .ref(GameRoom, "RST002")
      .send.with({ authorizationContext: viewer("session-1", "RST002") })
      .applyAction({ action: { type: "adjustLife", delta: -3 }, sessionId: "session-1" })

    const beforeShutdown = await room("RST002").snapshot({
      authorizationContext: viewer("session-1", "RST002"),
    })
    expect(beforeShutdown.room?.players[0]?.life).toBe(20)

    harness = await harness.restart()
    await harness.runtime.testing.drain()

    const afterRestart = await room("RST002").snapshot({
      authorizationContext: viewer("session-1", "RST002"),
    })
    expect(afterRestart.room?.players[0]?.life).toBe(17)
  })

  test("carries an unfinished deck effect through to its callback after restart", async () => {
    await harness.close()
    harness = await startTestRuntime({
      deck: async () => {
        throw new ArchidektRequestError("Archidekt is unreachable")
      },
    })
    await createdRoom("RST003")

    await harness.runtime
      .ref(GameRoom, "RST003")
      .send.with({ authorizationContext: viewer("session-1", "RST003") })
      .requestDeck({ deckId: "55", sessionId: "session-1" })

    harness = await harness.restart({
      deck: async (deckId: string) => ({ name: `Deck ${deckId}`, cards: [] }),
    })
    await harness.runtime.testing.drain()

    const snapshot = await room("RST003").snapshot({
      authorizationContext: viewer("session-1", "RST003"),
    })
    expect(harness.deckRequests).toContain("55")
    expect(snapshot.room?.players[0]?.deckStatus).toBe("loaded")
    expect(snapshot.room?.players[0]?.deckName).toBe("Deck 55")
  })

  test("fires a reminder scheduled before shutdown", async () => {
    await createdRoom("RST004")
    await room("RST004")
      .with({ authorizationContext: viewer("session-1", "RST004") })
      .applyAction({ action: { type: "openDeckSearch" }, sessionId: "session-1" })

    harness = await harness.restart()

    const scheduled = await harness.runtime.reminders.all({ authorizationContext: OPERATOR })
    const reminder = scheduled.items[0]
    expect(reminder?.operation).toBe("sweepIdleState")

    await harness.runtime.testing.runDueReminders({
      now: new Date(reminder?.runAt.getTime() ?? Date.now()),
    })
    await harness.runtime.testing.drain()

    const snapshot = await room("RST004").snapshot({
      authorizationContext: viewer("session-1", "RST004"),
    })
    expect(snapshot.room?.players[0]?.isSearchingDeck).toBe(false)
  })

  test("keeps the match log readable after a reopen", async () => {
    await createdRoom("RST005")

    harness = await harness.restart()

    const snapshot = await room("RST005").snapshot({
      authorizationContext: viewer("session-1", "RST005"),
    })
    expect(snapshot.room?.code).toBe("RST005")
  })
})
