import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { GameRoom, type GameViewer } from "../src/actors/game-room.ts"
import { startTestRuntime, type TestRuntime } from "./support/runtime.ts"

const SLOW_POLL_MILLISECONDS = 3_000

let harness: TestRuntime
let shutdown: AbortController
let running: Promise<void>

function viewer(sessionId: string, roomCode: string): GameViewer {
  return { sessionId, roomCode }
}

beforeEach(async () => {
  harness = await startTestRuntime({ pollingIntervalMilliseconds: SLOW_POLL_MILLISECONDS })
  shutdown = new AbortController()
  running = harness.runtime.run(shutdown.signal)
})

afterEach(async () => {
  shutdown.abort()
  await running
  await harness.close()
})

describe("wake-up signalling", () => {
  test("applies an enqueued action without waiting for the next poll", async () => {
    const reference = harness.runtime.ref(GameRoom, "WAKE01")
    const context = { authorizationContext: viewer("session-1", "WAKE01") }

    await reference.with(context).createRoom({
      code: "WAKE01",
      roomName: "Kitchen Table",
      playerName: "Alice",
      sessionId: "session-1",
    })

    const started = Date.now()
    await harness.runtime
      .ref(GameRoom, "WAKE01")
      .send.with(context)
      .applyAction({ action: { type: "adjustLife", delta: -4 }, sessionId: "session-1" })

    let life = 20
    while (Date.now() - started < SLOW_POLL_MILLISECONDS) {
      const snapshot = await reference.snapshot(context)
      life = snapshot.room?.players[0]?.life ?? 20
      if (life !== 20) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const elapsed = Date.now() - started
    expect(life).toBe(16)
    // Polling alone could not deliver this inside 400ms with a 3 second interval,
    // so passing proves the enqueue woke the worker rather than a poll finding it.
    expect(elapsed).toBeLessThan(400)
  })
})
