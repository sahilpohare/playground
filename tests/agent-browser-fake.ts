import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Runs script in a child bun whose PATH leads with an agent-browser that fails its first `fails` commands with error and then succeeds, since Bun's spawn reads the PATH its process started with; returns the child's exit code and stderr, and each command's argv, one line per call.
export const withFakeAgentBrowser = (fails: number, error: string, script: string) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-browser-fake-"))
  const log = join(dir, "calls")
  const failed = JSON.stringify({ error, success: false })
  writeFileSync(
    join(dir, "agent-browser"),
    `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$(wc -l < '${log}')" -le ${fails} ]; then echo '${failed}'; else echo '{"data":{},"success":true}'; fi\n`,
    { mode: 0o755 },
  )
  try {
    const child = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stderr: "pipe",
      stdout: "pipe",
    })
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []
    return { calls, code: child.exitCode, err: child.stderr.toString() }
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}
