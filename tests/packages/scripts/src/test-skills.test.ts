import { expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { scratchEnv } from "../../../scratch-env"

const SCRIPT = join(import.meta.dir, "../../../../packages/scripts/src/test-skills.ts")

// Runs one step through runSteps with the given fake binaries first on PATH and the real home in a scratch folder, and returns what the step wrote to its out file
const runStep = (fakes: Record<string, string>, script: string) => {
  const real = mkdtempSync(join(tmpdir(), "test-skills-real-home-"))
  try {
    const bin = join(real, "bin")
    mkdirSync(bin)
    for (const [name, body] of Object.entries(fakes)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    const out = join(real, "out")
    const tmp = join(real, "tmp")
    mkdirSync(tmp)
    const step = ["sh", "-c", script.replaceAll("$OUT", JSON.stringify(out))]
    const env = scratchEnv(real, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: tmp,
      UV_CACHE_DIR: undefined,
      UV_PYTHON_INSTALL_DIR: undefined,
    })
    const run = Bun.spawnSync(
      [
        "bun",
        "-e",
        `const { runSteps } = await import(${JSON.stringify(SCRIPT)}); const [[, ok]] = await runSteps([["step", ${JSON.stringify(step)}]]); process.exit(ok ? 0 : 1)`,
      ],
      { env },
    )
    expect(run.exitCode).toBe(0)
    return {
      left: readdirSync(tmp),
      marker: existsSync(join(real, ".claude/marker")),
      out: existsSync(out) ? readFileSync(out, "utf8") : "",
    }
  } finally {
    rmSync(real, { force: true, recursive: true })
  }
}

test("a step writes under the sandbox's home, never the real ~/.claude (#1430)", () => {
  const { marker } = runStep({}, 'mkdir -p "$HOME/.claude" && touch "$HOME/.claude/marker"')
  expect(marker).toBe(false)
})

test("a step runs in a marked scratch folder of the temp folder, gone once the run ends (#545)", () => {
  const { left, out } = runStep(
    {},
    'printf "%s %s" "$TEST_SANDBOX_HOME" "$(test -f "$TEST_SANDBOX_HOME/.safe-delete-scratch" && echo marked)" > $OUT',
  )
  const [home, marked] = out.split(" ")
  expect(home).toContain("/tmp/test-sandbox-")
  expect(marked).toBe("marked")
  expect(left).toEqual([])
})

test("uv's cache folder reaches a step (#1443)", () => {
  const uv =
    'case "$1 $2" in "cache dir") echo /fake/uv-cache ;; "python dir") echo /fake/uv-python ;; esac'
  const { out } = runStep({ uv }, 'printf "%s\\n" "$UV_CACHE_DIR" > $OUT')
  expect(out).toBe("/fake/uv-cache\n")
})

test("a red run's tail names each failed step and its first FAIL line on the Mac and the runner host, though a passing step ran last (#1677)", () => {
  const queryDb = [
    "sh",
    "-c",
    'echo "PASS 37 a query runs"; echo "FAIL 38 SIGHUP during a query stops the proxy rc=-1"; echo "FAIL 39 another"; echo "FAILURES: 2"; exit 1',
  ]
  const steps = [
    ["query-db", queryDb],
    ["em-dash check", ["sh", "-c", "exit 1"]],
    ["one sentence per line", ["sh", "-c", "echo fine"]],
  ]
  const dir = mkdtempSync(join(tmpdir(), "test-skills-tail-"))
  try {
    writeFileSync(
      join(dir, "t.ts"),
      `const { report, runSteps } = await import(${JSON.stringify(SCRIPT)}); process.exit(report(await runSteps(${JSON.stringify(steps)})))`,
    )
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { t: "bun t.ts" } }))
    const want =
      "2 of 3 failed: query-db: FAIL 38 SIGHUP during a query stops the proxy rc=-1; em-dash check"
    // checks.py's full_suite on the Mac: stdout then stderr, its last 2 lines
    const mac = Bun.spawnSync(["bun", "run", "t"], { cwd: dir })
    expect(mac.exitCode).toBe(1)
    const both = `${mac.stdout}${mac.stderr}`.trim().split("\n")
    expect(both.slice(-2).join(" ")).toContain(want)
    // suite.sh's step on the runner host: stdout and stderr in one log, its last 3 lines
    const box = Bun.spawnSync(["sh", "-c", "bun run t 2>&1"], { cwd: dir })
    expect(box.stdout.toString().trimEnd().split("\n").slice(-3).join(" ")).toContain(want)
    // a run on the Mac piped into `tail -n 3`, which reads stdout alone
    expect(mac.stdout.toString().trimEnd().split("\n").slice(-3).join(" ")).toContain(want)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("the Mac's 200-character cut of a red run with three long failures keeps the count and the first failed step's name (#1701)", () => {
  const long = (n: number) => [
    "sh",
    "-c",
    `echo "FAIL ${n} ${"a step that failed with a long description of what it checked ".repeat(2)}"; exit 1`,
  ]
  const steps = [
    ["query-db", long(38)],
    ["vault", long(12)],
    ["em-dash check", long(1)],
  ]
  const dir = mkdtempSync(join(tmpdir(), "test-skills-cut-"))
  try {
    writeFileSync(
      join(dir, "t.ts"),
      `const { report, runSteps } = await import(${JSON.stringify(SCRIPT)}); process.exit(report(await runSteps(${JSON.stringify(steps)})))`,
    )
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { "test:skills": "bun t.ts" } }),
    )
    // checks.py's full_suite on the Mac: stdout then stderr, its last 2 lines joined, then [-200:]
    const mac = Bun.spawnSync(["bun", "run", "test:skills"], { cwd: dir })
    expect(mac.exitCode).toBe(1)
    const tail = `${mac.stdout}${mac.stderr}`.trim().split("\n").slice(-2).join(" ").slice(-200)
    expect(tail).toStartWith("3 of 3 failed: query-db: FAIL 38")
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
