import { describe, expect, test } from "vitest"

import { cardPoint, dragOffset, dragPosition, rotationFromTransform } from "../public/drag-math.js"

const canvas = { left: 100, top: 50 }

const UPRIGHT = { center: { x: 300, y: 200 }, size: { width: 116, height: 162 }, rotation: 0 }
const TAPPED = { ...UPRIGHT, rotation: Math.PI / 2 }

describe("drag math", () => {
  test("holds a card still when the pointer has not moved", () => {
    const card = { left: 401, top: 20 }
    const pointer = { x: 460, y: 100 }

    const offset = dragOffset({ pointer, canvas, card })
    const position = dragPosition({ pointer, canvas, offset })

    expect(position).toEqual(card)
  })

  test("holds a rotated card still, because it uses the layout box", () => {
    // A tapped card renders 162x116 instead of 116x162. The layout box is what
    // left and top address, so the maths must not depend on the rendered size.
    const card = { left: 401, top: 20 }
    const pointer = { x: 523, y: 88 }

    const offset = dragOffset({ pointer, canvas, card })
    const position = dragPosition({ pointer, canvas, offset })

    expect(position).toEqual(card)
  })

  test("moves the card by exactly the pointer travel", () => {
    const card = { left: 200, top: 120 }
    const offset = dragOffset({ pointer: { x: 300, y: 200 }, canvas, card })

    const position = dragPosition({ pointer: { x: 340, y: 165 }, canvas, offset })

    expect(position).toEqual({ left: 240, top: 85 })
  })

  test("never lets a card leave the top or left edge", () => {
    const card = { left: 10, top: 10 }
    const offset = dragOffset({ pointer: { x: 120, y: 70 }, canvas, card })

    const position = dragPosition({ pointer: { x: 0, y: 0 }, canvas, offset })

    expect(position).toEqual({ left: 0, top: 0 })
  })

  test("treats a card with no inline position as the canvas origin", () => {
    const card = { left: 0, top: 0 }
    const offset = dragOffset({ pointer: { x: 100, y: 50 }, canvas, card })

    expect(dragPosition({ pointer: { x: 100, y: 50 }, canvas, offset })).toEqual({
      left: 0,
      top: 0,
    })
  })
})

describe("card rotation", () => {
  test("reads no rotation from a card that carries no transform", () => {
    expect(rotationFromTransform("none")).toBe(0)
    expect(rotationFromTransform("")).toBe(0)
    expect(rotationFromTransform(undefined)).toBe(0)
  })

  test("reads a quarter turn from a tapped card", () => {
    expect(rotationFromTransform("matrix(0, 1, -1, 0, 0, 0)")).toBeCloseTo(Math.PI / 2, 10)
  })

  test("reads no rotation from an identity transform", () => {
    expect(rotationFromTransform("matrix(1, 0, 0, 1, 0, 0)")).toBeCloseTo(0, 10)
  })
})

describe("counter positions on a card", () => {
  test("puts the pointer at the middle of an upright card", () => {
    const point = cardPoint({ pointer: { x: 300, y: 200 }, frame: UPRIGHT })

    expect(point).toEqual({ x: 58, y: 81 })
  })

  test("puts the pointer at the middle of a tapped card", () => {
    const point = cardPoint({ pointer: { x: 300, y: 200 }, frame: TAPPED })

    expect(point.x).toBeCloseTo(58, 6)
    expect(point.y).toBeCloseTo(81, 6)
  })

  test("follows the screen axes on an upright card", () => {
    const point = cardPoint({ pointer: { x: 300, y: 210 }, frame: UPRIGHT })

    expect(point.x).toBeCloseTo(58, 6)
    expect(point.y).toBeCloseTo(91, 6)
  })

  test("turns the screen axes with a tapped card", () => {
    const point = cardPoint({ pointer: { x: 300, y: 210 }, frame: TAPPED })

    expect(point.x).toBeCloseTo(68, 6)
    expect(point.y).toBeCloseTo(81, 6)
  })

  test("holds a counter still on a tapped card when the pointer has not moved", () => {
    const counter = { left: 20, top: 30 }
    const pointer = { x: 351, y: 162 }

    const grab = cardPoint({ pointer, frame: TAPPED })
    const offset = { x: grab.x - counter.left, y: grab.y - counter.top }
    const moved = cardPoint({ pointer, frame: TAPPED })

    expect(moved.x - offset.x).toBeCloseTo(counter.left, 6)
    expect(moved.y - offset.y).toBeCloseTo(counter.top, 6)
  })

  test("moves a counter along the card, not along the screen, when tapped", () => {
    const grab = cardPoint({ pointer: { x: 351, y: 162 }, frame: TAPPED })
    const moved = cardPoint({ pointer: { x: 351, y: 182 }, frame: TAPPED })

    expect(moved.x - grab.x).toBeCloseTo(20, 6)
    expect(moved.y - grab.y).toBeCloseTo(0, 6)
  })
})
