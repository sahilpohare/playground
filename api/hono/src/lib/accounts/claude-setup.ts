import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { site } from "@packages/config/site"
import { makeScratch, removeScratch } from "@packages/safe-delete"
import type { Result, Who } from "@packages/settings"

// Relative, not @/: the routes' types bring this file into web/next's type check, under its own @/ paths.
import { readsLive } from "../dashboard/fixture"
import { type AccountRow, addAccount, refusalOf } from "../store/accounts"

// Settings > Accounts' guided Add for Claude: `claude setup-token` runs here in Bun's own pty (script cannot take Bun's piped stdin, which is a socket), with BROWSER pointed at true so it never opens the default browser, which holds the owner's own sign-in; the link it prints goes to the page, which opens it in a new window on a fresh throwaway profile, on a Mac or on Linux, the code the page takes goes to its stdin, and the token it prints goes to the Keychain under the email once the account it names is that email. One sign-in runs at a time, in memory; nothing it prints is logged or answered but the link.

export type Browser = {
  app: "Brave Browser" | "Chromium" | "Firefox" | "Google Chrome" | "Helium" | "Microsoft Edge"
  name: "Brave" | "Chrome" | "Chromium" | "Edge" | "Firefox" | "Helium"
}

// Each browser that opens a link on a fresh profile, in the order one is picked: on a Mac by its app under /Applications when mac is set, on Linux by the first of its commands on PATH; Safari takes no profile from its argv, so a Mac with Safari alone gets the link to copy.
const BROWSERS = [
  { app: "Helium", commands: ["helium"], engine: "chromium", mac: false, name: "Helium" },
  {
    app: "Google Chrome",
    commands: ["google-chrome", "google-chrome-stable"],
    engine: "chromium",
    mac: true,
    name: "Chrome",
  },
  {
    app: "Chromium",
    commands: ["chromium", "chromium-browser"],
    engine: "chromium",
    mac: false,
    name: "Chromium",
  },
  { app: "Brave Browser", commands: [], engine: "chromium", mac: true, name: "Brave" },
  { app: "Microsoft Edge", commands: [], engine: "chromium", mac: true, name: "Edge" },
  { app: "Firefox", commands: ["firefox"], engine: "firefox", mac: true, name: "Firefox" },
] as const

// A browser found to open the link: on Linux by its command's path, with the display its window goes to.
type Found = {
  browser: (typeof BROWSERS)[number]
  command?: string
  display?: Record<string, string>
}

const profileFlags = (browser: Found["browser"], profile: string) =>
  browser.engine === "firefox"
    ? ["-profile", profile, "-no-remote"]
    : [`--user-data-dir=${profile}`, "--no-first-run"]

// A new window on the profile folder, with its fixed argv as probe.ts's COMMANDS are: the folder and the sign-in's own link are its only values; a Mac goes through open, Linux runs the browser's command itself.
const freshWindow = (open: string, found: Found, profile: string, url: string) =>
  found.command
    ? [found.command, ...profileFlags(found.browser, profile), url]
    : [open, "-na", found.browser.app, "--args", ...profileFlags(found.browser, profile), url]

// Wider than any sign-in link or token, so setup-token's screen never wraps one onto a second line.
const COLUMNS = 4096
// setup-token hands $BROWSER a link of its own to open; this one opens nothing, and the page opens the printed link in a new window on a fresh profile.
const NO_BROWSER = "/usr/bin/true"
const FAKE = join(import.meta.dir, "../../fixtures/setup-token.ts")
const LINK_MS = 20_000
const TOKEN_MS = 60_000
const PROFILE_MS = 10_000
// The longest a pasted code waits for its answer: setup-token's token, then the account read; the page waits a little longer.
export const CODE_WAIT_MS = TOKEN_MS + PROFILE_MS
const EXPIRY_MS = 10 * 60_000
// setup-token's Ink takes a long code and its Enter in one write as a paste and never submits it, so Enter goes on its own after this pause.
const PASTE_MS = 300

