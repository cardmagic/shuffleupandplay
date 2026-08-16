import { describe, expect, test } from "vitest"

import { applyPlayerAction, buildPlayer } from "../src/game/player.ts"
import type { GameAction } from "../src/game/action.ts"
import type { Card, Player } from "../src/game/types.ts"

const REVERSING_RANDOMNESS = {
  identifier: () => "counter-1",
  shuffle: <Item>(items: readonly Item[]): Item[] => [...items].reverse(),
}

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

function playerWithCards(): Player {
  return {
    ...buildPlayer({ name: "Alice", sessionId: "session-1", seat: 1, identifier: "player-1" }),
    library: [card("library-1")],
    hand: [card("hand-1")],
  }
}

function apply(player: Player, action: GameAction): Player {
  return applyPlayerAction({ player, action, randomness: REVERSING_RANDOMNESS })
}

describe("playFromHand placement", () => {
  test("gives each card played from hand its own position", () => {
    const holding: Player = {
      ...buildPlayer({ name: "Alice", sessionId: "session-1", seat: 1, identifier: "player-1" }),
      hand: [card("hand-1"), card("hand-2"), card("hand-3")],
    }

    const table = holding.hand.reduce(
      (player, held) => apply(player, { type: "playFromHand", instanceId: held.instanceId }),
      holding,
    )

    const positions = table.battlefield.map((placed) => `${placed.x},${placed.y}`)
    expect(table.battlefield).toHaveLength(3)
    expect(new Set(positions).size).toBe(3)
  })
})

