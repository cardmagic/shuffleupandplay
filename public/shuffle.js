import {
  SolidObjectsBrowserClient,
  SolidObjectsComponentRegistry,
} from "/vendor/live/browser/index.js"
import { dragOffset, dragPosition } from "./drag-math.js"
import { morph } from "./morph.js"

const game = document.querySelector("[data-game]")
if (game) start(game)

function start(game) {
  const actorType = game.dataset.tableType
  const actorId = game.dataset.tableCode
  const declarations = JSON.parse(game.dataset.components)

  const registry = new SolidObjectsComponentRegistry({
    refresh: async ({ actorType, actorId, instanceId, revision, batch, components, signal }) => {
      const response = await fetch("/api/components/refresh", {
        method: "POST",
        signal,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorType, actorId, instanceId, revision, batch, components }),
      })
      if (!response.ok) throw new Error(`component refresh failed with ${response.status}`)
      return response.json()
    },
    apply: ({ component, rendered }) => {
      const target = document.getElementById(component.target)
      if (!target) return
      if (component.strategy === "morph") return morph(target, rendered)
      target.innerHTML = rendered
    },
    onError: () => showToast("The table could not refresh. It retries on the next change."),
  })

  for (const declaration of declarations) {
    registry.register({
      actorType,
      actorId,
      target: targetIdFor(declaration),
      name: declaration.name,
      ...(declaration.key === undefined ? {} : { key: declaration.key }),
      observes: declaration.observes,
      ...(declaration.batch === undefined ? {} : { batch: declaration.batch }),
      strategy: declaration.strategy,
    })
  }

  const url = new URL("/live", window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("roomCode", actorId)

  const client = new SolidObjectsBrowserClient({
    url,
    createWebSocket: (target) => {
      const socket = new WebSocket(target)
      socket.addEventListener("open", () => setConnectionState("connected"))
      socket.addEventListener("close", () => setConnectionState("reconnecting"))
      return socket
    },
    onInvalidation: (envelope) => {
      setConnectionState("connected")
      registry.invalidate(envelope)
    },
    onPayload: () => {
      setConnectionState("connected")
    },
    onError: () => setConnectionState("reconnecting"),
  })

  window.addEventListener("offline", () => setConnectionState("offline"))
  window.addEventListener("online", () => setConnectionState("reconnecting"))

  client.subscribe({ actorType, actorId, payloads: ["game"] })
  client.connect()

  wireActions(game, actorId)
  wireDeckForms(game, actorId)
  wireCardPreview()
  wireLibraryFilter()
  wireCopyButton()
  wireTooltips()
}

const TOOLTIP_DELAY_MILLISECONDS = 90

function wireTooltips() {
  let element = null
  let timer = 0

  const hide = () => {
    window.clearTimeout(timer)
    element?.remove()
    element = null
  }

  const show = (control) => {
    const text = control.dataset.tooltip
    if (!text) return

    hide()
    timer = window.setTimeout(() => {
      element = document.createElement("div")
      element.className = "tooltip"
      element.setAttribute("role", "presentation")
      element.textContent = text
      document.body.append(element)
      placeTooltip(element, control)
    }, TOOLTIP_DELAY_MILLISECONDS)
  }

  document.addEventListener("pointerover", (event) => {
    const control = event.target.closest?.("[data-tooltip]")
    if (control) return show(control)
    if (element) hide()
  })
  document.addEventListener("pointerdown", hide)
  document.addEventListener("focusin", (event) => {
    const control = event.target.closest?.("[data-tooltip]")
    if (control) show(control)
  })
  document.addEventListener("focusout", hide)
  window.addEventListener("scroll", hide, true)
}

function placeTooltip(element, control) {
  const anchor = control.getBoundingClientRect()
  const box = element.getBoundingClientRect()
  const margin = 8

  const left = Math.min(
    Math.max(margin, anchor.left + anchor.width / 2 - box.width / 2),
    window.innerWidth - box.width - margin,
  )
  const above = anchor.top - box.height - margin
  const top = above > margin ? above : anchor.bottom + margin

  element.style.left = `${Math.round(left)}px`
  element.style.top = `${Math.round(top)}px`
}

function targetIdFor(declaration) {
  return declaration.key === undefined
    ? `component-${declaration.name}`
    : `component-${declaration.name}-${declaration.key}`
}

const CONNECTION_LABELS = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  offline: "Offline — actions are unavailable",
}

let connectionState = "connecting"

function setConnectionState(state) {
  if (!CONNECTION_LABELS[state] || state === connectionState) return

  const previous = connectionState
  connectionState = state

  const element = document.querySelector("[data-connection-status]")
  if (element) {
    element.dataset.state = state
    const label = element.querySelector("[data-connection-label]")
    if (label) label.textContent = CONNECTION_LABELS[state]
  }

  if (state === "connected" && previous !== "connecting") showToast("Connection restored")
}

function showToast(message) {
  const region = document.querySelector("[data-toast-region]")
  if (!region) return

  const toast = document.createElement("p")
  toast.className = "toast"
  toast.textContent = message
  region.append(toast)
  window.setTimeout(() => toast.remove(), 4000)
}


