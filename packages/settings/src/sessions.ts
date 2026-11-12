import type { RosterKind } from "@packages/config/kinds"
import { z } from "zod"

import { type Account, accountKey, accountsOf } from "@/accounts"
import { type Backend, GLM_MODEL } from "@/harnesses"
import { readPolicyOrDefaults } from "@/rendered"
import { defineSettings, type Refusal } from "@/settings"

const name = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a session name, lowercase words joined by hyphens")
const manager = z.enum(["builder", "dispatcher", "ops", "planner"])

// The manager kinds a template starts, each a lead in a workspace of its own through spawn.sh's manager mode: ROSTER_ROLE_OF_KIND's managers, written out since settings reads no package at run time but its own deps.
export const TEMPLATE_KINDS = [
  "assistant",
  "builder",
  "dispatcher",
  "ops",
  "optimizer",
  "orchestrator",
  "planner",
] as const satisfies readonly RosterKind[]

// The efforts spawn.sh takes, Claude Code's levels.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

// A brief is one file's name, under the data folder or scripts/briefs, so no template reaches outside either.
export const BRIEF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// One template the sidebar's plus starts a session from: every value checked here, so none reaches spawn.sh's argv unread. account is a usage.accounts email, Claude alone; none takes the first account that is not this machine's own login, for a second dispatcher, which spawn.sh never starts on the first's. harness is the one it runs in, and model a Claude id, or glm for models.glm.
export const sessionTemplate = z
  .strictObject({
    account: z.string().email().optional(),
    brief: z
      .string()
      .regex(BRIEF_NAME, "a brief is a file name, with no /")
      .refine((brief) => !brief.includes(".."), "a brief is a file name, with no .."),
    effort: z.enum(EFFORTS).optional(),
    // Claude Code's alone: Codex starts only the first dispatcher, which no template starts.
    harness: z.literal("claude-code"),
    id: name,
    kind: z.enum(TEMPLATE_KINDS),
    label: z.string().min(1).max(40),
    model: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]*$/, "a model id")
      .optional(),
  })
  .refine((t) => t.model !== GLM_MODEL || (t.account === undefined && t.effort === undefined), {
    message:
      "a GLM template runs on models.glm and its first GLM row, so it takes no account or effort",
  })

export type SessionTemplate = z.infer<typeof sessionTemplate>

// Pure: the backend spawn.sh's --backend takes for a template: glm for a GLM model, else claude.
export const templateBackend = (template: { model?: string }): Backend =>
  template.model === GLM_MODEL ? "glm" : "claude"

// Pure: a stored list as it reads now: a row saved before the harness split names a backend, which reads as Claude Code with glm as its model on GLM; a Claude row that named glm as its model, which spawn.sh refused, reads with that model dropped, so it never reads as GLM and the rest of the list still reads; a row naming another backend keeps it for the schema to refuse.
export const storedTemplates = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((row) => {
        if (typeof row !== "object" || row === null || !("backend" in row) || "harness" in row)
          return row
        const { backend, ...rest } = row as { backend: unknown; model?: unknown }
        const { model, ...modelless } = rest
        if (backend === "glm") return { ...rest, harness: "claude-code", model: GLM_MODEL }
        if (backend !== "claude") return { ...rest, backend, harness: "claude-code" }
        return { ...(model === GLM_MODEL ? modelless : rest), harness: "claude-code" }
      })
    : value

// The setting's list, each id once.
export const sessionTemplates = z
  .array(sessionTemplate)
  .refine(
    (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
    "each id is listed once",
  )

// Pure: each template whose account is no Claude row of usage.accounts, refused at its account, since spawn.sh reads that account's token from the Keychain.
export const unknownAccounts = (templates: SessionTemplate[], accounts: Account[]): Refusal[] => {
  const known = new Set(accountsOf(accounts, "claude").map(accountKey))
  return templates.flatMap((template, at) =>
    template.account && !known.has(template.account)
      ? [
          {
            message: `${template.account} is not in usage.accounts: add it in Settings > Accounts`,
            path: [at, "account"],
          },
        ]
      : [],
  )
}

// The managers' session names, so a factory names its own: each kind's name, and the old names a machine's sessions and stored rows still carry, each read as its kind.
export const sessionSettings = defineSettings({
  "sessions.aliases": {
    default: {},
    description:
      "Old names of the managers' sessions, each mapped to its kind, so a session or a stored row under one still reads as that kind.",
    schema: z.record(name, manager),
  },
  "sessions.names": {
    default: { builder: "builder", dispatcher: "dispatcher", ops: "ops", planner: "planner" },
    description:
      "The session name each manager kind starts under; the second dispatcher takes the dispatcher's with -2.",
    schema: z.strictObject({ builder: name, dispatcher: name, ops: name, planner: name }),
  },
  "sessions.templates": {
    against: (templates, read) =>
      unknownAccounts(templates as SessionTemplate[], read("usage.accounts") as Account[]),
    default: [
      {
        brief: "assistant.md",
        harness: "claude-code",
        id: "assistant",
        kind: "assistant",
        label: "Assistant",
      },
      {
        brief: "orchestrator.md",
        harness: "claude-code",
        id: "orchestrator",
        kind: "orchestrator",
        label: "Orchestrator",
      },
      {
        brief: "dispatcher-2.md",
        harness: "claude-code",
        id: "second-dispatcher-claude",
        kind: "dispatcher",
        label: "Second dispatcher on Claude",
      },
      {
        brief: "dispatcher-2.md",
        harness: "claude-code",
        id: "second-dispatcher-glm",
        kind: "dispatcher",
        label: "Second dispatcher on GLM",
        model: GLM_MODEL,
      },
    ] as SessionTemplate[],
    description:
      "The templates the sidebar's plus starts a dispatcher or an orchestrator from, A to Z by label: each one's kind, harness, model (a Claude id, or glm), effort, account (a Claude row of usage.accounts) and brief. A dispatcher template starts the second dispatcher; any other kind starts a new <id>-<kind> lead reporting to the dispatcher.",
    schema: sessionTemplates,
    stored: storedTemplates,
  },
})

// The machine's managers' names, as @packages/config/kinds' setSessionNames takes them: the defaults until a first setting writes policy.json; a policy that is there and cannot be read is a refusal, never the defaults.
export const readSessionNames = (data: string) => {
  const read = readPolicyOrDefaults(data)
  if (read.refusal !== undefined) throw new Error(read.refusal)
  return {
    aliases: sessionSettings.get(read.settings, "sessions.aliases"),
    names: sessionSettings.get(read.settings, "sessions.names"),
  }
}

// The machine's session templates: the defaults until a setting names others; a policy that cannot be read is a refusal.
export const readSessionTemplates = (data: string): SessionTemplate[] => {
  const read = readPolicyOrDefaults(data)
  if (read.refusal !== undefined) throw new Error(read.refusal)
  return sessionSettings.get(read.settings, "sessions.templates")
}
