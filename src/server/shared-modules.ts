import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import type { ServerResponse } from "node:http"
import { stripTypeScriptTypes } from "node:module"
import { resolve } from "node:path"

const SHARED_PREFIX = "/shared/"

const SHARED_MODULES = new Set([
  "actors/table-mirror.ts",
  "game/action.ts",
  "game/player.ts",
  "game/randomness.ts",
  "game/types.ts",
  "server/render/components.ts",
  "server/render/escape.ts",
])

const BROWSER_SPECIFIERS: Record<string, string> = {
  "solid-objects": "/vendor/live/browser/host.js",
  "@sqlite.org/sqlite-wasm": "/vendor/sqlite/index.mjs",
}

const SPECIFIER_PATTERN = /(\bfrom\s+|\bimport\s+)(["'])([^"']+)\2/g

export function rewriteBrowserSpecifiers(source: string): string {
  return source.replaceAll(SPECIFIER_PATTERN, (match, keyword: string, _quote, specifier: string) => {
    const replacement = BROWSER_SPECIFIERS[specifier]

    return replacement ? `${keyword}"${replacement}"` : match
  })
}

const ROOT_CANDIDATES = [
  resolve(import.meta.dirname, ".."),
  resolve(import.meta.dirname, "../../src"),
]

const sources = new Map<string, string>()
let sourceRoot: string | undefined

export function sharedModuleSourceRoot(): string {
  sourceRoot ??= ROOT_CANDIDATES.find((candidate) =>
    existsSync(resolve(candidate, "game/player.ts")),
  )
  if (!sourceRoot) throw new Error("the shared module source directory is missing")

  return sourceRoot
}

export function sharedModuleUrl(relativePath: string): string {
  return `${SHARED_PREFIX}${relativePath}`
}

export function isSharedModule(relativePath: string): boolean {
  return SHARED_MODULES.has(relativePath)
}

export async function serveSharedModule(options: {
  method: string
  pathname: string
  response: ServerResponse
}): Promise<boolean> {
  const { method, pathname, response } = options
  if (method !== "GET" && method !== "HEAD") return false
  if (!pathname.startsWith(SHARED_PREFIX)) return false

  const relativePath = decodePath(pathname.slice(SHARED_PREFIX.length))
  if (!relativePath || !isSharedModule(relativePath)) return false

  const source = await moduleSource(relativePath)
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=300, must-revalidate",
  })
  if (method === "HEAD") {
    response.end()
    return true
  }

  response.end(source)
  return true
}

async function moduleSource(relativePath: string): Promise<string> {
  const cached = sources.get(relativePath)
  if (cached !== undefined) return cached

  const source = await readFile(resolve(sharedModuleSourceRoot(), relativePath), "utf8")
  const stripped = rewriteBrowserSpecifiers(stripTypeScriptTypes(source, { mode: "strip" }))
  sources.set(relativePath, stripped)
  return stripped
}

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