function wireActions(game, actorId) {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-game-action]")
    if (!button) return

    event.preventDefault()
    button.disabled = true
    try {
      await sendAction(actorId, JSON.parse(button.dataset.gameAction))
    } finally {
      button.disabled = false
    }
  })

  document.addEventListener("pointerdown", (event) => beginDrag(event, game))
  document.addEventListener("pointermove", moveDrag)
  document.addEventListener("pointerup", (event) => finishDrag(event, actorId))
  document.addEventListener("pointercancel", cancelDrag)
}

async function sendAction(actorId, action, gestureKey = newGestureKey()) {
  const response = await fetch(`/api/tables/${actorId}/actions`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      prefer: "respond-async",
      "idempotency-key": gestureKey,
    },
    body: JSON.stringify({ action }),
  })
  if (!response.ok) showToast("That action was not accepted. Try again.")
  return response.ok
}

function newGestureKey() {
  return crypto.randomUUID()
}

const TAP_SLOP_PIXELS = 10
const DECK_COLORS = ["W", "U", "B", "R", "G", "C"]

let drag = null

function beginDrag(event, game) {
  const palette = event.target.closest("[data-counter-palette]")
  if (palette) {
    drag = { kind: "counterPalette", ghost: showCounterGhost(event, palette) }
    event.preventDefault()
    return
  }

  const counter = event.target.closest(".counter-chip")
  if (counter && !event.target.closest("button")) {
    const card = counter.closest(".battlefield-card")
    drag = {
      kind: "counter",
      element: counter,
      instanceId: counter.dataset.instanceId,
      counterId: counter.dataset.counterId,
      canvas: card.getBoundingClientRect(),
      offset: dragOffset({
        pointer: { x: event.clientX, y: event.clientY },
        canvas: card.getBoundingClientRect(),
        card: { left: counter.offsetLeft, top: counter.offsetTop },
      }),
    }
    counter.setPointerCapture(event.pointerId)
    return
  }

  const card = event.target.closest(".battlefield-card")
  if (!card || event.target.closest("button, .counter-chip")) return
  if (!belongsToCurrentPlayer(card, game)) return

  const canvas = card.closest(".battlefield-canvas").getBoundingClientRect()
  drag = {
    kind: "card",
    element: card,
    instanceId: card.dataset.instanceId,
    canvas,
    offset: dragOffset({
      pointer: { x: event.clientX, y: event.clientY },
      canvas,
      card: { left: card.offsetLeft, top: card.offsetTop },
    }),
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  }
  card.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function moveDrag(event) {
  if (!drag) return

  if (drag.kind === "counterPalette") {
    moveCounterGhost(drag.ghost, event)
    return
  }

  if (drag.kind === "card") {
    const travelled = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY)
    if (!drag.moved && travelled < TAP_SLOP_PIXELS) return
    if (!drag.moved) drag.element.classList.add("is-dragging")
    drag.moved = true
  }

  const position = currentDragPosition(event)
  drag.element.style.left = `${position.left}px`
  drag.element.style.top = `${position.top}px`
}

function currentDragPosition(event) {
  return dragPosition({
    pointer: { x: event.clientX, y: event.clientY },
    canvas: drag.canvas,
    offset: drag.offset,
  })
}

function showCounterGhost(event, palette) {
  const ghost = document.createElement("div")
  ghost.className = "counter-ghost"
  ghost.textContent = palette.textContent?.trim() || "+1/+1"
  ghost.setAttribute("aria-hidden", "true")
  document.body.append(ghost)
  moveCounterGhost(ghost, event)
  return ghost
}

function moveCounterGhost(ghost, event) {
  if (!ghost) return
  ghost.style.left = `${event.clientX}px`
  ghost.style.top = `${event.clientY}px`
}

function removeCounterGhost() {
  document.querySelector(".counter-ghost")?.remove()
}

function finishDrag(event, actorId) {
  if (!drag) return

  const current = drag
  drag = null
  current.element?.classList.remove("is-dragging")

  if (current.kind === "counterPalette") {
    removeCounterGhost()
    const card = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest(".battlefield-card")
    if (!card) return

    const rectangle = card.getBoundingClientRect()
    return void sendAction(actorId, {
      type: "addCounter",
      instanceId: card.dataset.instanceId,
      x: Math.max(0, Math.round(event.clientX - rectangle.left - 18)),
      y: Math.max(0, Math.round(event.clientY - rectangle.top - 12)),
      label: "+1/+1",
    })
  }

  const position = dragPosition({
    pointer: { x: event.clientX, y: event.clientY },
    canvas: current.canvas,
    offset: current.offset,
  })

  if (current.kind === "counter") {
    return void sendAction(actorId, {
      type: "moveCounter",
      instanceId: current.instanceId,
      counterId: current.counterId,
      x: position.left,
      y: position.top,
    })
  }

  if (!current.moved) {
    return void sendAction(actorId, { type: "toggleTap", instanceId: current.instanceId })
  }

  void sendAction(actorId, {
    type: "moveBattlefieldCard",
    instanceId: current.instanceId,
    x: position.left,
    y: position.top,
  })
}

