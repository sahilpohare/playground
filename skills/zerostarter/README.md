# ZeroStarter's skills

Each skill here, by its description's summary.
`packages/scripts/src/skills-manager.ts` writes both tables from each skill's frontmatter, so edit the description, never a table.

**Custom**

<!-- skills:custom -->

| Skill                                     | Description                                                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [add-package](add-package/SKILL.md)       | Add a new shared workspace package under packages/*.                                                                                                                               |
| [api-endpoint](api-endpoint/SKILL.md)     | Add a typed Hono API endpoint or WebSocket route: router, OpenAPI docs, validation envelope, and RPC client wiring.                                                                |
| [audit](audit/SKILL.md)                   | Run the dependency security audit, update every package to its latest version, and maintain docs/dependencies.md.                                                                  |
| [codebase-map](codebase-map/SKILL.md)     | Orient in this repo: which file to edit for a change, how a change ripples across the stack, and how to search the code.                                                           |
| [db-migration](db-migration/SKILL.md)     | Create and apply a Drizzle schema change.                                                                                                                                          |
| [design](design/SKILL.md)                 | Follow and maintain the app's UI conventions.                                                                                                                                      |
| [dev](dev/SKILL.md)                       | Start, restart, and verify the Playground dev stack. `bun run dev` serves portless named `.localhost` URLs (branch-prefixed in a worktree); resolve them with `bunx portless get`. |
| [doc-sync](doc-sync/SKILL.md)             | Sync docs and skills so they never drift from the code.                                                                                                                            |
| [docker-test](docker-test/SKILL.md)       | Build and smoke-test the Docker images with docker compose, and run the golden end-to-end suite against them.                                                                      |
| [fonts](fonts/SKILL.md)                   | Add, swap, or remove a self-hosted web font (latin variable woff2 from fontsource, localized via next/font/local).                                                                 |
| [gh-commit](gh-commit/SKILL.md)           | Create atomic commits in the conventional format.                                                                                                                                  |
| [ignore-sync](ignore-sync/SKILL.md)       | Mirror .gitignore to .dockerignore.                                                                                                                                                |
| [release](release/SKILL.md)               | Cut a production release by promoting canary to main.                                                                                                                              |
| [runtime-apis](runtime-apis/SKILL.md)     | Prefer Bun-native APIs, else Node built-ins with the node: prefix.                                                                                                                 |
| [shadcn-sync](shadcn-sync/SKILL.md)       | Run and reconcile the shadcn component sync (`bun run shadcn:update`).                                                                                                             |
| [skills-manager](skills-manager/SKILL.md) | Keep the skills tables in skills/zerostarter/README.md generated from skill descriptions, and understand how a fork syncs its skills from upstream.                                |
| [ui-verify](ui-verify/SKILL.md)           | Verify a frontend or UI change in a real browser.                                                                                                                                  |

<!-- /skills:custom -->

**Vendored** (upstream, copied verbatim)

<!-- skills:vendored -->

| Skill                                   | Description                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [agent-browser](agent-browser/SKILL.md) | Browser automation CLI for AI agents.                                                                                    |
| [portless](portless/SKILL.md)           | Set up and use portless for named local dev server URLs (e.g. https://myapp.localhost instead of http://localhost:3000). |

<!-- /skills:vendored -->
