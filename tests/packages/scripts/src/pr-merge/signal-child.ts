// A pr:merge stopped mid-run, for merge-signal.test.ts, each mode printing "ready" once there: `lock <root>` takes the merge lock for #112 and waits inside it; `types <root>` runs the types gate with a stub git, its worktree under root, inside its one step, which writes its pid to root/step.pid; `held-types <root>` takes the merge lock for #112 first, and its step, on its TERM, writes to root/step-saw whether the lock was still held half a second on; `merge <root> facts|squash` runs prMerge with stub gh and git, paused at reading the PR (answered when a signal comes) or inside the squash (answered on a line of stdin), printing each gh call it makes.
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { prMerge, takeLock, type Run } from "../../../../../packages/scripts/src/pr-merge/merge"
import { onStop } from "../../../../../packages/scripts/src/pr-merge/stop"
import { typesGate } from "../../../../../packages/scripts/src/pr-merge/types"
import { storeWith } from "../../../../scripts/hooks/render-set"
import { PR_TEMPLATE } from "./bodies"
import { greenChecks } from "./suite"

const [mode, root = "", phase = ""] = process.argv.slice(2)
const HEAD = "69a6a4c5e6caf46c4abda6a89de4ce6f3b309e88"
const ok = (stdout = "") => ({ code: 0, stderr: "", stdout })

const git: Run = async (args) => {
  if (args[0] === "merge-base")
    return { code: mode.endsWith("types") ? 1 : 0, stderr: "", stdout: "" }
  if (args.includes("--git-common-dir")) return ok(join(root, ".git"))
  if (args.includes("--show-toplevel")) return ok(root)
  if (args.includes("add")) mkdirSync(args.at(-2) ?? "", { recursive: true })
  if (args[0] === "diff") return ok("")
  if (args[0] === "rev-list") return ok("")
  if (args[0] === "show") return ok(PR_TEMPLATE)
  if (args[0] === "merge-tree") return ok(`${"1".repeat(40)}\n`)
  return ok("c0ffee")
}

const signalled = new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()))
const lineIn = async () => {
  for await (const _ of console) return
}

const gh: Run = async (args) => {
  const joined = args.join(" ")
  console.log(`gh ${args.slice(0, 2).join(" ")}`)
  if (joined.includes("baseRefName")) {
    if (phase === "facts") {
      // a slow cleanup after the lock's own keeps the process alive past the release, so the run reaches its squash unless it reads the stop first
      onStop(() => Bun.sleep(500))
      console.log("ready")
      await signalled
    }
    const view = { author: { login: "acme" }, baseRefName: "canary", headRefOid: HEAD }
    return ok(
      JSON.stringify({ ...view, isDraft: false, state: "OPEN", statusCheckRollup: greenChecks() }),
    )
  }
  if (joined.includes("/files")) return ok("README.md\n")
  if (joined.includes("/comments")) {
    const body = `## ReviewBot · round 1: 5/5 at ${HEAD.slice(0, 7)} · 0 blocking`
    return ok(JSON.stringify({ author: "acme", body, createdAt: "2026-11-02T00:00:00Z" }))
  }
  if (joined.includes("/compare/")) return ok("0")
  if (joined.includes("--json body")) return ok("Closes #112")
  if (joined.startsWith("pr merge")) {
    console.log("ready")
    await lineIn()
  }
  if (joined.includes("mergeCommit"))
    return ok(JSON.stringify({ mergeCommit: { oid: "abc1234def" }, state: "MERGED" }))
  return ok("")
}

if (mode === "lock") {
  if ("holder" in (await takeLock(root, 112))) process.exit(2)
  console.log("ready")
} else if (mode === "types") {
  // the step spawns in the same tick as this line, so it runs by the time the test reads it
  void typesGate({
    facts: { canary: "canary", head: "head", mergeTree: "tree", n: 7 },
    git,
    lockRoot: join(root, "lock"),
    steps: () => {
      console.log("ready")
      const pid = join(root, "step.pid")
      return [{ argv: ["sh", "-c", 'echo $$ > "$0"; exec sleep 5', pid], name: "wait" }]
    },
  })
} else if (mode === "held-types") {
  if ("holder" in (await takeLock(root, 112))) process.exit(2)
  const saw = `kill $!; sleep 0.5; if [ -d "$1" ]; then echo held > "$2"; else echo released > "$2"; fi; exit 143`
  void typesGate({
    facts: { canary: "canary", head: "head", mergeTree: "tree", n: 112 },
    git,
    lockRoot: join(root, "lock"),
    steps: () => {
      console.log("ready")
      const args = [join(root, "merge.lock"), join(root, "step-saw"), join(root, "step.pid")]
      const script = `trap '${saw}' TERM; echo $$ > "$3"; sleep 30 & wait`
      return [{ argv: ["sh", "-c", script, "sh", ...args], name: "wait" }]
    },
  })
} else {
  process.env.PLAYGROUND_DATA_DIR = storeWith(join(root, "data"), {}, { "factory.repo": "acme/f" })
  process.env.PLAYGROUND_HELD_PRS = join(root, "held-prs.json")
  void prMerge(112, { repo: "acme/other" }, gh, { git, lockRoot: root, store: null })
}
setInterval(() => {}, 1000)
