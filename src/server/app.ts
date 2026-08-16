import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, join, normalize, resolve } from "node:path"

import { Rejected, Unauthorized, type JsonObject, type SolidObjectsRuntime } from "solid-objects"
import {
  createDashboard,
  createNodeDashboardHandler,
  type DashboardAccess,
  type DashboardSession,
  type NodeDashboardHandler,
} from "solid-objects/web"

import { GameRoom, type GameViewer } from "../actors/game-room.ts"
import { extractDeckId } from "../archidekt/deck-id.ts"
import { generateRoomCode, normalizeRoomCode } from "../game/room-code.ts"
import type { RoomPayload } from "../game/types.ts"
import type { ShuffleApplication } from "../runtime.ts"
import {
  isRecord,
  PayloadTooLargeError,
  readBody,
  sendEmpty,
  sendHtml,
  sendJson,
  sendRedirect,
  type RequestContext,
} from "./http.ts"
import { createRateLimiter, type RateLimiter } from "./rate-limit.ts"
import { attachRealtime } from "./realtime.ts"
import {
  componentTargetId,
  isComponentName,
  renderComponent,
  type ComponentRenderContext,
} from "./render/components.ts"
import {
  ASSET_URLS,
  creditsPage,
  gamePage,
  isLobbyErrorCode,
  lobbyPage,
  notFoundPage,
  privacyPage,
  PRODUCT_DESCRIPTION,
  SITE_ORIGIN,
  type LobbyErrorCode,
} from "./render/pages.ts"
import {
  generateSessionId,
  readSessionCookie,
  sessionCookieHeader,
  SESSION_COOKIE_NAME,
} from "./session.ts"

const MAXIMUM_CODE_ATTEMPTS = 8

const REJECTION_STATUSES: Record<string, number> = {
  roomNotFound: 404,
  roomExists: 409,
  roomFull: 409,
  notAPlayer: 403,
  invalidAction: 400,
}

const STATIC_ROOTS: Record<string, string> = {
  "/assets/": resolve(import.meta.dirname, "../../public"),
  "/vendor/live/": resolve(import.meta.dirname, "../../node_modules/solid-objects/dist"),
}

const FINGERPRINT_PATTERN = /^(.*)\.[a-f0-9]{12}(\.[a-z0-9]+)$/

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
}

export type ShuffleServerOptions = {
  application: ShuffleApplication
  secret: string
  secureCookies?: boolean
  operatorDashboard?: ShuffleOperatorDashboardOptions
}

export type ShuffleOperatorDashboardOptions = {
  mountPath?: string
  access?: DashboardAccess
}

export type ShuffleServer = {
  server: Server
  listen(port: number): Promise<number>
  close(): Promise<void>
}

export function createShuffleServer(options: ShuffleServerOptions): ShuffleServer {
  const { application, secret } = options
  const runtime = application.runtime
  const secureCookies = options.secureCookies ?? false
  const limits: RequestLimits = {
    createTable: createRateLimiter({ limit: 10, windowMilliseconds: 60_000 }),
    joinTable: createRateLimiter({ limit: 20, windowMilliseconds: 60_000 }),
    loadDeck: createRateLimiter({ limit: 20, windowMilliseconds: 60_000 }),
    searchDecks: createRateLimiter({ limit: 30, windowMilliseconds: 60_000 }),
  }
  const requestSessions = new WeakMap<IncomingMessage, RequestSession>()
  const dashboardSessions = new Map<string, Map<string, string>>()
  const dashboardHandler = options.operatorDashboard
    ? createOperatorDashboardHandler({
        runtime,
        requestSessions,
        dashboardSessions,
        options: options.operatorDashboard,
      })
    : undefined

  const server = createServer((request, response) => {
    const method = request.method ?? "GET"
    const pathname = (request.url ?? "/").split("?")[0] ?? "/"
    const readMethod = method === "GET" || method === "HEAD"

    applySecurityHeaders({ response, secureCookies })

    if (readMethod && pathname === "/up") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      response.end("OK")
      return
    }

    if (readMethod) {
      void serveStaticAsset({ method, pathname, response }).then((served) => {
        if (served) return
        withSession()
      })
      return
    }

    withSession()

    function withSession(): void {
      const requestSession = resolveRequestSession({ request, secret, secureCookies })
      requestSessions.set(request, requestSession)
      if (requestSession.setCookies.length > 0) {
        response.setHeader("set-cookie", requestSession.setCookies)
      }

      const next = (error?: unknown) => {
        if (error) {
          respondToUnhandledError({ response, error })
          return
        }
        handle({ request, response, application, runtime, requestSession, limits }).catch((handleError) => {
          respondToUnhandledError({ response, error: handleError })
        })
      }
      if (dashboardHandler) {
        dashboardHandler(request, response, next)
        return
      }
      next()
    }
  })

  const realtime = attachRealtime({ server, runtime, secret })

  return {
    server,
    listen: (port) =>
      new Promise((resolveListen) => {
        server.listen(port, () => {
          const address = server.address()
          resolveListen(typeof address === "object" && address ? address.port : port)
        })
      }),
    close: async () => {
      await realtime.close()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      dashboardSessions.clear()
    },
  }
}

