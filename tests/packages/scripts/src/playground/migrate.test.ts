import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { herdrPath } from "../../../../../packages/scripts/src/ops-herdr/pin"
import { pinHerdr } from "../../../../../packages/scripts/src/playground/herdr-pin"
import {
  extFromOrgs,
  migrate,
  runMigrate,
  type Source,
  depsOf,
} from "../../../../../packages/scripts/src/playground/migrate"
import { OLD_TREE_PATHS } from "../../../../../packages/scripts/src/rename/rules"
import { mustGit } from "../../../../../packages/settings/src/folder"
import { putItem, showItem } from "../../../../../packages/settings/src/items"
import { scopeDir } from "../../../../../packages/settings/src/rendered"
import { resolveKey } from "../../../../../packages/settings/src/settings"
import { setSetting } from "../../../../../packages/settings/src/settings-folder"

const scratch = mkdtempSync(join(tmpdir(), "playground-migrate-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))
const HOME = join(scratch, "home")
// The checkout the factory works in after the switch, its origin a made-up repository.
const CHECKOUT = join(scratch, "checkout")

// playground herdr pin under a scratch HOME, from a fake asset with its own sum, so no run downloads herdr
const FAKE_HERDR = new TextEncoder().encode("#!/bin/sh\necho herdr 0.9.5\n")
const PINNED = herdrPath({ HOME: join(scratch, "herdr-home") })
let pins = 0
const fakePin = () => {
  pins++
  return pinHerdr({
    asset: "darwin-arm64",
    download: async () => FAKE_HERDR,
    path: PINNED,
    sha256: new Bun.CryptoHasher("sha256").update(FAKE_HERDR).digest("hex"),
    version: "0.9.5",
  })
}
mkdirSync(CHECKOUT, { recursive: true })
mustGit(CHECKOUT, ["init", "-q"])
mustGit(CHECKOUT, ["remote", "add", "origin", "git@github.com:acme/new-factory.git"])

const LOGIN = "octo-owner"
const ORG = "acme"
const ID = {
  GIT_AUTHOR_EMAIL: "test",
  GIT_AUTHOR_NAME: "test",
  GIT_COMMITTER_EMAIL: "test",
  GIT_COMMITTER_NAME: "test",
}

const write = (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

// The old tree's files, each holding its value where today's tree holds it, with made-up values.
const OLD = {
  "api/hono/src/lib/desk/inbox.ts":
    "`a sent Slack message goes out through acme-slack (never the connector)`\n",
  "api/hono/src/lib/dev/live-desk.ts":
    'export const LIVE_DESK = { branch: "live/old", database: "acme-old-db" }\n',
  "scripts/hooks/no-chat-question.ts":
    "const LINE = String.raw`^\\s*(?:@?(?:alex|octo-owner)\\s*[,:])`\n",
  "scripts/hooks/no-release-comment.ts": 'const GUARDED_OWNERS = new Set(["octo-owner"])\n',
  "packages/scripts/src/ops-tick/tick.ts": 'export const SWITCH_ACCOUNT = "b@example.com"\n',
  "scripts/watch/channel.ts": 'const CHANNEL = "C0MADEUP01"\nconst SKIP = "U0MADEUP02"\n',
  "scripts/ops/usage/account-watch.py":
    'r = subprocess.run(["security", "find-generic-password", "-s", "acme-claude-oauth", "-a", email, "-w"])\n',
  "scripts/ops/usage/glm-credits.py":
    '    ["security", "find-generic-password", "-s", "acme-glm", "-a", "zai", "-w"],\n',
  "scripts/ops/usage/login-flip.py": [
    'A, B = "a@example.com", "b@example.com"',
    'C = "c@example.com"',
    'SERVICE, PROBE_EVERY = "acme-claude-oauth", 840',
    "ACCOUNTS = [A, B, C]  # the order the flip reads",
    'ENDS = {B: "2026-11-07T18:30:00+00:00", C: None}',
    "ENDING_FIRST, ENDS_LEAD = [B, C], 2 * 3600",
    "RENEWS = {A: 17}  # billing days",
    "",
  ].join("\n"),
  "scripts/ops/usage/near-limit.py": 'ACCOUNTS = {"a@example.com", "c@example.com"}\n',
  "scripts/ops/usage/week-marks.py": [
    "ACCOUNTS = {",
    '    "a@example.com": {"plan": "Max", "resets": "Sun 17:00Z (10:30 PM)", "weekday": 6, "hourZ": 17.0},',
    '    "b@example.com": {"plan": "Max", "resets": "Tue 15:59Z", "weekday": 1, "hourZ": 15.0 + 59 / 60},',
    "}",
    "",
  ].join("\n"),
  [OLD_TREE_PATHS.endOfDayScan]: "from `TZ=Europe/Lisbon date '+%a %-d %b'`.\n",
}
// The pre-squash head's migration table, made up; the machine half's own test exercises each key.
const MIGRATION = {
  dataFolders: ["oldhome"],
  droppedEnv: [],
  droppedJobs: [],
  env: [],
  envPrefix: { from: "OLDCO_", to: "NEWCO_" },
  files: [],
  job: {
    name: { from: "ops-panel", to: "ops-board" },
    script: { from: "/scripts/ops/panel/", to: "/scripts/ops/board/" },
    setting: { from: "jobs.opsPanel", to: "jobs.opsBoard" },
    stop: { from: "panel", to: "board" },
  },
  jobs: [],
  linkConverter: "python3 ~/tools/links.py",
  sources: { channelWatch: "scripts/watch/channel.ts" },
  staleCopies: [],
  stateFolder: { from: "ops/panel", to: "ops/board" },
}

// An archive checkout: canary holds the old tree, a later commit the pre-squash head with the migration table.
const archiveWith = (name: string, old: Record<string, string>) => {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  mustGit(dir, ["init", "-q", "-b", "canary"])
  mustGit(dir, ["remote", "add", "origin", "https://github.com/acme/old-factory.git"])
  write(dir, old)
  mustGit(dir, ["add", "-A"])
  mustGit(dir, ["commit", "-q", "-m", "old"], ID)
  write(dir, {
    ".github/notes/migrate/table.json": JSON.stringify(MIGRATION),
  })
  mustGit(dir, ["add", "-A"])
  mustGit(dir, ["commit", "-q", "-m", "pre-squash"], ID)
  return {
    archive: dir,
    old: "canary",
    org: ORG,
    preSquash: mustGit(dir, ["rev-parse", "HEAD"]),
  }
}

const skillsWith = (name: string) => {
  const dir = join(scratch, name)
  write(dir, {
    "parity-sweep/SKILL.md": "---\nname: parity-sweep\n---\nSweep.\n",
    "parity-sweep/harness/sweep.py": "print('sweep')\n",
    "parity-sweep/harness/__pycache__/sweep.cpython-313.pyc": "cache",
    "smoke-test/SKILL.md": "---\nname: smoke-test\n---\nSmoke.\n",
  })
  return dir
}

// The machine's roster names each manager kind, the second dispatcher under <name>-2.
const ROSTER = {
  agents: [
    { kind: "dispatcher", name: "boss-2" },
    { kind: "dispatcher", name: "boss" },
    { kind: "builder", name: "maker" },
    { kind: "ops", name: "keeper" },
    { kind: "planner", name: "thinker" },
    { kind: "worker", name: "x-worker" },
  ],
}

const dataWith = (name: string) => {
  const data = join(scratch, name)
  write(data, { "extensions/login": `${LOGIN}\n`, "roster.json": JSON.stringify(ROSTER) })
  return data
}

const USAGE =
  "scripts/ops/usage/login-flip.py + scripts/ops/usage/near-limit.py + scripts/ops/usage/week-marks.py + scripts/ops/usage/glm-credits.py"

// Each setting, the value it seeds and where it is read from.
const SETTINGS: [string, unknown, string][] = [
  ["channel.skipUser", "U0MADEUP02", "scripts/watch/channel.ts at canary"],
  ["channel.slackId", "C0MADEUP01", "scripts/watch/channel.ts at canary"],
  ["clock.ownerZone", "Europe/Lisbon", `${OLD_TREE_PATHS.endOfDayScan} at canary`],
  ["ext.links", { [LOGIN]: ["*"], [ORG]: ["*", ORG] }, "--org"],
  ["ext.order", [LOGIN, ORG], "--org"],
  ["factory.archiveRepo", "acme/old-factory", "the archive's origin"],
  ["factory.publicRepo", "acme/new-factory", "this checkout's origin"],
  ["factory.repo", "acme/new-factory", "this checkout's origin"],
  ["live.branch", "live/old", "api/hono/src/lib/dev/live-desk.ts at canary"],
  ["live.container", "acme-old-db", "api/hono/src/lib/dev/live-desk.ts at canary"],
  ["models.glmKeychainService", "acme-glm", "scripts/ops/usage/glm-credits.py at canary"],
  ["owner.names", ["alex", "octo-owner"], "scripts/hooks/no-chat-question.ts at canary"],
  [
    "sessions.names",
    { builder: "maker", dispatcher: "boss", ops: "keeper", planner: "thinker" },
    "roster.json",
  ],
  ["slack.linkConverter", "python3 ~/tools/links.py", ".github/notes/migrate/table.json at PRE"],
  ["slack.sendServer", "acme-slack", "api/hono/src/lib/desk/inbox.ts at canary"],
  [
    "usage.accounts",
    [
      { email: "a@example.com", nearLimit: true, renews: 17, weekReset: { hour: 17, weekday: 6 } },
      {
        email: "b@example.com",
        ends: "2026-11-07T18:30:00+00:00",
        endsFirst: true,
        weekReset: { hour: 15 + 59 / 60, weekday: 1 },
      },
      { email: "c@example.com", ends: null, endsFirst: true, nearLimit: true },
      { label: "zai", provider: "glm" },
    ],
    `${USAGE} at canary`,
  ],
  ["usage.keychainService", "acme-claude-oauth", "scripts/ops/usage/account-watch.py at canary"],
  ["usage.switchAccount", "b@example.com", "packages/scripts/src/ops-tick/tick.ts at canary"],
]

const settingsAt = (data: string, scope: string) => {
  const path = join(scopeDir(data, scope), "settings.json")
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
}

describe("playground migrate", () => {
  const source: Source = archiveWith("archive", OLD)
  const skills = skillsWith("skills")

  test("a dry run says what each seed would write and writes nothing", () => {
    const data = dataWith("dry")
    const steps = migrate(data, source, depsOf(source, skills, HOME, CHECKOUT), true)
    expect(steps.every((step) => step.ok)).toBe(true)
    expect(steps.map((step) => step.line)).toEqual([
      ...SETTINGS.map(
        ([key, value, from]) =>
          `+ ${key} at ${LOGIN}: from ${from === "roster.json" ? join(data, from) : from.replace("PRE", source.preSquash)}${key.startsWith("ext.") ? `: ${JSON.stringify(value)}` : ""}`,
      ),
      `+ list release-owners at ${LOGIN}: from scripts/hooks/no-release-comment.ts at canary`,
      `+ skill parity-sweep at ${ORG}: from ${join(skills, "parity-sweep")}`,
      `+ skill smoke-test at ${ORG}: from ${join(skills, "smoke-test")}`,
    ])
    expect(existsSync(scopeDir(data, LOGIN))).toBe(false)
    expect(existsSync(scopeDir(data, ORG))).toBe(false)
  })

  test("a run seeds the login's settings and list from the archive, and the hand-made skills", () => {
    const data = dataWith("run")
    const steps = migrate(data, source, depsOf(source, skills, HOME, CHECKOUT), false)
    const settings = settingsAt(data, LOGIN)
    for (const [key, value] of SETTINGS) {
      const line = steps.find((step) =>
        step.line.startsWith(`${resolveKey(key) ? "+" : "-"} ${key} at`),
      )
      // a key the schema does not define yet is refused by name, the rest written
      if (resolveKey(key)) {
        expect(line).toEqual({ line: `+ ${key} at ${LOGIN}`, ok: true })
        expect(settings[key]).toEqual(value)
      } else expect(line?.ok).toBe(false)
    }
    const login = scopeDir(data, LOGIN)
    expect(JSON.parse(readFileSync(join(login, "lists", "release-owners.json"), "utf8"))).toEqual([
      "octo-owner",
    ])
    const company = scopeDir(data, ORG)
    expect(
      readFileSync(join(company, "skills", "parity-sweep", "harness", "sweep.py"), "utf8"),
    ).toBe("print('sweep')\n")
    expect(existsSync(join(company, "skills", "parity-sweep", "harness", "__pycache__"))).toBe(
      false,
    )
    expect(existsSync(join(company, "skills", "smoke-test", "SKILL.md"))).toBe(true)
    expect(existsSync(join(company, "skills", "review-bot"))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(data, "extensions", "hooks", "release-owners.json"), "utf8")),
    ).toEqual(["octo-owner"])
  })

  test("a second run leaves every value already there", () => {
    const data = dataWith("again")
    migrate(data, source, depsOf(source, skills, HOME, CHECKOUT), false)
    const head = mustGit(scopeDir(data, LOGIN), ["rev-parse", "HEAD"])
    const steps = migrate(data, source, depsOf(source, skills, HOME, CHECKOUT), false)
    expect(mustGit(scopeDir(data, LOGIN), ["rev-parse", "HEAD"])).toBe(head)
    const items = steps.filter(
      (step) => !SETTINGS.some(([key]) => step.line.includes(` ${key} at`)),
    )
    expect(items.map((step) => step.line[0])).toEqual(["=", "=", "="])
    for (const [key] of SETTINGS.filter(([key]) => resolveKey(key)))
      expect(steps.find((step) => step.line.includes(` ${key} at`))?.line).toBe(
        `= ${key} at ${LOGIN}: already set`,
      )
  })

  test("a second run leaves a value changed since the first run as it is", () => {
    const data = dataWith("changed")
    migrate(data, source, depsOf(source, skills, undefined, CHECKOUT), false)
    const who = { actor: "cli", author: "owner", inboxRef: null, reason: "a later choice" }
    expect(
      setSetting(data, { key: "usage.switchAccount", scope: LOGIN, value: "c@example.com" }, who)
        .ok,
    ).toBe(true)
    const steps = migrate(data, source, depsOf(source, skills, undefined, CHECKOUT), false)
    expect(steps.find((step) => step.line.includes(" usage.switchAccount at"))?.line).toBe(
      `= usage.switchAccount at ${LOGIN}: already set`,
    )
    expect(settingsAt(data, LOGIN)["usage.switchAccount"]).toBe("c@example.com")
  })

  test("reads no rule from the archive, since the owner's rules ride in their private extension, and a pre-squash with none still runs clean", () => {
    const data = dataWith("no-rule")
    const steps = migrate(data, source, depsOf(source, skills, HOME, CHECKOUT), false)
    expect(steps.filter((step) => /\brules?\b|zerosdk/.test(step.line))).toEqual([])
    expect(steps.filter((step) => !step.ok).map((step) => step.line.split(" ")[1])).toEqual(
      SETTINGS.map(([key]) => key).filter((key) => !resolveKey(key)),
    )
    expect(existsSync(join(scopeDir(data, LOGIN), "rules"))).toBe(false)
  })

  test("a second run leaves a list changed since the first run as it is", () => {
    const data = dataWith("changed-items")
    migrate(data, source, depsOf(source, skills, undefined, CHECKOUT), false)
    const who = { actor: "cli", author: "owner", inboxRef: null, reason: "a later choice" }
    const owners = { key: "release-owners", kind: "list" as const, scope: LOGIN }
    const later = { attachments: [], files: null }
    expect(
      putItem(data, owners, { ...later, body: null, value: ["later-owner"] }, who, true).ok,
    ).toBe(true)
    const head = mustGit(scopeDir(data, LOGIN), ["rev-parse", "HEAD"])
    const steps = migrate(data, source, depsOf(source, skills, undefined, CHECKOUT), false)
    expect(
      steps.filter((step) => / release-owners at /.test(step.line)).map((step) => step.line),
    ).toEqual([`= list release-owners at ${LOGIN}: already set`])
    expect(mustGit(scopeDir(data, LOGIN), ["rev-parse", "HEAD"])).toBe(head)
    expect(showItem(data, owners)?.content.value).toEqual(["later-owner"])
  })

  test("a checkout with no GitHub origin fails the two repository seeds it would give, by name", () => {
    const bare = join(scratch, "bare-checkout")
    mkdirSync(bare, { recursive: true })
    mustGit(bare, ["init", "-q"])
    const steps = migrate(dataWith("no-origin"), source, depsOf(source, skills, HOME, bare), true)
    expect(steps.filter((step) => !step.ok).map((step) => step.line)).toEqual([
      "- factory.publicRepo: none found in this checkout's origin",
      "- factory.repo: none found in this checkout's origin",
    ])
  })

  test("a skill the company's clone holds is left to it", () => {
    const data = dataWith("cloned")
    write(scopeDir(data, ORG), { "skills/smoke-test/SKILL.md": "cloned\n" })
    const steps = migrate(data, source, depsOf(source, skills, HOME, CHECKOUT), false)
    expect(steps.at(-1)?.line).toBe(`= skill smoke-test at ${ORG}: its clone holds it`)
    expect(
      readFileSync(join(scopeDir(data, ORG), "skills", "smoke-test", "SKILL.md"), "utf8"),
    ).toBe("cloned\n")
  })

  test("a value the archive does not hold fails its step by name, and the others still run", async () => {
    const { "scripts/ops/usage/glm-credits.py": _, ...old } = OLD
    const lacking = archiveWith("lacking", old)
    const data = dataWith("lacking-data")
    const out: string[] = []
    const code = await runMigrate(
      ["--archive", lacking.archive, "--pre-squash", lacking.preSquash, "--org", ORG, "--dry-run"],
      data,
      skills,
      HOME,
      (line) => out.push(line),
      CHECKOUT,
    )
    expect(code).toBe(1)
    expect(out).toContain(
      "- models.glmKeychainService: none found in scripts/ops/usage/glm-credits.py at canary",
    )
    expect(out).toHaveLength(SETTINGS.length + 4)
    expect(out.at(-1)).toBe(`+ herdr: playground herdr pin puts herdr 0.9.5 at ${herdrPath()}`)
  })

  test("the old data folder moves to ~/.playground first, so the seeds read it there", async () => {
    const config = join(scratch, "machine", ".claude")
    const old = dataWith(join("machine", ".claude", "oldhome"))
    const data = join(scratch, "machine", ".playground")
    const words = ["--archive", source.archive, "--pre-squash", source.preSquash, "--org", ORG]
    const dry: string[] = []
    await runMigrate(
      [...words, "--dry-run"],
      data,
      skills,
      HOME,
      (l) => dry.push(l),
      CHECKOUT,
      config,
    )
    expect(dry.filter((line) => line.startsWith("- "))).toEqual([])
    expect(dry[0]).toBe(`~ ${old} moved to ${data}, its old names left as links to it`)
    expect(existsSync(data)).toBe(false)
    const out: string[] = []
    await runMigrate(words, data, skills, HOME, (l) => out.push(l), CHECKOUT, config, fakePin)
    // a key the schema does not define yet is refused by name, as in the run above
    expect(out.filter((line) => line.startsWith("- ") && !line.includes(": no setting "))).toEqual(
      [],
    )
    expect(readFileSync(join(old, "extensions", "login"), "utf8")).toBe(`${LOGIN}\n`)
    expect(readFileSync(join(data, "roster.json"), "utf8")).toBe(JSON.stringify(ROSTER))
  })

  test("puts the pinned herdr in place, and --dry-run names that step and downloads nothing", async () => {
    const words = ["--archive", source.archive, "--pre-squash", source.preSquash, "--org", ORG]
    const before = pins
    const dry: string[] = []
    await runMigrate(
      [...words, "--dry-run"],
      dataWith("pin-dry"),
      skills,
      HOME,
      (l) => dry.push(l),
      CHECKOUT,
      undefined,
      fakePin,
    )
    expect(pins).toBe(before)
    expect(dry.at(-1)).toBe(`+ herdr: playground herdr pin puts herdr 0.9.5 at ${herdrPath()}`)
    const out: string[] = []
    await runMigrate(
      words,
      dataWith("pin"),
      skills,
      HOME,
      (l) => out.push(l),
      CHECKOUT,
      undefined,
      fakePin,
    )
    expect(pins).toBe(before + 1)
    expect(out.at(-1)).toMatch(/^\+ herdr: herdr 0\.9\.5 (already )?pinned at /)
    expect(existsSync(PINNED)).toBe(true)
  })

  test("a pin that fails fails the run by name", async () => {
    const out: string[] = []
    const code = await runMigrate(
      ["--archive", source.archive, "--pre-squash", source.preSquash, "--org", ORG],
      dataWith("pin-fails"),
      skills,
      HOME,
      (l) => out.push(l),
      CHECKOUT,
      undefined,
      async () => ({ code: 4, line: "herdr-pin: https://example.invalid answered 404" }),
    )
    expect(code).toBe(1)
    expect(out.at(-1)).toBe("- herdr: herdr-pin: https://example.invalid answered 404")
  })

  test("a machine with no login fails by name", async () => {
    const data = join(scratch, "no-login")
    mkdirSync(data, { recursive: true })
    const out: string[] = []
    const code = await runMigrate(
      ["--archive", source.archive, "--pre-squash", source.preSquash, "--org", ORG],
      data,
      skills,
      HOME,
      (line) => out.push(line),
      CHECKOUT,
      undefined,
      fakePin,
    )
    expect(code).toBe(1)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(
      `- the login: no login for the extensions in ${join(data, "extensions", "login")}: run playground ext init`,
    )
    expect(out[1]).toEndWith(`pinned at ${PINNED}`)
  })

  test("the archive and the pre-squash head are required", async () => {
    const out: string[] = []
    expect(
      await runMigrate(["--archive", source.archive], dataWith("usage"), skills, HOME, (l) =>
        out.push(l),
      ),
    ).toBe(2)
    expect(out).toEqual([
      "usage: playground migrate --archive <checkout> --pre-squash <sha> --org <org> [--old <rev>] [--dry-run]",
    ])
  })
})

test("the extensions' order and links come from orgs.map and orgs.always when the login holds them, else from --org", () => {
  expect(extFromOrgs("me", "acme")).toEqual({
    "ext.links": { acme: ["*", "acme"], me: ["*"] },
    "ext.order": ["me", "acme"],
  })
  const old = [
    { key: "orgs.always", value: ["corp"] },
    { key: "orgs.map", value: { "Acme-Inc": "acme", "acme-labs": "acme" } },
  ]
  expect(extFromOrgs("me", "unused", old)).toEqual({
    "ext.links": { acme: ["acme-inc", "acme-labs"], corp: ["*"], me: ["*"] },
    "ext.order": ["me", "acme", "corp"],
  })
})
