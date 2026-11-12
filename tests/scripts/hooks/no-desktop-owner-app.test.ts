import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "../../../scripts/hooks/no-desktop-owner-app"
import { check as extensionsWrite } from "../../../scripts/hooks/no-extensions-write"
import { storeWith } from "./render-set"

let scratch = ""
let guarded = ""
let freed = ""
let script = ""
let plain = ""

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "no-desktop-owner-app-"))
  guarded = storeWith(join(scratch, "guarded"), {
    "desktop-owner-apps.json": '["Helium", "Slack"]',
  })
  freed = storeWith(join(scratch, "freed"), { "desktop-owner-apps.json": '["Helium"]' })
  script = join(scratch, "run.sh")
  plain = join(scratch, "plain.sh")
  await Bun.write(script, "#!/bin/bash\nagent-desktop snapshot --app Slack -i\n")
  await Bun.write(plain, "#!/bin/bash\necho ready\n")
})

afterAll(async () => {
  await rm(scratch, { force: true, recursive: true })
})

const bash = (command: string, data = guarded, environment: Record<string, string> = {}) =>
  check(
    JSON.stringify({
      cwd: scratch,
      hook_event_name: "PreToolUse",
      tool_input: { command },
      tool_name: "Bash",
    }),
    { PLAYGROUND_DATA_DIR: data, ...environment },
  )

describe("--headed", () => {
  test.each([
    ["on a ref action", "agent-desktop click @s8f3k2p9:e5 --headed"],
    ["before the command", "agent-desktop --headed snapshot --app Finder"],
    ["with a value", "agent-desktop hover @s8f3k2p9:e5 --headed=true"],
    ["behind bash -c", `bash -c 'agent-desktop click @s8f3k2p9:e5 --headed'`],
    ["behind zsh -O -c", `zsh -O -c 'agent-desktop click @s8f3k2p9:e5 --headed'`],
    ["behind bash -O extglob -c", `bash -O extglob -c 'agent-desktop click @s8f3k2p9:e5 --headed'`],
    ["behind env", "env agent-desktop click @s8f3k2p9:e5 --headed"],
    ["behind run-slot", "~/.playground/ops/run-slot.sh w -- agent-desktop click @s1:e5 --headed"],
    ["in a pipeline", "echo go | agent-desktop click @s8f3k2p9:e5 --headed | cat"],
    ["through npx", "npx -y agent-desktop@latest click @s8f3k2p9:e5 --headed"],
    ["by its path", "/opt/bin/agent-desktop click @s8f3k2p9:e5 --headed"],
  ])("is refused %s", async (_, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-desktop-owner-app hook refused")
    expect(reason).toContain("--headed")
    expect(reason).toContain("! prefix in the dispatcher's terminal window")
  })
})