async function handle(options: {
  request: IncomingMessage
  response: ServerResponse
  application: ShuffleApplication
  runtime: SolidObjectsRuntime
  requestSession: RequestSession
  limits: RequestLimits
}): Promise<void> {
  const { request, response, application, runtime, requestSession, limits } = options
  const url = new URL(request.url ?? "/", requestOrigin(request))

  const context: RequestContext = {
    request,
    response,
    method: request.method ?? "GET",
    url,
    sessionId: requestSession.sessionId,
    setCookies: requestSession.setCookies,
  }

  try {
    await route({ context, application, runtime, limits })
  } catch (error) {
    respondToError({ context, error })
  }
}

async function route(options: {
  context: RequestContext
  application: ShuffleApplication
  runtime: SolidObjectsRuntime
  limits: RequestLimits
}): Promise<void> {
  const { context, application, runtime, limits } = options
  const path = context.url.pathname
  const method = context.method

  if (method === "GET" && path === "/") return showLobby(context)
  if (method === "GET" && path === "/manifest.webmanifest") return sendManifest(context)
  if (method === "GET" && path === "/robots.txt") return sendRobots(context)
  if (method === "GET" && path === "/.well-known/security.txt") return sendSecurityTxt(context)
  if (method === "GET" && path === "/privacy") return showPrivacy(context)
  if (method === "GET" && path === "/credits") return showCredits(context)

  if (method === "GET" && path.startsWith("/spaces/")) {
    return sendRedirect({ context, location: `/tables/${path.slice("/spaces/".length)}` })
  }
  if (method === "GET" && path.startsWith("/tables/")) {
    return showGame({ context, runtime, roomCode: path.slice("/tables/".length) })
  }
  if (method === "POST" && (path === "/api/tables" || path === "/api/spaces")) {
    if (!allows({ context, limiter: limits.createTable })) return sendTooManyRequests(context)
    return createSpace({ context, runtime })
  }
  if (method === "POST" && (path === "/api/tables/join" || path === "/api/spaces/join")) {
    if (!allows({ context, limiter: limits.joinTable })) return sendTooManyRequests(context)
    return joinByCode({ context, runtime })
  }
  if (method === "GET" && path === "/api/archidekt/search") {
    if (!allows({ context, limiter: limits.searchDecks })) return sendTooManyRequests(context)
    return searchDecks({ context, application })
  }
  if (method === "POST" && path === "/api/components/refresh") {
    return refreshComponents({ context, runtime })
  }

  const spaceMatch =
    /^\/api\/(?:tables|spaces)\/([A-Za-z0-9]{1,6})\/(join|state|deck|actions)$/.exec(path)
  if (spaceMatch) {
    const roomCode = normalizeRoomCode(spaceMatch[1])
    const segment = spaceMatch[2]
    if (method === "POST" && segment === "join") return joinSpace({ context, runtime, roomCode })
    if (method === "GET" && segment === "state") return showState({ context, runtime, roomCode })
    if (method === "POST" && segment === "deck") {
      if (!allows({ context, limiter: limits.loadDeck })) return sendTooManyRequests(context)
      return loadDeck({ context, runtime, roomCode })
    }
    if (method === "POST" && segment === "actions") {
      return applyAction({ context, runtime, roomCode })
    }
  }

  if (prefersHtml(context)) return sendHtml({ context, status: 404, body: notFoundPage() })

  sendJson({ context, status: 404, body: { error: "Not found" } })
}

