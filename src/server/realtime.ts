import type { Server } from "node:http"

import type { SolidObjectsRuntime } from "solid-objects"
import { WebSocketServer, type WebSocket } from "ws"

import type { GameViewer } from "../actors/game-room.ts"
import { normalizeRoomCode } from "../game/room-code.ts"
import { readSessionCookie } from "./session.ts"

const REALTIME_PATH = "/live"

export type RealtimeBridge = {
  close(): Promise<void>
}

export function attachRealtime(options: {
  server: Server
  runtime: SolidObjectsRuntime
  secret: string
}): RealtimeBridge {
  const webSocketServer = new WebSocketServer({ server: options.server, path: REALTIME_PATH })

  webSocketServer.on("connection", (socket: WebSocket, request) => {
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

    const viewer: GameViewer = { sessionId, roomCode }
    const session = options.runtime.realtime.connect({
      authorizationContext: viewer,
      send: (envelope) => socket.send(JSON.stringify(envelope)),
    })

    socket.on("message", (data) => {
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

export { REALTIME_PATH }
