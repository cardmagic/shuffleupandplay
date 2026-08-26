import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  componentTargetId,
  renderComponent,
  type ComponentName,
  type ComponentRenderContext,
} from "./components.ts"
import { attribute, escapeHtml, jsonAttribute } from "./escape.ts"
import { GameRoom } from "../../actors/game-room.ts"
import { MODULE_STAMP, stampedEntryUrl } from "../shared-modules.ts"
import type { RoomPayload } from "../../game/types.ts"

const PUBLIC_DIRECTORY = resolve(import.meta.dirname, "../../../public")

const ASSET_NAMES = [
  "application.css",
  "shuffle.js",
  "table-worker.js",
  "drag-math.js",
  "morph.js",
  "icon.svg",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "social-card.png",
] as const

const RELATIVE_IMPORT_PATTERN = /(\bfrom\s+|\bimport\s+)(["'])\.\/([^"']+)\2/g
const ABSOLUTE_IMPORT_PATTERN = /(\bfrom\s+|\bimport\s+)(["'])(\/(?:shared|vendor)\/[^"']+)\2/g

export const SITE_ORIGIN = process.env.SHUFFLE_PUBLIC_ORIGIN ?? "https://shuffleupandplay.com"

const digests = new Map<string, string>()

export const ASSET_URLS: Record<string, string> = Object.fromEntries(
  ASSET_NAMES.map((name) => [name, fingerprintedPath(name)]),
)

export function moduleImports(source: string): string[] {
  return [...source.matchAll(RELATIVE_IMPORT_PATTERN)].map((match) => match[3] as string)
}

export function stampModuleImports(source: string): string {
  const relative = source.replaceAll(
    RELATIVE_IMPORT_PATTERN,
    (match, keyword: string, _quote, name: string) => {
      const stamped = ASSET_URLS[name]

      return stamped ? `${keyword}"${stamped}"` : match
    },
  )

  return relative.replaceAll(ABSOLUTE_IMPORT_PATTERN, (match, keyword: string, _quote, specifier: string) => {
    const stamped = stampedEntryUrl(specifier)

    return stamped ? `${keyword}"${stamped}"` : match
  })
}

function assetDigest(name: string): string {
  const cached = digests.get(name)
  if (cached !== undefined) return cached

  digests.set(name, "")
  const source = readFileSync(resolve(PUBLIC_DIRECTORY, name))
  const hash = createHash("sha256").update(source)
  if (name.endsWith(".js")) {
    hash.update(MODULE_STAMP)
    for (const dependency of moduleImports(source.toString("utf8"))) {
      hash.update(assetDigest(dependency))
    }
  }

  const digest = hash.digest("hex").slice(0, 12)
  digests.set(name, digest)
  return digest
}

function fingerprintedPath(name: string): string {
  const dot = name.lastIndexOf(".")
  return `/assets/${name.slice(0, dot)}.${assetDigest(name)}${name.slice(dot)}`
}

function absolute(path: string): string {
  return new URL(path, SITE_ORIGIN).toString()
}

export const PRODUCT_DESCRIPTION =
  "Play Magic remotely with an Archidekt deck. Draw, tap, move, and track cards on a shared two-player table."

export type LobbyErrorField = "playerName" | "tableCode"

export type LobbyErrorCode =
  | "tableNotFound"
  | "tableFull"
  | "invalidCode"
  | "nameRequired"
  | "tableExpired"
  | "sessionLost"

export type LobbyError = {
  code: LobbyErrorCode
  playerName?: string | null
  tableCode?: string | null
}

const LOBBY_MESSAGES: Record<
  LobbyErrorCode,
  { field: LobbyErrorField | null; message: string; action: string }
> = {
  tableNotFound: {
    field: "tableCode",
    message: "This table does not exist.",
    action: "Check the code with your opponent, or create a new table.",
  },
  tableFull: {
    field: "tableCode",
    message: "This table is full.",
    action: "Two players are already seated. Ask the host for a new table.",
  },
  invalidCode: {
    field: "tableCode",
    message: "That table code is not valid.",
    action: "A code is six letters and numbers, like ABC123.",
  },
  nameRequired: {
    field: "playerName",
    message: "Enter your name to continue.",
    action: "Your opponent sees this name at the table.",
  },
  tableExpired: {
    field: "tableCode",
    message: "This table has expired.",
    action: "Create a new table to keep playing.",
  },
  sessionLost: {
    field: null,
    message: "Your seat could not be restored.",
    action: "Enter your name to take a seat again.",
  },
}

export function isLobbyErrorCode(value: string): value is LobbyErrorCode {
  return Object.hasOwn(LOBBY_MESSAGES, value)
}

function errorId(field: LobbyErrorField): string {
  return `error-${field}`
}

function fieldError(options: { error: LobbyError | null; field: LobbyErrorField }): string {
  const entry = options.error ? LOBBY_MESSAGES[options.error.code] : null
  if (!entry || entry.field !== options.field) return ""

  return `<p class="field-error" id="${errorId(options.field)}" role="alert">
    <strong>${escapeHtml(entry.message)}</strong> ${escapeHtml(entry.action)}
  </p>`
}

function describedBy(options: { error: LobbyError | null; field: LobbyErrorField }): string {
  const entry = options.error ? LOBBY_MESSAGES[options.error.code] : null
  if (!entry || entry.field !== options.field) return ""

  return `aria-invalid="true" aria-describedby="${errorId(options.field)}" data-autofocus`
}

function generalError(error: LobbyError | null): string {
  const entry = error ? LOBBY_MESSAGES[error.code] : null
  if (!entry || entry.field !== null) return ""

  return `<p class="field-error field-error-general" role="alert">
    <strong>${escapeHtml(entry.message)}</strong> ${escapeHtml(entry.action)}
  </p>`
}

export type ComponentDeclaration = {
  name: ComponentName
  key?: string | number
  observes: readonly string[]
  batch?: string
  strategy: "replace" | "morph"
}

export function layout(options: {
  title: string
  body: string
  description?: string
  private?: boolean
  canonical?: string
}): string {
  const description = options.description ?? PRODUCT_DESCRIPTION
  const robots = options.private
    ? `<meta name="robots" content="noindex, nofollow" />`
    : `<meta name="robots" content="index, follow" />
    ${options.canonical ? `<link rel="canonical" href="${attribute(options.canonical)}" />` : ""}`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(options.title)}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <meta name="description" content="${attribute(description)}" />
    ${robots}
    <meta name="theme-color" content="#0d1320" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Shuffle Up and Play" />
    <meta property="og:title" content="Shuffle Up and Play" />
    <meta property="og:description" content="${attribute(PRODUCT_DESCRIPTION)}" />
    <meta property="og:url" content="${attribute(SITE_ORIGIN)}" />
    <meta property="og:image" content="${attribute(absolute(ASSET_URLS["social-card.png"] ?? ""))}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Shuffle Up and Play" />
    <meta name="twitter:description" content="${attribute(PRODUCT_DESCRIPTION)}" />
    <meta name="twitter:image" content="${attribute(absolute(ASSET_URLS["social-card.png"] ?? ""))}" />
    <link rel="icon" href="${ASSET_URLS["icon.svg"]}" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="${ASSET_URLS["apple-touch-icon.png"]}" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="stylesheet" href="${ASSET_URLS["application.css"]}" />
    <script type="module" src="${ASSET_URLS["shuffle.js"]}"></script>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to main content</a>
    ${options.body}
    <div class="toast-region" data-toast-region role="status" aria-live="polite"></div>
    <aside id="card-hover-preview" class="card-hover-preview" aria-hidden="true">
      <img id="card-hover-preview-image" alt="" />
      <p id="card-hover-preview-name"></p>
    </aside>
  </body>
</html>`
}

export function lobbyPage(options: {
  joinCode: string | null
  error: LobbyError | null
  tableName?: string | null
  hostName?: string | null
}): string {
  const invited = Boolean(options.joinCode)
  const createForm = invited
    ? ""
    : `<form class="stacked-form" method="post" action="/api/tables" data-remember-name>
        <h2>Create a table</h2>
        ${fieldError({ error: options.error, field: "playerName" })}
        <label for="createPlayerName">Your name</label>
        <input id="createPlayerName" name="playerName" maxlength="28" required autocomplete="name"
          value="${attribute(options.error?.playerName ?? "")}"
          ${describedBy({ error: options.error, field: "playerName" })} />
        <label for="createTableName">Table name</label>
        <input id="createTableName" name="tableName" maxlength="40" value="Kitchen Table" />
        <button type="submit">Create table</button>
      </form>`

  const joinHeading = invited
    ? `<h2>Join ${escapeHtml(options.tableName ?? "this table")}</h2>
       ${options.hostName ? `<p class="join-host">${escapeHtml(options.hostName)} is waiting for an opponent.</p>` : ""}`
    : `<h2>Join a table</h2>`

  return layout({
    title: "Shuffle Up and Play",
    description: PRODUCT_DESCRIPTION,
    body: `<main class="layout" id="main">
  <header class="topbar panel">
    <h1>Shuffle Up and Play</h1>
    <p class="lede">${escapeHtml(PRODUCT_DESCRIPTION)}</p>
  </header>
  ${generalError(options.error)}
  <section class="panel lobby-panel">
    <div class="lobby-grid">
      ${createForm}
      <form class="stacked-form" method="post" action="/api/tables/join" data-remember-name>
        ${joinHeading}
        ${fieldError({ error: options.error, field: "playerName" })}
        <label for="joinPlayerName">Your name</label>
        <input id="joinPlayerName" name="playerName" maxlength="28" required autocomplete="name"
          value="${attribute(options.error?.playerName ?? "")}"
          ${describedBy({ error: options.error, field: "playerName" })} />
        ${fieldError({ error: options.error, field: "tableCode" })}
        <label for="joinTableCode">Table code</label>
        <input id="joinTableCode" name="tableCode" maxlength="6" placeholder="ABC123" required autocapitalize="characters"
          value="${attribute(options.joinCode ?? options.error?.tableCode ?? "")}"
          ${describedBy({ error: options.error, field: "tableCode" })} />
        <button type="submit">Join table</button>
      </form>
    </div>
  </section>
  <section class="panel how-it-works">
    <h2>How it works</h2>
    <ol class="steps">
      <li><strong>Create a table.</strong> No account needed.</li>
      <li><strong>Share the invite link.</strong> It fills in the table code for you.</li>
      <li><strong>Load your decks and play.</strong> Draw, tap, move and track cards together.</li>
    </ol>
  </section>
</main>`,
  })
}

export function gamePage(options: {
  payload: RoomPayload
  roomCode: string
  seat: number
  shareUrl: string
}): string {
  const room = options.payload.space
  if (!room) throw new TypeError("a game page needs a projected room")

  const context: ComponentRenderContext = {
    payload: options.payload,
    roomCode: options.roomCode,
    seat: options.seat,
    shareUrl: options.shareUrl,
  }
  const declarations = componentDeclarations(options.seat)
  const opponentSeat = options.seat === 1 ? 2 : 1

  return layout({
    title: `Shuffle Up and Play · ${escapeHtml(room.name)}`,
    private: true,
    body: `<main class="layout" id="main"
  data-game
  data-table-type="${attribute(GameRoom.actorType)}"
  data-table-code="${attribute(options.roomCode)}"
  data-current-player-id="${attribute(options.payload.currentPlayerId ?? "")}"
  data-seat="${options.seat}"
  data-worker-url="${attribute(ASSET_URLS["table-worker.js"])}"
  data-components="${jsonAttribute(declarations)}"
>
  <section class="topbar-live-meta panel">
    <div class="table-title-row">
      <h1>${escapeHtml(room.name)}</h1>
      <div class="table-title-actions">
        <button type="button" class="share-link-button" data-copy-text="${attribute(options.shareUrl)}">Copy invite link</button>
        <button type="button" class="help-button" data-open-help aria-haspopup="dialog">Help</button>
      </div>
    </div>
    <div class="status-grid">
      <p class="table-code">Table code <strong>${escapeHtml(options.roomCode)}</strong></p>
      <p>You are seat ${options.seat}</p>
      ${connectionStatus()}
    </div>
  </section>

  ${componentSlot({ name: "tableStatus", context })}

  <div class="board-layout">
    ${componentSlot({ name: "playerControls", key: options.seat, context })}
    <section class="main-table panel">
      <div id="players-area">
        ${componentSlot({ name: "player", key: options.seat, context })}
        ${componentSlot({ name: "player", key: opponentSeat, context })}
      </div>
    </section>
  </div>

  ${componentSlot({ name: "librarySearch", key: options.seat, context })}
  ${componentSlot({ name: "gameResult", context })}
</main>`,
  })
}

export function privacyPage(): string {
  return layout({
    title: "Privacy · Shuffle Up and Play",
    description: "What Shuffle Up and Play stores and why.",
    canonical: `${SITE_ORIGIN}/privacy`,
    body: `<main class="layout prose" id="main">
  <header class="topbar panel">
    <h1>Privacy</h1>
  </header>
  <section class="panel">
    <h2>What this site stores</h2>
    <p>Shuffle Up and Play needs no account. When you create or join a table the site sets one
      cookie that identifies your seat. It holds a random identifier and nothing else.</p>
    <p>A table holds the name you type, the deck you load, and the position of your cards. That
      data stays until the table is removed.</p>
    <h2>What this site does not do</h2>
    <p>The site runs no advertising, no analytics and no third-party trackers. It never sells data.
      Visiting the home page sets no cookie.</p>
    <h2>Other services</h2>
    <p>Deck search reads the public Archidekt API. Card images come from Scryfall. Your browser
      requests those images directly, so those services can see the request.</p>
    <p><a href="/">Back to the tables</a> · <a href="/credits">Credits</a></p>
  </section>
</main>`,
  })
}

export function creditsPage(): string {
  return layout({
    title: "Credits · Shuffle Up and Play",
    description: "Attribution for Archidekt, Scryfall and Wizards of the Coast.",
    canonical: `${SITE_ORIGIN}/credits`,
    body: `<main class="layout prose" id="main">
  <header class="topbar panel">
    <h1>Credits</h1>
  </header>
  <section class="panel">
    <h2>Deck data</h2>
    <p>Deck search and deck import use the public
      <a href="https://archidekt.com" rel="noopener noreferrer">Archidekt</a> API.
      Archidekt does not endorse this project.</p>
    <h2>Card images</h2>
    <p>Card images and card data come from
      <a href="https://scryfall.com" rel="noopener noreferrer">Scryfall</a>.
      Scryfall does not endorse this project.</p>
    <h2>Fan content</h2>
    <p>Shuffle Up and Play is unofficial Fan Content permitted under the Fan Content Policy of
      Wizards of the Coast. It is not approved or endorsed by Wizards. Portions of the materials
      used are property of Wizards of the Coast LLC, a subsidiary of Hasbro, Inc.</p>
    <p>Magic: The Gathering is a trademark of Wizards of the Coast LLC.</p>
    <p><a href="/">Back to the tables</a> · <a href="/privacy">Privacy</a></p>
  </section>
</main>`,
  })
}

export function notFoundPage(): string {
  return layout({
    title: "Page not found · Shuffle Up and Play",
    private: true,
    body: `<main class="layout prose" id="main">
  <header class="topbar panel">
    <h1>That page is not here</h1>
    <p class="lede">The link may be old, or the table may have ended.</p>
  </header>
  <section class="panel">
    <p><a class="primary-action" href="/">Go to the lobby</a></p>
    <p>From there you can create a table or join one with a six character code.</p>
  </section>
</main>`,
  })
}

function connectionStatus(): string {
  return `<p class="connection-status" data-connection-status data-state="connecting" role="status" aria-live="polite">
    <span class="connection-dot" aria-hidden="true"></span>
    <span data-connection-label>Connecting…</span>
    <span class="queued-moves" data-queued-moves role="status" aria-live="polite" hidden></span>
  </p>`
}

export function componentDeclarations(seat: number): ComponentDeclaration[] {
  const opponentSeat = seat === 1 ? 2 : 1
  const seatObservable = (value: number) => (value === 1 ? "seatOne" : "seatTwo")

  return [
    {
      name: "playerControls",
      key: seat,
      observes: [seatObservable(seat)],
      batch: "game",
      strategy: "morph",
    },
    {
      name: "player",
      key: seat,
      observes: [seatObservable(seat)],
      batch: "game",
      strategy: "morph",
    },
    {
      name: "player",
      key: opponentSeat,
      observes: [seatObservable(opponentSeat)],
      batch: "game",
      strategy: "morph",
    },
    {
      name: "librarySearch",
      key: seat,
      observes: [seatObservable(seat)],
      batch: "game",
      strategy: "replace",
    },
    {
      name: "gameResult",
      observes: ["lifeTotals"],
      batch: "game",
      strategy: "replace",
    },
    {
      name: "tableStatus",
      observes: [seatObservable(seat), seatObservable(opponentSeat)],
      batch: "game",
      strategy: "replace",
    },
  ]
}

function componentSlot(options: {
  name: ComponentName
  key?: string | number
  context: ComponentRenderContext
}): string {
  const target = componentTargetId({ name: options.name, ...(options.key === undefined ? {} : { key: options.key }) })
  const rendered = renderComponent({
    name: options.name,
    key: options.key === undefined ? undefined : String(options.key),
    context: options.context,
  })

  return `<div id="${attribute(target)}" data-component-target>${rendered}</div>`
}
