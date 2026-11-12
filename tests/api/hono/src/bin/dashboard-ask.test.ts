import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readdirSync, rmdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import { SQL } from "bun"

import { ASK_EXAMPLES } from "../../../../../api/hono/src/lib/dashboard/ask-shape"
import { ASK_CODE_COLUMNS } from "../../../../../packages/config/src/inbox"
import { testContainerName } from "../../../../container"
import { onLiveDashboard } from "../../../../dashboard-fixture"
import { liveReadsEnv } from "../../../../live-reads"
import { slowChild } from "../../../../slow-child"

// The CLI driven as a poster runs it, as its own process, against a throwaway Postgres in Docker published on 127.0.0.1 only and migrated as the dashboard's is, so it proves the database local as it does on the dashboard. Skipped where Docker is not running.
const CLI = join(import.meta.dir, "../../../../../api/hono/src/bin/dashboard-ask.ts")
const MIGRATIONS = join(import.meta.dir, "../../../../../packages/db/drizzle")
// made at run time, so no password is ever written into the repo
const PASSWORD = crypto.randomUUID()
const OPEN = Symbol("a stdin that never closes")
const DAY = 24 * 60 * 60 * 1000
const BUN = slowChild("bun")
// outside the describe, so the folder goes when Docker is down and the describe is skipped
afterAll(() => {
  if (BUN !== "bun") rmSync(dirname(BUN), { force: true, recursive: true })
})

// a test spawns the CLI up to ten times (resolve) and a loaded runner took 2.5s a spawn (ack's six went past 15s), so 60s holds ten at 6s each
setDefaultTimeout(60_000)

const DECISION = {
  from: "worker-envy",
  preview: {
    link: "https://app.slack.com/client/T0000000000/C0MADEUP01",
    text: "hi Merritt, the fix is on staging.",
    to: "@Merritt",
    type: "slack",
  },
  title: "Send Merritt the staging note?",
}

const dockerUp = (): boolean =>
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stderr: "ignore", stdout: "ignore" }).exitCode === 0

// The checkout guard reads this checkout's own .env, which a test box may not have, so its order is held in the source: it refuses before the database is located, proved or opened, and a test run, whose URL is its own container's on purpose, skips it.
test("ask refuses a database other than its own checkout's before it touches one", async () => {
  const cli = await Bun.file(CLI).text()
  const refusal = cli.indexOf("if (stray) fail(stray)")
  expect(refusal).toBeGreaterThan(-1)
  expect(cli).toContain(
    'process.env.NODE_ENV === "test" ? null : checkoutMismatch(env.POSTGRES_URL, dotenv)',
  )
  expect(cli).toContain('Bun.file(join(root, ".env"))')
  for (const step of [
    "locate(env.POSTGRES_URL)",
    "await prove(",
    "createDatabase(env.POSTGRES_URL)",
  ]) {
    expect(refusal).toBeLessThan(cli.indexOf(step))
  }
})