type RequestLimits = {
  createTable: RateLimiter
  joinTable: RateLimiter
  loadDeck: RateLimiter
  searchDecks: RateLimiter
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

function idempotency(context: RequestContext): { idempotencyKey?: string } {
  const supplied = context.request.headers["idempotency-key"]
  const key = Array.isArray(supplied) ? supplied[0] : supplied
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) return {}

  return { idempotencyKey: `${context.sessionId}:${key}` }
}

function allows(options: { context: RequestContext; limiter: RateLimiter }): boolean {
  return options.limiter.allows({ key: options.context.sessionId })
}

function sendTooManyRequests(context: RequestContext): void {
  context.response.setHeader("retry-after", "60")
  sendJson({ context, status: 429, body: { error: "Too many requests. Wait a moment." } })
}

function requestOrigin(request: IncomingMessage): string {
  const configured = process.env.SHUFFLE_PUBLIC_ORIGIN
  if (configured) return configured

  const host = request.headers.host ?? "localhost"
  const forwarded = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    ?.trim()
  const protocol = forwarded === "https" || forwarded === "http" ? forwarded : "http"

  return `${protocol}://${host}`
}

function sendManifest(context: RequestContext): void {
  const manifest = {
    name: "Shuffle Up and Play",
    short_name: "Shuffle Up",
    description: PRODUCT_DESCRIPTION,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0d1320",
    theme_color: "#0d1320",
    icons: [
      { src: ASSET_URLS["icon-192.png"], sizes: "192x192", type: "image/png", purpose: "any" },
      { src: ASSET_URLS["icon-512.png"], sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  }

  context.response.writeHead(200, {
    "content-type": "application/manifest+json; charset=utf-8",
    "cache-control": "public, max-age=3600",
  })
  context.response.end(JSON.stringify(manifest))
}

function sendRobots(context: RequestContext): void {
  const body = ["User-agent: *", "Disallow: /tables/", "Disallow: /api/", "Allow: /", ""].join("\n")

  context.response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=3600",
  })
  context.response.end(body)
}

function sendSecurityTxt(context: RequestContext): void {
  const body = [
    `Contact: ${SITE_ORIGIN}/credits`,
    "Preferred-Languages: en",
    `Canonical: ${SITE_ORIGIN}/.well-known/security.txt`,
    "",
  ].join("\n")

  context.response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=3600",
  })
  context.response.end(body)
}

function showPrivacy(context: RequestContext): void {
  sendHtml({ context, status: 200, body: privacyPage() })
}

function showCredits(context: RequestContext): void {
  sendHtml({ context, status: 200, body: creditsPage() })
}

const LOBBY_ERROR_CODES: Record<string, LobbyErrorCode | undefined> = {
  roomNotFound: "tableNotFound",
  roomFull: "tableFull",
  notAPlayer: "sessionLost",
}

function showLobby(context: RequestContext): void {
  const supplied = context.url.searchParams.get("error") ?? ""

  sendHtml({
    context,
    status: 200,
    body: lobbyPage({
      joinCode: context.url.searchParams.get("join"),
      error: isLobbyErrorCode(supplied) ? { code: supplied } : null,
    }),
  })
}

async function showGame(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
  roomCode: string
}): Promise<void> {
  const { context, runtime } = options
  const roomCode = normalizeRoomCode(options.roomCode)
  const payload = await projectRoom({ runtime, roomCode, sessionId: context.sessionId })

  if (!payload?.space || !payload.currentPlayerId) {
    return sendRedirect({ context, location: `/?join=${encodeURIComponent(roomCode)}` })
  }

  const seat = payload.space.players.find((player) => player.id === payload.currentPlayerId)?.seat
  if (!seat) return sendRedirect({ context, location: `/?join=${encodeURIComponent(roomCode)}` })

  sendHtml({
    context,
    status: 200,
    body: gamePage({
      payload,
      roomCode,
      seat,
      shareUrl: new URL(`/tables/${roomCode}`, context.url).toString(),
    }),
  })
}

