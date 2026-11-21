import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type Browser,
  CODE_WAIT_MS,
  openPrivate,
  profileUrl,
  startSetup,
  submitCode,
  urlOf,
} from "../../../../../../api/hono/src/lib/accounts/claude-setup"
import { MARKER } from "../../../../../../packages/safe-delete/src"
import { readSetting } from "../../../../../../packages/settings/src/settings-folder"
import { liveReads } from "../../../../../live-reads"

// The live branch runs `claude setup-token` through script's pty; here claude is the made-up one the fixture stacks run, first on PATH, beside a fake security and a fake open that log what reaches them.
liveReads()

const FAKE = join(import.meta.dir, "../../../../../../api/hono/src/fixtures/setup-token.ts")
const bin = mkdtempSync(join(tmpdir(), "claude-setup-"))
const log = join(bin, "log")
const items = join(bin, "items")
const script = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}`)
  chmodSync(join(bin, name), 0o755)
}
script(
  "claude",
  `printf 'claude %s cols %s browser %s\\n' "$*" "$(stty size | cut -d' ' -f2)" "$BROWSER" >> "${log}"\nexec "${process.execPath}" "${FAKE}" "$@"\n`,
)
// A claude that takes longer to print its link than a short expiry lasts, as a loaded machine does.
script("slow-claude", `sleep 0.6\nexec "${join(bin, "claude")}" "$@"\n`)
script("open", `printf 'open %s\\n' "$*" >> "${log}"\n`)
script(
  "security",
  `printf 'argv %s\\n' "$*" >> "${log}"
touch "${items}"
if [ "$1" = -i ]; then
  input=$(cat); printf 'stdin %s\\n' "$input" >> "${log}"
  echo "$input" | sed -E 's/.*-s "([^"]*)" -a "([^"]*)".*/\\1 \\2/' >> "${items}"; exit 0
fi
case "$1" in
  find-generic-password) grep -qx "$3 $5" "${items}" ;;
  *) exit 1 ;;
esac
`,
)
const path = process.env.PATH
const realFetch = globalThis.fetch
let fetched = 0
// No case reaches the network: the account reader is the fake below, and a fetch that slips past it is counted and fails.
globalThis.fetch = (async () => {
  fetched++
  throw new Error("this suite reaches no network")
}) as unknown as typeof fetch
const login = process.env.PLAYGROUND_LOGIN
process.env.PATH = `${bin}:${path}`
process.env.PLAYGROUND_LOGIN = "made-up-me"
// Every case reaches only the fakes: the file stops here unless claude and open resolve to them.
for (const name of ["claude", "open", "security"])
  if (Bun.which(name, { PATH: process.env.PATH }) !== join(bin, name))
    throw new Error(`${name} does not resolve to this test's fake, so no case runs`)
afterAll(() => {
  globalThis.fetch = realFetch
  process.env.PATH = path
  if (login === undefined) delete process.env.PLAYGROUND_LOGIN
  else process.env.PLAYGROUND_LOGIN = login
  rmSync(bin, { force: true, recursive: true })
})
beforeEach(() => writeFileSync(log, ""))

let n = 0
const fresh = () => join(bin, `data-${n++}`)
const apps = (...names: string[]) => {
  const dir = join(bin, `apps-${n++}`)
  for (const name of names) mkdirSync(join(dir, `${name}.app`), { recursive: true })
  return dir
}
const who = {
  actor: "test",
  author: "owner",
  inboxRef: null,
  reason: "add from the guided sign-in",
}
const logged = () => readFileSync(log, "utf8")
const tokenFor = (code: string) =>
  `sk-ant-oat01-${createHash("sha256").update(code).digest("hex")}-made-up-AA`
const EMAIL = "made-up@example.test"
const GONE =
  "This sign-in has ended, most likely because Playground restarted: start again for a new one"
