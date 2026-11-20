import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Channel, Message } from "../../../../../packages/message/src/index"
import { liveBranch } from "../../../../../packages/scripts/src/playground/probe"
import { runYard, type YardIo, yardIo } from "../../../../../packages/scripts/src/playground/yard"
import { settingHistory } from "../../../../../packages/settings/src/settings-folder"

type YardClient = import("../../../../../api/hono/src/lib/yard/client").YardClient
const { YardError } = await import("../../../../../api/hono/src/lib/yard/client")

const OPS: Channel = {
  id: "c1",
  joined: true,
  kind: "channel",
  lastMessageAt: null,
  mentions: 1,
  name: "ops",
  peer: null,
  postRule: "members",
  topic: null,
  unread: 2,
}
const DM: Channel = {
  ...OPS,
  id: "dm1",
  kind: "dm",
  name: "dm:a:b",
  peer: { id: "b", image: null, login: "Bo", name: "Bo" },
}
const MESSAGE: Message = {
  at: "2026-10-31T10:00:00.000Z",
  channel: "c1",
  from: { device: "studio", login: "bo" },
  id: "m1",
  kind: "question",
  text: "anyone up?",
}

// A made-up bot and its made-up token, which no line the command prints may hold.
const BOT_SECRET = "yard_madeUpBotTokenForTheTestOnly42"
const BOT = {
  createdAt: "2026-11-12T00:00:00.000Z",
  dm: "dm-bot",
  login: "grok[bot]",
  name: "grok",
  readsLog: false,
}

// A fake hosted Yard, Keychain and terminal, so nothing reaches any of them for real.
const setUp = (
  over: Partial<YardIo> & {
    botGone?: boolean
    keychainRefuses?: boolean
    token?: string | null
    status?: Message["status"]
    me?: () => Promise<unknown>
  } = {},
) => {
  const lines: string[] = []
  const calls: unknown[][] = []
  const stored: string[] = []
  const readers: string[] = []
  const io = {
    api: "https://api.yard.example",
    client: (base, token) => {
      calls.push(["client", base, token])
      return {
        channels: async () => [OPS, DM],
        me: over.me ?? (async () => ({ login: "owner", owner: true })),
        messages: async (id: string) => (
          calls.push(["messages", id]),
          { hasMore: false, messages: [MESSAGE] }
        ),
        post: async (id: string, post: unknown) => (
          calls.push(["post", id, post]),
          { ...MESSAGE, id: "m9", status: over.status ?? "sent" }
        ),
        read: async (id: string) => (calls.push(["read", id]), { lastReadAt: MESSAGE.at }),
        addBot: async (name: string, options?: { log?: boolean }) => (
          calls.push(["addBot", name, ...(options?.log ? [options] : [])]),
          { bot: { ...BOT, name, login: `${name}[bot]` }, secret: BOT_SECRET }
        ),
        revokeBot: async (name: string) => {
          calls.push(["revokeBot", name])
          if (over.botGone) throw new YardError(404, "Bot not found")
          return { ...BOT, name, login: `${name}[bot]` }
        },
      } as unknown as YardClient
    },
    botKeychain: (name: string) =>
      ({
        read: async () => null,
        remove: async () => void stored.push(`removed playground-yard-bot-${name}`),
        write: async (token: string) => {
          if (over.keychainRefuses) throw new Error("the Keychain refused it: locked")
          stored.push(`playground-yard-bot-${name}=${token}`)
        },
      }) as YardIo["keychain"],
    err: (line) => lines.push(`err: ${line}`),
    logReaders: {
      add: async (login: string, dm: string) => void readers.push(`+${login} ${dm}`),
      remove: async (login: string) => void readers.push(`-${login}`),
    },
    keychain: {
      read: async () => ("token" in over ? over.token : "yard_mac"),
      remove: async () => void stored.push("removed"),
      write: async (token: string) => void stored.push(token),
    } as YardIo["keychain"],
    out: (line) => lines.push(line),
    readSecret: async () => "yard_pasted\n",
    web: "https://yard.example",
    ...over,
  } as YardIo
  return { calls, io, lines, readers, stored }
}

