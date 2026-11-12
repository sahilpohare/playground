import { afterAll, describe, expect, spyOn, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { MARKER } from "../../../../../packages/safe-delete/src"
import {
  BOX_LOAD_MULT,
  capacityRefusals,
  databaseCheck,
  dropBox,
  installCheck,
  leftForYou,
  makeBox,
  readAfter,
  report,
  resultLine,
  scriptsGroup,
  shotAfter,
  STEP_COUNT,
  type Step,
  strayStandIns,
  usageWords,
  zshStartup,
} from "../../../../../packages/scripts/src/new-user-gate/cli"
import { stubs } from "../../../../../packages/scripts/src/new-user-gate/stubs"

describe("the new-user gate's reads", () => {
  test("reads install.sh's Left for you lines, and none from a clean finish", () => {
    expect(
      leftForYou(
        "Playground needs git...\nLeft for you:\n  - node: brew install node\ninstall.sh exit 1",
      ),
    ).toEqual(["node: brew install node"])
    expect(leftForYou("Playground is ready.\ninstall.sh exit 0")).toEqual([])
  })

  test("takes a usage reading as shown, and No usage windows read as none", () => {
    expect(usageWords("Alpha\nClaude usage: week 12% left, 5-hour 80% left\n")).toBe(
      "week 12% left, 5-hour 80% left",
    )
    expect(usageWords("Alpha\nClaude usage: No usage windows read\n")).toBeNull()
    expect(usageWords("Alpha\nClaude usage: Not read yet\n")).toBeNull()
    expect(usageWords("Alpha")).toBeNull()
  })

  test("finds the Scripts group by its header, with or without its count, and not by a row's words", () => {
    expect(scriptsGroup("Alpha\nScripts\n2\nClaude usage readings")).toBe(true)
    expect(scriptsGroup("Alpha\nScripts 2\n")).toBe(true)
    expect(scriptsGroup("Alpha\nScripts2\n")).toBe(true)
    expect(scriptsGroup("Alpha is not running\nEvery agent's state is on the System page.")).toBe(
      false,
    )
    expect(scriptsGroup("Script · Failing · every minute")).toBe(false)
  })

  test("prints PASS or FAIL per step with its detail, then the count", () => {
    expect(
      report([
        { detail: "", name: "curl | bash exits 0", ok: true },
        { detail: "no usage reading", name: "Usage shows", ok: false },
      ]),
    ).toBe("PASS 1. curl | bash exits 0\nFAIL 2. Usage shows: no usage reading\n1 of 2 passed")
  })

  test("names a shot the step could not take on its line, and leaves a taken shot's path off it", () => {
    expect(
      report([
        {
          detail: "",
          name: "curl | bash exits 0",
          ok: true,
          shot: "no shot: agent-browser wait: timed out after 25000ms",
        },
        { detail: "", name: "Usage shows", ok: true, shot: "/box/shots/5-usage.png" },
      ]),
    ).toBe(
      "PASS 1. curl | bash exits 0 (no shot: agent-browser wait: timed out after 25000ms)\nPASS 2. Usage shows\n2 of 2 passed",
    )
  })
})

// #1674: step 1 opened the page and waited for networkidle inside its check, so a slow page failed an install that passed.
describe("a step's screenshot settle", () => {
  const settleFails = () => {
    throw new Error("agent-browser wait: timed out after 25000ms")
  }

  test("a settle wait that throws leaves a passing install step passing, and names itself in the shot's place", () => {
    const taken: string[] = []
    const got = installCheck("Playground is ready.\ninstall.sh exit 0", () =>
      shotAfter(() => {
        taken.push("1-install")
        return "/box/shots/1-install.png"
      }, settleFails),
    )
    expect(got).toEqual({
      detail: "",
      ok: true,
      shot: "no shot: agent-browser wait: timed out after 25000ms",
    })
    expect(taken).toEqual([])
  })

  test("a failing install still fails, its shot taken once", () => {
    const order: string[] = []
    const got = installCheck(
      "Left for you:\n  - node: brew install node\ninstall.sh exit 1",
      () => {
        order.push("shot")
        return "/box/shots/1-install.png"
      },
    )
    expect(got.ok).toBe(false)
    expect(got.detail).toBe("exit 1; left for you: node: brew install node")
    expect(order).toEqual(["shot"])
  })

  test("a screenshot that throws is named in the shot's place, and one that settles gives its path", () => {
    expect(
      shotAfter(() => {
        throw new Error("agent-browser screenshot: no page")
      }),
    ).toBe("no shot: agent-browser screenshot: no page")
    expect(
      shotAfter(
        () => "/box/shots/7-follows-main.png",
        () => {},
      ),
    ).toBe("/box/shots/7-follows-main.png")
  })

  test("a settle wait that throws inside a step's read loop still reads the page, so the step judges its text", () => {
    expect(readAfter(settleFails, () => "Usage 12% of the week")).toBe("Usage 12% of the week")
    const order: string[] = []
    expect(
      readAfter(
        () => order.push("settle"),
        () => {
          order.push("read")
          return "Scripts 2"
        },
      ),
    ).toBe("Scripts 2")
    expect(order).toEqual(["settle", "read"])
  })
})

// #1767: step 2 clicked Start the database once before the button rendered, so under load the step failed while the app was fine.
describe("step 2's database click", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "gate-dbclick-")))
  afterAll(() => rmSync(parent, { force: true, recursive: true }))

  test("a fake browser that shows the button only on its third poll passes", async () => {
    const env = join(parent, ".env")
    let polls = 0
    const got = await databaseCheck(
      () => {
        polls++
        if (polls < 3) return false
        writeFileSync(env, "POSTGRES_URL=postgres://gate:gate@127.0.0.1:5432/gate\n")
        return true
      },
      () => existsSync(env) && /^POSTGRES_URL=\S/m.test(readFileSync(env, "utf8")),
      { buttonMs: 60_000, pollMs: 1, urlMs: 2_000 },
    )
    expect(got).toEqual({ detail: "", ok: true })
    expect(polls).toBe(3)
  })

  test("a page read as a 404 until its second reopen shows the button then and passes", async () => {
    const env = join(parent, "reopen.env")
    let opens = 0
    const got = await databaseCheck(
      () => {
        if (opens < 2) return false
        writeFileSync(env, "POSTGRES_URL=postgres://gate:gate@127.0.0.1:5432/gate\n")
        return true
      },
      () => existsSync(env) && /^POSTGRES_URL=\S/m.test(readFileSync(env, "utf8")),
      { buttonMs: 1_000, pollMs: 1, urlMs: 2_000 },
      () => opens++,
    )
    expect(got).toEqual({ detail: "", ok: true })
    expect(opens).toBe(2)
  })

  test("a fake browser that never shows the button gives up at the button's deadline, before the URL's", async () => {
    const started = Date.now()
    const got = await databaseCheck(
      () => false,
      () => false,
      {
        buttonMs: 100,
        pollMs: 1,
        urlMs: 2_000,
      },
    )
    expect(got).toEqual({
      detail: "the Start the database button never showed in 0.1s",
      ok: false,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("a shown button whose URL never lands waits the URL's deadline out and names it", async () => {
    const got = await databaseCheck(
      () => true,
      () => false,
      {
        buttonMs: 100,
        pollMs: 1,
        urlMs: 2_000,
      },
    )
    expect(got).toEqual({
      detail: "no POSTGRES_URL in the desk's .env after 2s",
      ok: false,
    })
  })
})

describe("a step failed on spawn.sh's capacity gate", () => {
  // two rows as spawn.sh's gate_capacity writes them to capacity.jsonl: a pass, then the load refusal a box met at load 26.9
  const log = [
    JSON.stringify({
      at: "2026-10-31T01:30:00Z",
      detail: "",
      gate: "",
      readings: { load5: 9.1 },
      verdict: "pass",
    }),
    JSON.stringify({
      at: "2026-10-31T01:31:05Z",
      detail:
        "max(load1, load5) is 26.90 and 0 started in the last 5 minutes, at or over 11.25: 15, the 15 cores at PLAYGROUND_LOAD_MULT 1, less the 3.75 kept for small items (this start is medium). Wait for it to fall, or close a session that is done, and run it again.",
      gate: "load",
      readings: { load5: 26.9 },
      verdict: "refused",
    }),
    "not json",
  ].join("\n")

  test("names each refusal since the step began, by its gate and its words, and none from before it", () => {
    expect(capacityRefusals(log, "2026-10-31T01:31:00Z")).toEqual([
      expect.stringMatching(/^load gate: max\(load1, load5\) is 26\.90 .* at or over 11\.25/),
    ])
    expect(capacityRefusals(log, "2026-10-31T01:32:00Z")).toEqual([])
  })

  test("reads INCONCLUSIVE, not FAIL, and counts it apart", () => {
    expect(
      report([
        { detail: "", name: "curl | bash exits 0", ok: true },
        {
          detail: "spawn.sh's capacity gate refused a start (load gate: …)",
          inconclusive: true,
          name: "Alpha routes",
          ok: false,
        },
      ]),
    ).toBe(
      "PASS 1. curl | bash exits 0\nINCONCLUSIVE 2. Alpha routes: spawn.sh's capacity gate refused a start (load gate: …)\n1 of 2 passed, 1 inconclusive",
    )
  })
})

describe("the box", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "gate-box-")))
  afterAll(() => rmSync(parent, { force: true, recursive: true }))

  test("is a marked scratch folder named for its sha, which dropBox removes, and dropBox leaves an unmarked folder, logging why (#545)", () => {
    const box = makeBox("abcdef1234567890", parent)
    expect(basename(box)).toStartWith("pg-gate-abcdef1-")
    expect(existsSync(join(box, MARKER))).toBe(true)
    dropBox(box)
    expect(existsSync(box)).toBe(false)
    const other = join(parent, "pg-gate-other")
    mkdirSync(other)
    const said = spyOn(console, "error").mockImplementation(() => {})
    try {
      dropBox(other)
      expect(existsSync(other)).toBe(true)
      expect(String(said.mock.calls[0]?.[0])).toContain(`has no ${MARKER} marker`)
    } finally {
      said.mockRestore()
    }
  })
})