describe("applyPlayerAction", () => {
  test("draws a card from the library", () => {
    const updated = apply(playerWithCards(), { type: "drawCard", count: 1 })

    expect(updated.library).toEqual([])
    expect(updated.hand).toHaveLength(2)
  })

  test("clamps the draw count and stops at an empty library", () => {
    const drained = apply(playerWithCards(), { type: "drawCard", count: 99 })

    expect(drained.hand).toHaveLength(2)
    expect(apply(drained, { type: "drawCard" })).toEqual(drained)
  })

  test("plays, taps, and untaps a card", () => {
    const played = apply(playerWithCards(), { type: "playFromHand", instanceId: "hand-1" })
    const tapped = apply(played, { type: "toggleTap", instanceId: "hand-1" })
    const untapped = apply(tapped, { type: "untapAll" })

    expect(played.hand).toEqual([])
    expect(played.battlefield[0]).toMatchObject({ x: 240, y: 140, counters: [] })
    expect(tapped.battlefield[0]?.tapped).toBe(true)
    expect(untapped.battlefield[0]?.tapped).toBe(false)
  })

  test("adjusts, sets, and resets life within bounds", () => {
    const damaged = apply(playerWithCards(), { type: "adjustLife", delta: -7 })

    expect(damaged.life).toBe(13)
    expect(apply(damaged, { type: "resetLife" }).life).toBe(20)
    expect(apply(damaged, { type: "setLife", value: 5000 }).life).toBe(999)
    expect(apply(damaged, { type: "adjustLife", delta: -900 }).life).toBe(0)
  })

  test("moves cards between zones and keeps only deck card attributes", () => {
    const played = apply(playerWithCards(), { type: "playFromHand", instanceId: "hand-1" })
    const discarded = apply(played, {
      type: "moveCardZone",
      instanceId: "hand-1",
      from: "battlefield",
      to: "graveyard",
    })
    const returned = apply(discarded, {
      type: "moveCardZone",
      instanceId: "hand-1",
      from: "graveyard",
      to: "battlefield",
      x: 50,
      y: 70,
    })

    expect(discarded.battlefield).toEqual([])
    expect(discarded.graveyard[0]).toEqual(card("hand-1"))
    expect(returned.battlefield[0]).toMatchObject({ x: 50, y: 70, counters: [] })
  })

  test("ignores a zone move onto the same zone", () => {
    const player = playerWithCards()
    const moved = apply(player, {
      type: "moveCardZone",
      instanceId: "hand-1",
      from: "hand",
      to: "hand",
    })

    expect(moved).toEqual(player)
  })

  test("moves cards to the top, bottom, and a shuffled library", () => {
    const player = playerWithCards()
    const toTop = apply(player, {
      type: "moveToDeck",
      instanceId: "hand-1",
      from: "hand",
      position: "top",
    })
    const toBottom = apply(player, {
      type: "moveToDeck",
      instanceId: "hand-1",
      from: "hand",
      position: "bottom",
    })
    const shuffled = apply(player, {
      type: "moveToDeck",
      instanceId: "hand-1",
      from: "hand",
      position: "shuffle",
    })

    expect(toTop.library.map((entry) => entry.instanceId)).toEqual(["hand-1", "library-1"])
    expect(toBottom.library.map((entry) => entry.instanceId)).toEqual(["library-1", "hand-1"])
    expect(shuffled.library.map((entry) => entry.instanceId)).toEqual(["hand-1", "library-1"])
  })

  test("moves a library card to hand and toggles the deck search", () => {
    const searching = apply(playerWithCards(), { type: "openDeckSearch" })
    const drawn = apply(searching, {
      type: "moveLibraryCardToHand",
      instanceId: "library-1",
    })
    const closed = apply(drawn, { type: "closeDeckSearch" })

    expect(searching.isSearchingDeck).toBe(true)
    expect(drawn.library).toEqual([])
    expect(drawn.hand).toHaveLength(2)
    expect(closed.isSearchingDeck).toBe(false)
  })

  test("clamps a battlefield move to the table", () => {
    const played = apply(playerWithCards(), { type: "playFromHand", instanceId: "hand-1" })
    const moved = apply(played, {
      type: "moveBattlefieldCard",
      instanceId: "hand-1",
      x: -40,
      y: 9000,
    })

    expect(moved.battlefield[0]).toMatchObject({ x: 0, y: 700 })
  })

  test("adds, moves, and updates a counter, and removes it at zero", () => {
    const played = apply(playerWithCards(), { type: "playFromHand", instanceId: "hand-1" })
    const withCounter = apply(played, {
      type: "addCounter",
      instanceId: "hand-1",
      x: 10,
      y: 20,
    })
    const moved = apply(withCounter, {
      type: "moveCounter",
      instanceId: "hand-1",
      counterId: "counter-1",
      x: 500,
      y: 500,
    })
    const increased = apply(moved, {
      type: "updateCounterValue",
      instanceId: "hand-1",
      counterId: "counter-1",
      delta: 2,
    })
    const cleared = apply(increased, {
      type: "updateCounterValue",
      instanceId: "hand-1",
      counterId: "counter-1",
      delta: -2,
    })

    expect(withCounter.battlefield[0]?.counters[0]).toEqual({
      id: "counter-1",
      label: "+1/+1",
      value: 0,
      x: 10,
      y: 20,
    })
    expect(moved.battlefield[0]?.counters[0]).toMatchObject({ x: 96, y: 136 })
    expect(increased.battlefield[0]?.counters[0]?.value).toBe(2)
    expect(cleared.battlefield[0]?.counters).toEqual([])
  })

  test("truncates a long counter label", () => {
    const played = apply(playerWithCards(), { type: "playFromHand", instanceId: "hand-1" })
    const withCounter = apply(played, {
      type: "addCounter",
      instanceId: "hand-1",
      x: 0,
      y: 0,
      label: "extraordinarily long",
    })

    expect(withCounter.battlefield[0]?.counters[0]?.label).toBe("extraordi")
  })

  test("leaves the player unchanged when the card is missing", () => {
    const player = playerWithCards()

    expect(apply(player, { type: "playFromHand", instanceId: "missing" })).toEqual(player)
    expect(apply(player, { type: "toggleTap", instanceId: "missing" })).toEqual(player)
    expect(
      apply(player, { type: "moveCardZone", instanceId: "missing", from: "hand", to: "exile" }),
    ).toEqual(player)
  })

  test("shuffles the library", () => {
    const player = { ...playerWithCards(), library: [card("a"), card("b")] }

    expect(apply(player, { type: "shuffleLibrary" }).library.map((entry) => entry.instanceId)).toEqual(
      ["b", "a"],
    )
  })

  test("does not mutate the supplied player", () => {
    const player = playerWithCards()
    const snapshot = structuredClone(player)

    apply(player, { type: "drawCard", count: 1 })

    expect(player).toEqual(snapshot)
  })
})

describe("buildPlayer", () => {
  test("starts at twenty life with empty zones", () => {
    const player = buildPlayer({
      name: "Alice",
      sessionId: "session-1",
      seat: 2,
      identifier: "player-2",
    })

    expect(player).toEqual({
      id: "player-2",
      sessionId: "session-1",
      name: "Alice",
      seat: 2,
      life: 20,
      deckName: null,
      deckStatus: "idle",
      library: [],
      hand: [],
      battlefield: [],
      graveyard: [],
      exile: [],
      isSearchingDeck: false,
    })
  })
})
