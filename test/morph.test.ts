// @vitest-environment happy-dom
import { describe, expect, test } from "vitest"

import { morph } from "../public/morph.js"

function container(html: string): HTMLElement {
  const element = document.createElement("div")
  element.innerHTML = html
  document.body.replaceChildren(element)
  return element
}

describe("morph", () => {
  test("keeps an unchanged image element so it never reloads", () => {
    const target = container(`<div class="card"><img src="/a.jpg" alt="A" /></div>`)
    const image = target.querySelector("img")

    morph(target, `<div class="card tapped"><img src="/a.jpg" alt="A" /></div>`)

    expect(target.querySelector("img")).toBe(image)
    expect(target.querySelector("div")?.className).toBe("card tapped")
  })

  test("keeps images when only a card position changes", () => {
    const target = container(
      `<div class="battlefield-card" style="left:10px;top:20px"><img src="/a.jpg" /></div>`,
    )
    const image = target.querySelector("img")

    morph(
      target,
      `<div class="battlefield-card" style="left:300px;top:80px"><img src="/a.jpg" /></div>`,
    )

    expect(target.querySelector("img")).toBe(image)
    expect(target.querySelector("div")?.getAttribute("style")).toBe("left:300px;top:80px")
  })

  test("replaces an image whose source actually changed", () => {
    const target = container(`<div><img src="/a.jpg" /></div>`)
    const image = target.querySelector("img")

    morph(target, `<div><img src="/b.jpg" /></div>`)

    expect(target.querySelector("img")).not.toBe(image)
    expect(target.querySelector("img")?.getAttribute("src")).toBe("/b.jpg")
  })

  test("removes an attribute that the new markup drops", () => {
    const target = container(`<div class="battlefield-card tapped"><img src="/a.jpg" /></div>`)

    morph(target, `<div class="battlefield-card"><img src="/a.jpg" /></div>`)

    expect(target.querySelector("div")?.className).toBe("battlefield-card")
  })

  test("adds and removes children", () => {
    const target = container(`<ul><li>one</li></ul>`)

    morph(target, `<ul><li>one</li><li>two</li></ul>`)
    expect(target.querySelectorAll("li")).toHaveLength(2)

    morph(target, `<ul><li>one</li></ul>`)
    expect(target.querySelectorAll("li")).toHaveLength(1)
  })

  test("reuses a keyed card even when the order changes", () => {
    const target = container(
      `<div>` +
        `<div data-instance-id="a"><img src="/a.jpg" /></div>` +
        `<div data-instance-id="b"><img src="/b.jpg" /></div>` +
        `</div>`,
    )
    const first = target.querySelector('[data-instance-id="a"] img')

    morph(
      target,
      `<div>` +
        `<div data-instance-id="b"><img src="/b.jpg" /></div>` +
        `<div data-instance-id="a"><img src="/a.jpg" /></div>` +
        `</div>`,
    )

    expect(target.querySelector('[data-instance-id="a"] img')).toBe(first)
    expect(
      Array.from(target.querySelectorAll("[data-instance-id]"), (node) =>
        node.getAttribute("data-instance-id"),
      ),
    ).toEqual(["b", "a"])
  })

  test("updates text without rebuilding the element", () => {
    const target = container(`<p><span class="life-value">20</span></p>`)
    const span = target.querySelector("span")

    morph(target, `<p><span class="life-value">17</span></p>`)

    expect(target.querySelector("span")).toBe(span)
    expect(span?.textContent).toBe("17")
  })

  test("leaves the tree untouched when the markup is identical", () => {
    const target = container(`<div class="card"><img src="/a.jpg" /></div>`)
    const card = target.querySelector("div")

    morph(target, `<div class="card"><img src="/a.jpg" /></div>`)

    expect(target.querySelector("div")).toBe(card)
  })
})
