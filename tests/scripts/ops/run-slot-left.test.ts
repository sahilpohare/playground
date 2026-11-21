import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

setDefaultTimeout(120_000)

const ROOT = join(import.meta.dir, "../../..")
const FAKE = join(import.meta.dir, "run-slot-fake.ts")

// a run-slot test file of its own, whose gated runs never see their gate: one test fails and one times out before stopping its run, each once the run's command has started, and a third checks the per-test sweep by starting with neither run alive, each writing its run's pid and its machine's folder
const fixture = (pids: string) => `import { test } from "bun:test"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { gated, machine } from ${JSON.stringify(FAKE)}
const runs = ${runs}
const started = async (m: ReturnType<typeof machine>, pid: number) => {
  const log = join(m.ops, "run-slot.runs.log")
  while (!(existsSync(log) && readFileSync(log, "utf8").includes(\` start worker-a \${pid} \`))) await Bun.sleep(20)
}
const run = async () => {
  const m = machine()
  const g = gated(m, "worker-a", 0)
  appendFileSync(${JSON.stringify(pids)}, \`\${g.p.pid} \${m.root}\\n\`)
  await started(m, g.p.pid)
  return g
}
test("fails before its stop", async () => {
  await run()
  throw new Error("fails before its stop")
})
test("times out before its stop", async () => {
  const g = await run()
  await g.p.exited
}, 3000)
test("the next test starts with neither run left", () => {
  const left = readFileSync(${JSON.stringify(pids)}, "utf8").split("\\n").filter(Boolean).filter(runs)
  if (left.length > 0) throw new Error(\`left: \${left}\`)
})
`

// a recorded run reads as left only while its pid still runs a command naming its own machine's folder, since a dead run's pid can be another process's within a second
const runs = (line: string) => {
  const [pid, root] = line.split(" ")
  return Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", pid!])
    .stdout.toString()
    .includes(root!)
}

// issue 1316, 7 Nov: five run-slot.sh processes of run-slot's own test fixtures lived on for days with ppid 1, each waiting on a gate in a removed scratch folder; a run left by a failing test must end before the file's next test starts, and none may outlive the file
test("a failing or timed-out run-slot test leaves no run alive into the next test, and no run-slot.sh of its fixture behind", () => {
  const scratch = mkdtempSync(join(tmpdir(), "run-slot-left-"))
  try {
    const pids = join(scratch, "pids")
    writeFileSync(pids, "")
    const file = join(scratch, "left.test.ts")
    writeFileSync(file, fixture(pids))
    const r = Bun.spawnSync(["bun", "test", file], { cwd: ROOT, stderr: "pipe", stdout: "pipe" })
    expect(`${r.stdout}${r.stderr}`).toContain("1 pass")
    expect(`${r.stdout}${r.stderr}`).toContain("2 fail")
    const started = readFileSync(pids, "utf8").split("\n").filter(Boolean)
    expect(started.length).toBe(2)
    const left = started.filter(runs)
    // this test's fixture started each, so one left behind is stopped by its own pid, and its trap ends its command
    for (const line of left) process.kill(Number(line.split(" ")[0]), "SIGTERM")
    expect(left).toEqual([])
  } finally {
    rmSync(scratch, { force: true, recursive: true })
  }
})
