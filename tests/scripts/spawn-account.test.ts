import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { OLD } from "../session-names"
import {
  homes,
  launchAfterRm,
  paneRun,
  placing,
  root,
  scratch,
  spawn,
  TOKEN,
  unplugged,
  usage,
} from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("--account logs the session in as another Claude account", () => {
  const email = "spare@example.com"
  const lookup = `tk="$(security find-generic-password -s playground-claude-oauth -a ${email} -w)" || exit 1; [ -n "$tk" ] || { echo "The playground-claude-oauth item for ${email} holds an empty token; save it again with security add-generic-password -s playground-claude-oauth -a ${email} -w, then respawn." >&2; exit 1; }; CLAUDE_CODE_OAUTH_TOKEN="$tk" `
  const command = launchAfterRm
  const leaks = (r: Awaited<ReturnType<typeof spawn>>) =>
    [...placing(r).flat(), ...(r.roster ?? []), r.out, r.err].join("\n").includes(TOKEN)

  test.each([
    ["worker", ["worker", "worker-brave-otter", "b.md", "--account", email]],
    [
      "column",
      ["column", "lead", OLD.planner, OLD.dispatcher, "w1:p2", "h.md", "--account", email],
    ],
    [
      "resume",
      ["resume", OLD.dispatcher, root, "a7e37f18-1fa1-4cb2-a26e-4ff414fd4b27", "--account", email],
    ],
    ["a flag before the mode", ["--account", email, "runner", "runner-calm-heron", "b.md"]],
  ])("%s: the pane's shell reads the token, which spawn.sh never sees", async (_, args) => {
    const r = await spawn(
      args,
      [],
      {},
      undefined,
      args[0] === "resume" ? { name: args[1] as string, backend: "claude" } : undefined,
    )
    expect(r.code).toBe(0)
    expect(command(r)).toStartWith(`(${lookup}env PLAYGROUND_ROLE=`)
    expect(command(r)).not.toContain("--account")
    expect(leaks(r)).toBe(false)
    expect(r.security).toEqual([`find-generic-password -s playground-claude-oauth -a ${email}`])
  })

  test("with inscope's config dir, the lookup comes before the env that drops it", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--account", email], [], {
      INSCOPE_CCD: "/work/.claude",
    })
    expect(command(r)).toStartWith(
      `(${lookup}env -u CLAUDE_CONFIG_DIR -u INSCOPE_CCD PLAYGROUND_ROLE=worker claude -n `,
    )
  })

  test("with no --account the command is what it was, and the Keychain is not asked", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md"], [])
    const home = join(scratch, `home-${homes}`)
    expect(unplugged(command(r))).toBe(
      `(env PLAYGROUND_ROLE=worker claude -n worker-brave-otter --model claude-opus-5-5 --effort high --settings ${home}/.playground/factory-settings-400k.json --dangerously-skip-permissions "You are worker-brave-otter, a worker in the Playground factory; you report to builder. Load the playbook skill first. Your brief is in ~/.playground/b.md: read it in full and follow it. Report to builder with SendMessage (to: builder).")`,
    )
    expect(r.security).toBeUndefined()
  })

  test("an empty token stops the pane before claude runs", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--account", email], [], {
      FAKE_EMPTY_TOKEN: "1",
    })
    const cmd = command(r)
    expect(cmd).toContain("holds an empty token")
    expect(cmd.indexOf('[ -n "$tk" ]')).toBeLessThan(cmd.indexOf(" claude "))
    expect(cmd).not.toContain(TOKEN)
  })

  test("an empty token ends the launch before claude runs", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--account", email], [], {
      FAKE_EMPTY_TOKEN: "1",
    })
    const pane = await paneRun(r, { FAKE_EMPTY_TOKEN: "1" })
    expect(pane.err).toContain("holds an empty token")
    expect(pane.code).toBe(1)
    expect(existsSync(join(r.home, "claude.args"))).toBe(false)
  })

  // A session on the machine's own login starts on its config with no token, as a bare start does, its usage judged as that login's (#1756).
  const own = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email } })
  // usage.json reading the own login, so a start on it is judged by that file
  const ownUsage = JSON.stringify(usage({ account: email }))
  test("a worker on this machine's own login starts on it with no token, and the Keychain is not asked", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--account", email], [], {
      CLAUDE_JSON: own(email.toUpperCase()),
      USAGE_JSON: ownUsage,
    })
    expect(r.code).toBe(0)
    expect(command(r)).toStartWith("(env PLAYGROUND_ROLE=worker claude ")
    expect(r.security).toBeUndefined()
  })

  test("the second dispatcher on this machine's own login is refused before herdr runs, since it would run out with the first", async () => {
    const r = await spawn(
      ["manager", `${OLD.dispatcher}-2`, `brief-${OLD.dispatcher}-2.md`, "--account", email],
      [],
      { CLAUDE_JSON: own(email) },
    )
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
    expect(r.err).toContain(
      "the second dispatcher, runs on --backend glm, or on Claude with --account <email>, a second account",
    )
  })

  test("the own login is read from the config folder's .claude.json when CLAUDE_CONFIG_DIR is set", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--account", email], [], {
      CLAUDE_JSON: own("quilla@example.org"),
      CONFIG_DIR_CLAUDE_JSON: own(email),
      CLAUDE_CONFIG_DIR: join(scratch, `home-${homes + 1}`, ".claude"),
      USAGE_JSON: ownUsage,
    })
    expect(r.code).toBe(0)
    expect(r.security).toBeUndefined()
  })

  test("under inscope, whose folder the launch drops, the own login is read from ~/.claude.json", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--account", email], [], {
      CLAUDE_JSON: own(email),
      CONFIG_DIR_CLAUDE_JSON: own("quilla@example.org"),
      CLAUDE_CONFIG_DIR: join(scratch, `home-${homes + 1}`, ".claude"),
      INSCOPE_CCD: "/work/.claude",
      USAGE_JSON: ownUsage,
    })
    expect(r.code).toBe(0)
    expect(r.security).toBeUndefined()
  })

  test.each([
    ["another login", own("quilla@example.org")],
    ["no login", JSON.stringify({ oauthAccount: null })],
    ["a config that does not read", "{"],
  ])("a config naming %s lets --account through", async (_, config) => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--account", email], [], {
      CLAUDE_JSON: config,
    })
    expect(r.code).toBe(0)
  })

  test("an account with no Keychain item is refused before herdr runs", async () => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--account", email], [], {
      FAKE_NO_ITEM: "1",
    })
    expect(r.code).toBe(1)
    expect(placing(r)).toEqual([])
    expect(r.roster).toBeUndefined()
    expect(r.err).toContain(`the Keychain holds no playground-claude-oauth item for ${email}`)
  })

  test.each([
    ["a quote", 'a"b@example.com'],
    ["a space", "a b@example.com"],
    ["a dollar", "$(id)@example.com"],
    ["a backtick", "a`id`@example.com"],
    ["no domain", "acme@"],
    ["no dot in the domain", "acme@localhost"],
    ["a semicolon", "a@example.com;id"],
  ])("an email with %s is refused before the Keychain or herdr", async (_, bad) => {
    const r = await spawn(["worker", "worker-brave-otter", "b.md", "--account", bad], [])
    expect(r.code).toBe(1)
    expect(r.err).toContain("--account takes a plain email")
    expect(r.security).toBeUndefined()
    expect(placing(r)).toEqual([])
  })

  test.each([
    ["no email after it", ["worker", "worker-brave-otter", "b.md", "--account"]],
    ["with an empty email", ["worker", "worker-brave-otter", "b.md", "--account", ""]],
    [
      "empty, then given again",
      ["worker", "worker-a", "b.md", "--account", "", "--account", email],
    ],
    ["given twice", ["worker", "worker-a", "b.md", "--account", email, "--account", email]],
  ])("--account %s is refused", async (_, args) => {
    const r = await spawn(args, [])
    expect(r.code).not.toBe(0)
    expect(placing(r)).toEqual([])
  })
})