// A template needs no database, so this runs where Docker does not, against a URL nothing listens on.
test("bun run ask example prints each template, and the usage for a kind it has none of", async () => {
  const example = async (kind: string) => {
    const proc = Bun.spawn([BUN, CLI, "example", kind], {
      env: liveReadsEnv({ ...process.env, POSTGRES_URL: "postgres://nobody@127.0.0.1:9/none" }),
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stderr, stdout }
  }
  for (const kind of ["code", "decision", "delete", "questions", "slack", "ui"] as const) {
    const printed = await example(kind)
    expect(printed.code).toBe(0)
    expect(JSON.parse(printed.stdout)).toEqual(ASK_EXAMPLES[kind])
  }
  const unknown = await example("poem")
  expect(unknown.code).toBe(2)
  expect(unknown.stderr).toContain("bun run ask example <code|decision|delete|questions|slack|ui>")
})

describe.skipIf(!dockerUp())("the bun run ask CLI", () => {
  let container = ""
  let url = ""
  let answer: (
    id: string,
    input?: { action: "approve" | "deny"; option?: number; options?: number[] },
  ) => Promise<void>
  let dismiss: (id: string) => Promise<void>
  let answerRelayed: (id: string) => Promise<{ delivery: unknown }>
  let reply: (tag: string) => Promise<void>
  let snooze: (id: string) => Promise<void>

  beforeAll(async () => {
    container = Bun.spawnSync([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      testContainerName("dashboard-ask"),
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:18-alpine",
    ])
      .stdout.toString()
      .trim()
    const port = Bun.spawnSync(["docker", "port", container, "5432/tcp"])
      .stdout.toString()
      .trim()
      .split(":")
      .at(-1)
    url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`
    let admin: SQL | null = null
    for (let i = 0; i < 60; i++) {
      try {
        admin = new SQL(url, { max: 1 })
        await admin`select 1`
        break
      } catch {
        await Bun.sleep(500)
      }
    }
    const journal = await Bun.file(join(MIGRATIONS, "meta/_journal.json")).json()
    for (const { tag } of journal.entries as { tag: string }[]) {
      for (const statement of (await Bun.file(join(MIGRATIONS, `${tag}.sql`)).text()).split(
        "--> statement-breakpoint",
      )) {
        if (statement.trim()) await admin!.unsafe(statement)
      }
    }
    await admin!.close()
    const { answerItem, dismissItems, recordReply, scheduleItem } =
      await import("../../../../../api/hono/src/lib/dashboard/inbox")
    const db = (await import("../../../../../packages/db/dist/index.mjs")).createDatabase(url)
    answer = async (id, input = { action: "approve" }) => {
      const answered = await answerItem(db, id, input, { actor: { label: "test" } })
      if (!answered.ok) throw new Error(answered.message)
    }
    answerRelayed = async (id) => {
      const answered = await answerItem(
        db,
        id,
        { action: "approve" },
        {
          actor: { label: "test" },
          deliver: async ({ to }) =>
            to === "dispatcher"
              ? { at: new Date().toISOString(), ok: true, sessionId: "s1" }
              : { code: "NOT_FOUND", ok: false, reason: `No live session is named ${to}.` },
          dispatcher: "dispatcher",
        },
      )
      if (!answered.ok) throw new Error(answered.message)
      return answered.item
    }
    reply = async (tag) => {
      if (!(await recordReply(db, Number(tag.slice(2)), new Date(), "on it")))
        throw new Error(`${tag} took no reply`)
    }
    snooze = async (id) => {
      const snoozed = await scheduleItem(db, id, new Date(Date.now() + DAY).toISOString())
      if (!snoozed.ok) throw new Error(snoozed.message)
    }
    dismiss = async (id) => {
      if ((await dismissItems(db, [id])) !== 1) throw new Error(`${id} was not dismissed`)
    }
  }, 60_000)

  afterAll(() => {
    if (container)
      Bun.spawnSync(["docker", "rm", "-f", "-v", container], { stderr: "ignore", stdout: "ignore" })
  })

  // stdin is "ignore" when none is given, or "open" for one that never closes, as an agent's shell hands a command that forgot its redirect.
  const cli = async (
    args: string[],
    stdin?: string | typeof OPEN,
    env?: Record<string, string | undefined>,
  ) => {
    const proc = Bun.spawn([BUN, CLI, ...args], {
      env: env ?? liveReadsEnv({ ...process.env, POSTGRES_URL: url }),
      stderr: "pipe",
      stdin:
        stdin === undefined ? "ignore" : stdin === OPEN ? "pipe" : new TextEncoder().encode(stdin),
      stdout: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stderr, stdout }
  }

  const post = async (input: object = DECISION) => {
    const posted = await cli(["new"], JSON.stringify(input))
    expect(posted.code).toBe(0)
    // the id alone on stdout, so `id=$(bun run ask new < f)` takes it whole; the tag on stderr
    expect(posted.stdout).toMatch(/^\S+\n$/)
    const id = posted.stdout.trim()
    const tag = /posted (#i\d+)/.exec(posted.stderr)?.[1]
    expect(tag).toBeDefined()
    return { id, tag: tag! }
  }

  test("posts an item from stdin, prints its id, and reads it back by the id or its tag", async () => {
    const { id, tag } = await post()
    expect(tag).toMatch(/^#i\d+$/)
    for (const key of [id, tag]) {
      const got = await cli(["get", key])
      expect(got.code).toBe(0)
      expect(JSON.parse(got.stdout)).toMatchObject({
        id,
        kind: "decision",
        status: "open",
        title: DECISION.title,
      })
    }
  })

  // playground rm --decision matches a delete's what against the full path alone, so a short name there would take the owner a second approval
  test("refuses a delete decision that names its target by a short name, naming the full path, and posts one that names the full path", async () => {
    const target = mkdtempSync(join(tmpdir(), "ask-delete-"))
    try {
      const remove = (what: string) => ({
        from: "worker-envy",
        kind: "decision",
        preview: { type: "delete", what, why: "a made-up scratch folder" },
        title: "Delete the scratch folder?",
      })
      const short = relative(process.cwd(), target)
      const refused = await cli(["new"], JSON.stringify(remove(`the folder ${short}`)))
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain(`write ${target} for ${short}`)
      expect(refused.stdout).toBe("")
      const { id } = await post(remove(`the folder ${target}`))
      const got = await cli(["get", id])
      expect(JSON.parse(got.stdout)).toMatchObject({
        preview: { type: "delete", what: `the folder ${target}` },
        status: "open",
      })
    } finally {
      rmdirSync(target)
    }
  })

  // a draft with no link is a public post's, which holds the owner's own words alone (the public rule), so its check runs before the item posts
  test("refuses a public post's draft whose words hold a work figure, naming the kind and never the words, and posts one in the owner's words", async () => {
    const launch = (text: string) => ({
      from: "worker-envy",
      kind: "draft",
      preview: { noLink: "the owner posts it on the company page", text, to: "the company page" },
      title: "Post the launch note?",
    })
    const refused = await cli(["new"], JSON.stringify(launch("I merged 12 PRs this week.")))
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("ask: a draft with no link is a public post's")
    expect(refused.stderr).toContain("this one holds a work figure")
    expect(refused.stderr).not.toContain("12 PRs")
    expect(refused.stdout).toBe("")
    const { id } = await post(launch("The board is live: every session on one page. Try it today."))
    const got = await cli(["get", id])
    expect(JSON.parse(got.stdout)).toMatchObject({ kind: "draft", status: "open" })
  })

  test("refuses an invalid item with the reason, and posts nothing", async () => {
    const result = await cli(["new"], JSON.stringify({ ...DECISION, preview: undefined }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("preview")
    const progress = await cli(
      ["new"],
      JSON.stringify({
        from: "x",
        kind: "update",
        preview: { outcome: "progress" },
        title: "Round 2",
      }),
    )
    expect(progress.code).toBe(1)
    expect(progress.stderr).toContain("outcome")
  })

  test("hints at the shape on a prose ask and still posts it; stays quiet on a structured one", async () => {
    const prose = {
      from: "worker-envy",
      preview: { text: "The export ends at a hundred rows. ".repeat(10).trim(), type: "ask" },
      title: "Port the export fix?",
    }
    const posted = await cli(["new"], JSON.stringify(prose))
    expect(posted.code).toBe(0)
    expect(posted.stdout).toMatch(/^\S+\n$/)
    expect(posted.stderr).toContain("ask: this ask is one block of prose")
    expect(posted.stderr).toContain("playground ask example code|decision|ui")
    const wide = await cli(
      ["new"],
      JSON.stringify({
        ...prose,
        preview: { text: `\`\`\`\n${"─".repeat(ASK_CODE_COLUMNS + 1)}\n\`\`\``, type: "ask" },
      }),
    )
    expect(wide.code).toBe(0)
    expect(wide.stderr).toContain(
      `runs ${ASK_CODE_COLUMNS + 1} characters, past the ${ASK_CODE_COLUMNS}`,
    )
    for (const example of Object.values(ASK_EXAMPLES)) {
      // the ui template's pictures are example paths, which bun run ask new refuses as no such file; ask-shape.test.ts checks their shape
      const { attachments: _, ...preview } = example.preview as typeof example.preview & {
        attachments?: unknown[]
      }
      const shaped = await cli(["new"], JSON.stringify({ ...example, preview }))
      expect(shaped.code).toBe(0)
      expect(shaped.stderr).not.toContain("one block of prose")
      expect(shaped.stderr).not.toContain("characters, past the")
    }
  })

  test.skipIf(onLiveDashboard())(
    "outside the live dashboard's checkout, says on stderr that the Dashboard never shows its inbox",
    async () => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("DASHBOARD_")),
      ) as Record<string, string>
      const posted = await cli(["new"], JSON.stringify(DECISION), { ...env, POSTGRES_URL: url })
      expect(posted.code).toBe(0)
      expect(posted.stdout).toMatch(/^\S+\n$/)
      expect(posted.stderr).toContain(
        "the owner's Dashboard (the live dashboard) never shows its inbox",
      )
    },
  )

  test("says when stdin is not JSON or an item does not exist", async () => {
    expect((await cli(["new"], "title: hi")).stderr).toContain("not JSON")
    const missing = await cli(["get", "#i999999"])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("no inbox item #i999999")
  })

  test("gives up on a stdin that never closes instead of hanging", async () => {
    const result = await cli(["new"], OPEN)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("no JSON arrived on stdin")
  }, 15_000)

  test("get --ack prints an open item as it is, then marks the answer read once there is one", async () => {
    const { id } = await post()
    const open = await cli(["get", id, "--ack"])
    expect(JSON.parse(open.stdout)).toMatchObject({ answer: null, status: "open" })
    await answer(id)
    const answered = JSON.parse((await cli(["get", id, "--ack"])).stdout)
    expect(answered.status).toBe("approved")
    expect(answered.answer.choice).toBe("approve")
    expect(answered.delivery).toMatchObject({ status: "delivered", via: "cli" })
  })

  test("new hints at an ask that labels no options, and get prints the option the owner picked on stderr (#873)", async () => {
    const bare = await cli(
      ["new"],
      JSON.stringify({
        from: "worker-envy",
        preview: { text: "Port it?", type: "ask" },
        title: "Port it?",
      }),
    )
    expect(bare.code).toBe(0)
    expect(bare.stderr).toContain("ask: this ask labels no options")
    const lettered = {
      from: "worker-envy",
      preview: {
        options: [{ label: "Port to staging, then main" }, { label: "Hotfix main" }],
        text: "Which way does the fix go?",
        type: "ask",
      },
      title: "Which way?",
    }
    const picked = await post(lettered)
    expect((await cli(["get", picked.id])).stderr).not.toContain("ask: picked")
    await answer(picked.id, { action: "approve", option: 1 })
    const got = await cli(["get", picked.tag])
    expect(got.stderr).toContain("ask: picked B: Hotfix main")
    expect(JSON.parse(got.stdout).answer).toMatchObject({ choice: "approve", option: 1 })
    const none = await post(lettered)
    await answer(none.id, { action: "deny" })
    expect((await cli(["get", none.id])).stderr).toContain("ask: picked C: None of these")
  })

  test("get prints each question's pick for a multi-question answer (#1250)", async () => {
    const multi = {
      from: "worker-envy",
      preview: {
        questions: [
          {
            options: [{ label: "Staging first" }, { label: "Straight to main" }],
            question: "Where first?",
          },
          { options: [{ label: "Now" }, { label: "After the next ship" }], question: "When?" },
        ],
        text: "Pick for each.",
        type: "ask",
      },
      title: "How should it roll out?",
    }
    const posted = await post(multi)
    expect((await cli(["get", posted.id])).stderr).not.toContain("ask: picked")
    await answer(posted.id, { action: "approve", options: [0, 1] })
    const got = await cli(["get", posted.tag])
    expect(got.stderr).toContain("ask: picked A: Staging first · B: After the next ship")
    expect(JSON.parse(got.stdout).answer).toMatchObject({ choice: "approve", options: [0, 1] })
  })

  test("get --ack prints a dismissed update as it is, since an update takes no answer to mark read", async () => {
    const { id } = await post({
      from: "builder",
      kind: "update",
      preview: { outcome: "merged" },
      title: "Merged",
    })
    await dismiss(id)
    const got = await cli(["get", id, "--ack"])
    expect(got.code).toBe(0)
    const item = JSON.parse(got.stdout)
    expect(item.answer.dismissedAt).toEqual(expect.any(String))
    expect(item.delivery).toBeNull()
  })

  test("ack closes a go with --no-link, says so each time, and refuses an item with no answer yet or a go with neither", async () => {
    const { id, tag } = await post()
    const early = await cli(["ack", tag])
    expect(early.code).toBe(1)
    expect(early.stderr).toContain("no answer yet")
    await answer(id)
    const bare = await cli(["ack", tag])
    expect(bare.code).toBe(1)
    expect(bare.stderr).toContain("--no-link")
    const acked = await cli(["ack", tag, "--no-link", "Sent as a new DM"])
    expect(acked.code).toBe(0)
    expect(acked.stdout).toStartWith(`${id} read by worker-envy at `)
    expect((await cli(["ack", id, "--no-link", "Sent as a new DM"])).stdout).toBe(acked.stdout)
    expect(JSON.parse((await cli(["get", id])).stdout).answer.noLink).toBe("Sent as a new DM")
  })

  test("ack names the session that took an answer typed into a session, the dispatcher when the poster had ended", async () => {
    const { id, tag } = await post()
    const answered = await answerRelayed(id)
    expect(answered.delivery).toMatchObject({
      status: "delivered",
      to: "dispatcher",
      via: "session",
    })
    const acked = await cli(["ack", tag, "--no-link", "Sent as a new DM"])
    expect(acked.code).toBe(0)
    expect(acked.stdout).toStartWith(`${id} delivered to dispatcher's session at `)
  })

  test("new refuses a draft that names neither where it lands nor why it cannot", async () => {
    const refused = await cli(
      ["new"],
      JSON.stringify({
        from: "x",
        kind: "draft",
        preview: { text: "hi", to: "@Merritt" },
        title: "Ask",
      }),
    )
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("noLink")
  })

  test("new reminds the poster once to check a reply draft is still unanswered, and only for a draft whose link is a message (#1814)", async () => {
    const draft = { from: "x", kind: "draft", title: "Reply to Merritt" }
    const thread =
      "https://app.slack.com/client/T0000000000/D0MADEUP11/thread/D0MADEUP11-1700000000.000100"
    const reply = await cli(
      ["new"],
      JSON.stringify({
        ...draft,
        preview: {
          link: thread,
          text: "hi Merritt",
          to: "Merritt DM",
        },
      }),
    )
    expect(reply.code).toBe(0)
    expect(reply.stderr.match(/this draft replies to a message/g)).toHaveLength(1)
    const fresh = await cli(
      ["new"],
      JSON.stringify({
        ...draft,
        preview: {
          link: "https://app.slack.com/client/T0000000000/D0MADEUP11",
          text: "hi Merritt",
          to: "Merritt DM",
        },
      }),
    )
    expect(fresh.code).toBe(0)
    expect(fresh.stderr).not.toContain("this draft replies to a message")
    const decision = await cli(
      ["new"],
      JSON.stringify({ ...DECISION, preview: { ...DECISION.preview, link: thread } }),
    )
    expect(decision.stderr).not.toContain("this draft replies to a message")
  })

  test("ack --link records where the answer was carried out, which get reads back, and refuses one that is not https", async () => {
    const { id, tag } = await post()
    await answer(id)
    const http = await cli([
      "ack",
      tag,
      "--link",
      "http://app.slack.com/client/T0000000000/C0MADEUP01",
    ])
    expect(http.code).toBe(1)
    expect(http.stderr).toContain("--link takes an https URL")
    const link =
      "https://app.slack.com/client/T0000000000/C0MADEUP01/thread/C0MADEUP01-1700000000.000100"
    expect((await cli(["ack", tag, "--label", "Sent in Slack"])).code).toBe(1)
    expect((await cli(["ack", tag, "--link", link, "--label", "Sent in Slack"])).code).toBe(0)
    expect(JSON.parse((await cli(["get", id])).stdout).answer).toMatchObject({
      linkLabel: "Sent in Slack",
      choice: "approve",
      link,
    })
  })

  test("stale lists an answer its poster has not acked within --minutes, until it acks", async () => {
    const { id, tag } = await post()
    await answer(id)
    const listed = async (args: string[]) => {
      const result = await cli(["stale", ...args])
      expect(result.code).toBe(0)
      return result.stdout
    }
    expect(await listed([])).not.toContain(id)
    expect(await listed(["--minutes", "0"])).toContain(`${tag} ${id} from worker-envy: pending`)
    expect(await listed(["--minutes", "0", "--since", "2999-01-01T00:00:00Z"])).not.toContain(id)
    // reading a go does not close it; its ack with where it landed does
    await cli(["get", id, "--ack"])
    expect(await listed(["--minutes", "0"])).toContain(id)
    await cli(["ack", id, "--link", "https://app.slack.com/client/T0000000000/C0MADEUP01"])
    expect(await listed(["--minutes", "0"])).not.toContain(id)
    expect((await cli(["stale", "--minutes", "soon"])).stderr).toContain("whole number")
  })

  // a session had no way to see what was already open before it posted, so two sessions posted the same question twice
  test("open lists each open item oldest first, never an answered or settled one, and --from keeps one sender's", async () => {
    const titled = (from: string, title: string) => post({ ...DECISION, from, title })
    const first = await titled("worker-open-a", "Ship the first open question?")
    const answered = await titled("worker-open-a", "Ship the answered question?")
    const second = await titled("worker-open-b", "Ship the second open question?")
    const settled = await titled("worker-open-b", "Ship the settled question?")
    await answer(answered.id)
    expect((await cli(["settle", settled.id])).code).toBe(0)
    const listed = async (args: string[]) => {
      const result = await cli(["open", ...args])
      expect(result.code).toBe(0)
      return result.stdout
    }
    const all = await listed([])
    const firstLine = `${first.tag} decision from worker-open-a · Ship the first open question?`
    const secondLine = `${second.tag} decision from worker-open-b · Ship the second open question?`
    expect(all).toContain(firstLine)
    expect(all).toContain(secondLine)
    expect(all.indexOf(firstLine)).toBeLessThan(all.indexOf(secondLine))
    expect(all).not.toContain(answered.tag + " ")
    expect(all).not.toContain(settled.tag + " ")
    const fromA = await listed(["--from", "worker-open-a"])
    expect(fromA).toContain(firstLine)
    expect(fromA).not.toContain("worker-open-b")
    expect(await listed(["--from", "worker-nobody"])).toBe("")
  })

  // PG-1349: ops-tick's focus card resolves once no ask that came in while focus stood is open, so open reads a window of posting times
  test("open --since and --until keep the items posted in that window alone, and refuse a time they cannot read", async () => {
    // the database stamps createdAt, so the window is read from the items themselves
    const postedAt = async (id: string) =>
      Date.parse(JSON.parse((await cli(["get", id])).stdout).createdAt)
    const before = await post({
      ...DECISION,
      from: "worker-open-w",
      title: "Ship the one before the window?",
    })
    const since = new Date((await postedAt(before.id)) + 1).toISOString()
    await Bun.sleep(5)
    const inside = await post({
      ...DECISION,
      from: "worker-open-w",
      title: "Ship the one in the window?",
    })
    const until = new Date((await postedAt(inside.id)) + 1).toISOString()
    await Bun.sleep(5)
    const after = await post({
      ...DECISION,
      from: "worker-open-w",
      title: "Ship the one after the window?",
    })
    const listed = await cli([
      "open",
      "--from",
      "worker-open-w",
      "--since",
      since,
      "--until",
      until,
    ])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(`${inside.tag} decision from worker-open-w`)
    expect(listed.stdout).not.toContain(`${before.tag} `)
    expect(listed.stdout).not.toContain(`${after.tag} `)
    expect((await cli(["open", "--since", "soon"])).stderr).toContain("--since takes an ISO time")
    expect((await cli(["open", "--until", "later"])).stderr).toContain("--until takes an ISO time")
  })

  // a chat-replied item the owner had moved to Done kept its open status, so it still listed as open
  test("open lists an item put away with Later and one replied to in chat until it moves to Done, and never an update", async () => {
    const snoozed = await post({
      ...DECISION,
      from: "worker-open-c",
      title: "Ship the one put away?",
    })
    const replied = await post({
      ...DECISION,
      from: "worker-open-c",
      title: "Ship the replied one?",
    })
    const update = await post({
      from: "worker-open-c",
      kind: "update",
      preview: { outcome: "merged" },
      title: "Merged the open list",
    })
    await snooze(snoozed.id)
    await reply(replied.tag)
    const listed = async () => (await cli(["open", "--from", "worker-open-c"])).stdout
    const before = await listed()
    expect(before).toContain(`${snoozed.tag} decision from worker-open-c`)
    expect(before).toContain(`${replied.tag} decision from worker-open-c`)
    expect(before).not.toContain(`${update.tag} `)
    await dismiss(replied.id)
    const after = await listed()
    expect(after).toContain(`${snoozed.tag} decision from worker-open-c`)
    expect(after).not.toContain(`${replied.tag} `)
  })

  test("resolve closes the poster's own alert update; another session, a decision and an unknown id are refused (#658)", async () => {
    const alertPost = {
      from: "worker-envy",
      kind: "update",
      preview: { outcome: "alert" },
      title: "The Mac is on battery",
    }
    const { id, tag } = await post(alertPost)
    const resolved = await cli(["resolve", tag, "--by", "worker-envy", "--note", "Plugged in"])
    expect(resolved.code).toBe(0)
    expect(resolved.stdout).toContain(`${id} resolved by worker-envy`)
    expect(JSON.parse((await cli(["get", id])).stdout).answer).toMatchObject({
      by: "worker-envy",
      choice: "resolved",
      note: "Plugged in",
    })
    // a second resolve is refused, and so is another session's, naming who posted it
    expect((await cli(["resolve", id, "--by", "worker-envy"])).stderr).toContain("already resolved")
    const refused = await cli(["resolve", (await post(alertPost)).id, "--by", "builder"])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("Only worker-envy")
    // a decision settles, it does not resolve; an unknown id is unknown; no --by is usage
    expect((await cli(["resolve", (await post()).id, "--by", "worker-envy"])).stderr).toContain(
      "Only an update resolves",
    )
    expect((await cli(["resolve", "#i999999", "--by", "worker-envy"])).stderr).toContain(
      "no inbox item",
    )
    expect((await cli(["resolve", id, "--note", "Plugged in"])).code).toBe(2)
  })

  test("new copies a slack decision's attachment into the attachments folder, and the card's item names it (PG-648)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-ask-slack-"))
    const kept = join(dir, "kept")
    const shot = join(dir, "slack-shot.png")
    await Bun.write(
      shot,
      Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        ),
      ),
    )
    const slack = { ...DECISION, preview: { ...DECISION.preview, attachments: [{ src: shot }] } }
    const env = liveReadsEnv({
      ...process.env,
      PLAYGROUND_ATTACHMENTS_DIR: kept,
      POSTGRES_URL: url,
    })
    const posted = await cli(["new"], JSON.stringify(slack), env)
    expect(posted.stderr).not.toContain("error")
    expect(posted.code).toBe(0)
    const got = JSON.parse((await cli(["get", posted.stdout.trim()], undefined, env)).stdout)
    expect(got.preview.attachments).toEqual([
      expect.objectContaining({ kind: "image", name: "slack-shot.png" }),
    ])
    expect(readdirSync(kept)).toEqual([got.preview.attachments[0].id])
    rmSync(dir, { force: true, recursive: true })
  })

  test("edit replaces the poster's own item's title, preview and attachments in place, by its id or its tag (PG-2547)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-ask-edit-"))
    const shot = join(dir, "edit-shot.png")
    await Bun.write(
      shot,
      Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        ),
      ),
    )
    const ask = (text: string, attachments?: object[]) => ({
      from: "worker-envy",
      preview: { text, type: "ask", ...(attachments ? { attachments } : {}) },
      title: `Progress: ${text}`,
    })
    const { id, tag } = await post(ask("10%"))
    const before = JSON.parse((await cli(["get", id])).stdout)
    const edited = await cli(["edit", tag], JSON.stringify(ask("60%", [{ src: shot }])))
    expect(edited.code).toBe(0)
    expect(edited.stderr).toContain(`edited ${tag}`)
    const after = JSON.parse((await cli(["get", id])).stdout)
    expect(after).toMatchObject({
      id,
      status: "open",
      title: "Progress: 60%",
      version: before.version + 1,
    })
    expect(after.preview.attachments).toEqual([
      expect.objectContaining({ kind: "image", name: "edit-shot.png" }),
    ])
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
    expect((await cli(["edit", id], JSON.stringify(ask("70%")))).code).toBe(0)
    // another session's edit, a bad shape, an unknown id and an empty stdin are refused
    const other = await cli(["edit", id], JSON.stringify({ ...ask("90%"), from: "builder" }))
    expect(other.code).toBe(1)
    expect(other.stderr).toContain("posted by worker-envy")
    expect(
      (await cli(["edit", id], JSON.stringify({ ...ask("90%"), preview: { type: "ask" } }))).code,
    ).toBe(1)
    expect((await cli(["edit", "#i999999"], JSON.stringify(ask("90%")))).stderr).toContain(
      "no inbox item",
    )
    expect((await cli(["edit", id])).code).toBe(1)
    rmSync(dir, { force: true, recursive: true })
  })

  test("new and edit fill {now} with the time they post at, and refuse a measured or now time ahead of the clock, passing an ETA", async () => {
    const update = (text: string) => ({
      from: "worker-envy",
      preview: { text, type: "ask" },
      title: "Clock",
    })
    const clock = /\d{1,2}:\d{2} (?:am|pm) \S+/
    const { id } = await post(update("measured {now}"))
    expect(JSON.parse((await cli(["get", id])).stdout).preview.text).toMatch(
      new RegExp(`^measured ${clock.source}$`),
    )
    expect((await cli(["edit", id], JSON.stringify(update("now {now}")))).code).toBe(0)
    expect(JSON.parse((await cli(["get", id])).stdout).preview.text).toMatch(
      new RegExp(`^now ${clock.source}$`),
    )
    const ahead = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    for (const args of [["new"], ["edit", id]]) {
      const refused = await cli(args, JSON.stringify(update(`measured ${ahead}`)))
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain("ahead of the clock")
      expect(refused.stderr).toContain("{now}")
    }
    expect((await cli(["new"], JSON.stringify(update(`ETA ${ahead}`)))).code).toBe(0)
  })

  test("new --thread files the item under that thread, and refuses a thread that does not exist", async () => {
    const admin = new SQL(url, { max: 1 })
    await admin`insert into thread (id, title) values ('t4sk', 'Ship the threads store')`
    const posted = await cli(["new", "--thread", "t4sk"], JSON.stringify(DECISION))
    expect(posted.code).toBe(0)
    const [row] = await admin`select thread_id from inbox_item where id = ${posted.stdout.trim()}`
    expect(row.thread_id).toBe("t4sk")
    const missing = await cli(["new", "--thread", "n0pe"], JSON.stringify(DECISION))
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("no thread n0pe")
    await admin.close()
  })

  test("refuses a database that is not a container on this machine", async () => {
    const result = await cli(
      ["get", "#i1"],
      undefined,
      liveReadsEnv({ ...process.env, POSTGRES_URL: "postgres://10.0.0.9:5432/db" }),
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("refusing to use the database")
  })

  test("prints its usage for anything else", async () => {
    for (const args of [
      ["delete", "x"],
      ["get", "x", "--acknowledge"],
      ["ack"],
      ["ack", "x", "--note", "y"],
      ["settle", "x", "--link"],
      ["settle", "x", "--note", "a", "--note", "b"],
      ["new", "--thread"],
      ["new", "--board", "t4sk"],
      ["open", "--from"],
      ["open", "--until"],
    ]) {
      const result = await cli(args)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("usage:")
    }
  })

  test("its usage names an accept decision's list form (PG-1149)", async () => {
    const result = await cli(["delete", "x"])
    expect(result.stderr.replace(/\s+/g, " ")).toContain(
      "more lists up to 20 further ones, accepted after it in that order; Approve stops at the first that fails",
    )
  })
})