describe("playground yard", () => {
  test("login checks the pasted token with Yard before the Keychain keeps it", async () => {
    const ok = setUp()
    expect(await runYard(["login"], ok.io)).toBe(0)
    expect(ok.stored).toEqual(["yard_pasted"])
    expect(ok.lines).toEqual(["Signed in to Yard as @owner; the token is in the Keychain"])
    const refused = setUp({
      me: async () => {
        throw new YardError(401, "Unauthorized")
      },
    })
    expect(await runYard(["login"], refused.io)).toBe(1)
    expect(refused.stored).toEqual([])
  })

  test("channels lists channels and DMs with their counts", async () => {
    const { io, lines } = setUp()
    expect(await runYard(["channels"], io)).toBe(0)
    expect(lines).toEqual(["#ops\t2 unread\t1 mentions\tc1", "@Bo\t2 unread\t1 mentions\tdm1"])
  })

  test("read finds a channel by #name or a DM by @login and prints its messages, leaving the owner's unread counts", async () => {
    const { calls, io, lines } = setUp()
    expect(await runYard(["read", "#ops"], io)).toBe(0)
    expect(lines).toEqual(["2026-10-31T10:00:00.000Z @bo (studio) [question]: anyone up?"])
    expect(calls.slice(1)).toEqual([["messages", "c1"]])
    expect(await runYard(["read", "@bo"], io)).toBe(0)
    expect(calls.at(-1)).toEqual(["messages", "dm1"])
  })

  test("post sends as its --kind, and names Yard's approve page when Yard holds it", async () => {
    const sent = setUp()
    expect(await runYard(["post", "ops", "hello there"], sent.io)).toBe(0)
    expect(sent.calls.at(-1)).toEqual(["post", "c1", { kind: "text", text: "hello there" }])
    expect(sent.lines).toEqual(["Posted to #ops"])
    const held = setUp({ status: "pending" })
    expect(await runYard(["post", "ops", "run it", "--kind", "steps"], held.io)).toBe(0)
    expect(held.calls.at(-1)).toEqual(["post", "c1", { kind: "steps", text: "run it" }])
    expect(held.lines).toEqual(["Held for your approval: https://yard.example/yard/approve/m9"])
    expect(await runYard(["post", "ops", "x", "--kind", "shout"], held.io)).toBe(2)
    expect(await runYard(["post", "ops", "--kind", "steps"], held.io)).toBe(2)
  })

  test("bot add writes the bot's token to its own Keychain item and prints only the item's name", async () => {
    const { calls, io, lines, stored } = setUp()
    expect(await runYard(["bot", "add", "grok"], io)).toBe(0)
    expect(calls.at(-1)).toEqual(["addBot", "grok"])
    expect(stored).toEqual([`playground-yard-bot-grok=${BOT_SECRET}`])
    expect(lines.join("\n")).toContain("playground-yard-bot-grok")
    expect(lines.join("\n")).toContain("dm-bot")
    expect(lines.join("\n")).not.toContain(BOT_SECRET)
    expect(lines.join("\n")).not.toContain("yard_madeUp")
  })

  test("bot add --log puts the bot on this Mac's yard.logReaders and leaves Yard's grant to the owner's browser, and a revoke takes it off (#1888, #2032)", async () => {
    const { calls, io, lines, readers } = setUp()
    expect(await runYard(["bot", "add", "grok", "--log"], io)).toBe(0)
    expect(calls.at(-1)).toEqual(["addBot", "grok"])
    expect(readers).toEqual(["+grok[bot] dm-bot"])
    expect(lines.join("\n")).toContain(
      "once the owner turns its log switch on in Yard's Account page",
    )
    expect(await runYard(["bot", "revoke", "grok"], io)).toBe(0)
    expect(readers).toEqual(["+grok[bot] dm-bot", "-grok[bot]"])
    const plain = setUp()
    expect(await runYard(["bot", "add", "grok"], plain.io)).toBe(0)
    expect(plain.readers).toEqual([])
    expect(await runYard(["bot", "add", "grok", "--logs"], plain.io)).toBe(2)
  })

  test("bot add revokes the bot it made when the Keychain will not keep its token, and prints no token", async () => {
    const { calls, io, lines, stored } = setUp({ keychainRefuses: true })
    expect(await runYard(["bot", "add", "grok"], io)).toBe(1)
    expect(calls.at(-1)).toEqual(["revokeBot", "grok"])
    expect(stored).toEqual([])
    expect(lines.join("\n")).not.toContain(BOT_SECRET)
  })

  test("bot revoke revokes the bot on Yard and deletes its Keychain item, also when Yard has no such bot", async () => {
    const made = setUp()
    expect(await runYard(["bot", "revoke", "grok"], made.io)).toBe(0)
    expect(made.calls.at(-1)).toEqual(["revokeBot", "grok"])
    expect(made.stored).toEqual(["removed playground-yard-bot-grok"])
    const gone = setUp({ botGone: true })
    expect(await runYard(["bot", "revoke", "grok"], gone.io)).toBe(0)
    expect(gone.stored).toEqual(["removed playground-yard-bot-grok"])
  })

  test("bot refuses a name its Keychain item cannot take, and a verb it does not know", async () => {
    const { calls, io } = setUp()
    expect(await runYard(["bot", "add", "Grok!"], io)).toBe(2)
    expect(await runYard(["bot", "add", "../yard"], io)).toBe(2)
    expect(await runYard(["bot", "list"], io)).toBe(2)
    expect(calls.filter(([verb]) => verb === "addBot")).toEqual([])
  })

  test("says what is missing: no Yard set up, no token, no such channel", async () => {
    const off = setUp({ api: undefined })
    expect(await runYard(["channels"], off.io)).toBe(1)
    expect(off.lines[0]).toContain("Yard is not set up here")
    const out = setUp({ token: null })
    expect(await runYard(["channels"], out.io)).toBe(1)
    expect(out.lines).toEqual(["err: No Yard token on this Mac: run playground yard login"])
    const lost = setUp()
    expect(await runYard(["read", "#nope"], lost.io)).toBe(1)
    const slow = setUp({
      me: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError")
      },
    })
    expect(await runYard(["login"], slow.io)).toBe(1)
    expect(slow.lines).toEqual(["err: Yard: The operation timed out."])
  })
})

