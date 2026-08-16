import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { sqlite } from "solid-objects/database/sqlite"

import { GameRoom, type GameViewer } from "../src/actors/game-room.ts"
import { createShuffleApplication } from "../src/runtime.ts"
import { startTestRuntime, type TestRuntime } from "./support/runtime.ts"

const OPERATOR = { source: "cli" }

let harness: TestRuntime

function viewer(sessionId: string, roomCode: string): GameViewer {
  return { sessionId, roomCode }
}

async function createdRoom(code: string) {
  const reference = harness.runtime.ref(GameRoom, code)
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

describe("doctor", () => {
  test("reports a healthy installation", async () => {
    const report = await harness.runtime.doctor.run()

    expect(report.checks.map((check) => check.name)).toContain("schema")
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([])
    expect(report.healthy).toBe(true)
  })

  test("passes the authorization posture check with deny by default policies", async () => {
    const report = await harness.runtime.doctor.run({ roundTrip: "skip" })
    const authorization = report.checks.find((check) => check.name === "authorization")

    expect(authorization?.status).not.toBe("fail")
  })
})

describe("processes", () => {
  test("lists the caller worker with its host metadata", async () => {
    await createdRoom("OPS001")

    const processes = await harness.runtime.processes.all({ authorizationContext: OPERATOR })

    expect(processes.length).toBeGreaterThan(0)
    expect(processes[0]).toMatchObject({ shutdownState: "running", stale: false })
    expect(processes[0]?.metadata.nodeVersion).toBe(process.version)
  })

  test("refuses process inspection without the operator context", async () => {
    await expect(
      harness.runtime.processes.all({ authorizationContext: { source: "browser" } }),
    ).rejects.toThrowError(/authoriz/i)
  })
})

describe("dead letters", () => {
  test("keeps a failed effect out of the actor dead letter list", async () => {
    await createdRoom("OPS002")

    const deadLetters = await harness.runtime.deadLetters.all({ authorizationContext: OPERATOR })

    expect(deadLetters).toEqual([])
  })
})

describe("retention", () => {
  test("previews message pruning without deleting live work", async () => {
    const reference = await createdRoom("OPS003")
    await reference
      .with({ authorizationContext: viewer("session-1", "OPS003") })
      .applyAction({ action: { type: "untapAll" }, sessionId: "session-1" })

    const preview = await harness.runtime.retention.preview({
      target: "messages",
      authorizationContext: OPERATOR,
    })

    expect(preview.target).toBe("messages")
    expect(preview.count).toBe(0)
  })
})

describe("reconciliation", () => {
  test("finds an actor with no pending work and repairs it through the mailbox", async () => {
    await createdRoom("OPS004")
    await harness.runtime.testing.drain()

    const page = await harness.runtime.reconciliation.withoutPendingWork({
      actorType: GameRoom.actorType,
      quietForMilliseconds: 0,
      authorizationContext: OPERATOR,
    })

    expect(page.items.map((instance) => instance.actorId)).toContain("OPS004")

    const repaired = await harness.runtime
      .ref(GameRoom, "OPS004")
      .with({ authorizationContext: viewer("session-1", "OPS004") })
      .reconcile()
    expect(repaired).toBe("reconciled")
  })

  test("reads migrated state batches for an actor type", async () => {
    await createdRoom("OPS005")

    const states = await harness.runtime.reconciliation.statesFor({
      actorType: GameRoom.actorType,
      actorIds: ["OPS005"],
      authorizationContext: OPERATOR,
    })

    expect(states.OPS005).toMatchObject({ room: { code: "OPS005" } })
    expect(states.OPS005).not.toHaveProperty("seatRevisions")
  })
})

describe("state migrations", () => {
  test("upgrades a version one room without retaining revision counters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shuffleupandplay-migration-"))
    const databasePath = join(directory, "solid-objects.sqlite3")
    const application = createShuffleApplication({
      databasePath,
      pollingIntervalMilliseconds: 10,
      archidekt: { deck: async () => ({ name: "", cards: [] }), search: async () => [] },
    })
    await application.install()

    const legacyRoom = {
      id: "room-1",
      code: "OLD001",
      name: "Legacy Table",
      version: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      players: [
        {
          id: "player-1",
          sessionId: "session-1",
          name: "Alice",
          seat: 1,
          life: 17,
          deckName: null,
          deckStatus: "idle",
          library: [],
          hand: [],
          battlefield: [],
          graveyard: [],
          exile: [],
          isSearchingDeck: false,
        },
      ],
    }

    const database = sqlite({ path: databasePath })
    await database.connection(async (connection) => {
      const now = await connection.nowMilliseconds()
      await connection.run(
        `INSERT INTO solid_objects_instances
         (id, actor_type, actor_id, state, state_version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [
          "instance-1",
          GameRoom.actorType,
          "OLD001",
          JSON.stringify({ room: legacyRoom }),
          now,
          now,
        ],
      )
    })
    await database.close()

    const snapshot = await application.runtime
      .ref(GameRoom, "OLD001")
      .snapshot({ authorizationContext: viewer("session-1", "OLD001") })

    expect(snapshot.room?.name).toBe("Legacy Table")
    expect(snapshot.room?.players[0]?.life).toBe(17)
    expect(snapshot).not.toHaveProperty("seatRevisions")
    expect(snapshot.room?.players[0]?.deckRequestId).toBeNull()

    await application.close()
    rmSync(directory, { recursive: true, force: true })
  })
})

describe("test helper", () => {
  test("resets every actor owned table", async () => {
    await createdRoom("OPS006")

    await harness.runtime.testing.reset()

    const snapshot = await harness.runtime
      .ref(GameRoom, "OPS006")
      .snapshot({ authorizationContext: viewer("session-1", "OPS006") })
    expect(snapshot.room).toBeNull()
  })
})