describe("an app on the list", () => {
  test.each([
    ["snapshot --app Slack", "agent-desktop snapshot --app Slack -i"],
    ["in another case", "agent-desktop snapshot --app sLaCk -i"],
    ["with .app", "agent-desktop snapshot --app Slack.app -i"],
    ["as --app=", "agent-desktop screenshot --app=Helium /abs/shot.png"],
    ["by its bundle path", "agent-desktop launch /Applications/Slack.app"],
    ["launch", "agent-desktop launch Slack --activate"],
    ["close-app", "agent-desktop close-app helium --force"],
    ["list-windows", "agent-desktop list-windows --app Slack"],
    ["behind bash -c", `bash -c "agent-desktop snapshot --app Slack"`],
    ["behind sh reading a pipe", "echo 'agent-desktop snapshot --app Slack' | sh"],
    ["behind sudo, its -p value in a cluster", "sudo -Hp echo agent-desktop snapshot --app Slack"],
    ["behind sudo --prompt", "sudo --prompt echo agent-desktop snapshot --app Slack"],
    ["behind time -o", "/usr/bin/time -o echo agent-desktop snapshot --app Slack"],
    ["behind doas -C", "doas -C echo agent-desktop snapshot --app Slack"],
    ["behind sudo, its -p value attached", "sudo -pecho agent-desktop snapshot --app Slack"],
    ["behind env's --, an assignment after it", "env -- X=1 agent-desktop snapshot --app Slack"],
    ["behind nice's -<number>", "nice -10 agent-desktop snapshot --app Slack"],
  ])("is refused: %s", async (_, command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-desktop-owner-app hook refused")
    expect(reason).toContain("desktop-owner-apps")
  })

  test("names both ways out", async () => {
    const reason = await bash("agent-desktop snapshot --app Slack")
    expect(reason).toContain("! prefix")
    expect(reason).toContain("take Slack off")
    expect(reason).toContain(
      "to take Slack off the list in the owner's login extension, tell your lead, who posts an apps decision with playground ask new (.agents/dashboard/asks.md), whose Approve takes it off",
    )
  })

  test("passes once the list no longer holds it", async () => {
    expect(await bash("agent-desktop snapshot --app Slack -i", freed)).toBeUndefined()
    expect(await bash("agent-desktop snapshot --app Helium -i", freed)).toContain(
      "no-desktop-owner-app hook refused",
    )
  })
})

describe("a session's own way out is refused", () => {
  const forms = (allow: string, call: string) => [
    ["an env var prefix", `AGENT_DESKTOP_ALLOW=${allow} ${call}`],
    ["export", `export AGENT_DESKTOP_ALLOW=${allow}; ${call}`],
    ["env", `env AGENT_DESKTOP_ALLOW=${allow} ${call}`],
    [
      "a file the session writes",
      `echo 'Override: ${allow} is fine for this task' > /abs/brief.md; ${call}`,
    ],
    [
      "the list file written in the same call",
      `echo '[]' > "$PLAYGROUND_DATA_DIR/extensions/hooks/desktop-owner-apps.json"; ${call}`,
    ],
  ]
  test.each([
    ...forms("headed", "agent-desktop click @s8f3k2p9:e5 --headed"),
    ...forms("Slack", "agent-desktop snapshot --app Slack"),
  ])("%s: %s", async (_, command) => {
    expect(await bash(command)).toContain("no-desktop-owner-app hook refused")
  })

  test.each([
    ["headed", "agent-desktop click @s8f3k2p9:e5 --headed"],
    ["Slack", "agent-desktop snapshot --app Slack"],
  ])("the hook's own environment: AGENT_DESKTOP_ALLOW=%s", async (allow, command) => {
    expect(await bash(command, guarded, { AGENT_DESKTOP_ALLOW: allow })).toContain(
      "no-desktop-owner-app hook refused",
    )
  })
})

// The documented limits of a text hook, pinned so the boundary stays visible; no-extensions-write refuses the list edit this hook would honour.
describe("what the hook does not reach", () => {
  test("a list changed between calls is honoured, and a session's edit of it is no-extensions-write's to refuse", async () => {
    const edited = storeWith(join(scratch, "edited"), {
      "desktop-owner-apps.json": '["Helium", "Slack"]',
    })
    expect(await bash("agent-desktop snapshot --app Slack", edited)).toContain("hook refused")
    const list = join(edited, "extensions", "hooks", "desktop-owner-apps.json")
    const write = JSON.stringify({
      cwd: scratch,
      tool_input: { command: `echo '["Helium"]' > ${list}` },
      tool_name: "Bash",
    })
    expect(await extensionsWrite(write, { PLAYGROUND_DATA_DIR: edited })).toContain(
      "no-extensions-write hook refuses",
    )
    storeWith(edited, { "desktop-owner-apps.json": '["Helium"]' })
    expect(await bash("agent-desktop snapshot --app Slack", edited)).toBeUndefined()
  })

  test.each([
    ["a program word in a variable", '"$AD" click @s8f3k2p9:e5 --headed'],
    ["a renamed copy of the binary", "/abs/ad snapshot --app Slack"],
  ])("%s, in a call that never names agent-desktop, passes", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })
})