// The account the sign-in names, as the reader of a kept token would answer it.
let signedIn: string | null | false = EMAIL
beforeEach(() => {
  signedIn = EMAIL
})
const fakes = {
  account: async () => signedIn,
  claude: join(bin, "claude"),
  open: join(bin, "open"),
  platform: "darwin" as const,
  profiles: bin,
}
// The fresh profile folder an open put in its argv.
const profileIn = (line: string) => line.match(/(?:--user-data-dir=|-profile )(\S+)/)?.[1] ?? ""

describe("the guided Claude sign-in", () => {
  test("setup answers the whole sign-in link, though it runs past 80 columns, and the first private-capable browser installed", async () => {
    const data = fresh()
    const started = await startSetup(
      { email: EMAIL },
      { ...fakes, applications: apps("Firefox", "Brave Browser"), data },
    )
    if (!started.ok) throw new Error(started.message)
    expect(started.url.length).toBeGreaterThan(80)
    expect(started.url).toMatch(
      /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&.*redirect_uri=https%3A%2F%2Fexample\.com.*&state=[0-9a-f]{32}$/,
    )
    expect(started.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(started.browser).toEqual({ app: "Brave Browser", name: "Brave" })
    expect(logged()).toMatch(/^claude setup-token cols (\d+) browser \/usr\/bin\/true\n$/)
    expect(Number(logged().match(/cols (\d+)/)![1])).toBeGreaterThan(started.url.length)
  })

  test("the code goes to setup-token's stdin, and the token it prints is kept under the email, never in an argv or the answer", async () => {
    const data = fresh()
    const started = await startSetup(
      { email: EMAIL, label: "work" },
      { ...fakes, applications: apps(), data },
    )
    if (!started.ok) throw new Error(started.message)
    expect(started.browser).toBeNull()
    const kept = await submitCode(started.id, "made-up-code", who, { ...fakes, data })
    expect(kept).toEqual({
      account: {
        email: EMAIL,
        key: EMAIL,
        label: "work",
        own: false,
        provider: "claude",
        stored: true,
      },
      confirmed: true,
      ok: true,
    })
    const token = tokenFor("made-up-code")
    expect(logged()).toContain(`-a "${EMAIL}" -w "${token}"`)
    expect(
      logged()
        .split("\n")
        .filter((line) => !line.startsWith("stdin "))
        .join("\n"),
    ).not.toContain(token)
    expect(logged()).not.toContain("made-up-code")
    expect(JSON.stringify(kept)).not.toContain(token)
    expect(readSetting(data, "usage.accounts")?.value).toEqual([
      { email: EMAIL, label: "work", provider: "claude" },
    ])
    expect(await submitCode(started.id, "made-up-code", who, { ...fakes, data })).toMatchObject({
      status: 404,
    })
  })

  test("a code as long as a real one, its code and state, is taken, since its Enter goes on its own", async () => {
    const data = fresh()
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })
    if (!started.ok) throw new Error(started.message)
    const code = `${"A1b2C3d4".repeat(10)}#${"e5F6g7H8".repeat(6)}a`
    expect(code).toHaveLength(130)
    expect(await submitCode(started.id, code, who, { ...fakes, data })).toMatchObject({ ok: true })
    expect(logged()).toContain(`-w "${tokenFor(code)}"`)
  }, 10_000)

  test("a setup-token that never answers ends the sign-in at its bound, in words that say so", async () => {
    const data = fresh()
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })
    if (!started.ok) throw new Error(started.message)
    const began = Date.now()
    expect(await submitCode(started.id, "silent", who, { ...fakes, data, tokenMs: 300 })).toEqual({
      message: "Claude did not answer in time: start again for a new sign-in",
      ok: false,
      status: 409,
    })
    expect(Date.now() - began).toBeLessThan(3_000)
    expect(readSetting(data, "usage.accounts")?.value ?? []).toEqual([])
    expect(await submitCode(started.id, "made-up-code", who, { ...fakes, data })).toEqual({
      message: GONE,
      ok: false,
      status: 404,
    })
  })

  test("a code for a sign-in the API no longer holds, as after a restart, is gone in plain words", async () => {
    expect(await submitCode("made-up-id-before-a-restart", "made-up-code", who, fakes)).toEqual({
      message: GONE,
      ok: false,
      status: 404,
    })
  })

  test("the code's whole wait is the token's and the account read's together", () => {
    expect(CODE_WAIT_MS).toBe(70_000)
  })

  test("a code setup-token refuses is answered at once, in plain words, keeping nothing and ending the sign-in", async () => {
    const data = fresh()
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })
    if (!started.ok) throw new Error(started.message)
    const began = Date.now()
    expect(await submitCode(started.id, "refused", who, { ...fakes, data })).toEqual({
      message:
        "Claude did not accept that code. It may be incomplete, expired, already used or from an earlier sign-in: start again for a new code",
      ok: false,
      status: 400,
    })
    expect(Date.now() - began).toBeLessThan(5_000)
    expect(readSetting(data, "usage.accounts")?.value ?? []).toEqual([])
    expect(logged()).not.toContain("add-generic-password")
    expect(await submitCode(started.id, "made-up-code", who, { ...fakes, data })).toMatchObject({
      status: 404,
    })
  })

  test("a new sign-in ends the one before it, and one left alone ends when it expires", async () => {
    const data = fresh()
    const first = await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })
    const second = await startSetup(
      { email: EMAIL },
      { ...fakes, applications: apps(), data, expiryMs: 300 },
    )
    if (!first.ok || !second.ok) throw new Error("setup failed")
    expect(await submitCode(first.id, "made-up-code", who, { ...fakes, data })).toEqual({
      message: GONE,
      ok: false,
      status: 404,
    })
    await Bun.sleep(600)
    expect(await submitCode(second.id, "made-up-code", who, { ...fakes, data })).toMatchObject({
      status: 404,
    })
    expect(readSetting(data, "usage.accounts")?.value ?? []).toEqual([])
  })

  test("a sign-in's time runs from its link, so a slow setup-token still answers one", async () => {
    const data = fresh()
    const started = await startSetup(
      { email: EMAIL },
      { ...fakes, applications: apps(), claude: join(bin, "slow-claude"), data, expiryMs: 300 },
    )
    expect(started).toMatchObject({ ok: true })
    if (!started.ok) return
    await Bun.sleep(600)
    expect(await submitCode(started.id, "made-up-code", who, { ...fakes, data })).toMatchObject({
      status: 404,
    })
  })

  test("an account listed already, or no login, is refused before setup-token starts", async () => {
    const data = fresh()
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })
    if (!started.ok) throw new Error(started.message)
    await submitCode(started.id, "made-up-code", who, { ...fakes, data })
    writeFileSync(log, "")
    expect(await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })).toEqual({
      message: `${EMAIL} is already listed`,
      ok: false,
      status: 409,
    })
    delete process.env.PLAYGROUND_LOGIN
    try {
      expect(
        await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data: fresh() }),
      ).toMatchObject({
        ok: false,
        status: 409,
      })
    } finally {
      process.env.PLAYGROUND_LOGIN = "made-up-me"
    }
    expect(logged()).not.toContain("claude setup-token")
  })

  test("open-private opens only the sign-in in progress, in a new window on a fresh profile of the first installed browser, deleted when the sign-in ends", async () => {
    const data = fresh()
    const applications = apps("Microsoft Edge", "Google Chrome")
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications, data })
    if (!started.ok) throw new Error(started.message)
    expect(await openPrivate("not-the-id", { ...fakes, applications })).toMatchObject({
      status: 404,
    })
    expect(await openPrivate(started.id, { ...fakes, applications })).toEqual({
      browser: { app: "Google Chrome", name: "Chrome" },
      ok: true,
    })
    const profile = profileIn(logged())
    expect(profile).toStartWith(join(bin, "playground-sign-in-"))
    expect(logged()).toContain(
      `open -na Google Chrome --args --user-data-dir=${profile} --no-first-run ${started.url}\n`,
    )
    expect(existsSync(join(profile, MARKER))).toBe(true)
    writeFileSync(log, "")
    expect(await openPrivate(started.id, { ...fakes, applications: apps() })).toEqual({
      browser: null,
      ok: true,
    })
    expect(logged()).toBe("")
    await submitCode(started.id, "made-up-code", who, { ...fakes, data })
    expect(existsSync(profile)).toBe(false)
  })

  test("Firefox opens the sign-in on a fresh profile of its own, and the profile goes once setup-token exits", async () => {
    const data = fresh()
    const applications = apps("Firefox", "Safari")
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications, data })
    if (!started.ok) throw new Error(started.message)
    expect(await openPrivate(started.id, { ...fakes, applications })).toEqual({
      browser: { app: "Firefox", name: "Firefox" },
      ok: true,
    })
    const profile = profileIn(logged())
    expect(logged()).toContain(
      `open -na Firefox --args -profile ${profile} -no-remote ${started.url}\n`,
    )
    expect(existsSync(profile)).toBe(true)
    await submitCode(started.id, "refused", who, { ...fakes, data })
    expect(existsSync(profile)).toBe(false)
  })

  test("a profile folder without the scratch marker is not removed, and the sign-in still ends", async () => {
    const data = fresh()
    const applications = apps("Firefox")
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications, data })
    if (!started.ok) throw new Error(started.message)
    await openPrivate(started.id, { ...fakes, applications })
    const profile = profileIn(logged())
    renameSync(join(profile, MARKER), join(profile, "moved-marker"))
    const answer = await submitCode(started.id, "refused", who, { ...fakes, data })
    expect(answer.ok).toBe(false)
    expect(existsSync(join(profile, "moved-marker"))).toBe(true)
    expect(await submitCode(started.id, "made-up-code", who, { ...fakes, data })).toMatchObject({
      status: 404,
    })
  })

  test("Safari alone opens nothing, so the page offers the link to copy", async () => {
    const data = fresh()
    const started = await startSetup(
      { email: EMAIL },
      { ...fakes, applications: apps("Safari"), data },
    )
    if (!started.ok) throw new Error(started.message)
    expect(started.browser).toBeNull()
    expect(await openPrivate(started.id, { ...fakes, applications: apps("Safari") })).toEqual({
      browser: null,
      ok: true,
    })
    expect(logged()).not.toContain("open ")
  })

  test("a token Ink draws with a cursor move before the next word is read to its own end, the real one's 108 characters", async () => {
    const data = fresh()
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })
    if (!started.ok) throw new Error(started.message)
    expect(await submitCode(started.id, "drawn", who, { ...fakes, data })).toMatchObject({
      ok: true,
    })
    const kept = logged().match(/-w "([^"]*)"/)?.[1] ?? ""
    expect(kept).toBe(
      `sk-ant-oat01-${createHash("sha256").update("drawn").digest("hex")}-made-up-${"A".repeat(22)}`,
    )
    expect(kept).toHaveLength(108)
  })

  test("a token Claude refuses is shown as refused, and neither kept nor listed", async () => {
    const data = fresh()
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })
    if (!started.ok) throw new Error(started.message)
    signedIn = false
    expect(await submitCode(started.id, "made-up-code", who, { ...fakes, data })).toEqual({
      message:
        "Claude refused the token this sign-in made, so it is not kept: start again for a new one",
      ok: false,
      status: 409,
    })
    expect(logged()).not.toContain("add-generic-password")
    expect(readSetting(data, "usage.accounts")?.value ?? []).toEqual([])
  })

  test("a token for another account than the email given is dropped, and nothing is listed", async () => {
    const data = fresh()
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })
    if (!started.ok) throw new Error(started.message)
    signedIn = "someone-else@example.test"
    expect(await submitCode(started.id, "made-up-code", who, { ...fakes, data })).toEqual({
      message: `the sign-in was for someone-else@example.test, not ${EMAIL}: start again, and sign in with ${EMAIL}`,
      ok: false,
      status: 409,
    })
    expect(logged()).not.toContain("add-generic-password")
    expect(readSetting(data, "usage.accounts")?.value ?? []).toEqual([])
  })

  test("a token whose account cannot be read back is kept, and its answer says the account is not confirmed", async () => {
    const data = fresh()
    const started = await startSetup({ email: EMAIL }, { ...fakes, applications: apps(), data })
    if (!started.ok) throw new Error(started.message)
    signedIn = null
    expect(await submitCode(started.id, "made-up-code", who, { ...fakes, data })).toMatchObject({
      confirmed: false,
      ok: true,
    })
    expect(readSetting(data, "usage.accounts")?.value).toEqual([
      { email: EMAIL, provider: "claude" },
    ])
  })

  test("no case reached the network", () => {
    expect(fetched).toBe(0)
  })

  test("a fixture stack runs the made-up setup-token and opens no browser", async () => {
    process.env.PLAYGROUND_LIVE_READS = ""
    try {
      const data = fresh()
      const applications = apps("Firefox")
      const started = await startSetup({ email: EMAIL }, { ...fakes, applications, data })
      if (!started.ok) throw new Error(started.message)
      expect(started.url).toStartWith("https://claude.com/cai/oauth/authorize?")
      expect(await openPrivate(started.id, { ...fakes, applications })).toEqual({
        browser: { app: "Firefox", name: "Firefox" },
        ok: true,
      })
      expect(await submitCode(started.id, "made-up-code", who, { ...fakes, data })).toMatchObject({
        ok: true,
      })
      const record = readFileSync(join(data, "keychain-record.json"), "utf8")
      expect(record).not.toContain(tokenFor("made-up-code"))
      expect(logged()).toBe("")
    } finally {
      process.env.PLAYGROUND_LIVE_READS = "1"
    }
  })
})

