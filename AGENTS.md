# AGENTS.md

Working notes for agents and contributors on Shuffle Up and Play.

## What this is

A two-player Magic: The Gathering table you play remotely with an Archidekt deck.
It is a product, not a demo. Players draw, tap, move and track their own cards by
hand. There is no rules engine, no account, no chat and no matchmaking.

Treat it as a product in every player-visible surface. Never name the underlying
framework in the interface, in metadata, in error text or in HTML.

## Stack

- Node 24, TypeScript, `node:http`, `ws`, SQLite
- No web framework, no bundler, no client build step
- `solid-objects` supplies the actor runtime and the realtime client
- Kamal deploys a single container behind kamal-proxy

Browser code is plain ES modules in `public/`, served straight to the browser.
Do not add a client build step to convert working JavaScript.

## Layout

```
src/
  actors/       GameRoom (the table) and MatchLog
  archidekt/    deck search and deck import
  game/         pure domain: actions, player rules, room projection, types
  server/       router, sessions, realtime bridge, HTML rendering
  runtime.ts    runtime wiring, effects, commit actions, authorization
  main.ts       entry point
public/         browser module, stylesheet, icons, social card
test/           vitest suites
```

## State model

One table code addresses one `GameRoom` actor, which owns the room and both
players and serializes every mutation.

- `src/game/player.ts` holds the pure action reducer. Add game rules there.
- `src/game/room-snapshot.ts` projects state: `roomPayload` for what a seat may
  see, `playerSummaries` for public counts, `seatFingerprints` for change
  detection.
- `GameRoom.stateVersion` drives migrations. Bump it when the stored shape changes.

### Observables, and the trap in them

`observables()` publishes three things:

- `version` and `lifeTotals` through `broadcastValue()`, whose values reach every
  authorized subscriber.
- `seatOne` and `seatTwo` through `broadcastInvalidation()`, whose values are
  never stored and never sent. They exist only so the runtime can detect change
  and refresh components.

Because the invalidation value never leaves the server, it must contain every
piece of state a component renders. `seatFingerprints` therefore carries each
battlefield card's tapped state, position and counters.

**If a component does not refresh after an action, check this first.** An earlier
version compared only counts, so tapping a card, dragging it or moving a counter
produced an identical fingerprint. The action committed, no invalidation was
broadcast, and the card sat still until an unrelated action changed a count.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Lobby. Public, no session until create or join. |
| `GET /tables/:code` | Table page. Private, `noindex`. |
| `GET /spaces/:code` | Redirect to `/tables/:code` for old links. |
| `POST /api/tables`, `/api/tables/join` | Create and join. `/api/spaces*` still works. |
| `POST /api/tables/:code/{join,deck,actions}` | Table operations. |
| `GET /api/tables/:code/state` | Seat-filtered projection. |
| `POST /api/components/refresh` | Component re-render, re-authorized. |
| `GET /live` | WebSocket. Neutral path on purpose. |
| `/privacy`, `/credits`, `/robots.txt`, `/manifest.webmanifest`, `/.well-known/security.txt` | Public. |
| `GET /up` | Health check. Answers GET and HEAD, sets no cookie. |

## Sessions and hidden information

A signed `shuffleSession` cookie identifies a seat. Static assets and the health
check never create one; only the lobby forms and table routes do.

Card identity moves through the `game` payload, which the runtime projects
separately for each subscribing session. One seat sees its own hand and library.
The other seat sees the same card count, each reading "Hidden card".

Hidden information must be absent from server-rendered HTML, component payloads
and realtime envelopes. Never hide it with CSS. `test/realtime.test.ts` and
`test/server.test.ts` assert this; keep those assertions.

## Assets and caching

`src/server/render/pages.ts` hashes each file in `public/` at process start and
emits `/assets/<name>.<hash>.<ext>`. The static handler strips the hash, so
fingerprinted URLs cache `immutable` for a year.

**Gotcha:** the hash is computed once at boot. Editing CSS or JS while the server
runs keeps the old URL, and the browser will keep the old immutable copy.
Restart the server after editing anything in `public/`.

## Security

`applySecurityHeaders` sets CSP, HSTS, nosniff, frame-ancestors, Referrer-Policy
and Permissions-Policy on every response. The CSP allowlist covers Google Fonts,
`cards.scryfall.io` and Archidekt's image host. Widen it deliberately, never with
a wildcard.

Lobby errors travel as short codes (`?error=tableNotFound`), never as raw
exception text. `LOBBY_MESSAGES` in `pages.ts` maps a code to player-facing text.

## Commands

```bash
pnpm install
SHUFFLE_SECRET="at-least-32-characters-long" pnpm start
pnpm test
pnpm typecheck
pnpm build
pnpm doctor
```

Environment: `SHUFFLE_SECRET` (required), `SHUFFLE_DATABASE_PATH`,
`SHUFFLE_OPERATOR_DASHBOARD`, `SHUFFLE_PUBLIC_ORIGIN`, `PORT`, `NODE_ENV`.

## Conventions

- Early returns, no nested conditionals, no boolean parameters, no abbreviations.
- No inline source comments. Explain a decision in the commit message.
- Write a failing test first, including for bug fixes.
- Prose in the product and the docs uses Simplified Technical English.
- Deploy with `KAMAL_SERVER_HOST=<host> kamal deploy`. Secrets come from 1Password
  through `.kamal/secrets`, which pins the account.

## Deferred work

Commander life totals and a command zone, undo, seat recovery tokens, the mobile
segmented layout, richer Archidekt filtering and a keyboard-accessible card menu
are specified but not built. Do not describe them as available.
