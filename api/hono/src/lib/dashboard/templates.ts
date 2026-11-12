import { copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"

import { ID_ALPHABET, seatOf } from "@packages/config/kinds"
import { spawnEnv } from "@packages/env/api-hono"
import {
  BRIEF_NAME,
  type HarnessId,
  readSessionTemplates,
  type SessionTemplate,
  templateBackend,
} from "@packages/settings"

import { readConfigAccount } from "@/lib/dashboard/account"
import { checkoutRoot, fixtureStart, readsLive } from "@/lib/dashboard/fixture"
import { readRegistry, registeredSessionsOf } from "@/lib/dashboard/peers"
import { readRoster } from "@/lib/dashboard/roster"
import { DISPATCHER, DISPATCHER_SECONDARY } from "@/lib/dashboard/workers"
import { dataDir } from "@/lib/sessions/paths"
import { listAccounts } from "@/lib/store/accounts"

// The sidebar's plus: a session started from one of sessions.templates, through spawn.sh's manager mode, so its capacity gate and its second-dispatcher rule hold unchanged. A dispatcher template starts the second dispatcher; any other kind a new <id>-<kind> lead, reporting to the dispatcher, its roster row written first, and a kind with a seat only while no live session holds it. A fixture stack runs nothing and brings back or makes the made-up session.

export type Run = (argv: string[]) => Promise<{ code: number; stderr: string; stdout: string }>

export type TemplateStarted =
  | { name: string; status: "running" | "started" }
  | { detail: string; name: string; status: "failed" | "refused" }
  | { status: "missing" }

// What a Claude second dispatcher with no account of its own waits on, said as the owner's next step.
export const NEEDS_ACCOUNT = "Add a second Claude account in Settings > Accounts"

// Pure: the argv each step of a template's start runs, in order: an orchestrator's roster row, then spawn.sh's manager start with the template's backend (--backend glm for a GLM model), account, model and effort; or why it cannot start.
export function templateArgv({
  account,
  dispatcher,
  name,
  root,
  template,
}: {
  account?: string
  dispatcher: string
  name: string
  root: string
  template: SessionTemplate
}): { error: string } | { steps: string[][] } {
  const { brief, effort, kind, label, model } = template
  const backend = templateBackend(template)
  if (!BRIEF_NAME.test(brief) || brief.includes(".."))
    return { error: `A brief is a file name in the data folder or scripts/briefs, not ${brief}` }
  if (kind === "dispatcher" && backend === "claude" && !account) return { error: NEEDS_ACCOUNT }
  const flags =
    backend === "glm"
      ? ["--backend", "glm"]
      : [
          ...(account ? ["--account", account] : []),
          ...(model ? ["--model", model] : []),
          ...(effort ? ["--effort", effort] : []),
        ]
  const start = [join(root, "scripts/spawn.sh"), "manager", name, briefOf(name), ...flags]
  if (kind === "dispatcher") return { steps: [start] }
  const row = [
    "bun",
    join(root, "scripts/roster.ts"),
    "set",
    name,
    `kind=${kind}`,
    `reportsTo=${dispatcher}`,
    `task=${label}`,
  ]
  return { steps: [row, start] }
}

// The brief a started session reads, in the data folder: its own, filled from the template's brief the first time, so the owner's edits to it stay.
export const briefOf = (name: string) => `brief-${name}.md`

// Pure: the account a Claude second dispatcher runs on when its template names none: the first Claude row of usage.accounts that is not this machine's own login.
export const secondAccount = (
  accounts: { email: string | null; provider: string }[],
  login: string | null,
): string | undefined =>
  accounts.find(
    (row) =>
      row.provider === "claude" && row.email && row.email.toLowerCase() !== login?.toLowerCase(),
  )?.email ?? undefined

// A made-up <id>-<kind> name for a fixture start, which reads no real session's names.
const madeUpName = (kind: string) =>
  `${Array.from({ length: 6 }, () => ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]).join("")}-${kind}`

const run: Run = async (argv) => {
  const child = Bun.spawn(argv, {
    env: spawnEnv(),
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stderr, stdout }
}

// The script's last line, whole: a refusal names its gate and reading, and the app shows all of it.
const said = (text: string) => text.trim().split("\n").at(-1) ?? ""

// A fresh <id>-<kind> name from the factory's one name picker, which reads every name used before.
const pickName = async (root: string, kind: string, runCli: Run): Promise<string | null> => {
  const picked = await runCli(["bun", join(root, "packages/scripts/src/name/index.ts"), kind])
  return picked.code === 0 ? picked.stdout.trim() || null : null
}

// Whether a session registered with Claude Code holds the name now.
const held = async (name: string): Promise<boolean> =>
  registeredSessionsOf(await readRegistry()).some((session) => session.name === name)

// The live session holding a kind's seat in the roster (seatOf), so a second Builder or Assistant never takes the running one's; none for an orchestrator, which holds no seat.
const seatHolder = async (kind: SessionTemplate["kind"]): Promise<string | undefined> =>
  seatOf((await readRoster()).roster?.agents, kind)

// The brief a template names, found where a start fills a session's own brief from: the data folder's file of that name first, else scripts/briefs'.
const briefSource = (data: string, root: string, brief: string): string | undefined =>
  [join(data, brief), join(root, "scripts/briefs", brief)].find((path) => existsSync(path))

// Pure: why a template cannot start now, or null: a Claude second dispatcher with no account but this machine's own login, or a brief found nowhere.
export const refusalOf = (
  template: SessionTemplate,
  { account, briefFound }: { account?: string; briefFound: boolean },
): string | null => {
  if (template.kind === "dispatcher" && templateBackend(template) === "claude" && !account)
    return NEEDS_ACCOUNT
  return briefFound ? null : `No brief ${template.brief} in the data folder or scripts/briefs`
}

type Context = {
  account: (template: SessionTemplate) => string | undefined
  data: string
  root: string | null
}

// What every template's start reads: the second account a Claude dispatcher takes, the data folder and the checkout.
const contextOf = async (
  data: string,
  root: string | null,
  login?: string | null,
): Promise<Context> => {
  const machine = login === undefined ? ((await readConfigAccount())?.email ?? null) : login
  const second = secondAccount(
    listAccounts(data).map((row) => ({ email: row.email, provider: row.provider })),
    machine,
  )
  return {
    account: (template) =>
      template.account ??
      (template.kind === "dispatcher" && templateBackend(template) === "claude"
        ? second
        : undefined),
    data,
    root,
  }
}

const refusalIn = (template: SessionTemplate, { account, data, root }: Context) =>
  refusalOf(template, {
    account: account(template),
    briefFound: Boolean(root && briefSource(data, root, template.brief)),
  })

export type TemplateRow = {
  effort: string | null
  harness: HarnessId
  id: string
  kind: string
  label: string
  model: string | null
  refusal: string | null
}

// The picker's rows: each template with why it cannot start now, or null.
export async function listTemplates({
  data = dataDir(),
  login,
  root = checkoutRoot(),
  templates = readSessionTemplates(data),
}: {
  data?: string
  login?: string | null
  root?: string | null
  templates?: SessionTemplate[]
} = {}): Promise<TemplateRow[]> {
  const context = await contextOf(data, root, login)
  return templates.map((template) => ({
    effort: template.effort ?? null,
    harness: template.harness,
    id: template.id,
    kind: template.kind,
    label: template.label,
    model: template.model ?? null,
    refusal: refusalIn(template, context),
  }))
}

export async function startTemplate(
  id: string,
  {
    data = dataDir(),
    dir,
    isHeld = held,
    live = readsLive(),
    login,
    root = checkoutRoot(),
    run: runCli = run,
    seat = seatHolder,
    templates = readSessionTemplates(data),
  }: {
    data?: string
    dir?: string
    isHeld?: (name: string) => Promise<boolean>
    live?: boolean
    login?: string | null
    root?: string | null
    run?: Run
    seat?: (kind: SessionTemplate["kind"]) => Promise<string | undefined>
    templates?: SessionTemplate[]
  } = {},
): Promise<TemplateStarted> {
  const template = templates.find((t) => t.id === id)
  if (!template) return { status: "missing" }
  const dispatcher = template.kind === "dispatcher"
  const unnamed = dispatcher ? DISPATCHER_SECONDARY : template.kind
  const context = await contextOf(data, root, login)
  const refusal = refusalIn(template, context)
  if (refusal) return { detail: refusal, name: unnamed, status: "refused" }
  if (!live) {
    const name = dispatcher ? DISPATCHER_SECONDARY : madeUpName(template.kind)
    return { name, status: fixtureStart(name, dir) ? "started" : "running" }
  }
  if (!root)
    return { detail: "This API has no checkout to start it from", name: unnamed, status: "failed" }
  const holder = dispatcher ? undefined : await seat(template.kind)
  if (holder) return { name: holder, status: "running" }
  const name = dispatcher ? DISPATCHER_SECONDARY : await pickName(root, template.kind, runCli)
  if (!name) return { detail: "The name picker gave no name", name: unnamed, status: "failed" }
  if (await isHeld(name)) return { name, status: "running" }
  const argv = templateArgv({
    account: context.account(template),
    dispatcher: DISPATCHER,
    name,
    root,
    template,
  })
  if ("error" in argv) return { detail: argv.error, name, status: "refused" }
  const target = join(data, briefOf(name))
  const source = briefSource(data, root, template.brief)
  if (!existsSync(target) && source) copyFileSync(source, target)
  for (const [index, step] of argv.steps.entries()) {
    const result = await runCli(step)
    if (result.code === 0) continue
    // The roster row an orchestrator's first step wrote ends with the start, so no row waits at starting for a session that never ran.
    if (index > 0) await runCli([...argv.steps[0]!.slice(0, 4), "status=ended"])
    const detail = said(result.stderr) || said(result.stdout) || `exit ${result.code}`
    return { detail, name, status: result.code === 1 ? "refused" : "failed" }
  }
  return { name, status: "started" }
}