function cancelDrag() {
  drag?.element?.classList.remove("is-dragging")
  removeCounterGhost()
  drag = null
}

function belongsToCurrentPlayer(card, game) {
  return card.closest(".player-section")?.dataset.currentPlayer === "true" && Boolean(game)
}

function wireDeckForms(game, actorId) {
  document.addEventListener("submit", async (event) => {
    const searchForm = event.target.closest("[data-deck-search]")
    if (searchForm) {
      event.preventDefault()
      await runDeckSearch(new FormData(searchForm).get("q"))
      return
    }

    const loadForm = event.target.closest("[data-deck-load]")
    if (!loadForm) return

    event.preventDefault()
    await loadDeck(actorId, new FormData(loadForm).get("deckId"))
  })

  document.addEventListener("click", async (event) => {
    const term = event.target.closest("[data-deck-term]")
    if (term) return void runDeckSearch(term.dataset.deckTerm)

    const result = event.target.closest("[data-deck-id]")
    if (result) return void loadDeck(actorId, result.dataset.deckId)
  })
}

async function runDeckSearch(query) {
  const results = document.querySelector("[data-deck-results]")
  if (!results || !query) return

  results.textContent = "Searching…"
  const response = await fetch(`/api/archidekt/search?q=${encodeURIComponent(query)}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  })
  if (!response.ok) {
    results.textContent = "Archidekt is unavailable"
    return
  }

  const { decks } = await response.json()
  results.replaceChildren(...decks.slice(0, 40).map(deckResultElement))
}

function deckResultElement(deck) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "deck-result-item"
  button.dataset.deckId = String(deck.id)
  button.append(deckCoverElement(deck), deckContentElement(deck))
  return button
}

function deckCoverElement(deck) {
  const source = safeImageUrl(deck.featuredUrl)
  if (!source) {
    const placeholder = document.createElement("span")
    placeholder.className = "deck-result-cover"
    return placeholder
  }

  const cover = document.createElement("img")
  cover.className = "deck-result-cover"
  cover.loading = "lazy"
  cover.alt = ""
  cover.src = source
  return cover
}

function deckContentElement(deck) {
  const content = document.createElement("span")
  content.className = "deck-result-content"

  const name = document.createElement("strong")
  name.textContent = deck.name

  const meta = document.createElement("span")
  meta.className = "meta"
  meta.textContent = [deck.ownerName, `${deck.size} cards`, deck.updatedAt]
    .filter((part) => part)
    .join(" · ")

  content.append(name, meta, deckColorBar(deck.colorBands))
  return content
}

function deckColorBar(bands) {
  const bar = document.createElement("span")
  bar.className = "deck-color-bar"

  const usable = Array.isArray(bands) ? bands.filter((band) => band.weight > 0) : []
  if (usable.length === 0) {
    bar.append(deckColorSegment("C", 100))
    return bar
  }

  const total = usable.reduce((sum, band) => sum + band.weight, 0)
  for (const band of usable) {
    bar.append(deckColorSegment(band.color, (band.weight / total) * 100))
  }
  return bar
}

function deckColorSegment(color, percent) {
  const known = DECK_COLORS.includes(color) ? color : "C"
  const segment = document.createElement("span")
  segment.className = `deck-color-segment color-${known}`
  segment.style.width = `${percent}%`
  segment.textContent = known
  return segment
}

function safeImageUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}

async function loadDeck(actorId, deckId) {
  if (!deckId) return

  const response = await fetch(`/api/tables/${actorId}/deck`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ deckId }),
  })
  setConnectionState(response.ok ? "Loading the deck…" : "The deck could not be requested")
}

function wireCardPreview() {
  const show = (event) => {
    const element = event.target.closest?.("[data-preview-image]")
    const preview = document.getElementById("card-hover-preview")
    if (!element || !preview) return

    const image = document.getElementById("card-hover-preview-image")
    const name = document.getElementById("card-hover-preview-name")
    image.src = element.dataset.previewImage
    image.alt = element.dataset.previewName ?? "Card preview"
    name.textContent = element.dataset.previewName ?? ""
    preview.classList.add("is-visible")
  }
  const hide = () => document.getElementById("card-hover-preview")?.classList.remove("is-visible")

  document.addEventListener("mouseover", show)
  document.addEventListener("focusin", show)
  document.addEventListener("mouseout", hide)
  document.addEventListener("focusout", hide)
}

function wireLibraryFilter() {
  document.addEventListener("input", (event) => {
    if (!event.target.matches("[data-library-filter]")) return

    const query = event.target.value.trim().toLowerCase()
    for (const card of document.querySelectorAll("[data-library-card-name]")) {
      card.hidden = !card.dataset.libraryCardName.includes(query)
    }
  })
}

function wireCopyButton() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-text]")
    if (!button) return

    await navigator.clipboard.writeText(button.dataset.copyText)
    const original = button.textContent
    button.textContent = "Copied"
    window.setTimeout(() => {
      button.textContent = original
    }, 1400)
  })
}
