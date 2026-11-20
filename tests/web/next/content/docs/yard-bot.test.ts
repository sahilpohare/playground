import { expect, test } from "bun:test"
import { join } from "node:path"

import { HELD_KINDS } from "../../../../../api/hono/src/lib/yard/tier"
import { MAX_TEXT, MESSAGE_KINDS, RETENTION_DAYS } from "../../../../../packages/message/src/index"

// The bot guide is handed to a bot as it is, so every route and number it names must be one Yard's code holds.
const ROOT = join(import.meta.dir, "../../../../..")
const read = (path: string) => Bun.file(join(ROOT, path)).text()
const page = await read("web/next/content/docs/yard-bot.mdx")
const router = await read("api/hono/src/routers/yard.ts")
const store = await read("api/hono/src/lib/yard/store.ts")
const dispatcher = await read("api/hono/src/routers/dispatcher.ts")

const PREFIX = "/api/v1/yard"

// Each route yard.ts mounts, as its method and path under the prefix.
const routes = new Set(
  [...router.matchAll(/\.(get|post|delete)\(\s*"([^"]+)"/g)].map(
    ([, method, path]) => `${method!.toUpperCase()} ${PREFIX}${path}`,
  ),
)

// The numbers the code holds: the text limit, retention, the post limits, a page's default and largest size, and the statuses a bot's call answers.
const postLimits = /POST_LIMITS = \{([^}]+)\}/.exec(store)![1]!
const messagesRead = store.slice(store.indexOf("export const messages"))
const pageSize = /limit = (\d+)/.exec(messagesRead)![1]!
const messagesQuery = router.slice(router.indexOf('"/bot/messages"'))
const pageMax = /limit: z\.coerce\.number\(\)\.int\(\)\.min\(\d+\)\.max\((\d+)\)/.exec(
  messagesQuery,
)![1]!
// the log route's page, the size the Mac answers it in
const logPage = /LOG_PAGE = (\d+)/.exec(dispatcher)?.[1] ?? "none"
// the log's first cursor, the lowest after the Mac's route takes
const logStart =
  /after: z\.coerce\.number\(\)\.int\(\)\.min\((\d+)\)/.exec(dispatcher)?.[1] ?? "none"
const STATUSES = ["201", "400", "401", "403", "404", "429", "503"]
const held = [
  String(MAX_TEXT),
  String(RETENTION_DAYS),
  ...[...postLimits.matchAll(/(\d+)/g)].map((m) => m[1]!),
  pageSize,
  pageMax,
  logPage,
  logStart,
  ...STATUSES,
]

test("every route the bot guide names is one yard.ts mounts, and it names both of the bot's message routes and the log route", () => {
  const named = [
    ...page.matchAll(/\b(GET|POST|DELETE) \$YARD_HOST(\/api\/v1\/yard\/[^\s?`]+)/g),
  ].map(([, method, path]) => `${method} ${path}`)
  expect(named.filter((route) => !routes.has(route))).toEqual([])
  expect(new Set(named)).toEqual(
    new Set([`GET ${PREFIX}/bot/log`, `GET ${PREFIX}/bot/messages`, `POST ${PREFIX}/bot/messages`]),
  )
  expect(page.match(/\/api\/v1\/yard/g)).toHaveLength(named.length)
})

test("every number the bot guide names is one the code holds, and it names each limit", () => {
  const numbers = [...page.matchAll(/(?<![\w.-])(\d+)(?![\w-]|\.\d)/g)].map((m) => m[1]!)
  expect(numbers.filter((n) => !held.includes(n))).toEqual([])
  for (const n of [
    String(MAX_TEXT),
    String(RETENTION_DAYS),
    ...postLimits.match(/\d+/g)!,
    pageSize,
    pageMax,
    logPage,
  ])
    expect(numbers).toContain(n)
  for (const status of ["401", "403", "429"]) expect(page).toContain(`- ${status}: `)
})

test("the bot guide lists the kinds a bot may send, the ones Yard never holds, and names the held ones as refused", () => {
  const free = MESSAGE_KINDS.filter((kind) => !(HELD_KINDS as readonly string[]).includes(kind))
  const sendable = /`kind` is one of ([^\n]+)/.exec(page)![1]!
  expect([...sendable.matchAll(/`([a-z]+)`/g)].map((m) => m[1])).toEqual([...free])
  for (const kind of HELD_KINDS) expect(page).toContain(`\`${kind}\``)
})

test("the bot guide names its two settings with no value and no DM id (#1995), in plain markdown with no components", () => {
  for (const name of ["YARD_HOST", "YARD_BOT_TOKEN"]) expect(page).toContain(`\`${name}\``)
  expect(page).not.toContain("YARD_DM_ID")
  expect(page).not.toMatch(/yard_[A-Za-z0-9_-]{8,}/)
  expect(page).not.toMatch(/https?:\/\//)
  expect(page).not.toMatch(/^(import|export) /m)
  expect(page).not.toMatch(/<[A-Z]/)
})

test("the bot guide pages the log by its after cursor, the last seq it read (#1888)", () => {
  const section = page.slice(page.indexOf("## Read the dispatcher's log"))
  expect(section).toContain("GET $YARD_HOST/api/v1/yard/bot/log?after=")
  for (const word of ["`after`", "`seq`", "`hasMore`", "`session`", "[hidden]", "- 503: "])
    expect(section).toContain(word)
})
