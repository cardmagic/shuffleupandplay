import type { IncomingMessage, ServerResponse } from "node:http"

const MAXIMUM_BODY_BYTES = 1_000_000

export type RequestContext = {
  request: IncomingMessage
  response: ServerResponse
  method: string
  url: URL
  sessionId: string
  setCookies: string[]
}

export async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? ""
  const raw = await readRawBody(request)
  if (raw.length === 0) return {}

  if (contentType.includes("application/json")) {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw))
  }

  return {}
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer)
    size += buffer.length
    if (size > MAXIMUM_BODY_BYTES) throw new PayloadTooLargeError("the request body is too large")
    chunks.push(buffer)
  }

  return Buffer.concat(chunks).toString("utf8")
}

export class PayloadTooLargeError extends Error {
  override readonly name = "PayloadTooLargeError"
}

export function sendJson(options: {
  context: RequestContext
  status: number
  body: unknown
}): void {
  send({
    context: options.context,
    status: options.status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(options.body),
  })
}

export function sendHtml(options: {
  context: RequestContext
  status: number
  body: string
}): void {
  send({
    context: options.context,
    status: options.status,
    contentType: "text/html; charset=utf-8",
    body: options.body,
  })
}

export function sendEmpty(options: { context: RequestContext; status: number }): void {
  send({ context: options.context, status: options.status, contentType: null, body: "" })
}

export function sendRedirect(options: { context: RequestContext; location: string }): void {
  options.context.response.writeHead(303, {
    location: options.location,
    "cache-control": "no-store",
    ...cookieHeader(options.context),
  })
  options.context.response.end()
}

export function send(options: {
  context: RequestContext
  status: number
  contentType: string | null
  body: string
  headers?: Record<string, string>
}): void {
  const headers: Record<string, string | string[]> = {
    "cache-control": "no-store",
    ...options.headers,
    ...cookieHeader(options.context),
  }
  if (options.contentType) headers["content-type"] = options.contentType

  options.context.response.writeHead(options.status, headers)
  options.context.response.end(options.body)
}

function cookieHeader(context: RequestContext): Record<string, string[]> {
  return context.setCookies.length > 0 ? { "set-cookie": context.setCookies } : {}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
