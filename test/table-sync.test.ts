import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { GameRoom, type GameViewer } from "../src/actors/game-room.ts"
import { startTestRuntime, type TestRuntime } from "./support/runtime.ts"

let harness: TestRuntime

function viewer(sessionId: string, roomCode: string): GameViewer {
  return { sessionId, roomCode }
}

async function createdRoom(options: { code: string; sessionId: string }) {
  const reference = harness.runtime.ref(GameRoom, options.code)
  await reference
    .with({ authorizationContext: viewer(options.sessionId, options.code) })
    .createRoom({
      code: options.code,
      roomName: "Kitchen Table",
      playerName: "Alice",
      sessionId: options.sessionId,
    })
  return reference
}

async function seatOne(code: string, sessionId: string) {
  const snapshot = await harness.runtime
    .ref(GameRoom, code)
    .snapshot({ authorizationContext: viewer(sessionId, code) })
  return snapshot.room?.players.find((player) => player.sessionId === sessionId)
}

beforeEach(async () => {
  harness = await startTestRuntime()
})

afterEach(async () => {
  await harness.close()
})

describe("seat move numbers", () => {
  test("start at zero", async () => {
    await createdRoom({ code: "ABC123", sessionId: "session-1" })

    expect((await seatOne("ABC123", "session-1"))?.appliedMove).toBe(0)
  })

  test("record the move number the seat sent", async () => {
    const reference = await createdRoom({ code: "ABC123", sessionId: "session-1" })

    await reference.with({ authorizationContext: viewer("session-1", "ABC123") }).applyAction({
      action: { type: "adjustLife", delta: -1 },
      sessionId: "session-1",
      moveNumber: 7,
    })

    expect((await seatOne("ABC123", "session-1"))?.appliedMove).toBe(7)
  })

  test("never move the mark backwards", async () => {
    const reference = await createdRoom({ code: "ABC123", sessionId: "session-1" })
    const invoker = reference.with({ authorizationContext: viewer("session-1", "ABC123") })

    await invoker.applyAction({
      action: { type: "adjustLife", delta: -1 },
      sessionId: "session-1",
      moveNumber: 7,
    })
    await invoker.applyAction({
      action: { type: "adjustLife", delta: -1 },
      sessionId: "session-1",
      moveNumber: 3,
    })

    expect((await seatOne("ABC123", "session-1"))?.appliedMove).toBe(7)
  })

  test("leave the mark alone for a move that carries no number", async () => {
    const reference = await createdRoom({ code: "ABC123", sessionId: "session-1" })
    const invoker = reference.with({ authorizationContext: viewer("session-1", "ABC123") })

    await invoker.applyAction({
      action: { type: "adjustLife", delta: -1 },
      sessionId: "session-1",
      moveNumber: 4,
    })
    await invoker.applyAction({ action: { type: "adjustLife", delta: -1 }, sessionId: "session-1" })

    expect((await seatOne("ABC123", "session-1"))?.appliedMove).toBe(4)
  })

  test("reach the seat's own projection so the browser can drop what landed", async () => {
    const reference = await createdRoom({ code: "ABC123", sessionId: "session-1" })
    await reference.with({ authorizationContext: viewer("session-1", "ABC123") }).applyAction({
      action: { type: "adjustLife", delta: -1 },
      sessionId: "session-1",
      moveNumber: 9,
    })

    const payloads = await harness.runtime.subscriptionPayloads({
      actorType: GameRoom.actorType,
      actorId: "ABC123",
      payloadNames: ["game"],
      authorizationContext: viewer("session-1", "ABC123"),
    })
    const payload = payloads[0]?.payload as { space: { players: { appliedMove: number }[] } }

    expect(payload.space.players[0]?.appliedMove).toBe(9)
  })
})
