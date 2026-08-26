import { expect, type Page } from "@playwright/test"

export type Seat = {
  code: string
  playerId: string
}

export type ServerPlayer = {
  id: string
  life: number
  appliedMove: number
  hand: { name: string }[]
  library: { name: string }[]
  battlefield: {
    instanceId: string
    tapped: boolean
    counters: { id: string; x: number; y: number }[]
  }[]
}

export async function openTable(page: Page, playerName = "Alice"): Promise<Seat> {
  await page.goto("/")
  const created = await page.evaluate(async (name) => {
    const response = await fetch("/api/tables", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ playerName: name, tableName: "Browser Suite" }),
    })
    const body = await response.json()
    return { code: body.space.code as string, playerId: body.currentPlayerId as string }
  }, playerName)

  await page.goto(`/tables/${created.code}`)
  await expect(page.locator(".your-seat")).toBeVisible()
  return created
}

export async function joinTable(page: Page, code: string, playerName: string): Promise<void> {
  await page.goto("/")
  await page.evaluate(
    async (input) => {
      await fetch(`/api/tables/${input.code}/join`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ playerName: input.playerName }),
      })
    },
    { code, playerName },
  )
  await page.goto(`/tables/${code}`)
  await expect(page.locator(".your-seat")).toBeVisible()
}

export async function loadDeck(page: Page, code: string): Promise<void> {
  await page.evaluate(async (tableCode) => {
    await fetch(`/api/tables/${tableCode}/deck`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ deckId: "1" }),
    })
  }, code)

  await expect
    .poll(async () => (await seatState(page, code)).library.length, { timeout: 15_000 })
    .toBeGreaterThan(0)
}

export async function seatState(page: Page, code: string): Promise<ServerPlayer> {
  return page.evaluate(async (tableCode) => {
    const response = await fetch(`/api/tables/${tableCode}/state`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    const body = await response.json()
    return body.space.players.find(
      (player: { id: string }) => player.id === body.currentPlayerId,
    ) as ServerPlayer
  }, code)
}

export async function originStorageNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = (await navigator.storage.getDirectory()) as unknown as {
      entries(): AsyncIterable<[string, unknown]>
    }
    const names: string[] = []
    for await (const [name] of root.entries()) names.push(name)
    return names
  })
}

export async function waitForMirror(page: Page): Promise<void> {
  await expect
    .poll(async () => (await originStorageNames(page)).includes(".opfs-sahpool"), {
      timeout: 20_000,
    })
    .toBe(true)
}

export async function clickAction(page: Page, match: string): Promise<void> {
  await page.locator(`[data-game-action*=${JSON.stringify(match)}]`).first().click()
}

export async function settle(page: Page): Promise<void> {
  await expect(page.locator("[data-queued-moves]")).toBeHidden({ timeout: 30_000 })
}

export function ownLife(page: Page) {
  return page.locator(".your-seat .life-value").first()
}

type Target = ReturnType<Page["locator"]>

async function centreOf(locator: Target): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error("the element has no box")

  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

export async function dragBy(options: {
  page: Page
  grab: Target
  measure: Target
  travel: { x: number; y: number }
}): Promise<{ x: number; y: number }> {
  const { page, travel } = options
  const start = await centreOf(options.grab)
  const before = await centreOf(options.measure)

  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + travel.x, start.y + travel.y, { steps: 8 })
  const after = await centreOf(options.measure)
  await page.mouse.up()

  return { x: Math.round(after.x - before.x), y: Math.round(after.y - before.y) }
}

export async function dragCounter(options: {
  page: Page
  chip: Target
  travel: { x: number; y: number }
}): Promise<{ x: number; y: number }> {
  return dragBy({
    page: options.page,
    grab: options.chip.locator(".counter-value"),
    measure: options.chip,
    travel: options.travel,
  })
}

export async function dropCounterOn(options: {
  page: Page
  card: Target
  at: { x: number; y: number }
}): Promise<void> {
  const { page } = options
  const from = await centreOf(page.locator("[data-counter-palette]"))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()

  const box = await options.card.boundingBox()
  if (!box) throw new Error("the card has no box")
  const target = { x: box.x + options.at.x, y: box.y + options.at.y }
  const viewport = page.viewportSize()
  if (viewport && (target.y < 0 || target.y > viewport.height)) {
    await page.mouse.up()
    throw new Error("the card sits outside the viewport, so the drop cannot land")
  }

  await page.mouse.move(target.x, target.y, { steps: 10 })
  await page.mouse.up()
}
