import { attribute, escapeHtml, jsonAttribute } from "./escape.ts"
import type { GameAction } from "../../game/action.ts"
import type {
  PublicBattlefieldCard,
  PublicCard,
  PublicPlayer,
  PublicRoom,
  RoomPayload,
} from "../../game/types.ts"

export const COMPONENT_NAMES = ["player", "playerControls", "librarySearch", "gameResult"] as const

export type ComponentName = (typeof COMPONENT_NAMES)[number]

export type ComponentRenderContext = {
  payload: RoomPayload
  roomCode: string
  seat: number
}

export function isComponentName(value: unknown): value is ComponentName {
  return COMPONENT_NAMES.includes(value as ComponentName)
}

export function renderComponent(options: {
  name: ComponentName
  key: string | undefined
  context: ComponentRenderContext
}): string {
  const { name, key, context } = options
  switch (name) {
    case "player":
      return renderPlayer({ context, seat: Number(key ?? context.seat) })
    case "playerControls":
      return renderPlayerControls(context)
    case "librarySearch":
      return renderLibrarySearch(context)
    case "gameResult":
      return renderGameResult(context)
  }
}

export function componentTargetId(options: { name: ComponentName; key?: string | number }): string {
  return options.key === undefined
    ? `component-${options.name}`
    : `component-${options.name}-${options.key}`
}

function playerAt(options: { room: PublicRoom | null; seat: number }): PublicPlayer | undefined {
  return options.room?.players.find((player) => player.seat === options.seat)
}

function renderPlayer(options: { context: ComponentRenderContext; seat: number }): string {
  const { context, seat } = options
  const player = playerAt({ room: context.payload.space, seat })
  if (!player) return ""

  const isCurrentPlayer = player.id === context.payload.currentPlayerId
  const classes = ["player-section", isCurrentPlayer ? "your-seat" : "opponent-seat"].join(" ")

  return `<section class="${classes}" data-player-id="${attribute(player.id)}" data-current-player="${isCurrentPlayer}">
  ${renderPlayerHeader({ player, isCurrentPlayer })}
  ${renderZoneSummary(player)}
  ${isCurrentPlayer ? renderHand(player) : ""}
  ${renderBattlefield({ player, isCurrentPlayer })}
  ${renderZoneLanes({ player, isCurrentPlayer })}
</section>`
}

function renderPlayerHeader(options: { player: PublicPlayer; isCurrentPlayer: boolean }): string {
  const { player, isCurrentPlayer } = options
  const searching =
    !isCurrentPlayer && player.isSearchingDeck
      ? `<span class="searching-indicator">Looking through library…</span>`
      : ""

  return `<header class="player-header">
  <div class="player-header-name"><strong>${escapeHtml(player.name)}</strong>${searching}</div>
  <div class="life-controls">
    ${isCurrentPlayer ? actionButton({ action: { type: "adjustLife", delta: -1 }, label: "−" }) : ""}
    <span class="life-value">${player.life}</span>
    ${isCurrentPlayer ? actionButton({ action: { type: "adjustLife", delta: 1 }, label: "+" }) : ""}
    ${isCurrentPlayer ? actionButton({ action: { type: "resetLife" }, label: "Reset" }) : ""}
  </div>
</header>`
}

function renderZoneSummary(player: PublicPlayer): string {
  const zones = ["library", "hand", "graveyard", "exile"] as const
  const counts = zones
    .map((zone) => {
      const label = zone[0]?.toUpperCase() + zone.slice(1)
      return `<span data-zone-count="${zone}" data-zone-label="${label}" data-count="${player[zone].length}">${label} ${player[zone].length}</span>`
    })
    .join("")

  return `<div class="zone-summary"><span>Deck: ${escapeHtml(player.deckName ?? "not loaded")}</span>${counts}</div>`
}

function renderHand(player: PublicPlayer): string {
  const cards = [...player.hand]
    .reverse()
    .map((card) =>
      actionButton({
        action: { type: "playFromHand", instanceId: card.instanceId },
        label: cardFace(card),
        className: "hand-card",
        preview: card,
      }),
    )
    .join("")

  return `<div class="hand-strip">${cards}</div>`
}

function renderBattlefield(options: {
  player: PublicPlayer
  isCurrentPlayer: boolean
}): string {
  const cards = options.player.battlefield
    .map((card) => renderBattlefieldCard({ card, isCurrentPlayer: options.isCurrentPlayer }))
    .join("")

  return `<div class="battlefield"><div class="battlefield-canvas" data-battlefield-player-id="${attribute(options.player.id)}">${cards}</div></div>`
}

