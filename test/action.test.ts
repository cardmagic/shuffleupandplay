import { describe, expect, test } from "vitest"

import { parseAction } from "../src/playmat/action.ts"

describe("parseAction", () => {
  test("accepts an action without arguments", () => {
    expect(parseAction({ type: "untapAll" })).toEqual({ type: "untapAll" })
  })

  test("rejects an unknown action type", () => {
    expect(parseAction({ type: "selfDestruct" })).toBeNull()
  })

  test("rejects a non-object action", () => {
    expect(parseAction("drawCard")).toBeNull()
    expect(parseAction(null)).toBeNull()
    expect(parseAction([{ type: "untapAll" }])).toBeNull()
  })

  test("normalizes numeric strings on numeric attributes", () => {
    expect(parseAction({ type: "adjustLife", delta: "-3" })).toEqual({
      type: "adjustLife",
      delta: -3,
    })
  })

  test("rejects a non-finite number", () => {
    expect(parseAction({ type: "adjustLife", delta: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseAction({ type: "adjustLife", delta: "three" })).toBeNull()
  })

  test("requires an instance identifier where the action targets a card", () => {
    expect(parseAction({ type: "playFromHand", instanceId: "card-1" })).toEqual({
      type: "playFromHand",
      instanceId: "card-1",
    })
    expect(parseAction({ type: "playFromHand", instanceId: "  " })).toBeNull()
    expect(parseAction({ type: "playFromHand" })).toBeNull()
  })

  test("requires coordinates for a battlefield move", () => {
    expect(parseAction({ type: "moveBattlefieldCard", instanceId: "card-1", x: 10, y: 20 })).toEqual(
      { type: "moveBattlefieldCard", instanceId: "card-1", x: 10, y: 20 },
    )
    expect(parseAction({ type: "moveBattlefieldCard", instanceId: "card-1" })).toBeNull()
  })

  test("requires known zones for a zone move", () => {
    expect(
      parseAction({ type: "moveCardZone", instanceId: "card-1", from: "hand", to: "graveyard" }),
    ).toEqual({ type: "moveCardZone", instanceId: "card-1", from: "hand", to: "graveyard" })
    expect(
      parseAction({ type: "moveCardZone", instanceId: "card-1", from: "hand", to: "sideboard" }),
    ).toBeNull()
  })

  test("keeps optional coordinates on a zone move and rejects invalid ones", () => {
    expect(
      parseAction({
        type: "moveCardZone",
        instanceId: "card-1",
        from: "hand",
        to: "battlefield",
        x: 12,
        y: 14,
      }),
    ).toEqual({
      type: "moveCardZone",
      instanceId: "card-1",
      from: "hand",
      to: "battlefield",
      x: 12,
      y: 14,
    })
    expect(
      parseAction({
        type: "moveCardZone",
        instanceId: "card-1",
        from: "hand",
        to: "battlefield",
        x: "left",
      }),
    ).toBeNull()
  })

  test("requires a known library position", () => {
    expect(
      parseAction({ type: "moveToDeck", instanceId: "card-1", from: "hand", position: "shuffle" }),
    ).toEqual({ type: "moveToDeck", instanceId: "card-1", from: "hand", position: "shuffle" })
    expect(
      parseAction({ type: "moveToDeck", instanceId: "card-1", from: "hand", position: "middle" }),
    ).toBeNull()
  })

  test("accepts a counter addition with an optional label", () => {
    expect(parseAction({ type: "addCounter", instanceId: "card-1", x: 4, y: 6 })).toEqual({
      type: "addCounter",
      instanceId: "card-1",
      x: 4,
      y: 6,
    })
    expect(
      parseAction({ type: "addCounter", instanceId: "card-1", x: 4, y: 6, label: "loyalty" }),
    ).toEqual({ type: "addCounter", instanceId: "card-1", x: 4, y: 6, label: "loyalty" })
    expect(parseAction({ type: "addCounter", instanceId: "card-1", x: 4, y: 6, label: 7 })).toBeNull()
  })

  test("renames the library search aliases to the deck search actions", () => {
    expect(parseAction({ type: "openLibrarySearch" })).toEqual({ type: "openDeckSearch" })
    expect(parseAction({ type: "closeLibrarySearch" })).toEqual({ type: "closeDeckSearch" })
  })

  test("drops unknown attributes", () => {
    expect(parseAction({ type: "drawCard", count: 3, sessionId: "stolen" })).toEqual({
      type: "drawCard",
      count: 3,
    })
  })
})