async function createSpace(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
}): Promise<void> {
  const { context, runtime } = options
  const body = await readBody(context.request)

  for (let attempt = 0; attempt < MAXIMUM_CODE_ATTEMPTS; attempt += 1) {
    const roomCode = generateRoomCode()
    const created = await tryCreateRoom({ context, runtime, roomCode, body })
    if (!created) continue

    return respondWithRoom({ context, runtime, roomCode, status: 201 })
  }

  sendJson({ context, status: 500, body: { error: "Could not create a unique space code" } })
}

async function tryCreateRoom(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
  roomCode: string
  body: Record<string, unknown>
}): Promise<boolean> {
  const { context, runtime, roomCode, body } = options
  try {
    await runtime
      .ref(GameRoom, roomCode)
      .with({ authorizationContext: viewerFor({ context, roomCode }) })
      .createRoom({
        code: roomCode,
        roomName: String(body.tableName ?? body.spaceName ?? ""),
        playerName: String(body.playerName ?? ""),
        sessionId: context.sessionId,
      })
    return true
  } catch (error) {
    if (error instanceof Rejected && error.code === "roomExists") return false
    throw error
  }
}

async function joinByCode(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
}): Promise<void> {
  const { context, runtime } = options
  const body = await readBody(context.request)
  const roomCode = normalizeRoomCode(body.tableCode ?? body.spaceCode)
  if (roomCode.length === 0) {
    return sendJson({ context, status: 404, body: { error: "Space not found" } })
  }

  await joinRoom({ context, runtime, roomCode, playerName: String(body.playerName ?? "") })
  await respondWithRoom({ context, runtime, roomCode, status: 200 })
}

async function joinSpace(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
  roomCode: string
}): Promise<void> {
  const { context, runtime, roomCode } = options
  const body = await readBody(context.request)

  await joinRoom({ context, runtime, roomCode, playerName: String(body.playerName ?? "") })
  await respondWithRoom({ context, runtime, roomCode, status: 200 })
}

async function joinRoom(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
  roomCode: string
  playerName: string
}): Promise<void> {
  await options.runtime
    .ref(GameRoom, options.roomCode)
    .with({ authorizationContext: viewerFor(options) })
    .join({ playerName: options.playerName, sessionId: options.context.sessionId })
}

async function showState(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
  roomCode: string
}): Promise<void> {
  const { context, runtime, roomCode } = options
  const payload = await projectRoom({ runtime, roomCode, sessionId: context.sessionId })
  if (!payload?.space) {
    return sendJson({ context, status: 404, body: { error: "Space not found" } })
  }

  const sinceVersion = Number(context.url.searchParams.get("sinceVersion"))
  if (Number.isFinite(sinceVersion) && sinceVersion >= payload.space.version) {
    return sendEmpty({ context, status: 204 })
  }

  sendJson({ context, status: 200, body: payload })
}

async function loadDeck(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
  roomCode: string
}): Promise<void> {
  const { context, runtime, roomCode } = options
  const body = await readBody(context.request)
  const deckId = extractDeckId(body.deckId)
  if (!deckId) {
    return sendJson({
      context,
      status: 400,
      body: { error: "A deck ID or Archidekt deck URL is required" },
    })
  }

  await runtime
    .ref(GameRoom, roomCode)
    .with({ authorizationContext: viewerFor(options) })
    .requestDeck({ deckId, sessionId: context.sessionId })

  if (prefersHtml(context)) return sendRedirect({ context, location: `/tables/${roomCode}` })

  sendJson({ context, status: 202, body: { status: "requested", deckId } })
}

async function applyAction(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
  roomCode: string
}): Promise<void> {
  const { context, runtime, roomCode } = options
  const body = await readBody(context.request)
  const action = asJsonObject(isRecord(body.action) ? body.action : body)

  const callContext = {
    authorizationContext: viewerFor(options),
    ...idempotency(context),
  }
  const reference = runtime.ref(GameRoom, roomCode).with(callContext)

  if (context.request.headers.prefer === "respond-async") {
    await runtime.ref(GameRoom, roomCode).send.with(callContext).applyAction({
      action,
      sessionId: context.sessionId,
    })
    return sendEmpty({ context, status: 202 })
  }

  await reference.applyAction({ action, sessionId: context.sessionId })
  await respondWithRoom({ context, runtime, roomCode, status: 200 })
}