function renderBattlefieldCard(options: {
  card: PublicBattlefieldCard
  isCurrentPlayer: boolean
}): string {
  const { card, isCurrentPlayer } = options
  const tools = isCurrentPlayer ? renderCardTools(card) : ""
  const counters = card.counters
    .map((counter) => {
      const controls = isCurrentPlayer
        ? actionButton({
            action: {
              type: "updateCounterValue",
              instanceId: card.instanceId,
              counterId: counter.id,
              delta: -1,
            },
            label: "−",
          }) +
          actionButton({
            action: {
              type: "updateCounterValue",
              instanceId: card.instanceId,
              counterId: counter.id,
              delta: 1,
            },
            label: "+",
          })
        : ""
      return `<div class="counter-chip" data-counter-id="${attribute(counter.id)}" data-instance-id="${attribute(card.instanceId)}" style="left:${counter.x}px;top:${counter.y}px">${controls}<span class="counter-value">${counter.value}</span></div>`
    })
    .join("")

  return `<div class="battlefield-card${card.tapped ? " tapped" : ""}" data-instance-id="${attribute(card.instanceId)}" ${previewAttributes(card)} style="left:${card.x}px;top:${card.y}px">
  <img loading="lazy" src="${attribute(card.imageUrl)}" alt="${attribute(card.name)}" />
  <div class="card-tools">${tools}</div>${counters}
</div>`
}

function renderCardTools(card: PublicBattlefieldCard): string {
  return [
    actionButton({
      action: {
        type: "moveCardZone",
        instanceId: card.instanceId,
        from: "battlefield",
        to: "hand",
      },
      label: "🖐️",
      className: "card-tool",
      title: "Move to hand",
    }),
    actionButton({
      action: {
        type: "moveToDeck",
        instanceId: card.instanceId,
        from: "battlefield",
        position: "shuffle",
      },
      label: "🔀",
      className: "card-tool",
      title: "Shuffle into library",
    }),
    actionButton({
      action: {
        type: "moveCardZone",
        instanceId: card.instanceId,
        from: "battlefield",
        to: "graveyard",
      },
      label: "🪦",
      className: "card-tool",
      title: "Move to graveyard",
    }),
    actionButton({
      action: {
        type: "moveCardZone",
        instanceId: card.instanceId,
        from: "battlefield",
        to: "exile",
      },
      label: "✨",
      className: "card-tool",
      title: "Move to exile",
    }),
  ].join("")
}

function renderZoneLanes(options: { player: PublicPlayer; isCurrentPlayer: boolean }): string {
  const lanes = (["graveyard", "exile"] as const)
    .map((zone) => {
      const label = zone[0]?.toUpperCase() + zone.slice(1)
      const cards = [...options.player[zone]]
        .reverse()
        .map((card, index) => {
          const topBadge =
            zone === "graveyard" && index === 0 ? `<em class="zone-top-badge">TOP</em>` : ""
          const className = `zone-card-chip${zone === "graveyard" && index === 0 ? " top-zone-card" : ""}`
          if (!options.isCurrentPlayer) {
            return `<div class="${className} read-only" ${previewAttributes(card)}>${cardFace(card)}${topBadge}</div>`
          }
          return actionButton({
            action: {
              type: "moveCardZone",
              instanceId: card.instanceId,
              from: zone,
              to: "battlefield",
              x: 48,
              y: 48,
            },
            label: `${cardFace(card)}${topBadge}`,
            className,
            preview: card,
          })
        })
        .join("")

      return `<div class="zone-lane"><span class="zone-lane-label">${label}</span><div class="zone-lane-cards">${cards}</div></div>`
    })
    .join("")

  return `<div class="zone-lanes">${lanes}</div>`
}