// What a test injects: the reader of the account a token signs in as, the binaries by path, so no case depends on PATH's order, the folder a Mac's browsers are found in, the data folder, the environment a Linux browser is found and opened with, the expiry, the platform, the folder fresh profiles are made in, the runtime folder X's auth file is read from, the wait for a token and the folder X's sockets are read from.
type Deps = {
  account?: (token: string) => Promise<string | null | false>
  applications?: string
  claude?: string
  data?: string
  env?: Record<string, string | undefined>
  expiryMs?: number
  open?: string
  platform?: NodeJS.Platform
  profiles?: string
  runtime?: string
  tokenMs?: number
  x11?: string
}

type SignIn = {
  email: string
  ended: boolean
  id: string
  label?: string
  proc: Bun.Subprocess
  profile?: string
  // the folder the profile was made in, which removeScratch checks it against
  profiles?: string
  screen: string
  timer?: ReturnType<typeof setTimeout>
  url: string
  wake: Set<() => void>
}

let current: SignIn | undefined

const plain = (screen: string) => Bun.stripANSI(screen).replaceAll("\r", "")

// The sign-in link on setup-token's screen, read past its colours, its hyperlink codes and its carriage returns.
export const urlOf = (screen: string): string | undefined =>
  plain(screen).match(/https:\/\/\S*\/oauth\/\S+/)?.[0]

// setup-token's own refusal of a code, which it prints and then waits on Enter to retry.
const refusedOn = (screen: string): boolean => /OAuth error:/.test(plain(screen))