async function searchDecks(options: {
  context: RequestContext
  application: ShuffleApplication
}): Promise<void> {
  const { context, application } = options
  const query = context.url.searchParams.get("q") ?? ""

  try {
    const decks = await application.archidekt.search(query)
    sendJson({ context, status: 200, body: { decks } })
  } catch {
    sendJson({ context, status: 502, body: { error: "Archidekt is unavailable" } })
  }
}

async function refreshComponents(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
}): Promise<void> {
  const { context, runtime } = options
  const body = await readBody(context.request)
  const roomCode = normalizeRoomCode(body.actorId)
  if (body.actorType !== GameRoom.actorType || roomCode.length === 0) {
    return sendJson({ context, status: 400, body: { error: "Unknown component request" } })
  }

  const payload = await projectRoom({ runtime, roomCode, sessionId: context.sessionId })
  if (!payload?.space || !payload.currentPlayerId) {
    return sendJson({ context, status: 403, body: { error: "You are not a player in this space" } })
  }

  const seat = payload.space.players.find((player) => player.id === payload.currentPlayerId)?.seat
  if (!seat) {
    return sendJson({ context, status: 403, body: { error: "You are not a player in this space" } })
  }

  const renderContext: ComponentRenderContext = {
    payload,
    roomCode,
    seat,
    shareUrl: new URL(`/tables/${roomCode}`, context.url).toString(),
  }
  const components = Array.isArray(body.components) ? body.components : []
  const frames = components.flatMap((component) => {
    if (!isRecord(component) || !isComponentName(component.name)) return []

    const key = component.key === undefined ? undefined : String(component.key)
    const target = componentTargetId({
      name: component.name,
      ...(key === undefined ? {} : { key }),
    })
    if (typeof component.target === "string" && component.target !== target) return []

    return [{ target, rendered: renderComponent({ name: component.name, key, context: renderContext }) }]
  })

  sendJson({ context, status: 200, body: frames })
}

async function respondWithRoom(options: {
  context: RequestContext
  runtime: SolidObjectsRuntime
  roomCode: string
  status: number
}): Promise<void> {
  const { context, runtime, roomCode } = options
  const payload = await projectRoom({ runtime, roomCode, sessionId: context.sessionId })
  if (!payload?.space) {
    return sendJson({ context, status: 404, body: { error: "Space not found" } })
  }

  if (prefersHtml(context)) return sendRedirect({ context, location: `/tables/${roomCode}` })

  sendJson({ context, status: options.status, body: payload })
}

async function projectRoom(options: {
  runtime: SolidObjectsRuntime
  roomCode: string
  sessionId: string
}): Promise<RoomPayload | null> {
  const payloads = await options.runtime.subscriptionPayloads({
    actorType: GameRoom.actorType,
    actorId: options.roomCode,
    payloadNames: ["game"],
    authorizationContext: {
      sessionId: options.sessionId,
      roomCode: options.roomCode,
    } satisfies GameViewer,
  })

  const payload = payloads[0]?.payload
  return payload ? (payload as unknown as RoomPayload) : null
}

function viewerFor(options: { context: RequestContext; roomCode: string }): GameViewer {
  return { sessionId: options.context.sessionId, roomCode: options.roomCode }
}

function asJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function prefersHtml(context: RequestContext): boolean {
  const accept = context.request.headers.accept ?? ""
  if (accept.includes("application/json")) return false

  return accept.includes("text/html")
}

function respondToError(options: { context: RequestContext; error: unknown }): void {
  const { context, error } = options
  if (error instanceof Rejected) {
    const status = REJECTION_STATUSES[error.code] ?? 422
    const lobbyCode = LOBBY_ERROR_CODES[error.code]
    if (prefersHtml(context) && lobbyCode) {
      return sendRedirect({ context, location: `/?error=${lobbyCode}` })
    }
    return sendJson({ context, status, body: { error: error.message, code: error.code } })
  }

  if (error instanceof Unauthorized) {
    return sendJson({ context, status: 403, body: { error: "This request is not authorized" } })
  }

  if (error instanceof PayloadTooLargeError) {
    return sendJson({ context, status: 413, body: { error: "That request was too large" } })
  }

  sendJson({ context, status: 500, body: { error: describeError(error) } })
}

