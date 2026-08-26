import {
  SolidObjectsBrowserClient,
  SolidObjectsComponentRegistry,
} from "/vendor/live/browser/index.js"
import { renderComponent } from "/shared/server/render/components.ts"
import { cardPoint, dragOffset, dragPosition, rotationFromTransform } from "./drag-math.js"
import { morph } from "./morph.js"

const MIRROR_COMPONENTS = ["player", "playerControls", "librarySearch"]
const SETTLE_INTERVAL_MILLISECONDS = 1000
const FALLBACK_DELAY_MILLISECONDS = 6000
const FALLBACK_RETRY_MILLISECONDS = 3000
const FALLBACK_TIMEOUT_MILLISECONDS = 25000
const TOOLTIP_DELAY_MILLISECONDS = 90
const TAP_SLOP_PIXELS = 10
const COUNTER_GRAB = { x: 18, y: 12 }
const DECK_COLORS = ["W", "U", "B", "R", "G", "C"]

const game = document.querySelector("[data-game]")
if (game) start(game)

let mirror = null

function start(game) {
  const actorType = game.dataset.tableType
  const actorId = game.dataset.tableCode
  const declarations = JSON.parse(game.dataset.components)
  const seat = Number(game.dataset.seat)
  const currentPlayerId = game.dataset.currentPlayerId
  const workerUrl = game.dataset.workerUrl

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
      if (mirror?.owns(component.target)) return

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

  const fallback = createChangeFallback({ actorId, registry })

  const client = new SolidObjectsBrowserClient({
    url,
    createWebSocket: (target) => {
      const socket = new WebSocket(target)
      socket.addEventListener("open", () => {
        fallback.stop()
        setConnectionState("connected")
      })
      socket.addEventListener("close", () => {
        fallback.startLater()
        setConnectionState("reconnecting")
      })
      return socket
    },
    onInvalidation: (envelope) => {
      fallback.observe(envelope)
      setConnectionState("connected")
      registry.invalidate(envelope)
      void mirror?.reconcile()
    },
    onPayload: () => {
      setConnectionState("connected")
    },
    onError: () => {
      fallback.startLater()
      setConnectionState("reconnecting")
    },
  })

  fallback.startLater()

  window.addEventListener("offline", () => setConnectionState("offline"))
  window.addEventListener("online", () => setConnectionState("reconnecting"))

  client.subscribe({ actorType, actorId, payloads: ["game"] })
  client.connect()

  void startMirror({ actorId, seat, currentPlayerId, workerUrl }).then((started) => {
    mirror = started
  })

  wireActions(game, actorId)
  wireDeckForms(game, actorId)
  wireCardPreview()
  wireLibraryFilter()
  wireCopyButton()
  wireTooltips()
}

async function startMirror({ actorId, seat, currentPlayerId, workerUrl }) {
  if (!workerUrl || !currentPlayerId || !window.Worker) return null

  try {
    const worker = new Worker(workerUrl, { type: "module" })
    const send = workerSender(worker)
    await send({ command: "start", roomCode: actorId, playerId: currentPlayerId })

    const targets = new Set(MIRROR_COMPONENTS.map((name) => `component-${name}-${seat}`))
    let payload = await fetchState(actorId)
    const own = ownPlayer({ payload, currentPlayerId })
    if (!own) throw new Error("this session holds no seat at the table")

    let settling = 0

    const mirror = {
      owns: (target) => targets.has(target),
      apply: async (action) => {
        const state = await send({ command: "apply", action })
        draw({ state, payload, actorId, seat })
        settle()
        return state
      },
      reconcile: async () => {
        payload = await fetchState(actorId)
        const player = ownPlayer({ payload, currentPlayerId })
        if (!player) return null

        const state = await send({ command: "reconcile", player })
        draw({ state, payload, actorId, seat })
        if (state.pendingCount === 0) stopSettling()
        return state
      },
    }

    function settle() {
      if (settling) return
      settling = window.setInterval(() => {
        void mirror.reconcile().catch(() => undefined)
      }, SETTLE_INTERVAL_MILLISECONDS)
    }

    function stopSettling() {
      window.clearInterval(settling)
      settling = 0
    }

    const seeded = await send({ command: "seed", player: own })
    draw({ state: seeded, payload, actorId, seat, currentPlayerId })
    return mirror
  } catch {
    showToast("This table runs without a local move queue.")
    return null
  }
}

function workerSender(worker) {
  return (request) =>
    new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const onMessage = (event) => {
        if (event.data.requestId !== requestId) return
        worker.removeEventListener("message", onMessage)
        if (event.data.ok) return resolve(event.data.value)
        reject(new Error(event.data.message))
      }
      worker.addEventListener("message", onMessage)
      worker.postMessage({ requestId, ...request })
    })
}

