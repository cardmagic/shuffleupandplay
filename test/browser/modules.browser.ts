import { expect, test, type Page } from "@playwright/test"

import { openTable, waitForMirror } from "./support.ts"

type PageFailures = {
  console: string[]
  requests: string[]
}

function watchFailures(page: Page): PageFailures {
  const failures: PageFailures = { console: [], requests: [] }

  page.on("console", (message) => {
    if (message.type() !== "error") return
    failures.console.push(message.text())
  })
  page.on("pageerror", (error) => failures.console.push(error.message))
  page.on("response", (response) => {
    if (response.status() < 400) return
    failures.requests.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })

  return failures
}

test("loads the table with no console error and no failed request", async ({ page }) => {
  const failures = watchFailures(page)

  await openTable(page)
  await waitForMirror(page)

  expect(failures.console).toEqual([])
  expect(failures.requests).toEqual([])
})

test("stamps every module the page and the worker import", async ({ page }) => {
  await openTable(page)

  const modules = await page.evaluate(async () => {
    const entries = [
      document.querySelector("script[type=module]")?.getAttribute("src"),
      document.querySelector("[data-game]")?.getAttribute("data-worker-url"),
    ].filter((value): value is string => Boolean(value))

    const sources: Record<string, string> = {}
    for (const entry of entries) {
      sources[entry] = await (await fetch(entry)).text()
    }
    return sources
  })

  expect(Object.keys(modules).length).toBeGreaterThan(1)
  for (const [entry, source] of Object.entries(modules)) {
    expect(source, `${entry} imports an unstamped shared module`).not.toMatch(
      /from "\/shared\/(?![a-f0-9]{12}\/)/,
    )
    expect(source, `${entry} imports an unstamped vendored module`).not.toMatch(
      /from "\/vendor\/(?![a-f0-9]{12}\/)/,
    )
    expect(source, `${entry} imports an unstamped sibling module`).not.toMatch(
      /from "\.\//,
    )
  }
})

test("serves every module the worker pulls in", async ({ page }) => {
  const failures = watchFailures(page)

  await openTable(page)
  await waitForMirror(page)

  const modulePaths = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => path.startsWith("/vendor/") || path.startsWith("/shared/")),
  )

  expect(modulePaths.length).toBeGreaterThan(0)
  expect(failures.requests).toEqual([])
})

test("keeps a stamped module cacheable for a year", async ({ page }) => {
  await openTable(page)

  const headers = await page.evaluate(async () => {
    const source = await (
      await fetch(document.querySelector("script[type=module]")!.getAttribute("src")!)
    ).text()
    const stamped = /\/shared\/[a-f0-9]{12}\/[^"']+/.exec(source)?.[0] ?? ""
    const response = await fetch(stamped)
    return { url: stamped, cacheControl: response.headers.get("cache-control") }
  })

  expect(headers.url).not.toBe("")
  expect(headers.cacheControl).toBe("public, max-age=31536000, immutable")
})