describe("the gate's stand-ins preflight", () => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), "gate-preflight-")))
  afterAll(() => rmSync(box, { force: true, recursive: true }))
  const home = join(box, "h")
  mkdirSync(join(box, "stubs"), { recursive: true })
  mkdirSync(home, { recursive: true })
  const names = Object.keys(stubs(box, ""))
  for (const [name, text] of Object.entries(stubs(box, ""))) {
    writeFileSync(join(box, "stubs", name), text)
    chmodSync(join(box, "stubs", name), 0o755)
  }

  test("with no startup files, the box's zsh finds security outside the stubs folder, and the preflight names it", () => {
    const stray = strayStandIns(box, home, names)
    expect(stray.filter((line) => /^-l?c security\b/.test(line))).toHaveLength(2)
  })

  test("the box's startup relaxes spawn.sh's load gate by BOX_LOAD_MULT, read as a number over 1", () => {
    const set = Bun.spawnSync(
      ["zsh", "-c", `${zshStartup(box)}print -r -- $PLAYGROUND_LOAD_MULT`],
      {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
      },
    )
    expect(set.stdout.toString().trim()).toBe(String(BOX_LOAD_MULT))
    expect(BOX_LOAD_MULT).toBeGreaterThan(1)
  })

  test("with the box's startup files, every stand-in resolves to the stubs folder in a plain and a login zsh", () => {
    for (const rc of [".zshenv", ".zprofile"]) writeFileSync(join(home, rc), zshStartup(box))
    expect(strayStandIns(box, home, names)).toEqual([])
  })

  test("the box's startup sends the profile read and ops-usage's probe to a closed loopback port, and ops-usage's stored-login reads to the box's usage reading", () => {
    expect(zshStartup(box)).toContain("export PLAYGROUND_PROFILE_URL=http://127.0.0.1:9/profile\n")
    expect(zshStartup(box)).toContain(
      "export PLAYGROUND_PROBE_URL=http://127.0.0.1:9/v1/messages\n",
    )
    expect(zshStartup(box)).toContain(
      `export PLAYGROUND_USAGE_API=file://${join(box, "usage-api")}\n`,
    )
  })
})