describe("yardIo's yard.logReaders write", () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
  })

  test("records the calling session as its author and the command line as its actor, never the owner (#2032)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "yard-readers-")))
    dirs.push(root)
    const login = process.env.PLAYGROUND_LOGIN
    process.env.PLAYGROUND_LOGIN = "made-up-me"
    Bun.spawnSync(["git", "init", "-q", root])
    const authorOf = async (env: Record<string, string>, data: string) => {
      const io = await yardIo(root, async () => "", data, env)
      await io.logReaders.add("grok[bot]", "dm-bot")
      const [entry] = settingHistory(data, "yard.logReaders") ?? []
      return [entry?.author, entry?.actor]
    }
    expect(await authorOf({ PLAYGROUND_ROLE: "worker" }, join(root, "session"))).toEqual([
      "worker",
      "cli",
    ])
    expect(await authorOf({}, join(root, "terminal"))).toEqual(["cli", "cli"])
    if (login === undefined) delete process.env.PLAYGROUND_LOGIN
    else process.env.PLAYGROUND_LOGIN = login
  })
})

describe("yardIo reads the live dashboard checkout's .env", () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { force: true, recursive: true })
  })

  // A clone of a made-up repo whose worktree on the live branch holds the fake .env, the clone itself holding none, built the way probe.test.ts builds its fixtures.
  const cloneWithLive = (env: string): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "yard-live-")))
    dirs.push(root)
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=fixture", "-c", "user.name=a", ...args], {
        cwd: root,
      })
    git("init", "-q", "-b", "main", "origin")
    git("-C", "origin", "commit", "-q", "--allow-empty", "-m", "first")
    git("clone", "-q", "origin", "repo")
    const repo = join(root, "repo")
    const live = join(repo, ".claude", "worktrees", "desk")
    git("-C", "repo", "worktree", "add", "-b", liveBranch(), live)
    writeFileSync(join(live, ".env"), env)
    return repo
  }

  test("YARD_API_URL and YARD_WEB_URL come from the live checkout's .env when the environment holds none, so the CLI is set up here", async () => {
    delete process.env.YARD_API_URL
    delete process.env.YARD_WEB_URL
    const repo = cloneWithLive(
      "YARD_API_URL=https://api.yard.example\nYARD_WEB_URL=https://yard.example\n",
    )
    const io = await yardIo(repo, async () => "")
    expect(io.api).toBe("https://api.yard.example")
    expect(io.web).toBe("https://yard.example")
  })

  test("with no live checkout, the running checkout's .env stays unread and the CLI says it is not set up", async () => {
    delete process.env.YARD_API_URL
    delete process.env.YARD_WEB_URL
    const root = realpathSync(mkdtempSync(join(tmpdir(), "yard-live-")))
    dirs.push(root)
    Bun.spawnSync(["git", "init", "-q", root])
    writeFileSync(join(root, ".env"), "YARD_API_URL=https://api.yard.example\n")
    const lines: string[] = []
    const io = { ...(await yardIo(root, async () => "")), err: (l: string) => lines.push(l) }
    expect(io.api).toBeUndefined()
    expect(await runYard(["channels"], io)).toBe(1)
    expect(lines).toEqual([
      "Yard is not set up here: set YARD_API_URL in your environment or the live dashboard checkout's .env",
    ])
  })
})