function renderPlayerControls(context: ComponentRenderContext): string {
  const player = playerAt({ room: context.payload.space, seat: context.seat })
  if (!player || player.id !== context.payload.currentPlayerId) return ""

  const deckPanel = player.deckName
    ? `<div class="selected-deck-panel">
        <h4>Loaded deck</h4>
        <p class="deck-name">${escapeHtml(player.deckName)}</p>
        <p class="selected-deck-meta">
          <span>Library ${player.library.length} cards</span>
          <span>Hand ${player.hand.length} · Graveyard ${player.graveyard.length} · Exile ${player.exile.length}</span>
        </p>
      </div>
      <div class="controls-block">
        <h4>Card actions</h4>
        <div class="button-row">
          ${actionButton({ action: { type: "drawCard", count: 1 }, label: "Draw" })}
          ${actionButton({ action: { type: "shuffleLibrary" }, label: "Shuffle" })}
          ${actionButton({ action: { type: "untapAll" }, label: "Untap all" })}
          ${actionButton({ action: { type: "openDeckSearch" }, label: "Search library" })}
        </div>
      </div>
      <div class="controls-block">
        <h4>Counter token</h4>
        <p class="hint">Drag this onto a battlefield card.</p>
        <div class="counter-palette-token" data-counter-palette>+1/+1</div>
      </div>`
    : ""

  const status =
    player.deckStatus === "loading"
      ? `<p class="deck-status">Loading the deck…</p>`
      : player.deckStatus === "failed"
        ? `<p class="deck-status deck-status-failed">The deck could not be loaded. Try again.</p>`
        : ""

  return `<aside class="left-rail panel">
  <details class="deck-browser"${player.deckName ? "" : " open"}>
    <summary>${player.deckName ? "Change deck" : "Choose a deck"}</summary>
    <form class="deck-search-row" data-deck-search>
      <input type="search" name="q" placeholder="Search Archidekt decks" minlength="2" required />
      <button type="submit">Search</button>
    </form>
    <div class="search-term-row">
      ${["oldschool", "commander", "cedh", "modern", "legacy", "pauper"]
        .map((term) => `<button type="button" class="search-term-chip" data-deck-term="${term}">${term}</button>`)
        .join("")}
    </div>
    <div class="deck-results" data-deck-results></div>
    <form class="deck-load-row" data-deck-load>
      <input type="text" name="deckId" placeholder="Archidekt deck ID or URL" required />
      <button type="submit">Load deck</button>
    </form>
  </details>
  ${status}
  ${deckPanel}
</aside>`
}

function renderLibrarySearch(context: ComponentRenderContext): string {
  const player = playerAt({ room: context.payload.space, seat: context.seat })
  if (!player || player.id !== context.payload.currentPlayerId) return ""
  if (!player.isSearchingDeck) return ""

  const cards = player.library
    .map((card) =>
      actionButton({
        action: { type: "moveLibraryCardToHand", instanceId: card.instanceId },
        label: cardFace(card),
        className: "library-search-item",
        preview: card,
        libraryCardName: card.name.toLowerCase(),
      }),
    )
    .join("")

  return `<div class="modal-overlay">
  <section class="modal-card library-search-modal-card" role="dialog" aria-modal="true">
    <h3>Search library</h3>
    <p>Choose a card to move it from your library to your hand.</p>
    <input type="search" placeholder="Filter card names" data-library-filter />
    <div class="library-search-list">${cards}</div>
    ${actionButton({ action: { type: "closeDeckSearch" }, label: "Close", className: "modal-cancel-button" })}
  </section>
</div>`
}

function renderGameResult(context: ComponentRenderContext): string {
  const room = context.payload.space
  if (!room) return ""

  const current = room.players.find((player) => player.seat === context.seat)
  const opponents = room.players.filter((player) => player.seat !== context.seat)
  if (current && current.life <= 0) {
    return `<div class="game-result-banner lose" aria-live="polite"><p class="game-result-banner-text">YOU LOSE</p></div>`
  }
  if (opponents.some((player) => player.life <= 0)) {
    return `<div class="game-result-banner win" aria-live="polite"><p class="game-result-banner-text">YOU WIN</p></div>`
  }
  return ""
}

function actionButton(options: {
  action: GameAction
  label: string
  className?: string
  title?: string
  preview?: PublicCard
  libraryCardName?: string
}): string {
  const className = options.className ? ` class="${attribute(options.className)}"` : ""
  const title = options.title ? ` title="${attribute(options.title)}"` : ""
  const preview = options.preview ? ` ${previewAttributes(options.preview)}` : ""
  const filter = options.libraryCardName
    ? ` data-library-card-name="${attribute(options.libraryCardName)}"`
    : ""

  return `<button type="button"${className}${title}${preview}${filter} data-game-action="${jsonAttribute(options.action)}">${options.label}</button>`
}

function previewAttributes(card: PublicCard): string {
  return `data-preview-image="${attribute(card.imageUrl)}" data-preview-name="${attribute(card.name)}"`
}

function cardFace(card: PublicCard): string {
  const image = card.imageUrl
    ? `<img loading="lazy" src="${attribute(card.imageUrl)}" alt="${attribute(card.name)}" />`
    : `<span class="hidden-card-face"></span>`
  return `${image}<span>${escapeHtml(card.name)}</span>`
}