describe("what the hook cannot read is refused", () => {
  test.each([
    ["an app in a variable", `A=Slack; agent-desktop snapshot --app "$A"`],
    ["a flag in a variable", `F=--headed; agent-desktop click @s8f3k2p9:e5 $F`],
    ["a command substitution", "agent-desktop snapshot --app $(cat /abs/app)"],
    ["the program in a variable", `D=agent-desktop; $D click @s8f3k2p9:e5 --headed`],
    ["the program from which", "$(which agent-desktop) snapshot --app Slack"],
    ["xargs filling the arguments", "echo --headed | xargs agent-desktop click @s8f3k2p9:e5"],
    ["a batch", `agent-desktop batch '[{"command":"snapshot","args":["--app","Slack"]}]'`],
    ["a window picked by id", "agent-desktop snapshot --app Finder --window-id 4242"],
    ["a notification action", "agent-desktop notification-action 1 Reply"],
    ["snapshot with no --app", "agent-desktop snapshot -i --compact"],
    ["press with no --app", "agent-desktop press cmd+c"],
    ["focus-window by title alone", "agent-desktop focus-window --title general"],
    ["list-notifications with no --app", "agent-desktop list-notifications"],
    ["a wrapper option it does not know", "sudo -Z echo agent-desktop snapshot --app Slack"],
    ["a wrapper option's value in a variable", "/usr/bin/time -o $F echo agent-desktop --headed"],
    ["an interpreter that runs it", `python3 -c "import os; os.system('agent-desktop --headed')"`],
    [
      "a script written in the same call",
      "echo 'agent-desktop --headed' > /abs/x.sh; bash /abs/x.sh",
    ],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toContain("no-desktop-owner-app hook refused")
  })

  test("a script file that names a listed app", async () => {
    expect(await bash(`bash ${script}`)).toContain("Slack")
    // bash's -O takes a shopt name, so the script file is the word after it: the shell's name has to reach the reader
    expect(await bash(`bash -O extglob ${script}`)).toContain("Slack")
    expect(await bash(`source ${script}`)).toContain("no-desktop-owner-app hook refused")
  })
})