async function fetchState(actorId) {
  const response = await fetch(`/api/tables/${actorId}/state`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  })
  if (!response.ok) throw new Error(`the table state is unavailable (${response.status})`)
  return response.json()
}

function ownPlayer({ payload, currentPlayerId }) {
  return payload?.space?.players.find((player) => player.id === currentPlayerId) ?? null
}

function draw({ state, payload, actorId, seat }) {
  if (!state?.player || !payload?.space) return

  const context = {
    payload: {
      ...payload,
      space: {
        ...payload.space,
        players: payload.space.players.map((player) =>
          player.id === state.player.id ? state.player : player,
        ),
      },
    },
    roomCode: actorId,
    seat,
    shareUrl: window.location.href,
  }

  for (const name of MIRROR_COMPONENTS) {
    const target = document.getElementById(`component-${name}-${seat}`)
    if (!target) continue
    morph(target, renderComponent({ name, key: String(seat), context }))
  }

  showQueuedMoves(state.pendingCount)
}

function showQueuedMoves(pendingCount) {
  const element = document.querySelector("[data-queued-moves]")
  if (!element) return

  element.hidden = pendingCount === 0
  element.textContent = pendingCount === 1 ? "1 move waiting" : `${pendingCount} moves waiting`
}

function createChangeFallback({ actorId, registry }) {
  let revision = "0"
  let running = false
  let timer = 0

  const observe = (envelope) => {
    if (BigInt(envelope.revision) > BigInt(revision)) revision = String(envelope.revision)
  }

  const stop = () => {
    window.clearTimeout(timer)
    timer = 0
    running = false
  }

  const startLater = () => {
    if (running || timer) return
    timer = window.setTimeout(() => {
      timer = 0
      running = true
      void poll()
    }, FALLBACK_DELAY_MILLISECONDS)
  }

  const poll = async () => {
    while (running) {
      const waited = await pollOnce()
      if (!running) return
      if (waited) continue

      await new Promise((resolve) => window.setTimeout(resolve, FALLBACK_RETRY_MILLISECONDS))
    }
  }

  const pollOnce = async () => {
    const query = `since=${encodeURIComponent(revision)}&timeout=${FALLBACK_TIMEOUT_MILLISECONDS}`
    try {
      const response = await fetch(`/api/tables/${actorId}/changes?${query}`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      })
      if (response.status === 204) return true
      if (!response.ok) return false

      const envelope = await response.json()
      observe(envelope)
      registry.invalidate(envelope)
      void mirror?.reconcile()
      setConnectionState("connected")
      return true
    } catch {
      return false
    }
  }

  return { observe, stop, startLater }
}

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
  if (mirror) return queueAction(action)

  return postAction(actorId, action, gestureKey)
}

async function queueAction(action) {
  try {
    await mirror.apply(action)
    return true
  } catch {
    showToast("That action was not accepted. Try again.")
    return false
  }
}

async function postAction(actorId, action, gestureKey) {
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
    const frame = cardFrame(counter.closest(".battlefield-card"))
    const grab = cardPoint({ pointer: { x: event.clientX, y: event.clientY }, frame })
    drag = {
      kind: "counter",
      element: counter,
      instanceId: counter.dataset.instanceId,
      counterId: counter.dataset.counterId,
      frame,
      offset: { x: grab.x - counter.offsetLeft, y: grab.y - counter.offsetTop },
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

  const position = positionFor({ held: drag, event })
  drag.element.style.left = `${position.left}px`
  drag.element.style.top = `${position.top}px`
}

function positionFor(options) {
  const { held, event } = options
  const pointer = { x: event.clientX, y: event.clientY }
  if (held.kind !== "counter") {
    return dragPosition({ pointer, canvas: held.canvas, offset: held.offset })
  }

  const point = cardPoint({ pointer, frame: held.frame })
  return {
    left: Math.max(0, Math.round(point.x - held.offset.x)),
    top: Math.max(0, Math.round(point.y - held.offset.y)),
  }
}

function cardFrame(card) {
  const rectangle = card.getBoundingClientRect()

  return {
    center: {
      x: rectangle.left + rectangle.width / 2,
      y: rectangle.top + rectangle.height / 2,
    },
    size: { width: card.offsetWidth, height: card.offsetHeight },
    rotation: rotationFromTransform(window.getComputedStyle(card).transform),
  }
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

    const point = cardPoint({
      pointer: { x: event.clientX, y: event.clientY },
      frame: cardFrame(card),
    })
    return void sendAction(actorId, {
      type: "addCounter",
      instanceId: card.dataset.instanceId,
      counterId: crypto.randomUUID(),
      x: Math.max(0, Math.round(point.x - COUNTER_GRAB.x)),
      y: Math.max(0, Math.round(point.y - COUNTER_GRAB.y)),
      label: "+1/+1",
    })
  }

  const position = positionFor({ held: current, event })

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
