import { statSync } from "node:fs"
import { join } from "node:path"

import { type HarnessId, loginOf, setSetting } from "@packages/settings"

import { runCommand, type Started, startDispatcher } from "@/lib/dashboard/dispatcher-start"
import { checkoutRoot, readsLive } from "@/lib/dashboard/fixture"
import { DISPATCHER } from "@/lib/dashboard/workers"
import { CODEX_LIVE_REFUSAL, isLiveFolder } from "@/lib/onboard/harness"
import { dataDir } from "@/lib/sessions/paths"

// Settings' Switch Alpha, on the owner's own click: a dispatcher that is not running starts on the other harness; for a running one the answer carries the words that ask it to write its handoff to a fixed file and stop, which Settings sends through the dashboard's outbox as that same click, and once that file is written and still, spawn.sh closes it and the CLI starts it again on the new harness from that handoff. harness.alpha takes the new harness once it has started. One switch at a time; a Codex switch on the live data folder is refused before anything changes, as Start is.

export type SwitchRead = {
  // The words Settings sends the running dispatcher through the outbox while the switch waits for its handoff, else null.
  ask: string | null
  harness: HarnessId | null
  reason: string | null
  state: "failed" | "idle" | "ok" | "running"
  step: string | null
  // The dispatcher the ask goes to, else null.
  to: string | null
}

const LABELS: Record<HarnessId, string> = { "claude-code": "Claude Code", codex: "Codex" }

// The handoff a switch asks for, under the data folder, which the new dispatcher's --brief names.
export const switchBrief = (name: string) => join("handoffs", `${name}-switch.md`)

// Pure: what the dispatcher is asked, as the owner would type it, naming the file and what happens next.
export const handoffAsk = (path: string, name: string, harness: HarnessId) =>
  `Switch Alpha to ${LABELS[harness]}: write your handoff now to ${path}, as the playbook's SESSIONS.md says (Write a handoff), then stop. Once it is written, the Dashboard closes this session and starts ${name} again on ${LABELS[harness]} from it.`

export type SwitchDeps = {
  close: (name: string) => Promise<string | null>
  data: string
  env: Record<string, string | undefined>
  mtime: (path: string) => number | null
  name: string
  now: () => number
  pollMs: number
  save: (harness: HarnessId) => string | null
  sleep: (ms: number) => Promise<void>
  start: (harness: HarnessId, brief?: string) => Promise<Started>
  waitMs: number
}

const mtimeOf = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The real switch's parts: spawn.sh close from the API's checkout, harness.alpha at the login's scope.
export const switchDeps = (actor: { id: string }): SwitchDeps => ({
  close: async (name) => {
    const root = checkoutRoot()
    if (!readsLive()) return null
    if (!root) return "this API has no checkout to close it from"
    const result = await runCommand([join(root, "scripts", "spawn.sh"), "close", name])
    return result.code === 0
      ? null
      : result.stderr.trim().split("\n").at(-1) || `spawn.sh close exited ${result.code}`
  },
  data: dataDir(),
  env: process.env,
  mtime: mtimeOf,
  name: DISPATCHER,
  now: Date.now,
  pollMs: 5_000,
  save: (harness) => {
    const set = setSetting(
      dataDir(),
      { key: "harness.alpha", scope: loginOf(dataDir()), value: harness },
      { actor: actor.id, author: "owner", inboxRef: null, reason: "Switch Alpha in Settings" },
    )
    return set.ok ? null : set.message
  },
  sleep: (ms) => Bun.sleep(ms),
  start: (harness, brief) => startDispatcher({ brief, harness }),
  waitMs: 20 * 60_000,
})

export const createSwitch = () => {
  let current: SwitchRead = {
    ask: null,
    harness: null,
    reason: null,
    state: "idle",
    step: null,
    to: null,
  }

  const fail = (job: SwitchRead, reason: string) => {
    job.ask = null
    job.reason = reason
    job.state = "failed"
  }

  // harness.alpha takes the new harness only once the dispatcher has started on it, so a switch that fails leaves the setting on the harness Alpha still runs.
  const succeed = (job: SwitchRead, to: HarnessId, deps: SwitchDeps) => {
    const unsaved = deps.save(to)
    if (unsaved)
      return fail(
        job,
        `${deps.name} runs on ${LABELS[to]} now, but harness.alpha did not save: ${unsaved}`,
      )
    job.state = "ok"
  }

  // Waits for the handoff, then closes the dispatcher and starts it again from it. The handoff counts once it is newer than the ask and unchanged over one wait, so a file still being written is never read.
  const handover = async (to: HarnessId, deps: SwitchDeps, job: SwitchRead, asked: number) => {
    const path = join(deps.data, switchBrief(deps.name))
    let seen: number | null = null
    for (let waited = 0; ; waited += deps.pollMs) {
      if (waited >= deps.waitMs)
        return fail(job, `${deps.name} wrote no handoff in time, so it still runs as before`)
      await deps.sleep(deps.pollMs)
      const at = deps.mtime(path)
      if (at !== null && at >= asked && at === seen) break
      seen = at
    }
    job.ask = null
    job.step = `Starting ${deps.name} on ${LABELS[to]}`
    const closed = await deps.close(deps.name)
    if (closed) return fail(job, closed)
    const again = await deps.start(to, switchBrief(deps.name))
    if (again.status === "started") return succeed(job, to, deps)
    const why = again.status === "running" ? "its name is still held" : again.detail
    fail(job, `${deps.name} stopped, but did not start again on ${LABELS[to]}: ${why}`)
  }

  // Starts a switch to harness to: the refusal's words while one runs, or for Codex on the live data folder; else done, which settles once the switch has.
  const begin = async (
    to: HarnessId,
    deps: SwitchDeps,
  ): Promise<{ done: Promise<void> } | string> => {
    if (current.state === "running") return "A switch is already running"
    if (to === "codex" && isLiveFolder(deps.env)) return CODEX_LIVE_REFUSAL
    const job: SwitchRead = {
      ask: null,
      harness: to,
      reason: null,
      state: "running",
      step: null,
      to: null,
    }
    current = job
    const settled = { done: Promise.resolve() }
    const first = await deps.start(to).catch((error: unknown): Started => ({
      detail: messageOf(error),
      name: deps.name,
      status: "failed",
    }))
    if (first.status === "started") {
      succeed(job, to, deps)
      return settled
    }
    if (first.status !== "running") {
      fail(job, first.detail)
      return settled
    }
    const asked = deps.now()
    job.ask = handoffAsk(join(deps.data, switchBrief(deps.name)), deps.name, to)
    job.step = "Waiting for Alpha's handoff"
    job.to = deps.name
    const done = handover(to, deps, job, asked).catch((error: unknown) =>
      fail(job, messageOf(error)),
    )
    return { done }
  }

  return { begin, read: (): SwitchRead => ({ ...current }) }
}

// The one switch every request reads.
export const dispatcherSwitch = createSwitch()
