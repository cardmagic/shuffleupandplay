# Shuffle Up and Play

Play Magic remotely with an Archidekt deck. Draw, tap, move, and track cards on a
shared two-player table.

Create a table, send the invite link, load your decks, and play. No account, no
install, no rules engine. You move your own cards, exactly as you would across a
kitchen table.

Live at [shuffleupandplay.com](https://shuffleupandplay.com).

## How it works

One table code addresses one table. Two browsers share it, and each seat sees
only its own cards. The other seat sees the same number of cards, each reading
"Hidden card". Every change reaches the other browser over a live connection.

The app runs on Node 24, TypeScript, SQLite, `node:http`, and `ws`. It adds no
web framework, no bundler, and no client build step. Card art comes from
Scryfall. Deck import reads the public Archidekt API.

### What the deployment proves

This deployment demonstrates durable actors and realtime synchronization in one
Node process backed by SQLite. Multi-process and PostgreSQL behaviour are tested
in the Solid Objects repository, not here. The restart suite in
`test/restart.test.ts` closes the runtime, reopens the same database, and proves
that committed state, an accepted asynchronous action, an unfinished effect, and
a scheduled reminder all survive.

Contributors should start with [AGENTS.md](AGENTS.md), which covers the
architecture, the state model, and the known traps.

## Setup

```bash
pnpm install
SHUFFLE_SECRET="a-secret-of-at-least-32-characters" pnpm start
```

Open http://localhost:3000 and create a table. Open the share link in a second
browser profile. Each browser gets its own signed `shuffleSession` cookie. The
cookie decides which seat you hold.

To inspect the runtime, set `SHUFFLE_OPERATOR_DASHBOARD=true` and open
http://localhost:3000/solid-objects/dashboard. For a demo backed only by
synthetic data, set it to `public-read-only`. That mode needs no authentication,
renders no mutation controls, and rejects every POST. The dashboard is disabled
by default. Authorized modes cannot run with `NODE_ENV=production`, and the
application policy authorizes loopback requests only.

## Verification

```bash
pnpm test        # 171 tests
pnpm typecheck
pnpm build
pnpm doctor
```

The doctor reports one warning by design. All five authorization policies deny a
neutral context.

## Architecture

| Solid Objects feature | Where the app uses it |
| --- | --- |
| Actor state and operations | `src/actors/game-room.ts` |
| Getters as queries | `roomName`, `playerCount` |
| `observables()` | value-broadcast version and life totals, invalidation-only seats |
| `payloads` | `game`, the seat-filtered room |
| `reject()` | `roomFull`, `notAPlayer`, `invalidAction`, `roomNotFound` |
| `emit()` effect | `fetchArchidektDeck`, with success and failure callbacks |
| `sendTo()` | `GameRoom` writes to a `MatchLog` actor in the same turn |
| `schedule()` reminder | `sweepIdleState` closes a forgotten library search |
| `commitAction()` | `recordActionMetric` writes a metrics row in the actor transaction |
| `runtime.realtime` | `src/server/realtime.ts` over `ws` |
| `solid-objects/browser` | `public/shuffle.js`, served straight from `node_modules` |
| `solid-objects/web` | opt-in authorized or public read-only dashboard |
| Component registry | batched, per-seat HTML refresh through `/api/components/refresh` |
| State migrations | `stateVersion: 5`, with a legacy room upgraded in the test suite |
| Doctor, processes, retention, reconciliation | `src/doctor.ts` and `test/operations.test.ts` |
| `testing.drain()` / `testing.reset()` | every runtime test |

### Two channels, two trust levels

The invalidation envelope carries value-broadcast observables to every
authorized subscriber. Only `version` and `lifeTotals` cross the wire.

`seatOne` and `seatTwo` use `broadcastInvalidation()`. Solid Objects compares
the real seat summaries and sends only the changed names. The actor needs no
application-maintained revision counters, and no player data enters the shared
envelope.

Card identity moves through the `game` payload. One seat sees its own hand
and library. The other seat sees the same number of cards, and each card reads
"Hidden card".

The component registry observes the seat names directly. When seat 2 taps a
card, only the seat 2 component refreshes. That refresh goes through an HTTP
endpoint that authorizes the request again.

## Layout

```
src/
  actors/            GameRoom and MatchLog
  archidekt/         deck search and deck import client
  game/              pure domain: actions, player rules, room projection
  server/            node:http router, session cookies, ws bridge, HTML rendering
  runtime.ts         configure the runtime, effects, commit actions, policies
  main.ts            entry point
public/              browser client and stylesheet
test/                171 tests
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHUFFLE_SECRET` | none, required | signs the session cookie, 32 characters or more |
| `SHUFFLE_DATABASE_PATH` | `storage/solid-objects.sqlite3` | SQLite file |
| `SHUFFLE_OPERATOR_DASHBOARD` | none | `true`, `authorized-read-only`, or `public-read-only` mounts the dashboard |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | none | `production` adds `Secure` to the session cookie |

## Deployment

The app deploys with [Kamal](https://kamal-deploy.org) to a single Docker host.
Cloudflare terminates public TLS, and kamal-proxy serves a Cloudflare Origin
certificate to Cloudflare. Set the Cloudflare SSL mode to Full (strict).

```bash
KAMAL_SERVER_HOST=your-host KAMAL_SSH_USER=your-user kamal setup     # first deploy
KAMAL_SERVER_HOST=your-host KAMAL_SSH_USER=your-user kamal deploy    # later deploys
```

`config/deploy.yml` keeps the host in an environment variable, so no server
address enters this repository. `KAMAL_SSH_USER` defaults to `app`, so set it
when the server uses a different account. `.kamal/secrets` reads every
credential from 1Password and holds no raw values.

| Secret | Purpose |
| --- | --- |
| `KAMAL_REGISTRY_PASSWORD` | pushes the image to the container registry |
| `CLOUDFLARE_ORIGIN_CERT` | origin certificate that kamal-proxy serves |
| `CLOUDFLARE_ORIGIN_KEY` | private key for that certificate |
| `SHUFFLE_SECRET` | signs the session cookie |

SQLite lives on the `shuffleupandplay-storage` volume at `/app/storage`, so the
database survives a deploy. `GET /up` answers the proxy health check without a
session.

## License

MIT. See [MIT-LICENSE](MIT-LICENSE).

Magic: The Gathering is a trademark of Wizards of the Coast LLC. This project
has no relation to and no endorsement from Wizards of the Coast. Card images
come from [Scryfall](https://scryfall.com), and deck import uses the public
[Archidekt](https://archidekt.com) API.
