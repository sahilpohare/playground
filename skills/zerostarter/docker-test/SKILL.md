---
name: docker-test
description: Build and smoke-test the Docker images with docker compose, and run the golden end-to-end suite against them. Use when touching a Dockerfile, the bundle build, compose config, or a *.e2e.test.ts.
source: https://github.com/nrjdalal/zerostarter
---

# Docker Testing

The web image builds on the runner host, never on this Mac while the live dashboard's Postgres runs in its Docker VM ([why](../../../scripts/hooks/README.md#no-mac-web-build)).
Commit, then build it there with the smoke `.env` and the single-libc check below, the image removed after:

```bash
bash ~/.playground/ops/runner-host/ci.sh web HEAD
```

It exits with the build's code, or 255 when the box cannot take it; nothing falls back to the Mac.
With no runner host set (`RUNNER_HOST`, or the data folder's `ops/runner-host/ip`), it exits 255 at once, and the live dashboard's Postgres stays up: set one up (a peer machine of your own user, by [scripts/ops/README.md](../../../scripts/ops/README.md#runner-host)'s runner-host section, then write its address to that ip file), or build the web image on a machine with no live dashboard running.
The api image still builds here, so a recipe below that names `api` runs as written; a full-stack one runs only on a Mac whose Docker VM holds no live dashboard's Postgres.

Full stack, the same Dockerfiles prod ships, built through run-slot, then started with `--no-build`, since a compose `up` builds every missing image at once.
run-slot runs one docker build at a time on the machine, a compose build one service at a time, each in a BuildKit builder capped at half the Docker VM's memory, so a build that outgrows the cap fails there rather than filling the Docker VM the live dashboard's Postgres shares.
A build that needs more than the cap needs a larger VM, the owner's setting.

```bash
~/.playground/ops/run-slot.sh <your name> -- docker compose build --no-cache && docker compose up --no-build
```

Scope to one service while iterating:

```bash
~/.playground/ops/run-slot.sh <your name> -- docker compose build --no-cache api && docker compose up -d --no-build api
curl -sf --retry 30 --retry-delay 1 --retry-connrefused http://localhost:4000/api/health
docker compose logs -f api
docker compose down
```

## .env

- **Where it comes from.** The build reads `.env` as a BuildKit secret (compose wires `secrets: dotenv` from `./.env`; a plain build passes `--secret id=dotenv,src=.env`) and validates it in full; `up` loads it via `env_file: .env`. The secret mounts only during the build RUN and never lands in a layer. A missing `.env` fails fast: compose reports "secret file not found", docker build "secret not provided"; invalid runtime env crashes the container loudly at boot.
- **Smoke build vs deploy image.** A clean checkout has no real `.env`, so give a smoke build a dummy from `.env.example` with the required blanks filled:

  ```bash
  sed -e 's|^BETTER_AUTH_SECRET=$|BETTER_AUTH_SECRET=dummy|' \
      -e 's|^POSTGRES_URL=$|POSTGRES_URL=postgres://dummy:dummy@localhost:5432/dummy|' \
      -e 's|^AGENT_SIGNIN_ENABLED=$|AGENT_SIGNIN_ENABLED=true|' \
      .env.example > .env
  ```

  Empty optionals (e.g. `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=`) pass via `emptyStringAsUndefined`. A smoke build is disposable: Next inlines `NEXT_PUBLIC_*` into the bundle at build, so a dummy-built web image carries dummy URLs forever. Deploy images build with the real `.env`.
- **`--no-cache` after any `.env` edit.** Secret contents are not part of BuildKit's cache key, so a plain rebuild reuses the cached build RUN and silently ships stale baked values (web's `NEXT_PUBLIC_*`).
- **Skip `SKIP_ENV_VALIDATION`.** Build and runtime both load a real `.env`, so both validate real values. The flag no longer bypasses validation anyway: it only substitutes shape-valid dummies for *missing* required vars while zod defaults and transforms still run (`HONO_PORT` defaults to 4000, `HONO_TRUSTED_ORIGINS` parses to an array). Reserve it for CI, which genuinely lacks a `.env`. The web deploy uses the narrower `SKIP_ENV_VALIDATION_SERVER`, which dummies only server secrets while still validating the `NEXT_PUBLIC_*` it inlines.
- **`NODE_ENV` is read at runtime.** The API bundle is built with `bun build --env disable`, so bun does not bake `process.env.NODE_ENV` from the build shell, where `.env` is never sourced and the value would always be "development". What `up` loads from `.env` wins: `/api/health` reports it as `environment`, and `NODE_ENV=local` with `AGENT_SIGNIN_ENABLED=true` mounts the agent sign-in inside the container.
- **Database.** Without a reachable `POSTGRES_URL`, DB-backed routes (e.g. `/api/v1/user`) return 500 while `/api/health` answers degraded (`"db":"unreachable"` with the error, still HTTP 200), which `bun run verify problems` names. The end-to-end suite below needs one: a disposable container published on loopback alone (`docker run -d --name playground-<worktree>-db -e POSTGRES_PASSWORD=<pw> -p 127.0.0.1::5432 postgres:alpine`, then `docker port playground-<worktree>-db 5432` for its port; the `db-migration` skill's step 3), written into `.env` as `host.docker.internal:<port>` so the containers reach it (OrbStack routes `host.docker.internal` to the host's loopback, so a container reaches the loopback publish), and migrated first with `POSTGRES_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres bun run db:migrate`.
- **Direct `docker run --env-file`** does not strip inline comments: `HONO_RATE_LIMIT=60 # note` arrives as `"60 # note"`, coerces to NaN, and validation rejects it. Compose's parser strips them; for `docker run`, sanitize first: `sed 's/ #.*//' .env > .env.docker`.
- **Ports** `4000` and `3000` collide with a running dev stack; for side-by-side testing bump the compose mappings (e.g. `14000:4000`) in a scratch checkout.

## Self-containment check (catches runtime auto-install)

The api runner ships only `bundle/`, so the bundle must resolve every import with no `node_modules`. When one is missing, Bun's runtime auto-install fetches it from npm, so a container that "works" online may be downloading packages at cold start or on a later request. The image runs `bun --no-install`, which turns that off: a missing import fails at once instead. Two probes prove both halves, offline:

```bash
sed 's/ #.*//' .env > .env.docker
docker run -d --name t-offline --network=none --env-file .env.docker <image>
docker exec t-offline sh -c 'for i in $(seq 1 30); do wget -qO- http://localhost:4000/api/health && exit 0; sleep 1; done; exit 1'
docker logs t-offline        # on failure: "Cannot find package 'X'" = an import the bundle needs and does not carry
# the first sign-in is where Better Auth reaches for its optional telemetry import; it answers with the database error here (nothing is reachable), and it must answer at once
time docker exec t-offline sh -c 'wget -qO- --post-data=x --header="Origin: http://localhost:3000" http://localhost:4000/api/agents/sign-in-as; echo'
docker diff t-offline | grep .bun/install/cache   # must print nothing
docker rm -fv t-offline
```

Health alone proves nothing about sign-in: the telemetry import fires on the first Better Auth call, not at boot. Before `--no-install`, this container fetched `@opentelemetry/api` (some 640 files) on that call whenever it had a network, and stalled on it when it did not. Run the same `docker diff` on the online container after the golden suite; entries under `.bun/install/cache` mean a runtime install got past the flag (history: `--external hono` in the bundle build fetched hono from npm at cold start).

## Single-libc check (web image, catches silent re-bloat)

The web build prunes the unused libc stack from standalone (libc is auto-detected at build; an alpine base means musl). Store-layout or dep-rename drift regresses it back into bloat silently, so assert after any web image build:

```bash
docker run --rm --entrypoint sh playground-web -c \
  'find /app/node_modules \( -name "*linux-*-gnu*" -o -name "*sharp-linux-*" -o -name "*libvips-linux-*" \) ! -type l | grep . && echo "FAIL: glibc stack shipped" && exit 1; echo OK'
```

Expect `OK`; `ci.sh web` runs this check on the box and prints `ok single-libc`. `! -type l` skips dangling glibc-named symlinks (expected leftovers); only real files count. Any hit means the excludes in `web/next/next.config.ts` stopped matching, so fix the patterns, never delete the assertion.

## End-to-end golden suite

With the stack up on a fresh disposable database, run every `*.e2e.test.ts` under `tests/` against it:

```bash
E2E_POSTGRES_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres bun run test:e2e
```

`E2E_API_URL` and `E2E_WEB_URL` default to the compose ports. The suite signs in as `LocalAgent` and asserts the stage is `local` (so `.env` needs `NODE_ENV=local` and `AGENT_SIGNIN_ENABLED=true`, plus both OAuth credential pairs set, the id and the secret of each, which the dummy `.env` above already does: left blank, the providers endpoint lists only `agent` and its snapshot fails; it is a suite for a local-stage stack, never a deployed one, and a URL whose host is not local is refused at load), drives the organization plugin, the console routes, the waitlist and the web pages, and snapshots every contract response after normalizing ids, timestamps and the build version. A snapshot mismatch is a contract change: review it, then `bun run test:e2e --update-snapshots`. The users list assumes LocalAgent is the only account, which is why the database is fresh; `E2E_POSTGRES_URL` is what lets the suite seed and remove a second account for the role and ban flows, and it refuses any host that is not local and any database holding an account beyond the agent and the seed, so neither the shared database nor a populated local one can be seeded by mistake; the stack's own `POSTGRES_URL` must be disposable for the same reason, since the suite writes through the API. Done when it prints 0 fail twice in a row: the second run proves the goldens are deterministic and that a run removes what it created (its organization, rules, signups, seeded account and sessions; the audit log keeps its rows by design, and the goldens read only the entries a run adds).

In a browser against the images, sign in as `LocalAgent` by submitting the agent sign-in form from the page's console, and the 302 lands on the dashboard with the session (cookies on `localhost` do not isolate by port):

```js
document.body.appendChild(Object.assign(document.createElement("form"), { method: "POST", action: "http://localhost:4000/api/agents/sign-in-as" })).submit()
```

## Notes

- Start the daemon if needed: `open -a Docker`, then poll `docker info` until ready.
- `.dockerignore` excludes real `.env*` from the build context (only `.env.example` enters), so the context itself carries no secret.