// Linux: browsers by command on a PATH of the case's own, each logging its argv and display, beside a socket folder and a runtime folder holding gdm's auth file.
describe("the guided Claude sign-in on Linux", () => {
  const linux = (commands: string[], sockets: string[], env: Record<string, string> = {}) => {
    const path = join(bin, `path-${n++}`)
    const x11 = join(bin, `x11-${n++}`)
    const runtime = join(bin, `runtime-${n++}`)
    mkdirSync(path)
    mkdirSync(x11)
    mkdirSync(join(runtime, "gdm"), { recursive: true })
    writeFileSync(join(runtime, "gdm", "Xauthority"), "")
    for (const name of commands) {
      writeFileSync(
        join(path, name),
        `#!/bin/sh\nprintf '${name} %s display %s auth %s\\n' "$*" "$DISPLAY" "$XAUTHORITY" >> "${log}"\n`,
      )
      chmodSync(join(path, name), 0o755)
    }
    for (const name of sockets) writeFileSync(join(x11, name), "")
    return {
      ...fakes,
      env: { PATH: path, ...env },
      platform: "linux" as const,
      runtime,
      x11,
    }
  }
  const opened = async () => {
    for (let i = 0; i < 100 && !logged().includes("display"); i++) await Bun.sleep(20)
    return logged()
  }

  test("each browser is picked by its command in order: Helium, Chrome, Chromium, then Firefox, and Brave or Edge alone finds none", async () => {
    const picks: [string[], Browser["name"] | null][] = [
      [["firefox", "chromium", "google-chrome-stable", "helium"], "Helium"],
      [["firefox", "chromium-browser", "google-chrome"], "Chrome"],
      [["firefox", "chromium"], "Chromium"],
      [["firefox"], "Firefox"],
      [["brave-browser", "microsoft-edge"], null],
    ]
    for (const [commands, name] of picks) {
      const started = await startSetup(
        { email: EMAIL },
        { ...linux(commands, ["X1"]), data: fresh() },
      )
      if (!started.ok) throw new Error(started.message)
      expect(started.browser?.name ?? null).toBe(name)
    }
  })

  test("a browser opens the sign-in detached on a fresh profile, on the one X display this user owns with gdm's auth file", async () => {
    const data = fresh()
    const deps = linux(["helium", "firefox"], ["X1"])
    const started = await startSetup({ email: EMAIL }, { ...deps, data })
    if (!started.ok) throw new Error(started.message)
    writeFileSync(log, "")
    expect(await openPrivate(started.id, deps)).toEqual({
      browser: { app: "Helium", name: "Helium" },
      ok: true,
    })
    const line = await opened()
    const profile = profileIn(line)
    expect(profile).toStartWith(join(bin, "playground-sign-in-"))
    expect(line).toBe(
      `helium --user-data-dir=${profile} --no-first-run ${started.url} display :1 auth ${join(deps.runtime, "gdm", "Xauthority")}\n`,
    )
    await submitCode(started.id, "made-up-code", who, { ...fakes, data })
    expect(existsSync(profile)).toBe(false)
  })

  test("Firefox opens on a fresh profile of its own, on the display the environment names", async () => {
    const deps = linux(["firefox"], [], { DISPLAY: ":7" })
    const started = await startSetup({ email: EMAIL }, { ...deps, data: fresh() })
    if (!started.ok) throw new Error(started.message)
    writeFileSync(log, "")
    expect(await openPrivate(started.id, deps)).toMatchObject({ browser: { name: "Firefox" } })
    const line = await opened()
    expect(line).toBe(
      `firefox -profile ${profileIn(line)} -no-remote ${started.url} display :7 auth \n`,
    )
  })

  test("two X sockets, or none, name no display, so nothing opens and the page offers the link to copy", async () => {
    for (const sockets of [["X0", "X1"], []]) {
      const deps = linux(["helium"], sockets)
      const started = await startSetup({ email: EMAIL }, { ...deps, data: fresh() })
      if (!started.ok) throw new Error(started.message)
      expect(started.browser).toBeNull()
      writeFileSync(log, "")
      expect(await openPrivate(started.id, deps)).toEqual({ browser: null, ok: true })
      expect(logged()).toBe("")
    }
  })
})

describe("urlOf", () => {
  const url = `https://claude.com/cai/oauth/authorize?code=true&client_id=made-up&state=${"a".repeat(64)}`

  test("reads the link out of the screen's colours, its hyperlink codes and carriage returns", () => {
    expect(url.length).toBeGreaterThan(80)
    const screen = `\x1b[1mWelcome\x1b[22m\r\nUse the url below to sign in\r\n\x1b]8;;${url}\x07\x1b[2m${url}\x1b[22m\x1b]8;;\x07\r\nPaste code here if prompted > `
    expect(urlOf(screen)).toBe(url)
  })

  test("a link wrapped at 80 columns is not read as whole, which is why the pty is made wider than any link", () => {
    expect(urlOf(`${url.slice(0, 80)}\n${url.slice(80)}\n`)).not.toBe(url)
  })
})

describe("profileUrl", () => {
  test("is Claude's own profile read, or PLAYGROUND_PROFILE_URL where the new-user gate sets it", () => {
    expect(profileUrl({})).toBe("https://api.anthropic.com/api/oauth/profile")
    expect(profileUrl({ PLAYGROUND_PROFILE_URL: "http://127.0.0.1:9/profile" })).toBe(
      "http://127.0.0.1:9/profile",
    )
  })
})
