import { describe, expect, test } from "vitest"

import { generateRoomCode, normalizeRoomCode } from "../src/playmat/room-code.ts"
import { buildPlayer } from "../src/playmat/player.ts"
import { playerSummaries, roomPayload } from "../src/playmat/room-snapshot.ts"
import type { Card, Room } from "../src/playmat/types.ts"

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
