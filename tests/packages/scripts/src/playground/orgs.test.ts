import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { MARKER } from "../../../../../packages/safe-delete/src"
import {
  type OrgsIo,
  orgsCommand,
  ownerOf,
  planFor,
  resolveFor,
} from "../../../../../packages/scripts/src/playground/orgs"
import { currentDir } from "../../../../../packages/settings/src/rendered"

const scratch = mkdtempSync(join(tmpdir(), "orgs-resolve-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// The core scope's folders in a checkout: ask, tdd and xyz in playground's beside an in-progress one no session gets, dev in zerostarter's, and upstream's tdd and grill-me in extensions/core's; and the bundled slack extension's ask, slack-dm and tdd, which load only once ext.bundled turns it on.
const checkout = join(scratch, "checkout")
for (const [path, text] of Object.entries({
  "extensions/core/skills/grill-me/SKILL.md": "GRILL",
  "extensions/core/skills/tdd/SKILL.md": "UPSTREAM-TDD",
  "extensions/slack/skills/ask/SKILL.md": "SLACK-ASK",
  "extensions/slack/skills/slack-dm/SKILL.md": "SLACK-DM",
  "extensions/slack/skills/tdd/SKILL.md": "SLACK-TDD",
  "skills/playground/ask/SKILL.md": "CORE-ASK",
  "skills/playground/in-progress/draft/SKILL.md": "DRAFT",
  "skills/playground/tdd/SKILL.md": "CORE-TDD",
  "skills/playground/xyz/SKILL.md": "CORE-XYZ",
  "skills/zerostarter/dev/SKILL.md": "ZS-DEV",
}))
  put(join(checkout, path), text)

// A data folder whose extensions hold acme's ask, xyz, acme-only with its tests and a review no session can run, corp's ask and corp-only, the login me's tdd, and the policy given; the default login, someone, has no scope folder.
const extensionsWith = (name: string, values: Record<string, unknown>) => {
  const data = join(scratch, name)
  for (const [path, text] of Object.entries({
    "acme/skills/acme-only/SKILL.md": "ACME-ONLY",
    "acme/skills/acme-only/tests/acme.test.ts": "test",
    "acme/skills/ask/SKILL.md": "ACME-ASK",
    "acme/skills/review/SKILL.md": "ACME-REVIEW",
    "acme/skills/xyz/SKILL.md": "ACME-XYZ",
    "corp/skills/ask/SKILL.md": "CORP-ASK",
    "corp/skills/corp-only/SKILL.md": "CORP-ONLY",
    "me/skills/tdd/SKILL.md": "MY-TDD",
    "policy.json": JSON.stringify({ orgs: {}, schemaVersion: 1, values }),
  }))
    put(join(currentDir(data), path), text)
  return data
}

const origins: Record<string, string> = {
  "/repos/acme": "git@github.com:Acme-Inc/web.git",
  "/repos/home": "https://github.com/someone/playground.git",
}

const ioOf = (data: string, over: Partial<OrgsIo> = {}) => {
  const out: string[] = []
  const err: string[] = []
  const io: OrgsIo = {
    checkout,
    claude: () => undefined,
    data,
    err: (line) => err.push(line),
    login: () => "someone",
    origin: (dir) => origins[dir] ?? "",
    out: (line) => out.push(line),
    personal: join(data, "personal-skills"),
    ...over,
  }
  return { err, io, out }
}

const resolve = async (data: string, repo?: string, over: Partial<OrgsIo> = {}) => {
  const { err, io, out } = ioOf(data, over)
  const code = await orgsCommand(repo ? ["resolve", "--repo", repo] : ["resolve"], io)
  const plugin = out[0] ?? ""
  const skills = plugin ? readdirSync(join(plugin, "skills")).sort() : []
  const body = (name: string) => readFileSync(join(plugin, "skills", name, "SKILL.md"), "utf8")
  return { body, code, err, plugin, skills }
}

const policy = { "ext.links": { acme: ["acme-inc"], corp: ["*"] }, "ext.order": ["acme", "corp"] }
const acmeSet = ["acme-only", "ask", "corp-only", "dev", "grill-me", "tdd", "xyz"]

test("a session in an org's repo takes the extension linked to it over the one linked to *, and both over core", async () => {
  const session = await resolve(extensionsWith("org-repo", policy), "/repos/acme")
  expect(session.code).toBe(0)
  expect(session.skills).toEqual(acmeSet)
  expect(session.body("ask")).toBe("ACME-ASK")
  expect(session.body("tdd")).toBe("CORE-TDD")
  expect(session.body("dev")).toBe("ZS-DEV")
  expect(session.body("grill-me")).toBe("GRILL")
  expect(session.body("corp-only")).toBe("CORP-ONLY")
  expect(existsSync(join(session.plugin, "skills", "acme-only", "tests", "acme.test.ts"))).toBe(
    true,
  )
  expect(
    JSON.parse(readFileSync(join(session.plugin, ".claude-plugin", "plugin.json"), "utf8")).name,
  ).toBe("ws-acme")
})

test("xyz in core and in an org loads the org's alone, and the resolve names the core copy it shadows", async () => {
  const data = extensionsWith("shadow", policy)
  const session = await resolve(data, "/repos/acme")
  expect(session.body("xyz")).toBe("ACME-XYZ")
  const resolved = await resolveFor(ioOf(data).io, "/repos/acme")
  if (resolved.refusal !== undefined) throw new Error(resolved.refusal)
  expect(resolved.winners.filter((winner) => winner.name === "xyz")).toEqual([
    { dir: join(currentDir(data), "acme", "skills", "xyz"), from: "acme", name: "xyz" },
  ])
  expect(resolved.shadowed.get("xyz")).toEqual(["core"])
  expect(resolved.shadowed.get("ask")).toEqual(["corp", "core"])
})

test("an org given by name resolves as a repo of that org would, in any case", async () => {
  const data = extensionsWith("by-org", policy)
  const named = await resolveFor(ioOf(data).io, undefined, "Acme-Inc")
  const byRepo = await resolveFor(ioOf(data).io, "/repos/acme")
  if (named.refusal !== undefined || byRepo.refusal !== undefined) throw new Error("refused")
  expect(named.winners).toEqual(byRepo.winners)
  expect(named.shadowed.get("ask")).toEqual(["corp", "core"])
})

test("the login's scope comes first, over the org's and core's", async () => {
  const session = await resolve(extensionsWith("login", policy), "/repos/acme", {
    login: () => "me",
  })
  expect(session.body("tdd")).toBe("MY-TDD")
  expect(session.body("ask")).toBe("ACME-ASK")
})

test("an org's skill named after a built-in's alias is left out and named", async () => {
  const session = await resolve(extensionsWith("alias", policy), "/repos/acme")
  expect(session.skills).not.toContain("review")
  expect(session.err.join("\n")).toContain("left out acme's review: a built-in's alias")
})

test("an extension linked to * reaches every repo, and takes a name over core's", async () => {
  const session = await resolve(extensionsWith("home-repo", policy), "/repos/home")
  expect(session.skills).toEqual(["ask", "corp-only", "dev", "grill-me", "tdd", "xyz"])
  expect(session.body("ask")).toBe("CORP-ASK")
  expect(session.plugin).toContain(join("orgs", "home"))
})

// A session's checkout whose .claude/skills holds the dev given, as Playground's own links its folder to skills/zerostarter.
const checkoutWithDev = (name: string, dev: (path: string) => void) => {
  const repo = join(scratch, name)
  mkdirSync(join(repo, ".claude", "skills"), { recursive: true })
  dev(join(repo, ".claude", "skills", "dev"))
  return repo
}
const playgroundOrigin = { origin: () => "https://github.com/someone/playground.git" }

test("a session in Playground's own checkout loads no plugin copy of a skill its .claude/skills already lists", async () => {
  const data = extensionsWith("own-checkout", policy)
  const repo = checkoutWithDev("own", (path) =>
    symlinkSync(join(checkout, "skills", "zerostarter", "dev"), path),
  )
  const session = await resolve(data, repo, playgroundOrigin)
  expect(session.code).toBe(0)
  expect(session.skills).toEqual(["ask", "corp-only", "grill-me", "tdd", "xyz"])
})

test("a session in an org's checkout keeps the full set, its own skill of the same name beside the plugin's", async () => {
  const data = extensionsWith("org-checkout", policy)
  const repo = checkoutWithDev("org", (path) => put(join(path, "SKILL.md"), "ORG-DEV"))
  const session = await resolve(data, repo, { origin: () => origins["/repos/acme"]! })
  expect(session.skills).toEqual(acmeSet)
  expect(session.body("dev")).toBe("ZS-DEV")
})

test("the order decides which of two linked extensions keeps a name, and one linked twice loads once", async () => {
  const data = extensionsWith("both", {
    "ext.links": { acme: ["*", "acme-inc"], corp: ["*"] },
    "ext.order": ["corp", "acme"],
  })
  const session = await resolve(data, "/repos/acme")
  expect(session.body("ask")).toBe("CORP-ASK")
  expect(session.skills).toEqual(acmeSet)
  expect((await resolve(data, "/repos/home")).skills).toEqual(acmeSet)
})

test("with no extensions the home set is core's alone, and the same winners reuse one folder", async () => {
  const data = join(scratch, "none")
  const first = await resolve(data, "/repos/acme", { login: () => "me" })
  expect(first.code).toBe(0)
  expect(first.skills).toEqual(["ask", "dev", "grill-me", "tdd", "xyz"])
  expect(first.body("tdd")).toBe("CORE-TDD")
  expect((await resolve(data)).plugin).toBe(first.plugin)
  expect(readdirSync(join(data, "orgs", "home"))).toHaveLength(1)
  expect(existsSync(join(first.plugin, MARKER))).toBe(false)
})

test("extensions that name no login refuse, exit 2, naming ext init", async () => {
  const refused = await resolve(extensionsWith("no-login", policy), "/repos/acme", {
    login: () => {
      throw new Error("no login for the extensions: run playground ext init")
    },
  })
  expect(refused.code).toBe(2)
  expect(refused.err.join("\n")).toContain("run playground ext init")
})

test("a policy that does not parse refuses, exit 2, and a wrong word prints the usage", async () => {
  const data = extensionsWith("broken", policy)
  writeFileSync(join(currentDir(data), "policy.json"), "{")
  const refused = await resolve(data)
  expect(refused.code).toBe(2)
  expect(refused.err.join("\n")).toContain("policy.json does not parse")
  const { err, io } = ioOf(data)
  expect(await orgsCommand(["resolve", "--repo"], io)).toBe(2)
  expect(await orgsCommand(["list"], io)).toBe(2)
  expect(await orgsCommand(["which", "xyz"], io)).toBe(2)
  expect(err.join("\n")).toContain("usage: playground orgs resolve")
})

test("the owner comes from a GitHub origin in either form, and links case-blind", () => {
  expect(ownerOf("git@github.com:Acme-Inc/web.git")).toBe("acme-inc")
  expect(ownerOf("https://github.com/acme-inc/web")).toBe("acme-inc")
  expect(ownerOf("https://gitlab.com/acme-inc/web")).toBeUndefined()
  expect(planFor("acme-inc", policy, "me")).toEqual({
    bundled: [],
    chain: ["me", "acme", "corp", "core"],
    own: "acme",
  })
  expect(planFor(undefined, policy)).toEqual({
    bundled: [],
    chain: ["corp", "core"],
    own: undefined,
  })
})

// a bundled extension ships in the checkout and loads only once ext.bundled turns it on (#849)
test("with ext.bundled empty the bundled slack extension loads no skill", async () => {
  const session = await resolve(extensionsWith("bundled-off", policy), "/repos/acme")
  expect(session.skills).toEqual(acmeSet)
  expect(session.body("tdd")).toBe("CORE-TDD")
})

test("slack in ext.bundled resolves its skills after the installed extensions and before core", async () => {
  const data = extensionsWith("bundled-on", { ...policy, "ext.bundled": ["slack"] })
  const session = await resolve(data, "/repos/acme")
  expect(session.skills).toEqual([...acmeSet, "slack-dm"].sort())
  expect(session.body("slack-dm")).toBe("SLACK-DM")
  expect(session.body("ask")).toBe("ACME-ASK")
  expect(session.body("tdd")).toBe("SLACK-TDD")
  const resolved = await resolveFor(ioOf(data).io, "/repos/acme")
  if (resolved.refusal !== undefined) throw new Error(resolved.refusal)
  expect(resolved.shadowed.get("ask")).toEqual(["corp", "slack", "core"])
  expect(new Set(resolved.shadowed.get("tdd"))).toEqual(new Set(["core"]))
  expect(resolved.winners.find((winner) => winner.name === "slack-dm")).toEqual({
    dir: join(checkout, "extensions", "slack", "skills", "slack-dm"),
    from: "slack",
    name: "slack-dm",
  })
})

test("a bundled name an installed extension holds stays that extension's, and a value ext.bundled refuses reads as none", () => {
  expect(planFor(undefined, { ...policy, "ext.bundled": ["slack"] }, "me")).toEqual({
    bundled: ["slack"],
    chain: ["me", "corp", "slack", "core"],
    own: undefined,
  })
  const installed = {
    "ext.bundled": ["slack"],
    "ext.links": { slack: ["*"] },
    "ext.order": ["slack"],
  }
  expect(planFor(undefined, installed)).toEqual({
    bundled: [],
    chain: ["slack", "core"],
    own: undefined,
  })
  for (const bad of ["slack", ["vault"], 3])
    expect(planFor(undefined, { "ext.bundled": bad }).chain).toEqual(["core"])
})

// A fake claude: each call's words, a plugin list that names ws-home@ws once installed, and a failure for the words given.
const fakeClaude = (fail?: string) => {
  const calls: string[] = []
  let installed = false
  const claude = (args: string[]) => {
    const words = args.join(" ")
    calls.push(words)
    if (words === fail) return { code: 1, out: "no" }
    if (words.startsWith("plugin install")) installed = true
    return { code: 0, out: words === "plugin list" && installed ? "ws-home@ws\n" : "" }
  }
  return { calls, claude }
}
const home = async (data: string, over: Partial<OrgsIo> = {}) => {
  const { err, io, out } = ioOf(data, over)
  return { code: await orgsCommand(["home"], io), err, out }
}

test("orgs home lists the home set in the ws marketplace, adds and installs it once, then updates it", async () => {
  const data = extensionsWith("home-install", policy)
  const fake = fakeClaude()
  expect((await home(data, { claude: fake.claude })).code).toBe(0)
  const marketplace = JSON.parse(
    readFileSync(join(data, "orgs", ".claude-plugin", "marketplace.json"), "utf8"),
  )
  const source = marketplace.plugins[0].source as string
  expect(marketplace).toMatchObject({ name: "ws", plugins: [{ name: "ws-home" }] })
  expect(source).toStartWith("./home/")
  expect(readdirSync(join(data, "orgs", source, "skills")).sort()).toEqual([
    "ask",
    "corp-only",
    "dev",
    "grill-me",
    "tdd",
    "xyz",
  ])
  expect((await home(data, { claude: fake.claude })).code).toBe(0)
  expect(fake.calls).toEqual([
    "plugin list",
    `plugin marketplace add ${join(data, "orgs")}`,
    "plugin install ws-home@ws --scope user",
    "plugin list",
    "plugin update ws-home@ws",
  ])
})

test("orgs home removes a personal link into the checkout at a name the set ships, keeps the rest, and moves a real folder to my-skills, linked back", async () => {
  const data = extensionsWith("personal", policy)
  const personal = join(data, "personal-skills")
  mkdirSync(join(personal, "tdd"), { recursive: true })
  symlinkSync(join(scratch, "elsewhere", "archify"), join(personal, "archify"))
  symlinkSync(join(checkout, "skills", "playground", "ask"), join(personal, "ask"))
  const result = await home(data)
  expect(result.code).toBe(0)
  expect(readdirSync(personal).sort()).toEqual(["archify", "tdd"])
  const kept = join(data, "my-skills", "tdd")
  expect(readlinkSync(join(personal, "tdd"))).toBe(kept)
  expect(lstatSync(kept).isDirectory()).toBe(true)
  expect(result.out.join("\n")).toContain(`moved your tdd to ${kept} and linked it back`)
})

// An install's link-skills removed the user's own links at the names the home set ships, writing-for-agents into inscope's cache among them, so running sessions lost those skills
test("orgs home keeps a personal link that points outside Playground's checkout, naming the clash, and replaces only its own", async () => {
  const own = join(scratch, "own-checkout")
  for (const name of ["ask", "writing-for-agents"])
    put(join(own, "skills", "playground", name, "SKILL.md"), name)
  const data = extensionsWith("foreign-links", {})
  const personal = join(data, "personal-skills")
  const foreign = join(scratch, "inscope-cache", "skills", "writing-for-agents")
  put(join(foreign, "SKILL.md"), "THE USER'S OWN")
  mkdirSync(personal, { recursive: true })
  symlinkSync(foreign, join(personal, "writing-for-agents"))
  symlinkSync(join(own, "skills", "playground", "ask"), join(personal, "ask"))
  const result = await home(data, { checkout: own })
  expect(result.code).toBe(0)
  expect(readdirSync(personal)).toEqual(["writing-for-agents"])
  expect(readlinkSync(join(personal, "writing-for-agents"))).toBe(foreign)
  expect(result.out).toContain(
    "kept the personal link writing-for-agents: it points outside Playground, so it takes the name over the home skill set's writing-for-agents",
  )
  expect(result.out).toContain("removed the personal link ask: the home skill set ships it")
})

test("orgs home with no claude on PATH writes the set and says it waits; a failed install exits 1 naming it", async () => {
  const data = extensionsWith("home-none", policy)
  const none = await home(data)
  expect(none.code).toBe(0)
  expect(none.out.join("\n")).toContain("claude is not on PATH")
  const failed = await home(data, {
    claude: fakeClaude("plugin install ws-home@ws --scope user").claude,
  })
  expect(failed.code).toBe(1)
  expect(failed.err.join("\n")).toContain("claude plugin install ws-home@ws --scope user failed")
})

// ext init can stop after making the extensions root, before it writes the login or clones a scope, and link-skills.sh's last step is orgs home.
test("a root ext init stopped in, with no policy.json, no login and no scope yet, installs the home set on core alone", async () => {
  const data = join(scratch, "stopped")
  mkdirSync(currentDir(data), { recursive: true })
  const noLogin = () => {
    throw new Error("no login for the extensions: run playground ext init")
  }
  const fake = fakeClaude()
  const installed = await home(data, { claude: fake.claude, login: noLogin })
  expect(installed.err).toEqual([])
  expect(installed.code).toBe(0)
  const session = await resolve(data, undefined, { login: noLogin })
  expect(session.code).toBe(0)
  expect(session.skills.length).toBeGreaterThan(0)
})