describe("the gate's last line, which ship:merge reads (#1659)", () => {
  const SHA = "a11fb8850c8304a91ab714b2ff46ad89fe7411a7"
  const step = (name: string, ok: boolean, inconclusive?: boolean): Step => ({
    detail: "",
    name,
    ok,
    ...(inconclusive && { inconclusive }),
  })
  const all = () => Array.from({ length: STEP_COUNT }, (_, i) => step(`step ${i + 1}`, true))

  test("a run that reached every step with none reading FAIL reads PASS, an INCONCLUSIVE step included", () => {
    expect(resultLine(SHA, all())).toBe(`New-user gate at ${SHA}: PASS`)
    const unsure = [...all().slice(1), step("Usage", false, true)]
    expect(resultLine(SHA, unsure)).toBe(`New-user gate at ${SHA}: PASS`)
  })

  test("a step reading FAIL, or a run that stopped short of its last step, reads FAIL", () => {
    expect(resultLine(SHA, [...all().slice(1), step("Usage", false)])).toBe(
      `New-user gate at ${SHA}: FAIL`,
    )
    expect(resultLine(SHA, [])).toBe(`New-user gate at ${SHA}: FAIL`)
    expect(resultLine(SHA, all().slice(1))).toBe(`New-user gate at ${SHA}: FAIL`)
  })

  test("STEP_COUNT is the number of steps main checks", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../../../../../packages/scripts/src/new-user-gate/cli.ts"),
    ).text()
    expect(source.match(/\bawait check\((?!\))/g)?.length).toBe(STEP_COUNT)
  })
})
