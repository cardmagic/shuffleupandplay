import { describe, expect, test } from "vitest"

import { generateRoomCode, normalizeRoomCode } from "../src/game/room-code.ts"
import { buildPlayer } from "../src/game/player.ts"
import { playerSummaries, roomPayload, seatFingerprints } from "../src/game/room-snapshot.ts"
import type { BattlefieldCard, Card, Room } from "../src/game/types.ts"

function card(instanceId: string): Card {
  return {
    instanceId,
    name: `Card ${instanceId}`,
    scryfallId: `scryfall-${instanceId}`,
    imageUrl: `https://example.com/${instanceId}.jpg`,
    tapped: false,
    isManaSource: false,
  }
}

function room(): Room {
  return {
    id: "room-1",
    code: "ABC123",
    name: "Kitchen Table",
    version: 4,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    players: [
      {
        ...buildPlayer({ name: "Alice", sessionId: "session-1", seat: 1, identifier: "player-1" }),
        hand: [card("alice-hand")],
        library: [card("alice-library")],
      },
      {
        ...buildPlayer({ name: "Bob", sessionId: "session-2", seat: 2, identifier: "player-2" }),
        hand: [card("bob-hand-1"), card("bob-hand-2")],
      },
    ],
  }
}

function projected(sessionId: string) {
  const payload = roomPayload({ room: room(), sessionId })
  if (!payload.space) throw new Error("expected a projected room")
  return { ...payload, space: payload.space }
}

describe("roomPayload", () => {
  test("names the viewer's own player", () => {
    expect(roomPayload({ room: room(), sessionId: "session-1" }).currentPlayerId).toBe("player-1")
  })

  test("returns a null current player for an observer session", () => {
    expect(roomPayload({ room: room(), sessionId: "session-9" }).currentPlayerId).toBeNull()
  })

  test("never exposes a session identifier", () => {
    const payload = projected("session-1")

    expect(JSON.stringify(payload)).not.toContain("session-1")
    expect(payload.space.players.every((player) => !("sessionId" in player))).toBe(true)
  })

  test("keeps the viewer's own hand visible", () => {
    const payload = projected("session-1")
    const alice = payload.space.players.find((player) => player.id === "player-1")

    expect(alice?.hand).toEqual([card("alice-hand")])
  })

  test("replaces an opponent hand with hidden cards of the same size", () => {
    const payload = projected("session-1")
    const bob = payload.space.players.find((player) => player.id === "player-2")

    expect(bob?.hand).toHaveLength(2)
    expect(bob?.hand.map((entry) => entry.name)).toEqual(["Hidden card", "Hidden card"])
    expect(bob?.hand.every((entry) => entry.isHidden)).toBe(true)
    expect(JSON.stringify(bob?.hand)).not.toContain("bob-hand-1")
  })

  test("hides every hand from an observer session", () => {
    const payload = projected("session-9")

    expect(payload.space.players.flatMap((player) => player.hand)).toHaveLength(3)
    expect(JSON.stringify(payload)).not.toContain("alice-hand")
  })

  test("keeps the opponent library hidden but its size visible", () => {
    const payload = projected("session-2")
    const alice = payload.space.players.find((player) => player.id === "player-1")

    expect(alice?.library).toHaveLength(1)
    expect(JSON.stringify(alice?.library)).not.toContain("alice-library")
  })
})

describe("playerSummaries", () => {
  test("reports public counts without card identity", () => {
    expect(playerSummaries(room())).toEqual([
      {
        seat: 1,
        name: "Alice",
        deckName: null,
        deckStatus: "idle",
        life: 20,
        libraryCount: 1,
        handCount: 1,
        battlefieldCount: 0,
        graveyardCount: 0,
        exileCount: 0,
        isSearchingDeck: false,
      },
      {
        seat: 2,
        name: "Bob",
        deckName: null,
        deckStatus: "idle",
        life: 20,
        libraryCount: 0,
        handCount: 2,
        battlefieldCount: 0,
        graveyardCount: 0,
        exileCount: 0,
        isSearchingDeck: false,
      },
    ])
  })
})

describe("seatFingerprints", () => {
  function battlefieldRoom(overrides: Partial<BattlefieldCard>): Room {
    const base = room()
    const played: BattlefieldCard = {
      ...card("alice-battlefield"),
      x: 10,
      y: 20,
      counters: [],
      ...overrides,
    }
    return {
      ...base,
      players: base.players.map((player) =>
        player.seat === 1 ? { ...player, battlefield: [played] } : player,
      ),
    }
  }

  test("changes when a battlefield card taps", () => {
    expect(seatFingerprints(battlefieldRoom({ tapped: true }))).not.toEqual(
      seatFingerprints(battlefieldRoom({})),
    )
  })

  test("changes when a battlefield card moves", () => {
    expect(seatFingerprints(battlefieldRoom({ x: 300 }))).not.toEqual(
      seatFingerprints(battlefieldRoom({})),
    )
  })

  test("changes when a counter moves on a card", () => {
    const counter = { id: "counter-1", label: "+1/+1", value: 1, x: 4, y: 6 }
    expect(
      seatFingerprints(battlefieldRoom({ counters: [{ ...counter, x: 40 }] })),
    ).not.toEqual(seatFingerprints(battlefieldRoom({ counters: [counter] })))
  })

  test("keeps card identity out of the fingerprint", () => {
    const fingerprints = JSON.stringify(seatFingerprints(battlefieldRoom({})))
    expect(fingerprints).not.toContain("Card alice-battlefield")
    expect(fingerprints).not.toContain("scryfall-alice-battlefield")
  })
})

describe("room codes", () => {
  test("generates a six character code from the unambiguous alphabet", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(generateRoomCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    }
  })

  test("upcases and strips a supplied code", () => {
    expect(normalizeRoomCode(" abc-123 ")).toBe("ABC123")
    expect(normalizeRoomCode("abcdefghij")).toBe("ABCDEF")
    expect(normalizeRoomCode(undefined)).toBe("")
    expect(normalizeRoomCode("!!!")).toBe("")
  })
})
