import type { Server } from "node:http"

import type { SolidObjectsRuntime } from "solid-objects"
import { WebSocketServer, type WebSocket } from "ws"

import type { GameViewer } from "../actors/game-room.ts"
import { normalizeRoomCode } from "../game/room-code.ts"
import { readSessionCookie } from "./session.ts"

const REALTIME_PATH = "/live"
const MAXIMUM_FRAME_BYTES = 16 * 1024
const MAXIMUM_CONNECTIONS = 500
const MESSAGE_WINDOW_MILLISECONDS = 10_000
const MAXIMUM_MESSAGES_PER_WINDOW = 60

export type RealtimeBridge = {
  close(): Promise<void>
}

export function attachRealtime(options: {
  server: Server
  runtime: SolidObjectsRuntime
  secret: string
}): RealtimeBridge {
  const webSocketServer = new WebSocketServer({
    server: options.server,
    path: REALTIME_PATH,
    maxPayload: MAXIMUM_FRAME_BYTES,
  })

  webSocketServer.on("connection", (socket: WebSocket, request) => {
    if (webSocketServer.clients.size > MAXIMUM_CONNECTIONS) {
      socket.close(1013, "too many connections")
      return
    }

    if (!allowsOrigin({ origin: request.headers.origin, host: request.headers.host })) {
      socket.close(1008, "origin not allowed")
      return
    }

    const url = new URL(request.url ?? "/", "http://localhost")
    const roomCode = normalizeRoomCode(url.searchParams.get("roomCode"))
    const sessionId = readSessionCookie({
      cookieHeader: request.headers.cookie,
      secret: options.secret,
    })

    if (!sessionId || roomCode.length === 0) {
      socket.close(1008, "unauthenticated")
      return
    }

    let windowStart = Date.now()
    let messagesInWindow = 0

    const viewer: GameViewer = { sessionId, roomCode }
    const session = options.runtime.realtime.connect({
      authorizationContext: viewer,
      send: (envelope) => socket.send(JSON.stringify(envelope)),
    })

    socket.on("message", (data) => {
      const now = Date.now()
      if (now - windowStart > MESSAGE_WINDOW_MILLISECONDS) {
        windowStart = now
        messagesInWindow = 0
      }
      messagesInWindow += 1
      if (messagesInWindow > MAXIMUM_MESSAGES_PER_WINDOW) {
        socket.close(1008, "too many messages")
        return
      }

      let request: unknown
      try {
        request = JSON.parse(String(data))
      } catch {
        socket.close(1008, "malformed subscription request")
        return
      }

      session.receive(request).catch(() => socket.close(1008, "subscription rejected"))
    })
    socket.on("close", () => session.close())
    socket.on("error", () => session.close())
  })

  return {
    close: async () => {
      for (const client of webSocketServer.clients) client.terminate()
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()))
    },
  }
}

function allowsOrigin(options: { origin: string | undefined; host: string | undefined }): boolean {
  if (!options.origin) return true

  const configured = process.env.SHUFFLE_PUBLIC_ORIGIN
  if (configured && options.origin === configured) return true

  try {
    return new URL(options.origin).host === options.host
  } catch {
    return false
  }
}

export { REALTIME_PATH }
