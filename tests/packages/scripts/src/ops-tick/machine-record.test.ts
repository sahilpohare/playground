import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"

import { peerRecordArgv, seed } from "../../../../../packages/scripts/src/machine-record/record"
import { machineRecord } from "../../../../../packages/scripts/src/ops-tick/machine-record"
import { BEATS, type Context } from "../../../../../packages/scripts/src/ops-tick/tick"

const HERE = hostname().split(".")[0]!

// A scratch home with its data folder, a clone at ~/code/playground whose .env names one peer (or, with dashboard, no .env and a Dashboard checkout at ~/code/desk whose .env does), and an empty root-step folder; a run that answers docker as absent and ssh as given, recording each argv, and the lines sent.
const setUp = async (ssh: { code: number; out: string }, dashboard = false) => {
  const home = mkdtempSync(join(tmpdir(), "machine-record-beat-"))
  const data = join(home, ".playground")
  const repo = join(home, "code", "playground")
  const system = join(home, "root-steps")
  const desk = join(home, "code", "desk")
  for (const dir of [join(data, "ops"), repo, desk, system, join(home, ".cache")])
    mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dashboard ? desk : repo, ".env"),
    "PLAYGROUND_PEERS=spark-test=me@spark-test\nPLAYGROUND_PEER_KEY=/k/playground_spark\n",
  )
  const runs: string[][] = []
  const sent: { text: string; to: string }[] = []
  const ctx: Context = {
    now: new Date("2026-11-18T03:45:00Z"),
    ops: join(data, "ops"),
    repo,
    run: async (argv) => {
      runs.push(argv)
      return argv[0] === "ssh" ? ssh : { code: 127, out: "" }
    },
    send: async (to, text) => {
      sent.push({ text, to })
      return true
    },
  }
  const places = { home, homes: [data, repo], run: ctx.run, system: [system] }
  await seed(data, [], places)
  return {
    beat: machineRecord(home, [system], () => (dashboard ? desk : null)),
    ctx,
    home,
    runs,
    sent,
  }
}

test("the machine-record beat runs daily, sending ops each finding here and on the peer, each led by its machine", async () => {
  expect(BEATS.find((b) => b.name === "machine-record")).toMatchObject({ cron: "45 3 * * *" })
  const peer =
    "misplaced: /home/me/.cache/hand\nroot-only: /etc/polkit-1/rules.d, no root helper on this machine, so its listing is skipped\nunreadable: /usr/local/lib/playground\n"
  const { beat, ctx, home, runs, sent } = await setUp({ code: 1, out: peer })
  mkdirSync(join(home, ".cache", "by-hand"))
  await beat(ctx)
  expect(runs.filter((argv) => argv[0] === "ssh")).toEqual([
    peerRecordArgv("/k/playground_spark", "me@spark-test", "~/code/playground", "check"),
  ])
  expect(sent).toEqual([
    { text: `machine record: ${HERE}: misplaced: ${join(home, ".cache", "by-hand")}`, to: "ops" },
    { text: "machine record: spark-test: misplaced: /home/me/.cache/hand", to: "ops" },
    {
      text: "machine record: spark-test: root-only: /etc/polkit-1/rules.d, no root helper on this machine, so its listing is skipped",
      to: "ops",
    },
    { text: "machine record: spark-test: unreadable: /usr/local/lib/playground", to: "ops" },
  ])
})

test("the peers come from the Dashboard checkout's .env when the main checkout keeps none, and the ssh still enters the main checkout's clone", async () => {
  const { beat, ctx, runs } = await setUp({ code: 0, out: "" }, true)
  await beat(ctx)
  expect(runs.filter((argv) => argv[0] === "ssh")).toEqual([
    peerRecordArgv("/k/playground_spark", "me@spark-test", "~/code/playground", "check"),
  ])
})

test("a peer ssh cannot reach is one line, and a clean check sends nothing", async () => {
  const down = await setUp({
    code: 255,
    out: "ssh: connect to host spark-test port 22: No route to host\n",
  })
  await down.beat(down.ctx)
  expect(down.sent).toEqual([
    {
      text: "machine record: spark-test: not checked: ssh: connect to host spark-test port 22: No route to host",
      to: "ops",
    },
  ])
  const clean = await setUp({ code: 0, out: "" })
  await clean.beat(clean.ctx)
  expect(clean.sent).toEqual([])
})
