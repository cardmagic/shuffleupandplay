import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import type { ServerResponse } from "node:http"
import { createRequire, stripTypeScriptTypes } from "node:module"
import { resolve } from "node:path"

const SHARED_PREFIX = "/shared/"
const VENDOR_PREFIX = "/vendor/"
const STAMP_PATTERN = /^([a-f0-9]{12})\//
const VENDOR_PACKAGES = ["solid-objects", "@sqlite.org/sqlite-wasm"]

const SHARED_MODULES = new Set([
  "actors/table-mirror.ts",
  "game/action.ts",
  "game/player.ts",
  "game/randomness.ts",
  "game/types.ts",
  "server/render/components.ts",
  "server/render/escape.ts",
])

const SPECIFIER_PATTERN = /(\bfrom\s+|\bimport\s+)(["'])([^"']+)\2/g

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

export const MODULE_STAMP = browserModuleStamp()

const BROWSER_SPECIFIERS: Record<string, string> = {
  "solid-objects": `${VENDOR_PREFIX}${MODULE_STAMP}/live/browser/host.js`,
  "@sqlite.org/sqlite-wasm": `${VENDOR_PREFIX}${MODULE_STAMP}/sqlite/index.mjs`,
}

export function rewriteBrowserSpecifiers(source: string): string {
  return source.replaceAll(SPECIFIER_PATTERN, (match, keyword: string, _quote, specifier: string) => {
    const replacement = BROWSER_SPECIFIERS[specifier] ?? stampedEntryUrl(specifier)

    return replacement ? `${keyword}"${replacement}"` : match
  })
}

export function stampedEntryUrl(specifier: string): string | null {
  for (const prefix of [SHARED_PREFIX, VENDOR_PREFIX]) {
    if (!specifier.startsWith(prefix)) continue
    if (STAMP_PATTERN.test(specifier.slice(prefix.length))) return specifier

    return `${prefix}${MODULE_STAMP}/${specifier.slice(prefix.length)}`
  }

  return null
}

export function readModuleStamp(pathname: string, prefix: string): {
  path: string
  stamped: boolean
} {
  const rest = pathname.slice(prefix.length)
  const match = STAMP_PATTERN.exec(rest)
  if (!match) return { path: rest, stamped: false }

  return { path: rest.slice(match[0].length), stamped: match[1] === MODULE_STAMP }
}

function browserModuleStamp(): string {
  const hash = createHash("sha256")
  for (const name of [...SHARED_MODULES].sort()) {
    hash.update(readFileSync(resolve(sharedModuleSourceRoot(), name)))
  }
  for (const name of VENDOR_PACKAGES) hash.update(packageVersion(name))

  return hash.digest("hex").slice(0, 12)
}

function packageVersion(name: string): string {
  try {
    const path = createRequire(import.meta.url).resolve(`${name}/package.json`)
    return String(JSON.parse(readFileSync(path, "utf8")).version ?? name)
  } catch {
    return name
  }
}

export function sharedModuleUrl(relativePath: string): string {
  return `${SHARED_PREFIX}${MODULE_STAMP}/${relativePath}`
}

export function isSharedModule(relativePath: string): boolean {
  return SHARED_MODULES.has(relativePath)
}

export function moduleCacheControl(stamped: boolean): string {
  return stamped ? "public, max-age=31536000, immutable" : "no-cache"
}

export async function serveSharedModule(options: {
  method: string
  pathname: string
  response: ServerResponse
}): Promise<boolean> {
  const { method, pathname, response } = options
  if (method !== "GET" && method !== "HEAD") return false
  if (!pathname.startsWith(SHARED_PREFIX)) return false

  const requested = readModuleStamp(pathname, SHARED_PREFIX)
  const relativePath = decodePath(requested.path)
  if (!relativePath || !isSharedModule(relativePath)) return false

  const source = await moduleSource(relativePath)
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": moduleCacheControl(requested.stamped),
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
