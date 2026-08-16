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
import type { RoomPayload } from "../../game/types.ts"

const PUBLIC_DIRECTORY = resolve(import.meta.dirname, "../../../public")
const ASSET_NAMES = ["application.css", "shuffle.js"] as const

const ASSET_URLS: Record<string, string> = Object.fromEntries(
  ASSET_NAMES.map((name) => [name, `/assets/${name}?v=${fingerprint(name)}`]),
)

function fingerprint(name: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(PUBLIC_DIRECTORY, name)))
    .digest("hex")
    .slice(0, 12)
}

export type ComponentDeclaration = {
  name: ComponentName
  key?: string | number
  observes: readonly string[]
  batch?: string
  strategy: "replace" | "morph"
}

export function layout(options: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(options.title)}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="stylesheet" href="${ASSET_URLS["application.css"]}" />
    <script type="module" src="${ASSET_URLS["shuffle.js"]}"></script>
  </head>
  <body>
    ${options.body}
    <aside id="card-hover-preview" class="card-hover-preview" aria-hidden="true">
      <img id="card-hover-preview-image" alt="Card preview" />
      <p id="card-hover-preview-name"></p>
    </aside>
  </body>
</html>`
}

export function lobbyPage(options: { joinCode: string | null; error: string | null }): string {
  const error = options.error ? `<p class="lobby-error">${escapeHtml(options.error)}</p>` : ""
  const createForm = options.joinCode
    ? ""
    : `<form class="stacked-form" method="post" action="/api/spaces">
        <h3>Create a new table</h3>
        <label for="createPlayerName">Your name</label>
        <input id="createPlayerName" name="playerName" maxlength="28" required autocomplete="name" />
        <label for="createSpaceName">Space name</label>
        <input id="createSpaceName" name="spaceName" maxlength="40" value="Gaming Table" />
        <button type="submit">Create space</button>
      </form>`

  return layout({
    title: "Shuffle Up and Play",
    body: `<main class="layout">
  <header class="topbar panel">
    <p class="eyebrow">Gaming table simulator</p>
    <h1>Shuffle Up and Play</h1>
    <p>Two-player shared table with Archidekt decks, live sync, and manual card control.</p>
  </header>
  ${error}
  <section class="panel lobby-panel">
    <h2>Start or join</h2>
    <div class="lobby-grid">
      ${createForm}
      <form class="stacked-form" method="post" action="/api/spaces/join">
        <h3>Join an existing table</h3>
        <label for="joinPlayerName">Your name</label>
        <input id="joinPlayerName" name="playerName" maxlength="28" required autocomplete="name" />
        <label for="joinSpaceCode">Space code</label>
        <input id="joinSpaceCode" name="spaceCode" maxlength="6" value="${attribute(options.joinCode ?? "")}" placeholder="ABC123" required autocapitalize="characters" />
        <button type="submit">Join space</button>
      </form>
    </div>
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
  }
  const declarations = componentDeclarations(options.seat)
  const opponentSeat = options.seat === 1 ? 2 : 1

  return layout({
    title: `Shuffle Up and Play · ${options.roomCode}`,
    body: `<main class="layout"
  data-game
  data-actor-type="${attribute(GameRoom.actorType)}"
  data-actor-id="${attribute(options.roomCode)}"
  data-room-version="${room.version}"
  data-current-player-id="${attribute(options.payload.currentPlayerId ?? "")}"
  data-seat="${options.seat}"
  data-components="${jsonAttribute(declarations)}"
>
  <section class="topbar-live-meta panel">
    <div class="space-title-row">
      <h2>${escapeHtml(room.name)} · ${escapeHtml(options.roomCode)}</h2>
      <button type="button" class="share-link-button" data-copy-text="${attribute(options.shareUrl)}">Copy share link</button>
    </div>
    <p>Share this code: ${escapeHtml(options.roomCode)} (version <span data-room-version-label>${room.version}</span>)</p>
    <div class="status-grid">
      <span>You are in seat ${options.seat}</span>
      <span data-connection-state>Connecting…</span>
    </div>
  </section>

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