// Ink moves the cursor rather than printing a line break after the token, so each cursor code and carriage return reads as a break, and the token ends where it does on screen rather than running on into the next word.
const tokenOf = (screen: string): string | undefined =>
  Bun.stripANSI(screen.replace(/\x1b\[[0-9;?]*[A-Za-ln-z]|\r/g, "\n")).match(
    /sk-ant-[A-Za-z0-9_-]{20,}/,
  )?.[0]

// A Linux window's display: the environment's own, else the one X socket this user owns with gdm's auth file beside it, since a stack started from a herdr pane carries no display; none when no socket or more than one is found.
const displayOf = (deps: Deps): Record<string, string> | undefined => {
  const env = deps.env ?? process.env
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return {}
  const sockets = deps.x11 ?? "/tmp/.X11-unix"
  const uid = process.getuid?.()
  let mine: string[]
  try {
    mine = readdirSync(sockets).filter(
      (name) => /^X\d+$/.test(name) && statSync(join(sockets, name)).uid === uid,
    )
  } catch {
    return undefined
  }
  if (mine.length !== 1) return undefined
  const auth = join(deps.runtime ?? env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`, "gdm", "Xauthority")
  return { DISPLAY: `:${mine[0]!.slice(1)}`, ...(existsSync(auth) ? { XAUTHORITY: auth } : {}) }
}

const browserOf = (deps: Deps): Found | undefined => {
  if ((deps.platform ?? process.platform) !== "linux") {
    const applications = deps.applications ?? "/Applications"
    const browser = BROWSERS.find(
      (each) => each.mac && existsSync(join(applications, `${each.app}.app`)),
    )
    return browser && { browser }
  }
  const display = displayOf(deps)
  if (!display) return undefined
  const PATH = (deps.env ?? process.env).PATH ?? ""
  for (const browser of BROWSERS)
    for (const name of browser.commands) {
      const command = Bun.which(name, { PATH })
      if (command) return { browser, command, display }
    }
}

const shown = (found: Found | undefined): Browser | null =>
  found ? { app: found.browser.app, name: found.browser.name } : null

// Pure: where the profile read goes, PLAYGROUND_PROFILE_URL when set (the new-user gate points it at a closed loopback port, so its made-up token never leaves the Mac), else Claude's own.
export const profileUrl = (env: Record<string, string | undefined> = process.env): string =>
  env.PLAYGROUND_PROFILE_URL || "https://api.anthropic.com/api/oauth/profile"

// The account a long-lived token signs in as, by Claude's own profile read: false when Claude refuses the token (401), or null when it cannot say (a token scoped to inference alone may not read it).
const profileOf = async (token: string): Promise<string | null | false> => {
  try {
    const answer = await fetch(profileUrl(), {
      headers: { "anthropic-beta": "oauth-2025-04-20", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROFILE_MS),
    })
    if (answer.status === 401) return false
    if (!answer.ok) return null
    const body = (await answer.json()) as { account?: { email?: unknown } }
    return typeof body.account?.email === "string" ? body.account.email : null
  } catch {
    return null
  }
}

// A command by its path on PATH as it is now: Bun.spawn looks a bare name up on the PATH the process started with, which a later change misses.
const which = (name: string) => Bun.which(name, { PATH: process.env.PATH ?? "" })

// The real setup-token on a stack that reads this machine, else the made-up one; undefined when there is no claude.
const argvOf = (claude = which("claude")): string[] | undefined => {
  if (!readsLive()) return [process.execPath, FAKE, "setup-token"]
  return claude ? [claude, "setup-token"] : undefined
}

const end = (signIn: SignIn | undefined) => {
  if (!signIn || signIn.ended) return
  signIn.ended = true
  clearTimeout(signIn.timer)
  signIn.proc.kill()
  const kept = signIn.profile && removeScratch(signIn.profile, signIn.profiles)
  if (kept) console.error(`claude-setup: the sign-in's profile stays: ${kept}`)
  if (current === signIn) current = undefined
  for (const wake of signIn.wake) wake()
}

// The first thing read from the screen, once it shows, or undefined once the command exits, the sign-in ends or the wait runs out.
const until = <T>(signIn: SignIn, read: (screen: string) => T | undefined, ms: number) =>
  new Promise<T | undefined>((resolve) => {
    const settle = (value: T | undefined) => {
      clearTimeout(timer)
      signIn.wake.delete(check)
      resolve(value)
    }
    const check = () => {
      const value = read(signIn.screen)
      if (value !== undefined) settle(value)
      else if (signIn.ended) settle(undefined)
    }
    const timer = setTimeout(() => settle(read(signIn.screen)), ms)
    signIn.wake.add(check)
    check()
  })

// Starts a sign-in for the email, ending any before it: refused with the plain Add's words before anything runs when the account is listed already with its token kept or there is no login.
export async function startSetup(
  input: { email: string; label?: string },
  deps: Deps = {},
): Promise<Result<{ browser: Browser | null; id: string; url: string }>> {
  const refused = refusalOf({ ...input, provider: "claude" }, deps.data)
  if (refused) return refused
  const argv = argvOf(deps.claude)
  if (!argv)
    return { message: "claude is not on PATH, so it cannot sign in", ok: false, status: 409 }
  end(current)
  const decoder = new TextDecoder()
  const proc = Bun.spawn(argv, {
    env: { ...process.env, BROWSER: NO_BROWSER },
    terminal: {
      cols: COLUMNS,
      data: (_, chunk) => {
        signIn.screen += decoder.decode(chunk, { stream: true })
        for (const wake of signIn.wake) wake()
      },
      rows: 50,
    },
  })
  const signIn: SignIn = {
    email: input.email,
    ended: false,
    id: randomUUID(),
    ...(input.label ? { label: input.label } : {}),
    proc,
    screen: "",
    url: "",
    wake: new Set(),
  }
  current = signIn
  void proc.exited.then(() => end(signIn))
  const url = await until(signIn, urlOf, LINK_MS)
  if (!url) {
    end(signIn)
    return { message: "claude setup-token printed no sign-in link", ok: false, status: 409 }
  }
  signIn.url = url
  // Its time runs from the link, when the owner can act on it, so a slow start under load never eats it.
  signIn.timer = setTimeout(() => end(signIn), deps.expiryMs ?? EXPIRY_MS)
  return { browser: shown(browserOf(deps)), id: signIn.id, ok: true, url }
}

const gone = {
  message: `This sign-in has ended, most likely because ${site.name} restarted: start again for a new one`,
  ok: false,
  status: 404,
} as const

// Hands the code to setup-token and keeps the token it prints under the sign-in's email, unless the account it names is another, which drops it; confirmed says whether the account was named. The sign-in ends either way.
export async function submitCode(
  id: string,
  code: string,
  who: Who,
  deps: Deps = {},
): Promise<Result<{ account: AccountRow; confirmed: boolean }>> {
  const signIn = current
  if (!signIn || signIn.id !== id) return gone
  // Only what setup-token prints after the code answers it.
  const from = signIn.screen.length
  signIn.proc.terminal?.write(code)
  await Bun.sleep(PASTE_MS)
  signIn.proc.terminal?.write("\r")
  const answer = await until(
    signIn,
    (screen) => {
      const after = screen.slice(from)
      return tokenOf(after) ?? (refusedOn(after) ? null : undefined)
    },
    deps.tokenMs ?? TOKEN_MS,
  )
  const exited = signIn.ended
  end(signIn)
  if (answer === null)
    return {
      message:
        "Claude did not accept that code. It may be incomplete, expired, already used or from an earlier sign-in: start again for a new code",
      ok: false,
      status: 400,
    }
  if (answer === undefined && !exited)
    return {
      message: "Claude did not answer in time: start again for a new sign-in",
      ok: false,
      status: 409,
    }
  if (!answer)
    return {
      message: "the code was not taken: start again, and paste the code the sign-in page shows",
      ok: false,
      status: 400,
    }
  const token = answer
  const named = await (deps.account ?? (readsLive() ? profileOf : async () => signIn.email))(token)
  if (named === false)
    return {
      message:
        "Claude refused the token this sign-in made, so it is not kept: start again for a new one",
      ok: false,
      status: 409,
    }
  if (named && named.toLowerCase() !== signIn.email.toLowerCase())
    return {
      message: `the sign-in was for ${named}, not ${signIn.email}: start again, and sign in with ${signIn.email}`,
      ok: false,
      status: 409,
    }
  const added = addAccount(
    {
      email: signIn.email,
      ...(signIn.label ? { label: signIn.label } : {}),
      provider: "claude",
      token,
    },
    who,
    deps.data,
  )
  return added.ok ? { ...added, confirmed: named !== null } : added
}

// Opens the sign-in in progress in a new window on a fresh profile of the first installed browser, a folder deleted when the sign-in ends; a fixture stack opens nothing and names the browser it would have used. A Linux browser stays running as its window, so it starts detached and is not waited on.
export async function openPrivate(
  id: string,
  deps: Deps = {},
): Promise<Result<{ browser: Browser | null }>> {
  const signIn = current
  if (!signIn || signIn.id !== id || !signIn.url) return gone
  const found = browserOf(deps)
  if (!found) return { browser: null, ok: true }
  if (!readsLive()) return { browser: shown(found), ok: true }
  const open = deps.open ?? which("open") ?? "/usr/bin/open"
  signIn.profiles ??= deps.profiles ?? tmpdir()
  signIn.profile ??= makeScratch("playground-sign-in-", signIn.profiles)
  const opened = Bun.spawn(freshWindow(open, found, signIn.profile, signIn.url), {
    detached: Boolean(found.command),
    env: { ...(deps.env ?? process.env), ...found.display },
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  })
  if (found.command) {
    opened.unref()
    return { browser: shown(found), ok: true }
  }
  return { browser: (await opened.exited) === 0 ? shown(found) : null, ok: true }
}