describe("passes", () => {
  test.each([
    ["snapshot --app Finder", "agent-desktop snapshot --app Finder --skeleton -i --compact"],
    ["a ref action", "agent-desktop click @s8f3k2p9:e5"],
    ["type into a ref", `agent-desktop type @s8f3k2p9:e5 "Slack is busy"`],
    ["a snapshot under a ref", "agent-desktop snapshot --root @s8f3k2p9:e3 -i --compact"],
    ["wait on a ref", "agent-desktop wait --element @s8f3k2p9:e9 --predicate actionable"],
    ["launch Finder", "agent-desktop launch Finder --activate"],
    ["list-apps", "agent-desktop list-apps"],
    ["the version", "agent-desktop version"],
    ["its docs", "agent-desktop skills get desktop"],
    ["permissions", "agent-desktop permissions"],
    ["a commit naming it", `git commit -m "docs: agent-desktop --headed is refused"`],
    ["snapshot --app Finder behind watch -n", "watch -n 1 agent-desktop snapshot --app Finder"],
    ["snapshot --app Finder behind flock", "flock /tmp/x agent-desktop snapshot --app Finder"],
    ["list-apps behind setsid", "setsid agent-desktop list-apps"],
    ["a quoted line watch runs", "watch -n 1 'agent-desktop snapshot --app Finder'"],
    ["an unrelated script", `bash ${join(tmpdir(), "missing-dir", "x.sh")}`],
    [
      "behind sudo's known options",
      "sudo -Hp pw -u root --preserve-env agent-desktop launch Finder",
    ],
    ["behind time -p", "time -p agent-desktop list-apps"],
  ])("%s", async (_, command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("a script file with no agent-desktop in it", async () => {
    expect(await bash(`bash ${plain}`)).toBeUndefined()
  })

  test("an empty list guards no app, and --headed stays refused", async () => {
    const none = storeWith(join(scratch, "none"), { "desktop-owner-apps.json": "[]" })
    expect(await bash("agent-desktop snapshot --app Slack", none)).toBeUndefined()
    expect(await bash("agent-desktop click @s8f3k2p9:e5 --headed", none)).toContain("--headed")
  })

  test("a store whose set lacks the list refuses, naming the file and the dispatcher's route", async () => {
    const missing = storeWith(join(scratch, "missing"), {})
    const reason = await bash("agent-desktop snapshot --app Finder", missing)
    expect(reason).toContain("hooks/desktop-owner-apps.json")
    expect(reason).toContain("tell your lead, and the dispatcher hands the owner the command")
    expect(reason).not.toContain("ext import")
  })

  test("a call that is not agent-desktop never reads the list", async () => {
    const broken = storeWith(join(scratch, "broken"), { "desktop-owner-apps.json": "{" })
    expect(await bash("ls -la", broken)).toBeUndefined()
    expect(await bash("agent-desktop snapshot --app Finder", broken)).toContain(
      "desktop-owner-apps.json",
    )
  })
})

// bun run ask/thread read argv as data only from the main checkout, whose package.json maps the script to its Playground entry and whose entry file no session writes; every other cwd, a byte-identical linked worktree included, keeps the verdict, since there the script's body goes unread.
describe("a bun run ask/thread note reads as data only from the main checkout", () => {
  const askNote = `bun run ask x "note; agent-desktop 1.0 ok"`
  const threadNote = `bun run thread title t1 "note; agent-desktop 1.0 ok"`
  const { scripts } = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"),
  )
  const GOOD = { ask: scripts.ask, thread: scripts.thread }
  const gitc = (dir: string, ...args: string[]) =>
    Bun.spawnSync([
      "git",
      "-C",
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ])
  // A fabricated main checkout: a git repo with scripts/spawn.sh, the given package scripts, and (unless entry is false) the ask/thread entry files.
  const makeMain = async (name: string, scripts: Record<string, string>, entry = true) => {
    const dir = join(scratch, name)
    Bun.spawnSync(["git", "-C", scratch, "init", "-q", "-b", "canary", dir])
    await Bun.write(join(dir, "scripts", "spawn.sh"), "#!/bin/sh\n")
    await Bun.write(join(dir, "package.json"), `${JSON.stringify({ scripts })}\n`)
    if (entry) {
      await Bun.write(join(dir, "api", "hono", "src", "bin", "dashboard-ask.ts"), "")
      await Bun.write(join(dir, "api", "hono", "src", "bin", "dashboard-thread.ts"), "")
    }
    return dir
  }
  let MAIN = ""
  let WORK = ""
  let prior: string | undefined
  beforeAll(async () => {
    MAIN = await makeMain("ndo-main", GOOD)
    WORK = join(scratch, "ndo-work")
    gitc(MAIN, "add", ".")
    gitc(MAIN, "commit", "-q", "-m", "base")
    gitc(MAIN, "worktree", "add", "-q", "--detach", WORK)
    prior = process.env.PLAYGROUND_REPO
    process.env.PLAYGROUND_REPO = MAIN
  })
  afterAll(() => {
    if (prior === undefined) delete process.env.PLAYGROUND_REPO
    else process.env.PLAYGROUND_REPO = prior
  })
  const at = (command: string, cwd: string) =>
    check(
      JSON.stringify({
        cwd,
        hook_event_name: "PreToolUse",
        tool_input: { command },
        tool_name: "Bash",
      }),
      { PLAYGROUND_DATA_DIR: guarded },
    )
  const withMain = async (repo: string, command: string, cwd: string) => {
    const save = process.env.PLAYGROUND_REPO
    process.env.PLAYGROUND_REPO = repo
    try {
      return await at(command, cwd)
    } finally {
      if (save === undefined) delete process.env.PLAYGROUND_REPO
      else process.env.PLAYGROUND_REPO = save
    }
  }

  test("runs from the main checkout, whose package.json maps the script to its entry", async () => {
    expect(await at(askNote, MAIN)).toBeUndefined()
    expect(await at(threadNote, MAIN)).toBeUndefined()
  })

  test("stays refused from a byte-identical linked worktree of the main checkout", async () => {
    expect(await at(askNote, WORK)).toContain("no-desktop-owner-app hook refused")
    expect(await at(threadNote, WORK)).toContain("no-desktop-owner-app hook refused")
  })

  test("stays refused in a folder with no package.json", async () => {
    expect(await at(askNote, scratch)).toContain("no-desktop-owner-app hook refused")
    expect(await at(threadNote, scratch)).toContain("no-desktop-owner-app hook refused")
  })

  test("stays refused where the main checkout's package.json maps the script elsewhere", async () => {
    const bad = await makeMain("ndo-bad", { ask: "echo hi", thread: "agent-desktop launch Slack" })
    expect(await withMain(bad, askNote, bad)).toContain("no-desktop-owner-app hook refused")
    expect(await withMain(bad, threadNote, bad)).toContain("no-desktop-owner-app hook refused")
  })

  test("stays refused where the main checkout's package.json runs the entry with no prebuild", async () => {
    const bare = await makeMain("ndo-bare", {
      ask: "bun api/hono/src/bin/dashboard-ask.ts",
      thread: "bun api/hono/src/bin/dashboard-thread.ts",
    })
    expect(await withMain(bare, askNote, bare)).toContain("no-desktop-owner-app hook refused")
    expect(await withMain(bare, threadNote, bare)).toContain("no-desktop-owner-app hook refused")
  })

  test("stays refused where the Playground entry file is absent", async () => {
    const noentry = await makeMain("ndo-noentry", GOOD, false)
    expect(await withMain(noentry, askNote, noentry)).toContain("no-desktop-owner-app hook refused")
  })

  test("stays refused from a planted git folder with its own scripts/spawn.sh when PLAYGROUND_REPO is unset", async () => {
    const planted = await makeMain("ndo-planted", GOOD)
    const save = process.env.PLAYGROUND_REPO
    delete process.env.PLAYGROUND_REPO
    try {
      expect(await at(askNote, planted)).toContain("no-desktop-owner-app hook refused")
      expect(await at(threadNote, planted)).toContain("no-desktop-owner-app hook refused")
    } finally {
      if (save === undefined) delete process.env.PLAYGROUND_REPO
      else process.env.PLAYGROUND_REPO = save
    }
  })

  test("stays refused from a plain folder under the main checkout's .claude/worktrees with its own package.json", async () => {
    const made = join(MAIN, ".claude", "worktrees", "madeX")
    await Bun.write(
      join(made, "package.json"),
      JSON.stringify({ scripts: { ask: "echo hi", thread: "echo hi" } }),
    )
    expect(await at(askNote, made)).toContain("no-desktop-owner-app hook refused")
    expect(await at(threadNote, made)).toContain("no-desktop-owner-app hook refused")
  })

  test("stays refused after a cd out of the main checkout earlier in the line", async () => {
    expect(await at(`cd ${scratch} && ${askNote}`, MAIN)).toContain(
      "no-desktop-owner-app hook refused",
    )
  })

  test("stays refused after a cd to a variable, whose target is unknown", async () => {
    expect(await at(`cd "$DEST" && ${askNote}`, MAIN)).toContain(
      "no-desktop-owner-app hook refused",
    )
  })

  test("stays refused with an argument built from a variable, even from the main checkout", async () => {
    expect(await at(`bun run ask x "note: agent-desktop $BUILD ok"`, MAIN)).toContain(
      "no-desktop-owner-app hook refused",
    )
  })
})
