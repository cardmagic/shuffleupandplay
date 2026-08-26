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
- `solid-objects` supplies the actor runtime and the realtime client, on both
  the server and, on OPFS SQLite WebAssembly, in the browser
- Kamal deploys a single container behind kamal-proxy

Browser code is plain ES modules in `public/`, served straight to the browser.
Do not add a client build step to convert working JavaScript.

## Layout

```
src/
  actors/       GameRoom (the table), MatchLog, TableMirror (runs in the browser)
  archidekt/    deck search and deck import
  game/         pure domain: actions, player rules, room projection, types
  server/       router, sessions, realtime bridge, HTML rendering,
                shared-modules, live-poll, live-tables, sync-ingest
  runtime.ts    runtime wiring, effects, commit actions, authorization
  main.ts       entry point
public/         browser module, table worker, stylesheet, icons, social card
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
| `GET /api/tables/:code/changes` | Long poll. Answers the same envelope the socket sends. |
| `POST /api/tables/:code/sync` | Ingest for a move the browser queued. |
| `POST /api/components/refresh` | Component re-render, re-authorized. |
| `GET /api/operator/tables` | Live table view. Operator surface only. |
| `GET /live` | WebSocket. Neutral path on purpose. |
| `GET /shared/**`, `GET /vendor/**` | Browser modules. See below. |
| `/privacy`, `/credits`, `/robots.txt`, `/manifest.webmanifest`, `/.well-known/security.txt` | Public. |
| `GET /up` | Health check. Answers GET and HEAD, sets no cookie. |

## Browser modules

The browser runs some of the same TypeScript the server runs. There is still no
build step. `src/server/shared-modules.ts` removes the types at request time
with Node's own `stripTypeScriptTypes` and serves the result as JavaScript, so
one file is the single source for both sides. `tsconfig.json` sets
`erasableSyntaxOnly`, which is what makes every module strippable.

- `/shared/<path>` serves an allowlisted module from `src/`. The list is a `Set`
  of exact paths. A path that is not on the list is a 404.
- `/vendor/live/` serves `solid-objects/dist`; `/vendor/sqlite/` serves the
  SQLite WebAssembly build.
- Both routes rewrite bare specifiers (`solid-objects`,
  `@sqlite.org/sqlite-wasm`) to vendored URLs. A module worker cannot use an
  import map, so the specifiers have to be resolved before the browser sees
  them.

**Gotchas:**

- Add a module to `SHARED_MODULES` *and* every module it imports at runtime, or
  the browser gets a 404 partway through the import graph.
- A shared module must not import `node:` anything. `src/game/randomness.ts`
  uses the global `crypto.randomUUID()` for this reason.
- The production image copies `src/` as well as `dist/`, because the route reads
  the TypeScript source at runtime.
- `stripTypeScriptTypes` prints one experimental warning to stderr at boot.

## Signals

`solid-objects/signals` gives `reference.live`, read-only signals fed by an
in-process realtime session. Two places use it:

- `src/server/live-poll.ts` watches `GameRoom.ref(code).live.version` and
  answers `GET /api/tables/:code/changes` with the same version-1 invalidation
  envelope the socket sends, built from `runtime.snapshotWithIncarnation`. The
  browser feeds it straight to the component registry, so a table keeps
  updating where WebSockets are blocked.
- `src/server/live-tables.ts` keeps active tables current for the operator view
  without re-reading the database.

**Gotchas:**

- A live signal subscribes with an **undefined** authorization context, so
  `authorizeSubscription` has to accept it. That is safe because the WebSocket
  bridge closes any socket without a signed session before it opens a session,
  and because an undefined context reaches only value-broadcast observables
  (`version`, `lifeTotals`) and invalidation *names*. Payloads are gated
  separately by `authorizeQuery`, which denies the undefined context, so the
  `game` payload can never reach it. `test/live-poll.test.ts` pins this.
- The signal only fires when a `broadcastValue` observable changes. A turn that
  bumps the actor revision without changing `version` does not wake a poller;
  the poll deadline bounds the delay.
- Waiting needs the broadcast worker. A test must call `runtime.run(signal)`.

## The browser mirror

`src/actors/table-mirror.ts` is a Solid Objects actor that runs **in the
browser**, in a module worker (`public/table-worker.js`), on OPFS SQLite
WebAssembly through `sharedSqliteWasm`. It holds the player's own seat and the
moves the table has not applied yet.

A move goes: apply the shared rule locally and commit to OPFS, redraw the seat
from `renderComponent`, then stage a transmit. `registerTransmit` drains the
outbox to `POST /api/tables/:code/sync` with at-least-once delivery and per-seat
order. Click to redraw is about 25 ms, and it works with the server down.

`readSyncEnvelope` in `src/server/sync-ingest.ts` never trusts the envelope. It
rebuilds it: the actor type, the actor id and the operation are fixed, and the
session id comes from the cookie, never from the body. The effect id is
namespaced by session, so one player's replay cannot silence another's move.

The seat carries `appliedMove`, a high-water mark. The browser numbers each
move; the table records the highest it applied; reconciliation drops every
queued move at or below that number and replays the rest.

**Gotchas:**

- The mirror owns `player`, `playerControls` and `librarySearch` for its own
  seat. The component registry skips those targets (`mirror.owns`), or the
  server's HTML would overwrite a queued move.
- Give the outbox a large `maxAttempts` and a capped retry delay. With the
  default five attempts an outage longer than about half a minute dead-letters
  the queued moves, and the high-water mark then hides the loss, because a later
  move that does land advances the mark past the ones that did not.
- The mirror reconciles on a socket invalidation, on a long-poll envelope, and
  on a short timer while moves are queued. The timer matters: a socket that
  reconnects without replaying leaves the queue stuck otherwise.
- The runtime uses `workerCount: 0`. The mirror has no async messages, and an
  idle polling role in a tab costs battery. Add a worker if you add `send()` or
  a reminder.
- WebAssembly needs `'wasm-unsafe-eval'` in `script-src`. Without it Chrome
  blocks the SQLite build.
- If the mirror cannot start, `sendAction` posts to `/api/tables/:code/actions`
  exactly as before. Keep that path working.
- Browser timers are throttled to about one per second in a background tab.
  Measure latency inside the handler, not with `setTimeout`, or every number
  reads as 1000 ms.

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
- Deploy with `KAMAL_SERVER_HOST=<host> KAMAL_SSH_USER=<user> kamal deploy`. Both
  variables are necessary. `KAMAL_SSH_USER` defaults to `app`, which fails when
  the server uses a different account. Secrets come from 1Password through
  `.kamal/secrets`, which pins the account. Unlock 1Password in the same shell,
  because the session token does not cross shells.

## Deferred work

Commander life totals and a command zone, undo, seat recovery tokens, the mobile
segmented layout, richer Archidekt filtering and a keyboard-accessible card menu
are specified but not built. Do not describe them as available.

The browser mirror has no test that drives a real browser; this repository has
no Playwright suite. `test/table-mirror.test.ts` covers the actor against a Node
runtime, and `test/sync-ingest.test.ts` covers the server side. The WebAssembly
adapter, the worker and the redraw were checked by hand in Chrome. Add a browser
suite before changing the worker.

A move can still be lost if the table refuses it for good: the outbox treats a
400 or a 403 as delivered and drops it, and the high-water mark then hides the
gap. Reloading the table redraws the true seat.
