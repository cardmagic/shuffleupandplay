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
  readBody,
  sendEmpty,
  sendHtml,
  sendJson,
  sendRedirect,
  type RequestContext,
} from "./http.ts"
import { attachRealtime } from "./realtime.ts"
import {
  componentTargetId,
  isComponentName,
  renderComponent,
  type ComponentRenderContext,
} from "./render/components.ts"
import { lobbyPage, gamePage } from "./render/pages.ts"
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
  "/vendor/solid-objects/": resolve(
    import.meta.dirname,
    "../../node_modules/solid-objects/dist",
  ),
}

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
    if (request.method === "GET" && (request.url ?? "").split("?")[0] === "/up") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      response.end("OK")
      return
    }

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
      handle({ request, response, application, runtime, requestSession }).catch((handleError) => {
        respondToUnhandledError({ response, error: handleError })
      })
    }
    if (dashboardHandler) {
      dashboardHandler(request, response, next)
      return
    }
    next()
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
}): Promise<void> {
  const { request, response, application, runtime, requestSession } = options
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)

  const context: RequestContext = {
    request,
    response,
    method: request.method ?? "GET",
    url,
    sessionId: requestSession.sessionId,
    setCookies: requestSession.setCookies,
  }

  if (await serveStatic(context)) return

  try {
    await route({ context, application, runtime })
  } catch (error) {
    respondToError({ context, error })
  }
}

async function route(options: {
  context: RequestContext
  application: ShuffleApplication
  runtime: SolidObjectsRuntime
}): Promise<void> {
  const { context, application, runtime } = options
  const path = context.url.pathname
  const method = context.method

  if (method === "GET" && path === "/") return showLobby(context)
  if (method === "GET" && path.startsWith("/spaces/")) {
    return showGame({ context, runtime, roomCode: path.slice("/spaces/".length) })
  }
  if (method === "POST" && path === "/api/spaces") return createSpace({ context, runtime })
  if (method === "POST" && path === "/api/spaces/join") return joinByCode({ context, runtime })
  if (method === "GET" && path === "/api/archidekt/search") {
    return searchDecks({ context, application })
  }
  if (method === "POST" && path === "/api/components/refresh") {
    return refreshComponents({ context, runtime })
  }

  const spaceMatch = /^\/api\/spaces\/([A-Za-z0-9]{1,6})\/(join|state|deck|actions)$/.exec(path)
  if (spaceMatch) {
    const roomCode = normalizeRoomCode(spaceMatch[1])
    const segment = spaceMatch[2]
    if (method === "POST" && segment === "join") return joinSpace({ context, runtime, roomCode })
    if (method === "GET" && segment === "state") return showState({ context, runtime, roomCode })
    if (method === "POST" && segment === "deck") return loadDeck({ context, runtime, roomCode })
    if (method === "POST" && segment === "actions") {
      return applyAction({ context, runtime, roomCode })
    }
  }

  sendJson({ context, status: 404, body: { error: "Not found" } })
}

function showLobby(context: RequestContext): void {
  sendHtml({
    context,
    status: 200,
    body: lobbyPage({
      joinCode: context.url.searchParams.get("join"),
      error: context.url.searchParams.get("error"),
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
      shareUrl: new URL(`/spaces/${roomCode}`, context.url).toString(),
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
        roomName: String(body.spaceName ?? ""),
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
  const roomCode = normalizeRoomCode(body.spaceCode)
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

  if (prefersHtml(context)) return sendRedirect({ context, location: `/spaces/${roomCode}` })

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

  const reference = runtime
    .ref(GameRoom, roomCode)
    .with({ authorizationContext: viewerFor(options) })

  if (context.request.headers.prefer === "respond-async") {
    await runtime
      .ref(GameRoom, roomCode)
      .send.with({ authorizationContext: viewerFor(options) })
      .applyAction({ action, sessionId: context.sessionId })
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

  const renderContext: ComponentRenderContext = { payload, roomCode, seat }
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

  if (prefersHtml(context)) return sendRedirect({ context, location: `/spaces/${roomCode}` })

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
    if (prefersHtml(context) && (error.code === "roomNotFound" || error.code === "roomFull")) {
      return sendRedirect({
        context,
        location: `/?error=${encodeURIComponent(error.message)}`,
      })
    }
    return sendJson({ context, status, body: { error: error.message, code: error.code } })
  }

  if (error instanceof Unauthorized) {
    return sendJson({ context, status: 403, body: { error: "This request is not authorized" } })
  }

  sendJson({ context, status: 500, body: { error: describeError(error) } })
}

function describeError(error: unknown): string {
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

async function serveStatic(context: RequestContext): Promise<boolean> {
  if (context.method !== "GET") return false

  const entry = Object.entries(STATIC_ROOTS).find(([prefix]) =>
    context.url.pathname.startsWith(prefix),
  )
  if (!entry) return false

  const [prefix, root] = entry
  const relative = normalize(context.url.pathname.slice(prefix.length))
  if (relative.startsWith("..")) return false

  const filePath = join(root, relative)
  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) return false
  } catch {
    return false
  }

  context.response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  })
  createReadStream(filePath).pipe(context.response)
  return true
}

export { SESSION_COOKIE_NAME }
