import { describe, expect, test } from "vitest"

import { dragOffset, dragPosition } from "../public/drag-math.js"

const canvas = { left: 100, top: 50 }

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
