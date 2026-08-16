import {
  SolidObjectsBrowserClient,
  SolidObjectsComponentRegistry,
} from "/vendor/solid-objects/browser/index.js"

const playmat = document.querySelector("[data-playmat]")
if (playmat) start(playmat)

function start(playmat) {
  const actorType = playmat.dataset.actorType
  const actorId = playmat.dataset.actorId
  const declarations = JSON.parse(playmat.dataset.components)

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
    onError: () => setConnectionState("Refresh failed; retrying on the next change"),
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

  const url = new URL("/solid-objects", window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("roomCode", actorId)

  const client = new SolidObjectsBrowserClient({
    url,
    onInvalidation: (envelope) => {
      applyVersion(envelope.observables.version)
      setConnectionState("Live via Solid Objects")
      registry.invalidate(envelope)
    },
    onPayload: (envelope) => {
      if (envelope.name !== "playmat") return
      applyVersion(envelope.payload?.space?.version)
    },
    onError: () => setConnectionState("Reconnecting…"),
  })

  client.subscribe({ actorType, actorId, payloads: ["playmat"] })
  client.connect()

  wireActions(playmat, actorId)
  wireDeckForms(playmat, actorId)
  wireCardPreview()
  wireLibraryFilter()
  wireCopyButton()
}

function targetIdFor(declaration) {
  return declaration.key === undefined
    ? `component-${declaration.name}`
    : `component-${declaration.name}-${declaration.key}`
}

function applyVersion(version) {
  if (typeof version !== "number") return
  const playmat = document.querySelector("[data-playmat]")
  if (!playmat) return
  playmat.dataset.roomVersion = String(version)
  const label = playmat.querySelector("[data-room-version-label]")
  if (label) label.textContent = String(version)
}

function setConnectionState(message) {
  const element = document.querySelector("[data-connection-state]")
  if (element) element.textContent = message
}

function morph(target, rendered) {
  const next = document.createElement("div")
  next.innerHTML = rendered
  if (target.innerHTML === next.innerHTML) return

  const activeId = document.activeElement?.id
  target.innerHTML = next.innerHTML
  if (activeId) document.getElementById(activeId)?.focus()
}

function wireActions(playmat, actorId) {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-playmat-action]")
    if (!button) return

    event.preventDefault()
    button.disabled = true
    try {
      await sendAction(actorId, JSON.parse(button.dataset.playmatAction))
    } finally {
      button.disabled = false
    }
  })

  document.addEventListener("pointerdown", (event) => beginDrag(event, playmat))
  document.addEventListener("pointermove", moveDrag)
  document.addEventListener("pointerup", (event) => finishDrag(event, actorId))
  document.addEventListener("pointercancel", cancelDrag)
}

async function sendAction(actorId, action) {
  const response = await fetch(`/api/spaces/${actorId}/actions`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", prefer: "respond-async" },
    body: JSON.stringify({ action }),
  })
  if (!response.ok) setConnectionState("The last action was refused")
}

let drag = null

function beginDrag(event, playmat) {
  const palette = event.target.closest("[data-counter-palette]")
  if (palette) {
    drag = { kind: "counterPalette" }
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
      origin: card.getBoundingClientRect(),
    }
    counter.setPointerCapture(event.pointerId)
    return
  }

  const card = event.target.closest(".battlefield-card")
  if (!card || event.target.closest("button, .counter-chip")) return
  if (!belongsToCurrentPlayer(card, playmat)) return

  const canvas = card.closest(".battlefield-canvas")
  const cardRectangle = card.getBoundingClientRect()
  drag = {
    kind: "card",
    element: card,
    instanceId: card.dataset.instanceId,
    origin: canvas.getBoundingClientRect(),
    offsetX: event.clientX - cardRectangle.left,
    offsetY: event.clientY - cardRectangle.top,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  }
  card.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function moveDrag(event) {
  if (!drag || drag.kind === "counterPalette") return

  const position = dragPosition(event)
  if (drag.kind === "card") {
    const travelled = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY)
    if (!drag.moved && travelled < 3) return
    drag.moved = true
  }
  drag.element.style.left = `${position.x}px`
  drag.element.style.top = `${position.y}px`
}

function dragPosition(event) {
  return {
    x: Math.max(0, event.clientX - drag.origin.left - (drag.offsetX ?? 18)),
    y: Math.max(0, event.clientY - drag.origin.top - (drag.offsetY ?? 12)),
  }
}

function finishDrag(event, actorId) {
  if (!drag) return

  const current = drag
  drag = null

  if (current.kind === "counterPalette") {
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest(".battlefield-card")
    if (!card) return
    const rectangle = card.getBoundingClientRect()
    return void sendAction(actorId, {
      type: "addCounter",
      instanceId: card.dataset.instanceId,
      x: Math.max(0, event.clientX - rectangle.left - 18),
      y: Math.max(0, event.clientY - rectangle.top - 12),
      label: "+1/+1",
    })
  }

  drag = current
  const position = dragPosition(event)
  drag = null

  if (current.kind === "counter") {
    return void sendAction(actorId, {
      type: "moveCounter",
      instanceId: current.instanceId,
      counterId: current.counterId,
      x: position.x,
      y: position.y,
    })
  }

  if (!current.moved) {
    return void sendAction(actorId, { type: "toggleTap", instanceId: current.instanceId })
  }

  void sendAction(actorId, {
    type: "moveBattlefieldCard",
    instanceId: current.instanceId,
    x: position.x,
    y: position.y,
  })
}

function cancelDrag() {
  drag = null
}

function belongsToCurrentPlayer(card, playmat) {
  return card.closest(".player-section")?.dataset.currentPlayer === "true" && Boolean(playmat)
}

function wireDeckForms(playmat, actorId) {
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
  button.className = "deck-result"
  button.dataset.deckId = String(deck.id)
  button.textContent = `${deck.name} · ${deck.size} cards · ${deck.ownerName}`
  return button
}

async function loadDeck(actorId, deckId) {
  if (!deckId) return

  const response = await fetch(`/api/spaces/${actorId}/deck`, {
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
