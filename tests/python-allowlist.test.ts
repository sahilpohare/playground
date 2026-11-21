import { expect, test } from "bun:test"
import { join } from "node:path"

// Cut from `git ls-files '*.py'` at this branch's head; each Python port removes its own entries until the list is empty.
const ALLOWLIST = Object.freeze([
  "scripts/ops/beat.py",
  "scripts/ops/dashboard/watch-stuck.py",
  "scripts/ops/merge-train/run.py",
  "scripts/ops/once.py",
  "scripts/ops/ptable.py",
  "scripts/ops/unstick/run.py",
  "scripts/ops/up.py",
  "scripts/ops/usage/account-watch.py",
  "scripts/ops/usage/glm-credits.py",
  "scripts/ops/usage/login-flip.py",
  "scripts/ops/usage/near-limit.py",
  "scripts/ops/usage/run.py",
  "scripts/ops/usage/week-marks.py",
  "tests/test_docker_rm_volumes.py",
  "tests/test_kill_by_name.py",
  "tests/test_links.py",
  "tests/test_loopback_postgres.py",
  "tests/test_ops_checks.py",
  "tests/test_ops_jobs.py",
  "tests/test_ops_merge_train.py",
  "tests/test_setup_check.py",
])

const RULE =
  "TypeScript under Bun for every script and test; the file waits for its port, or is removed"

const readPythonFiles = async (): Promise<string[]> => {
  const proc = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.py"],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ls-files failed with ${code}: ${err}`)
  return out.split("\n").filter((path) => path.length > 0)
}

test("every .py file in the checkout is on the python allowlist", async () => {
  expect(ALLOWLIST.length).toBeGreaterThan(0)
  expect([...ALLOWLIST]).toEqual([...ALLOWLIST].sort())
  const found = await readPythonFiles()
  expect(found.length).toBeGreaterThan(0)
  const extra = found.filter((path) => !ALLOWLIST.includes(path))
  if (extra.length > 0) {
    throw new Error(
      `${extra.length} .py file(s) outside the python allowlist:\n${extra.join("\n")}\n${RULE}`,
    )
  }
})