function describeError(error: unknown): string {
  if (process.env.NODE_ENV === "production") return "Something went wrong. Try again."

  return error instanceof Error ? error.message : "Unexpected server error"
}

type RequestSession = {
  sessionId: string
  setCookies: string[]
}

function resolveRequestSession(options: {
  request: IncomingMessage
  secret: string
  secureCookies: boolean
}): RequestSession {
  const existingSessionId = readSessionCookie({
    cookieHeader: options.request.headers.cookie,
    secret: options.secret,
  })
  if (existingSessionId) return { sessionId: existingSessionId, setCookies: [] }

  const sessionId = generateSessionId()
  return {
    sessionId,
    setCookies: [
      sessionCookieHeader({ sessionId, secret: options.secret, secure: options.secureCookies }),
    ],
  }
}

function createOperatorDashboardHandler(options: {
  runtime: SolidObjectsRuntime
  requestSessions: WeakMap<IncomingMessage, RequestSession>
  dashboardSessions: Map<string, Map<string, string>>
  options: ShuffleOperatorDashboardOptions
}): NodeDashboardHandler {
  const dashboard = createDashboard({
    runtime: options.runtime,
    mountPath: options.options.mountPath ?? "/solid-objects/dashboard",
    ...(options.options.access ? { access: options.options.access } : {}),
  })
  return createNodeDashboardHandler({
    dashboard,
    resolveContext: (request) => {
      const requestSession = options.requestSessions.get(request)
      if (!requestSession) throw new Error("request session is unavailable")
      return {
        authorizationContext: dashboardAuthorizationContext(request),
        session: dashboardSession({
          sessions: options.dashboardSessions,
          sessionId: requestSession.sessionId,
        }),
      }
    },
  })
}

function dashboardSession(options: {
  sessions: Map<string, Map<string, string>>
  sessionId: string
}): DashboardSession {
  let values = options.sessions.get(options.sessionId)
  if (!values) {
    values = new Map<string, string>()
    options.sessions.set(options.sessionId, values)
  }
  return {
    read: (key) => values.get(key),
    write: (key, value) => {
      values.set(key, value)
    },
  }
}

function dashboardAuthorizationContext(request: IncomingMessage): { source: string } {
  return { source: loopbackAddress(request.socket.remoteAddress) ? "cli" : "remote" }
}

function loopbackAddress(address: string | undefined): boolean {
  if (address === "::1" || address === "127.0.0.1") return true
  return address?.startsWith("::ffff:127.") ?? false
}

function respondToUnhandledError(options: { response: ServerResponse; error: unknown }): void {
  if (options.response.headersSent) return
  options.response.writeHead(500, { "content-type": "application/json" })
  options.response.end(JSON.stringify({ error: describeError(options.error) }))
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://cards.scryfall.io https://storage.googleapis.com",
  "connect-src 'self' ws: wss:",
  "manifest-src 'self'",
].join("; ")

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ")

export function applySecurityHeaders(options: {
  response: ServerResponse
  secureCookies: boolean
}): void {
  const { response } = options
  response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY)
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("referrer-policy", "strict-origin-when-cross-origin")
  response.setHeader("permissions-policy", PERMISSIONS_POLICY)
  response.setHeader("x-frame-options", "DENY")
  response.setHeader("cross-origin-opener-policy", "same-origin")
  if (options.secureCookies) {
    response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains; preload")
  }
}

export async function serveStaticAsset(options: {
  method: string
  pathname: string
  response: ServerResponse
}): Promise<boolean> {
  const { method, pathname, response } = options
  if (method !== "GET" && method !== "HEAD") return false

  const entry = Object.entries(STATIC_ROOTS).find(([prefix]) => pathname.startsWith(prefix))
  if (!entry) return false

  const [prefix, root] = entry
  const requested = normalize(pathname.slice(prefix.length))
  if (requested.startsWith("..")) return false

  const match = FINGERPRINT_PATTERN.exec(requested)
  const relative = match ? `${match[1]}${match[2]}` : requested

  const filePath = join(root, relative)
  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) return false
  } catch {
    return false
  }

  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    "cache-control": match
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300, must-revalidate",
  })
  if (method === "HEAD") {
    response.end()
    return true
  }

  createReadStream(filePath).pipe(response)
  return true
}

export { SESSION_COOKIE_NAME }
