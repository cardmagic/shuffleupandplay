import { expect, test, type Page } from "@playwright/test"

import {
  clickAction,
  dragCounter,
  dropCounterOn,
  loadDeck,
  openTable,
  seatState,
  settle,
  waitForMirror,
} from "./support.ts"

function card(page: Page) {
  return page.locator(".your-seat .battlefield-card").first()
}

function chips(page: Page) {
  return page.locator(".your-seat .counter-chip")
}

async function playedCard(page: Page): Promise<string> {
  const seat = await openTable(page)
  await loadDeck(page, seat.code)
  await waitForMirror(page)

  await clickAction(page, '"drawCard"')
  await expect(page.locator(".your-seat .hand-strip .hand-card")).toHaveCount(1)
  await page.locator(".your-seat .hand-strip .hand-card").first().click()
  await expect(card(page)).toBeVisible()

  return seat.code
}

async function addCounterAt(page: Page, at: { x: number; y: number }): Promise<void> {
  const before = await chips(page).count()
  await dropCounterOn({ page, card: card(page), at })
  await expect(chips(page)).toHaveCount(before + 1)
  await settle(page)
}

async function tapCard(page: Page): Promise<void> {
  await card(page).scrollIntoViewIfNeeded()
  const box = await card(page).boundingBox()
  if (!box) throw new Error("the card has no box")

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(card(page)).toHaveClass(/tapped/)
  await settle(page)
}

test("moves a counter with the pointer on an upright card", async ({ page }) => {
  await playedCard(page)
  await addCounterAt(page, { x: 30, y: 40 })

  const travel = await dragCounter({ page, chip: chips(page).first(), travel: { x: 24, y: 18 } })

  expect(travel).toEqual({ x: 24, y: 18 })
})

test("moves a counter with the pointer on a tapped card", async ({ page }) => {
  await playedCard(page)
  await addCounterAt(page, { x: 30, y: 60 })
  await tapCard(page)

  const travel = await dragCounter({ page, chip: chips(page).first(), travel: { x: 20, y: 16 } })

  expect(travel).toEqual({ x: 20, y: 16 })
})

test("commits the position the player dragged a counter to on a tapped card", async ({ page }) => {
  const code = await playedCard(page)
  await addCounterAt(page, { x: 30, y: 60 })
  await tapCard(page)

  await dragCounter({ page, chip: chips(page).first(), travel: { x: 18, y: 14 } })

  const local = await chips(page)
    .first()
    .evaluate((node: HTMLElement) => ({ x: node.offsetLeft, y: node.offsetTop }))
  await expect
    .poll(async () => {
      const counter = (await seatState(page, code)).battlefield[0]?.counters[0]
      return counter ? { x: counter.x, y: counter.y } : null
    })
    .toEqual(local)
})

test("drops a counter where the player let go on a tapped card", async ({ page }) => {
  const code = await playedCard(page)
  await tapCard(page)
  await addCounterAt(page, { x: 40, y: 90 })

  await expect
    .poll(async () => (await seatState(page, code)).battlefield[0]?.counters.length)
    .toBe(1)
  const shown = await chips(page)
    .first()
    .evaluate((node: HTMLElement) => ({ x: node.offsetLeft, y: node.offsetTop }))
  const held = (await seatState(page, code)).battlefield[0]!.counters[0]!

  expect({ x: held.x, y: held.y }).toEqual(shown)
})

test("keeps every counter on a card when the seat redraws", async ({ page }) => {
  const code = await playedCard(page)
  await addCounterAt(page, { x: 26, y: 30 })
  await addCounterAt(page, { x: 26, y: 90 })
  await addCounterAt(page, { x: 70, y: 130 })

  await expect(chips(page)).toHaveCount(3)
  await expect
    .poll(async () => (await seatState(page, code)).battlefield[0]?.counters.length)
    .toBe(3)

  await clickAction(page, '"delta":-1')
  await expect(page.locator(".your-seat .life-value")).toHaveText("19")

  await expect(chips(page)).toHaveCount(3)
})

test("shows exactly the counters the table holds", async ({ page }) => {
  const code = await playedCard(page)
  await addCounterAt(page, { x: 26, y: 30 })
  await addCounterAt(page, { x: 26, y: 100 })
  await dragCounter({ page, chip: chips(page).first(), travel: { x: 20, y: 10 } })

  await expect
    .poll(async () => (await seatState(page, code)).battlefield[0]?.counters.length)
    .toBe(2)

  await expect
    .poll(async () => {
      const held = (await seatState(page, code)).battlefield[0]!.counters
        .map((counter) => `${counter.x},${counter.y}`)
        .sort()
        .join(" ")
      const shown = (
        await chips(page).evaluateAll((nodes) =>
          nodes.map(
            (node) => `${(node as HTMLElement).offsetLeft},${(node as HTMLElement).offsetTop}`,
          ),
        )
      )
        .sort()
        .join(" ")
      return { held, shown, agree: held === shown }
    })
    .toMatchObject({ agree: true })
})
