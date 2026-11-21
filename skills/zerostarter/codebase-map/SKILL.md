---
name: codebase-map
description: "Orient in this repo: which file to edit for a change, how a change ripples across the stack, and how to search the code. Use at the start of a task in an unfamiliar area, or before a cross-cutting change."
source: https://github.com/nrjdalal/zerostarter
---

# Codebase Map

One Bun + Turborepo monorepo: two deployable apps over shared packages. Imports use `@api/hono`, `@packages/*`, and the `@/` alias, never deep relative paths. A script under `extensions/` is the exception: the root links no `@packages`, since only `api/*`, `packages/*` and `web/*` are workspaces, so it reaches a package's `src` by a relative path, as the tests do.

```
.generated/           # repo-root home for build-time generated assets (gitignored)
api/hono/             # backend (Hono): routers, middlewares, the AppType export
web/next/             # frontend (Next.js App Router): app/, components/, lib/, content/
packages/auth/        # Better Auth instance
packages/db/          # Drizzle schema + client
packages/message/     # the Yard message schema (Zod) the server and every client parse
packages/redis/       # the lock store on Bun's Redis client (REDIS_URL), the merge lock's holder
packages/safe-delete/ # playground rm's trash: quarantine, restore, the trash purge, the protected list, removeScratch
packages/settings/    # Playground's typed settings, the factory's items store and its jobs, read by the hooks and ops scripts
packages/env/         # type-safe env, one validated entry per consumer
packages/config/      # TS base, tsdown factory, and site.ts (brand identity)
packages/scripts/     # build-only bun tooling (auth-schema, data-table-metrics, generate-env, lock, pr-merge, verify); every new script lands here, never bundled but for `ops-machine/readings`, which the API's bundle inlines
packages/cli/         # the zerostarter scaffolding CLI (canonical repo only; init strips it)
tests/                # the whole suite, mirroring each subject's path; *.e2e.test.ts drive a running stack (canonical repo only; forks take no tests)
```

Read `AGENTS.md` first for the rules (the dashboard app's are in `.agents/dashboard/<topic>.md`: AGENTS.md holds each ALWAYS rule in one line and a pointer naming when to read its file); `curl --cacert <pdir>/ca.pem "$(PORTLESS_STATE_DIR=<pdir> bunx portless get playground)/llms-full.txt"`, with `<pdir>` the path the `dev` skill's Start prints, dumps the whole codebase as one context file.

## Trace a feature across the stack

Types flow downhill, so a change ripples predictably:

```
packages/db/src/schema  →  api/hono/src/routers  →  api/hono/src/local.ts (AppType)  →  web/next/src/lib/api/client.ts  →  app / components
```

To add a field end to end: edit and migrate the schema, then select and return it in the router. Every `apiClient` call site is retyped automatically, and the compiler becomes your worklist of what still must change.

A `packages/scripts` file that needs an api type spells the type out locally, and a test that imports the api file relatively pins that copy to the real schema, since a type-only import of an api file that imports `@packages/db` still pulls the file into `@packages/scripts`' tsc, which fails with TS2307.

## Entry points (read these first)

- `api/hono/src/local.ts`, the `.route()` chain and `export type AppType`, the whole local API shape in one file; `index.ts` serves it, or `hosted.ts` (sign-in, health and Yard, typed by `HostedAppType`) under `PLAYGROUND_HOSTED=1`.
- `web/next/src/app/layout.tsx`, the web root.
- `packages/config/src/site.ts`, brand identity and injectable content.

## Fast find

```bash
rg -n "\.route\(" api/hono/src/local.ts               # every mounted router
rg -n "export const \w+Router" api/hono/src/routers   # every router definition
ls packages/db/src/schema                             # every schema file (tables)
rg -n "apiClient\." web/next/src                      # every API call site
rg -n "SOME_ENV_VAR" packages/env                     # where an env var is declared
ls .agents/skills                                     # every task skill available
```

A rev held in a variable takes braces before `:path`, since zsh reads the letter after `$REV:` as a modifier: `$REV:src/index.ts` stops the line with `bad substitution`, and `$REV:api/...`, `$REV:tests/...` or `$REV:hono/...` run on a silently rewritten rev (`:a`, `:t`, `:h`; measured, while bash reads the same text fine): write `git show ${REV}:src/index.ts`.
A shell profile may hold an alias on a short name, so a helper function of the same name fails to define (`defining function based on alias`, measured); give a helper function a longer name.

## Then

Load the task skill that fits; `dev` runs and restarts the stack, and concept docs live under `/docs`.
