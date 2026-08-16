# MTG Playmat (Node)

A two-player Magic: The Gathering playmat for Node.js. It is a complete example
application for the [`solid-objects`](https://www.npmjs.com/package/solid-objects)
npm package.

The app uses Node 24, TypeScript, SQLite, `node:http`, and `ws`. It adds no web
framework and no bundler. Two browsers share one room. Each browser holds one
seat, and each seat sees only its own cards.

## What this example demonstrates

Solid Objects gives you stateful, realtime objects on a database. This app
exercises the full feature set:

- **Actors own state.** One room code addresses one `PlaymatRoom` actor. The
  actor serializes every mutation and persists to SQLite.
- **Two observable contracts.** `broadcastValue()` shares a scalar with every
  authorized subscriber. `broadcastInvalidation()` refreshes components without
  a value on the wire. Version 0.13.0 makes invalidation-only the default.
- **Per-subscriber payloads.** The runtime projects the same payload separately
  for each session, with that session's own authorization context.
- **Effects with callbacks.** A deck import runs outside the turn. Success and
  failure callbacks both receive the staged arguments.
- **Rejection rollback.** A rejected turn discards the state, the staged
  message, and the staged effect together.
- **Reminders and commit actions.** A reminder closes an idle card search. A
  commit action writes a metrics row inside the actor transaction.
- **State migrations.** The actor is at `stateVersion: 3`. Version 1 rows
  hydrate and upgrade with no extra code.
- **Realtime without a bundler.** The browser client comes from
  `node_modules/solid-objects/dist/browser`. A static route serves it as is.
- **An operator dashboard.** `solid-objects/web` mounts at
  `/solid-objects/dashboard`.

The test suite proves the concurrency guarantees. Twenty-five concurrent
`adjustLife` calls on one actor produce exactly twenty-five decrements. Three
rooms progress at the same time. A repeated idempotency key applies once.

## Setup

```bash
pnpm install
PLAYMAT_SECRET="a-secret-of-at-least-32-characters" pnpm start
```

Open http://localhost:3000 and create a table. Open the share link in a second
browser profile. Each browser gets its own signed `mtgSession` cookie. The
cookie decides which seat you hold.

To inspect the runtime, set `PLAYMAT_OPERATOR_DASHBOARD=true` and open
http://localhost:3000/solid-objects/dashboard. For a demo backed only by
synthetic data, set it to `public-read-only`. That mode needs no authentication,
renders no mutation controls, and rejects every POST. The dashboard is disabled
by default. Authorized modes cannot run with `NODE_ENV=production`, and the
application policy authorizes loopback requests only.

## Verification

```bash
pnpm test        # 126 tests
pnpm typecheck
pnpm build
pnpm doctor
```

The doctor reports one warning by design. All five authorization policies deny a
neutral context.

## Architecture

| Solid Objects feature | Where the app uses it |
| --- | --- |
| Actor state and operations | `src/actors/playmat-room.ts` |
| Getters as queries | `roomName`, `playerCount` |
| `observables()` | value-broadcast version and life totals, invalidation-only seats |
| `payloads` | `playmat`, the seat-filtered room |
| `reject()` | `roomFull`, `notAPlayer`, `invalidAction`, `roomNotFound` |
| `emit()` effect | `fetchArchidektDeck`, with success and failure callbacks |
| `sendTo()` | `PlaymatRoom` writes to a `MatchLog` actor in the same turn |
| `schedule()` reminder | `sweepIdleState` closes a forgotten library search |
| `commitAction()` | `recordActionMetric` writes a metrics row in the actor transaction |
| `runtime.realtime` | `src/server/realtime.ts` over `ws` |
| `solid-objects/browser` | `public/playmat.js`, served straight from `node_modules` |
| `solid-objects/web` | opt-in authorized or public read-only dashboard |
| Component registry | batched, per-seat HTML refresh through `/api/components/refresh` |
| State migrations | `stateVersion: 3` removes obsolete manual revision counters |
| Doctor, processes, retention, reconciliation | `src/doctor.ts` and `test/operations.test.ts` |
| `testing.drain()` / `testing.reset()` | every runtime test |

### Two channels, two trust levels

The invalidation envelope carries value-broadcast observables to every
authorized subscriber. Only `version` and `lifeTotals` cross the wire.

`seatOne` and `seatTwo` use `broadcastInvalidation()`. Solid Objects compares
the real seat summaries and sends only the changed names. The actor needs no
application-maintained revision counters, and no player data enters the shared
envelope.

Card identity moves through the `playmat` payload. One seat sees its own hand
and library. The other seat sees the same number of cards, and each card reads
"Hidden card".

The component registry observes the seat names directly. When seat 2 taps a
card, only the seat 2 component refreshes. That refresh goes through an HTTP
endpoint that authorizes the request again.

## Layout

```
src/
  actors/            PlaymatRoom and MatchLog
  archidekt/         deck search and deck import client
  playmat/           pure domain: actions, player rules, room projection
  server/            node:http router, session cookies, ws bridge, HTML rendering
  runtime.ts         configure the runtime, effects, commit actions, policies
  main.ts            entry point
public/              browser client and stylesheet
test/                126 tests
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAYMAT_SECRET` | none, required | signs the session cookie, 32 characters or more |
| `PLAYMAT_DATABASE_PATH` | `storage/solid-objects.sqlite3` | SQLite file |
| `PLAYMAT_OPERATOR_DASHBOARD` | none | `true`, `authorized-read-only`, or `public-read-only` mounts the dashboard |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | none | `production` adds `Secure` to the session cookie |

## License

MIT. See [MIT-LICENSE](MIT-LICENSE).

Magic: The Gathering is a trademark of Wizards of the Coast LLC. This project
has no relation to and no endorsement from Wizards of the Coast. Card images
come from [Scryfall](https://scryfall.com), and deck import uses the public
[Archidekt](https://archidekt.com) API.
