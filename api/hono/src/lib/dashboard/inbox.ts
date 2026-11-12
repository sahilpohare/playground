import { readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { withOwn } from "@packages/config/accounts"
import {
  ANSWER_LEAD,
  type AnswerPayload,
  answerPayloadSchema,
  choicesOf,
  CLOCKS_STOPPED_AT,
  MAX_OPTIONS,
  picksOf,
  rowOfAnswer,
} from "@packages/config/inbox"
import type { ActivityActor, Database } from "@packages/db"
import { inboxItem, thread } from "@packages/db"
import { dataDir } from "@packages/env/data-dir"
import {
  checkSetting,
  extensionsDir,
  extScopeSchema,
  GUARD_SETTING_KEYS,
  itemKeySchema,
  JOBS,
  jobKey,
  jobSchema,
  KINDS,
  orgJobKey,
  readSetting,
  resetSetting,
  SCOPE_NAME,
  setSetting,
  settingRows,
  slackSettings,
} from "@packages/settings"
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import { z } from "zod"

import { fileNameOf } from "../download"
import { KEYCHAIN_ITEM_NAMES, keychainSpec, PLAYGROUND_SERVICE } from "../keychain-items"
import { ID_PATTERN } from "./attachments"
import { checkoutRoot, currentSource, type DashboardSource } from "./fixture"
import { OWNER_APPS } from "./owner-apps"

// Playground's Inbox: what the factory posts for the owner, one row of inbox_item each, through the bun run ask CLI alone. A decision previews exactly what Approve does, a draft is a Slack message or Linear comment to send, and an update is an outcome to read. The dashboard records his answer and types it into the posting session through deliver(); the dashboard itself never sends a message, merges or files anything, sharing only a Slack send's files (filesToUpload) and running only the step an accept's, an apps change's, a grant's, a guard setting's or an own account change's Approve names (stepOf). Nothing here imports the API's env or an @/ path, so the CLI runs from any shell and the web reads its types.

const LIMITS = { line: 200, name: 120, prs: 50, text: 4000 }

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/.test(value), "Must be one line")

const words = z.string().trim().min(1).max(LIMITS.text)

// A Slack link reaches the owner in the app form they open, never the archives form; slack.linkConverter names the command that rewrites one, and slack.sendServer the MCP server a send goes through, each read from the extensions' policy when a message is made, "" when unset or unreadable.
const ARCHIVES = /\b(?:[a-z0-9-]+\.)?slack\.com\/archives\//i
const slack = (key: "slack.linkConverter" | "slack.sendServer"): string => {
  try {
    const policy = JSON.parse(readFileSync(join(extensionsDir(dataDir()), "policy.json"), "utf8"))
    return slackSettings.get({ schemaVersion: 1, values: policy.values ?? {} }, key)
  } catch {
    return ""
  }
}
const archivesMessage = (): string => {
  const converter = slack("slack.linkConverter")
  return `A Slack link goes in its app form (https://app.slack.com/client/...), never .../archives/...${converter ? `; rewrite it with ${converter}` : ""}`
}

// A mention reaches the owner as a name they read, never Slack's raw token: a user, a user group, a channel, or @here, @channel or @everyone.
const MENTION_TOKEN =
  /<(?:@[UW][A-Z0-9]+|#C[A-Z0-9]+|!subteam\^[A-Z0-9]+|!(?:here|channel|everyone))(?:\|[^>]*)?>/
const MENTION_MESSAGE =
  "A raw Slack mention token (<@U...>, <!subteam^...>, <!here>, <#C...>) is refused: write mentions as readable names (@name, @team-name); the poster resolves IDs when posting"

// A draft, or a slack decision, speaks in the owner's own voice, and the owner's rule is first person singular: I, never we, us, our, ours or ourselves. The all-caps US is the country, not the pronoun, so it alone passes.
const OWNER_VOICE = /\b(?:ourselves|ours|our|we|us)\b/gi
const OWNER_VOICE_MESSAGE =
  "A draft, or a slack decision, speaks in the owner's voice, and the owner's rule is first person singular: I, never we, us, our, ours or ourselves (code, quoted words, US the country and hyphenated names like us-east-1 aside)"

// Pure: the first owner's-voice word a text holds outside fenced and inline code, double-quoted spans and blockquote lines, since those are someone else's words; a link (bare, or Slack's <url|label>) is an address, not a voice. Null when none.
const ownerVoiceWord = (text: string): string | null => {
  const clean = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/<[^<>|]+\|[^<>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
  for (const match of clean.matchAll(OWNER_VOICE)) {
    if (match[0] === "US") continue
    // a hyphen right after reads as a compound's half, us-east-1, not the pronoun
    if (clean[(match.index ?? 0) + match[0].length] === "-") continue
    return match[0]
  }
  return null
}

// An ask that has the owner quit, restart, close or stop something names what its poster found still depending on it: any form of the four verbs, but a past form after after, since, because or while, a determiner and one word ("after the dashboard restarted").
const TAKES_DOWN =
  /\b(?:quit(?:s|ting)?|restart(?:s|ed|ing)?|clos(?:e|es|ed|ing)|stop(?:s|ped|ping)?)\b/i
const PASSING_MENTION =
  /\b(?:after|since|because|while)\s+(?:the|a|an|its|their|this|that)\s+[\w'-]+\s+(?:quit|restarted|closed|stopped)\b/gi
const TAKES_DOWN_MESSAGE =
  'An ask to quit, restart, close or stop something carries preview.checked, one line saying what still depends on it ("none", or the list; a close that takes nothing down, such as a pull request, is "none"), found by checking the runtimes in ops/jobs.json in the data folder, the live processes under the target, the sessions in it, and the Dashboard\'s /api/health; post it only when nothing would break'

// Where an item will land, given upfront: the Slack thread, channel or DM, the compare or pull request, the Linear team or project; or, with no place yet, why (`noLink`).
const place = {
  link: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .optional(),
  noLink: oneLine(LIMITS.line).optional(),
}

// The kinds of file an ask can carry, each opened in the Inbox's viewer by its own renderer.
export const INBOX_ATTACHMENT_KINDS = ["code", "doc", "html", "image", "pdf"] as const
export type InboxAttachmentKind = (typeof INBOX_ATTACHMENT_KINDS)[number]

export const MAX_INBOX_ATTACHMENTS = 20

// A label pairs a before with an after in one group, a group being a section's one-line heading.
const attachmentPlace = {
  group: oneLine(LIMITS.line).optional(),
  label: z.enum(["after", "before"]).optional(),
}

// What a poster names: a file on this Mac, its kind read from its extension when left out, which bun run ask copies in before posting.
export const attachmentSourceSchema = z.strictObject({
  ...attachmentPlace,
  kind: z.enum(INBOX_ATTACHMENT_KINDS).optional(),
  src: z.string().min(1).max(4096),
})

// What the item keeps: the copy's id in the attachments folder, its kind and the source's file name.
export const attachmentSchema = z.strictObject({
  ...attachmentPlace,
  id: z.string().regex(ID_PATTERN),
  kind: z.enum(INBOX_ATTACHMENT_KINDS),
  name: oneLine(LIMITS.name),
})

export type InboxAttachment = z.infer<typeof attachmentSchema>

// The files an ask, a draft, a Slack decision or a read-only update shows on its card.
const attachments = z.array(attachmentSchema).min(1).max(MAX_INBOX_ATTACHMENTS).optional()

// What the other side has said so far, one line per message in their words' gist, oldest first, so a Slack message or draft reads in its context.
const soFar = z
  .array(z.strictObject({ said: oneLine(LIMITS.line), who: oneLine(LIMITS.name) }))
  .min(1)
  .max(12)
  .optional()

// A name that goes into a sink's argv: never empty, never read as a flag, no space.
const argName = z
  .string()
  .max(LIMITS.name)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Must be a lowercase name: letters, digits, dot, dash, underscore",
  )

const SECRET_ENVIRONMENTS = ["development", "preview", "production"] as const

const vercelSinkSchema = z.strictObject({
  environments: z
    .array(z.enum(SECRET_ENVIRONMENTS))
    .min(1)
    .refine((list) => new Set(list).size === list.length, "Name each environment once"),
  project: argName,
  scope: argName,
  type: z.literal("vercel"),
})

// A Keychain item a card names: a typed one by name (slack, yard), or any of Playground's own by its full service (keychainSpec), always as this Mac's signed-in user.
const playgroundService = z.string().regex(PLAYGROUND_SERVICE, "Must be a playground- service")
const keychainItemField = z.union([z.enum(KEYCHAIN_ITEM_NAMES), playgroundService])

// Where a secret ask's value goes, the allowlist in code: Vercel, `vercel env add` once an environment for one project, or keychain, one of this Mac's Keychain items keychainItemField allows.
export const secretSinkSchema = z.discriminatedUnion("type", [
  vercelSinkSchema,
  z.strictObject({ item: keychainItemField, type: z.literal("keychain") }),
])

export type SecretSink = z.infer<typeof secretSinkSchema>

// Pure: the one command a Vercel sink runs for an environment; the value goes on its stdin alone, so it is never in an argv a process list shows.
export const sinkArgv = (
  key: string,
  sink: z.infer<typeof vercelSinkSchema>,
  environment: string,
): string[] => [
  "vercel",
  "env",
  "add",
  key,
  "--environment",
  environment,
  "--project",
  sink.project,
  "--scope",
  sink.scope,
  "--yes",
]

// An extension proposal the owner accepts from the Inbox in place of a terminal: its scope, kind and key, and the rev he reads, which the accept holds to, so a proposal written after he read it is refused. Each word is one the store takes, none can start as a flag, and no session supplies the argv.
const proposalSchema = z.strictObject({
  key: z.string().max(LIMITS.name).pipe(itemKeySchema),
  kind: z.enum(KINDS),
  rev: z.string().regex(/^[0-9a-f]{7,40}$/, "Must be a commit SHA"),
  scope: z.string().max(LIMITS.name).regex(SCOPE_NAME, "Must be a login, an org or core"),
})

export type InboxProposal = z.infer<typeof proposalSchema>

// An accept decision: its own proposal first, then more, the ones accepted after it in the order they land, so one card holds a set the owner reads as one change.
const acceptSchema = z.strictObject({
  key: proposalSchema.shape.key,
  kind: proposalSchema.shape.kind,
  more: z.array(proposalSchema).min(1).max(20).optional(),
  rev: proposalSchema.shape.rev,
  scope: proposalSchema.shape.scope,
  type: z.literal("accept"),
  why: words,
})

export type InboxAccept = z.infer<typeof acceptSchema>

// Pure: an accept's proposals in the order Approve accepts them, a single accept's one alone.
export const proposalsOf = (preview: InboxAccept): InboxProposal[] => [
  { key: preview.key, kind: preview.kind, rev: preview.rev, scope: preview.scope },
  ...(preview.more ?? []),
]

// Accepts each proposal in order through `playground ext accept`, stopping at the first that fails: a list of one gives the CLI's own result, a longer one a line naming those accepted, the one that failed with its reason and those not tried.
async function acceptAll(accept: ExtRun, preview: InboxAccept, ref: number): Promise<RunResult> {
  const proposals = proposalsOf(preview)
  if (proposals.length === 1) return runResult(await accept(acceptArgs(proposals[0]!, ref)))
  const name = (proposal: InboxProposal) => `${proposal.kind} ${proposal.key} in ${proposal.scope}`
  const accepted: string[] = []
  for (const [at, proposal] of proposals.entries()) {
    const ran = await accept(acceptArgs(proposal, ref))
      .then(runResult)
      .catch((error: unknown) =>
        runResult({
          code: 1,
          err: error instanceof Error ? error.message : String(error),
          out: "",
        }),
      )
    if (ran.exitCode !== 0) {
      const rest = proposals.slice(at + 1).map(name)
      const done = accepted.length ? `accepted ${accepted.join(", ")}; ` : ""
      const untried = rest.length ? `; not tried: ${rest.join(", ")}` : ""
      return {
        exitCode: ran.exitCode,
        line: `${done}${name(proposal)} failed: ${ran.line}${untried}`,
      }
    }
    accepted.push(name(proposal))
  }
  return { exitCode: 0, line: `accepted ${accepted.join(", ")}` }
}

// Pure: the one command Approve runs for a proposal, as `playground ext <args>`: the preview's words, and a reason naming the item.
export const acceptArgs = (preview: InboxProposal, ref: number): string[] => [
  "accept",
  preview.scope,
  preview.kind,
  preview.key,
  preview.rev,
  "--reason",
  `the owner approved it in the Inbox (${itemTag(ref)})`,
]

// Runs `playground ext <args>` with no role, stdin on its input when given, and returns its exit code and output: store/extensions.ts's runCli is the real one, which the router passes, and a test passes its own. It restates that file's Cli, since the web reads this file's types and that file's imports reach the API's own.
export type ExtRun = (
  args: string[],
  stdin?: string,
) => Promise<{ code: number; err: string; out: string }>

// The System Settings pane for each permission agent-desktop needs, by the name a grant decision gives it.
export const GRANT_PANES = {
  accessibility: "Privacy_Accessibility",
  "screen-recording": "Privacy_ScreenCapture",
} as const

// A macOS permission agent-desktop needs, which the owner grants in System Settings: Approve opens its pane on this Mac, and the poster rechecks the grant itself, since macOS grants the app that launches agent-desktop, which only the poster's own run reads.
const grantSchema = z.strictObject({
  permission: z.enum(Object.keys(GRANT_PANES) as [keyof typeof GRANT_PANES]),
  type: z.literal("grant"),
  why: words,
})

export type InboxGrant = z.infer<typeof grantSchema>

// Pure: the one command a grant's Approve runs: macOS's open, at the pane the preview names.
export const grantArgv = (preview: InboxGrant): string[] => [
  "/usr/bin/open",
  `x-apple.systempreferences:com.apple.preference.security?${GRANT_PANES[preview.permission]}`,
]

// Runs an argv with no shell and returns its exit code and output; run-argv.ts holds the real one, and a test passes its own.
export type ArgvRun = (argv: string[]) => Promise<{ code: number; err: string; out: string }>

// An app's name as the owner's list holds it: a letter or digit of any script first, then letters, digits, spaces and . _ & ' ( ) + -, so none starts as a flag or names a path.
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._&'()+-]*$/u

// A change to the owner's own apps, which the owner approves from the Inbox in place of a terminal: the app to add or remove, and why.
const appsSchema = z.strictObject({
  app: z.string().trim().min(1).max(LIMITS.name).regex(APP_NAME, "Must be an app's name"),
  change: z.enum(["add", "remove"]),
  type: z.literal("apps"),
  why: words,
})

export type InboxApps = z.infer<typeof appsSchema>

// Pure: the one command an apps change's Approve runs, as `playground ext <args>` with the new list on its stdin: a put of the login's own list, with a reason naming the item.
export const appsArgs = (login: string, ref: number): string[] => [
  "put",
  login,
  "list",
  OWNER_APPS,
  "-",
  "--reason",
  `the owner approved it in the Inbox (${itemTag(ref)})`,
]

// Pure: an app's name as the hook's appName matches it (no-desktop-owner-app.ts): its last path part, without .app, edge spaces or case.
const appKey = (name: string): string =>
  (name.split("/").filter(Boolean).pop() ?? "")
    .replace(/\.app$/i, "")
    .trim()
    .toLowerCase()

// One apps change at a time in this process: each reads the whole list and puts it back with no base rev, so a second Approve waits and reads the list the first wrote.
let appsQueue: Promise<unknown> = Promise.resolve()
const oneAppsChange = <T>(change: () => Promise<T>): Promise<T> => {
  const next = appsQueue.then(change, change)
  appsQueue = next.catch(() => undefined)
  return next
}

// Pure: the owner's own list after the change, or the result when there is nothing to write: an app already on it, or one to remove that it does not hold.
export const appsChange = (list: string[], preview: InboxApps): { list: string[] } | RunResult => {
  const held = list.some((name) => appKey(name) === appKey(preview.app))
  if (preview.change === "add")
    return held
      ? { exitCode: 0, line: `${preview.app} is on your apps already` }
      : { list: [...list, preview.app] }
  return held
    ? { list: list.filter((name) => appKey(name) !== appKey(preview.app)) }
    : { exitCode: 1, line: `${preview.app} is not on your own apps list, so nothing changed` }
}

// The owner's own apps list and the CLI that writes it: the login's scope, its list as accepted (empty when it has none, null when it is not a list of names), and `playground ext`. store/extensions.ts's ownerApps is the real one.
export type OwnerApps = { login: string; read: () => string[] | null; run: ExtRun }

// A registry job's setting key, which a guard decision turns on or off by its enabled field alone, or gives a new config object alone, so its command, schedule and runtime still come from the registry; core checks a config only for being an object, and the job checks each field itself.
const JOB_KEYS = Object.keys(JOBS).map(jobKey)
const jobPart = z.union([
  z.strictObject({ enabled: z.boolean() }),
  z.strictObject({ config: z.record(z.string(), z.unknown()) }),
])
// An org's own job's setting key, jobs.<camelName> for a job the registry lacks, whose whole row a guard decision places, or whose enabled field or config alone it changes over the row its scope holds; the write checks the row against the org's script folders
const orgJobKeySchema = z
  .string()
  .regex(/^jobs\.[a-z][A-Za-z0-9]*$/)
  .refine(orgJobKey)

// A guard setting the owner sets from the Inbox in place of a terminal: a key a guard reads (GUARD_SETTING_KEYS), a registry job's or an org's own job's, the scope it is written at (the owner's login or an org; core changes by a pull request), and the value its key's schema takes (a job's enabled field alone or its config alone, or an org's own job's whole row, which the write checks against that org's script folders), or none to take it back to its default. The card shows all three as Approve writes them, so a value its key refuses is refused when it is posted.
const guardSchema = z
  .strictObject({
    key: z.union([z.enum(GUARD_SETTING_KEYS), z.enum(JOB_KEYS), orgJobKeySchema]),
    scope: extScopeSchema,
    type: z.literal("guard"),
    value: z.unknown().optional(),
    why: words,
  })
  .superRefine((preview, ctx) => {
    if (preview.value === undefined) return
    if (JOB_KEYS.includes(preview.key) && !jobPart.safeParse(preview.value).success) {
      const message = `${preview.key} takes its enabled field alone, {"enabled": true} or {"enabled": false}, or its config alone, {"config": {...}}: its command, schedule and runtime come from the registry`
      ctx.addIssue({ code: "custom", message, path: ["value"] })
      return
    }
    if (orgJobKey(preview.key)) {
      if (jobPart.safeParse(preview.value).success) return
      const parsed = jobSchema.safeParse(preview.value)
      if (!parsed.success)
        ctx.addIssue({
          code: "custom",
          message: `${preview.key} takes its enabled field alone, its config alone or a whole job row: ${z.prettifyError(parsed.error).replaceAll("\n", " ")}`,
          path: ["value"],
        })
      return
    }
    const checked = checkSetting(preview.key, preview.value)
    if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.message, path: ["value"] })
  })

export type InboxGuard = z.infer<typeof guardSchema>

// One Claude account's own flag, set or cleared from the Inbox in place of Settings > Accounts' switch: key is the row's email in usage.accounts at scope, own the flag Approve leaves it with. Only that row changes; a key that names no Claude row there is refused as it is posted (ownRefused).
const ownSchema = z.strictObject({
  key: z.email().max(LIMITS.name),
  own: z.boolean(),
  scope: extScopeSchema,
  type: z.literal("own"),
  why: words,
})

export type InboxOwn = z.infer<typeof ownSchema>

const ACCOUNTS = "usage.accounts"

// usage.accounts as it is stored at one scope: undefined when that scope sets none.
const accountsAt = (data: string, scope: string): unknown =>
  readSetting(data, ACCOUNTS)?.rows.find((row) => row.scope === scope)?.value

// Pure: the Claude row with this email in a stored usage.accounts value, or undefined.
const claudeRow = (value: unknown, key: string): Record<string, unknown> | undefined =>
  Array.isArray(value)
    ? (value as Record<string, unknown>[]).find(
        (row) => (row.provider ?? "claude") === "claude" && row.email === key,
      )
    : undefined

// Runs a sink's argv with the value on its stdin and returns its exit code: null once stopped by a signal (its time limit's included), 127 when it could not start. secret-sink.ts holds the real one; a test passes its own.
export type SinkRun = (argv: string[], stdin: string) => Promise<number | null>

// Saves the value as one allowlisted Keychain item, throwing on a refusal; secret-sink.ts holds the real one, and a test passes its own.
export type KeychainSave = (item: string, value: string) => Promise<void>

// Reads one allowlisted Keychain item's value, null when it holds none of its shape; secret-sink.ts holds the real one, and a test passes its own.
export type KeychainRead = (item: string) => Promise<string | null>

const OPTIONS_MESSAGE = `An ask offers 1 to ${MAX_OPTIONS} options, each with a label: one for a yes or no, two or more for lettered choices`

// One ask option: a label and an optional one-line description.
const askOption = z.strictObject({
  description: oneLine(LIMITS.line).optional(),
  label: oneLine(LIMITS.line),
})

// Whose work an ask or an update is about: FACTORY_SCOPE, or an org's name; only a factory card goes to WhatsApp (ADR 0024).
const scope = oneLine(LIMITS.name).optional()

// The most and fewest questions one ask holds.
export const MAX_QUESTIONS = 20
export const MIN_QUESTIONS = 2
const QUESTIONS_MESSAGE = `An ask holds ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions, each with its own ${MAX_OPTIONS}-at-most options`

// One question in a multi-question ask: its own words, its 1-to-5 options in the ask's shape, and an optional recommended option index, marked on the card rather than moved.
const askQuestion = z
  .strictObject({
    options: z.array(askOption).min(1, OPTIONS_MESSAGE).max(MAX_OPTIONS, OPTIONS_MESSAGE),
    question: oneLine(LIMITS.line),
    recommended: z
      .number()
      .int()
      .min(0)
      .max(MAX_OPTIONS - 1)
      .optional(),
  })
  .refine((q) => q.recommended === undefined || q.recommended < q.options.length, {
    error: "An ask question's recommended index is one of its own options",
    path: ["recommended"],
  })

// What Approve does, one shape per kind of approval the owner keeps (playbook's ask rule): an extension accept, an apps change, a grant's System Settings pane, a guard setting or an own account change, which the dashboard carries out itself, a Slack message, a ship of canary, a new Linear ticket, a delete, a schema, a budget, or a plain ask, whose words say what its poster does on Approve, for a decision no other shape fits (a production port, a work request from outside the chain, or a step only he can take, such as plugging in the Mac, where Approve means done and Deny means he can't). An ask labels its options in plain words (the plain-words skill), one line each: one option and deny for a yes or no, or 2 to 5 for lettered choices, A to E, then None of these (choicesOf); the card shows its text as the quoted block above them. A secret asks for a value instead of a yes, which goes straight to its sink and is kept nowhere. A reveal shows the owner a Keychain item's value on the owner's click instead, kept nowhere either.
export const previewSchema = z.discriminatedUnion("type", [
  z.strictObject({
    approve: oneLine(LIMITS.line).optional(),
    attachments,
    checked: oneLine(LIMITS.line).optional(),
    deny: oneLine(LIMITS.line).optional(),
    options: z
      .array(askOption)
      .min(1, OPTIONS_MESSAGE)
      .max(MAX_OPTIONS, OPTIONS_MESSAGE)
      .optional(),
    questions: z
      .array(askQuestion)
      .min(MIN_QUESTIONS, QUESTIONS_MESSAGE)
      .max(MAX_QUESTIONS, QUESTIONS_MESSAGE)
      .optional(),
    scope,
    text: words,
    type: z.literal("ask"),
  }),
  z.strictObject({
    attachments,
    ...place,
    text: words,
    thread: soFar,
    to: oneLine(LIMITS.name),
    type: z.literal("slack"),
  }),
  z.strictObject({
    ...place,
    prs: z
      .array(
        z.strictObject({
          number: z.number().int().positive(),
          title: oneLine(LIMITS.line),
          url: z
            .url({ protocol: /^https$/ })
            .max(2000)
            .optional(),
        }),
      )
      .min(1)
      .max(LIMITS.prs),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/, "Must be a commit SHA"),
    type: z.literal("ship"),
  }),
  z.strictObject({
    body: words,
    ...place,
    team: oneLine(LIMITS.name),
    title: oneLine(LIMITS.line),
    type: z.literal("ticket"),
  }),
  z.strictObject({ type: z.literal("delete"), what: words, why: words }),
  z.strictObject({ shape: words, type: z.literal("schema") }),
  z.strictObject({ amount: oneLine(LIMITS.name), type: z.literal("budget"), why: words }),
  z.strictObject({
    key: z
      .string()
      .max(LIMITS.name)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Must be an environment variable's name"),
    sink: secretSinkSchema,
    type: z.literal("secret"),
  }),
  // shows a Keychain item's value on the owner's click, in that one response alone (revealSecret); it names the item by its full service, so the card shows which one
  z.strictObject({ service: playgroundService, type: z.literal("reveal"), why: words }),
  acceptSchema,
  appsSchema,
  grantSchema,
  guardSchema,
  ownSchema,
])

const link = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .optional()

// A draft's words, who they go to by a short name ("a colleague's thread"), the thread they reply in, which its card links to, and files its card shows, which Send shares into that Slack thread (filesToUpload).
export const draftSchema = z.strictObject({
  attachments,
  ...place,
  text: words,
  thread: soFar,
  to: oneLine(LIMITS.name),
})

// An update is an outcome, never progress: one of these five, so a step or an ETA has no way in. It may show an ask's words and files read-only, for something to look at that asks nothing.
export const OUTCOMES = ["alert", "decision", "finding", "merged", "shipped"] as const

export const updateSchema = z.strictObject({
  // a page the owner approves on in the browser, where a session never can: a pending Yard post's approve page
  approve: link,
  attachments,
  link,
  outcome: z.enum(OUTCOMES),
  scope,
  text: words.optional(),
})

const base = { from: oneLine(64), title: oneLine(LIMITS.line) }

// What a poster sends ask: a decision when kind is left out, as every ask was.
export const inboxInputSchema = z
  .preprocess(
    (value) =>
      value && typeof value === "object" && !("kind" in value)
        ? { ...value, kind: "decision" }
        : value,
    z.discriminatedUnion("kind", [
      z.strictObject({ ...base, kind: z.literal("decision"), preview: previewSchema }),
      z.strictObject({ ...base, kind: z.literal("draft"), preview: draftSchema }),
      z.strictObject({ ...base, kind: z.literal("update"), preview: updateSchema }),
    ]),
  )
  .refine((input) => !ARCHIVES.test(JSON.stringify(input)), { error: archivesMessage })
  .refine((input) => !MENTION_TOKEN.test(JSON.stringify(input)), MENTION_MESSAGE)
  .refine(
    (input) => !namesPlace(input) || "link" in input.preview !== "noLink" in input.preview,
    "A draft, or a slack, ship or ticket decision, names where it lands: preview.link, or preview.noLink with why there is none yet",
  )
  .refine((input) => {
    if (input.kind !== "decision" || input.preview.type !== "ask") return true
    const { approve, checked, deny, options = [], text } = input.preview
    const said = options.flatMap((option) => [option.label, option.description])
    return (
      checked !== undefined ||
      !TAKES_DOWN.test(
        [input.title, text, approve, deny, ...said].join("\n").replace(PASSING_MENTION, ""),
      )
    )
  }, TAKES_DOWN_MESSAGE)
  .refine(
    (input) =>
      input.kind !== "decision" ||
      input.preview.type !== "ask" ||
      !(input.preview.approve && input.preview.options),
    "An ask labels its go row in options or in approve, not both",
  )
  .refine(
    (input) =>
      input.kind !== "decision" ||
      input.preview.type !== "ask" ||
      !(
        input.preview.questions &&
        (input.preview.options || input.preview.approve || input.preview.deny)
      ),
    "An ask holds either a single question's options, approve or deny, or a questions list, not both",
  )
  .superRefine((input, ctx) => {
    const text =
      input.kind === "draft"
        ? input.preview.text
        : input.kind === "decision" && input.preview.type === "slack"
          ? input.preview.text
          : null
    const word = text === null ? null : ownerVoiceWord(text)
    if (word) {
      ctx.addIssue({
        code: "custom",
        message: `${OWNER_VOICE_MESSAGE}. Found "${word}"; rewrite it in the first person singular and post again`,
      })
    }
  })

// Pure: whether an item's preview names a place it lands, so it carries a link or a noLink.
function namesPlace(input: { kind: string; preview: object }): boolean {
  if (input.kind === "draft") return true
  const type = input.kind === "decision" && "type" in input.preview ? input.preview.type : null
  return (PLACED_TYPES as readonly unknown[]).includes(type)
}

// The decisions whose preview names where they land.
export const PLACED_TYPES = ["ship", "slack", "ticket"] as const

export type InboxInput = z.input<typeof inboxInputSchema>
export type InboxKind = "decision" | "draft" | "update"
export type InboxPreview = z.infer<typeof previewSchema>
export type InboxDraft = z.infer<typeof draftSchema>
export type InboxUpdate = z.infer<typeof updateSchema>
export type InboxStatus =
  | "approved"
  | "cleared"
  | "denied"
  | "discarded"
  | "done"
  | "drafted"
  | "open"
  | "provided"
  | "sent"

export const ACTIONS = [
  "approve",
  "archive",
  "clear",
  "deny",
  "discard",
  "dismiss",
  "draft",
  "edit",
  "send",
  "unarchive",
] as const
export type InboxAction = (typeof ACTIONS)[number]
// What an answer holds: every action but Archive and Move back, which answer nothing, and Dismiss, which a waiting item records as clear.
export type InboxChoice = Exclude<InboxAction, "archive" | "dismiss" | "unarchive">

// ackedAt: when its poster closed it through bun run ask, so the sweep stops chasing it; accepted, listed, opened, owned and set: what the dashboard ran on an accept's, an apps change's, a grant's, an own card's and a guard setting's Approve gave; dismissedAt: when he dismissed the answered item or its poster closed it, which moves it to Done at once; noLink: why a go closed with no link; uploaded: how many files a Slack send shared into its channel and thread, so a retry shares none twice.
export type InboxAnswer = {
  accepted?: RunResult
  ackedAt?: string
  at: string
  choice: InboxChoice
  dismissed?: true
  dismissedAt?: string
  editedText?: string
  link?: string
  linkLabel?: string
  listed?: RunResult
  noLink?: string
  note?: string
  opened?: RunResult
  option?: number
  options?: number[]
  owned?: RunResult
  set?: RunResult
  uploaded?: number
  // where the owner answered when not on the card: whatsapp, his reply naming the card's id there (whatsapp-answer.ts)
  via?: "whatsapp"
}

// What a run the dashboard carried out on Approve gave: its exit code and the line it printed, the result or why it was refused.
export type RunResult = { exitCode: number; line: string }

// Pure: a run as a result: its exit code, and its first line, its error when it failed, cut to a line.
export const runResult = (ran: { code: number; err: string; out: string }): RunResult => {
  const line = ((ran.code === 0 ? ran.out : ran.err || ran.out).split("\n")[0] ?? "").trim()
  return {
    exitCode: ran.code,
    line: line.length > LIMITS.line ? `${line.slice(0, LIMITS.line - 1)}…` : line,
  }
}

// Pure: a go, an answer he gave to carry out (Approve, Edit, Send, Draft), which closes only with where it landed or why there is no link.
export const isGo = (choice: string): boolean => (GO_CHOICES as readonly string[]).includes(choice)

export const GO_CHOICES = ["approve", "draft", "edit", "send"] as const

// Pure: whether a draft can be saved as a draft in its app: Slack's own MCP server saves one (slack_send_message_draft), while Linear's API has no mutation that creates a Draft, so a Linear comment, named by its link's host as the card names it, is only sent or discarded.
export const savesDraft = (preview: InboxDraft): boolean => {
  try {
    return !preview.link || new URL(preview.link).hostname !== "linear.app"
  } catch {
    return true
  }
}

// The poster closed its own open item, having decided it another way (`bun run ask settle`): the owner gave no answer, so nothing is delivered.
export type InboxSettled = {
  at: string
  by: string
  choice: "settled"
  dismissed?: true
  dismissedAt?: string
  link?: string
  linkLabel?: string
  note?: string
}

// An update takes no answer, so its answer holds only when he sent it to Done, with dismissed when that was his Dismiss rather than his Done.
export type InboxDismissed = { dismissed?: true; dismissedAt: string }

// A reply he sent in chat naming the item (`re #iN`): when, and his words after the tag, so the card says what is being done; its poster's close adds where that landed, and his Dismiss when he cleared it.
export type InboxReplied = {
  ackedAt?: string
  at: string
  choice: "replied"
  dismissed?: true
  dismissedAt?: string
  link?: string
  linkLabel?: string
  said?: string
}

// how much of a reply the card keeps, a line or two
const SAID_CHARS = 280

// Pure: a reply's words without its `re #iN` tag and the colon after it, cut to SAID_CHARS; undefined when nothing is left.
export const saidOf = (text: string): string | undefined => {
  const said = text
    .replace(/\bre #i\d{1,9}\b:?/i, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!said) return undefined
  return said.length > SAID_CHARS ? `${said.slice(0, SAID_CHARS - 1)}…` : said
}

// The poster cleared its own update (`bun run ask resolve`), which had settled: read, so nothing was left for the owner to dismiss.
export type InboxResolved = {
  at: string
  by: string
  choice: "resolved"
  dismissed?: true
  dismissedAt?: string
  note?: string
}

// A secret ask he answered with its value, which went to its sink and is kept nowhere: when, and each environment's exit status (null: stopped by a signal), written once the sink has run; its poster's read closes it.
export type InboxProvided = {
  ackedAt?: string
  at: string
  choice: "provided"
  dismissed?: true
  dismissedAt?: string
  link?: string
  linkLabel?: string
  results?: SinkResult[]
}

// line: what the card shows in place of the exit status, "saved" or a refusal's first line, never the value
export type SinkResult = { environment: string; exitCode: number | null; line?: string }

// An open decision or draft, or an update, he pushed out of his list until a time (Schedule); it asks again once the time passes.
export type InboxScheduled = { snoozedUntil: string }

// An open decision or draft, or an update, he archived: out of his list and its count, unanswered, its poster told nothing and still waiting, until he moves it back, puts it off until a time or dismisses it.
export type InboxArchived = { archivedAt: string }

// How the answer reached its poster, or the dispatcher when the poster had ended: typed into a session (to: the session that took it, absent on a row from before it was recorded), or read through bun run ask. queued: Claude Code holds it until the session is free (deliver.ts's QUEUED), under the delivery's id, which the dashboard reads again until it reads delivered, or failed as LOST.
export type InboxDelivery =
  | { status: "pending" }
  | { at: string; id: string; status: "queued"; to: string }
  | { at: string; status: "delivered"; to?: string; via: "cli" | "session" }
  | { code: string; reason: string; status: "failed" }

type Common = {
  createdAt: string
  delivery: InboxDelivery | null
  from: string
  id: string
  readAt: string | null
  ref: number
  status: InboxStatus
  title: string
  updatedAt: string
  version: number
}

type Answered = {
  answer:
    | InboxAnswer
    | InboxArchived
    | InboxProvided
    | InboxReplied
    | InboxScheduled
    | InboxSettled
    | null
}

export type InboxItem =
  | (Common & Answered & { kind: "decision"; preview: InboxPreview })
  | (Common & Answered & { kind: "draft"; preview: InboxDraft })
  | (Common & {
      answer: InboxArchived | InboxDismissed | InboxResolved | InboxScheduled | null
      kind: "update"
      preview: InboxUpdate
    })

// The list the dashboard shows, in the order it shows it, and the count on its Inbox tab; snoozed: the open items and updates put away until a time still ahead, and archived: those he archived, each kept out of items, which every reader takes as awake, for the Inbox's Later and Archive shelves alone; quiet: the ids of the items in the list that came in while focus stands, which the count, the Inbox square and the tab's dot leave out until it ends.
export type InboxList = {
  items: InboxItem[]
  archived: InboxItem[]
  count: number
  quiet: string[]
  snoozed: InboxItem[]
}

// What the dashboard posts for an item: the action, the words that go with Edit or with a draft changed before Send or Draft, and seen, the updatedAt of the card he answered, so an answer never lands on words its poster edited after he read them.
export const answerInputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  note: z.string().trim().max(LIMITS.text).optional(),
  option: z
    .number()
    .int()
    .min(0)
    .max(MAX_OPTIONS - 1)
    .optional(),
  options: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(MAX_OPTIONS - 1),
    )
    .min(MIN_QUESTIONS)
    .max(MAX_QUESTIONS)
    .optional(),
  seen: z.iso.datetime().optional(),
  text: z.string().trim().max(LIMITS.text).optional(),
})

export type AnswerInput = z.input<typeof answerInputSchema>

// The delivery adapter's contract, deliver() in deliver.ts, restated since this file cannot resolve the API's @/ paths; routers/inbox.ts passes deliver() as a Deliver, so the compiler fails if the two drift apart. It throws only when it cannot write its activity row, which may come after the Enter.
export type Delivery = {
  actor: ActivityActor
  id?: string
  queuedAt?: string
  text: string
  to: string
}
export type DeliveryResult =
  | { at: string; ok: true; sessionId: string }
  | { code: string; ok: false; queuedAt?: string; reason: string }
export type Deliver = (delivery: Delivery) => Promise<DeliveryResult>

export type InboxFailure = { code: "CONFLICT" | "NOT_FOUND" | "VALIDATION_ERROR"; message: string }
type Refused = { ok: false } & InboxFailure

export const zodMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ")

// The short id an item goes by, in the list, in a reply and in bun run ask get.
export const itemTag = (ref: number): string => `#i${ref}`

const REF_RE = /^#?i(\d{1,9})$/

// A reply names the item it is about (`re #iN`), typed by the card's Reply or in his chat; the web's TYPED holds the same pattern, and a test holds the two equal.
export const REPLY_RE = /\bre #i(\d{1,9})\b/i

// An item's fields, kept apart by kind, so a preview reads as its own kind's.
type Shape<K extends keyof Common | "kind" | "preview"> = {
  [Kind in InboxKind]: Pick<Extract<InboxItem, { kind: Kind }>, K>
}[InboxKind]

// Pure: what an action makes of an item, or why it does not fit: a decision is approved (Edit approves it with his words), denied, cleared (Archive, set aside as neither) or nothing else; a draft is sent or, for a Slack draft, saved as a draft in Slack, each as it was or as he changed it, or discarded; an update is only read.
export function checkAnswer(
  item: Shape<"kind" | "preview" | "status">,
  input: AnswerInput,
): { answer: Omit<InboxAnswer, "at">; status: InboxStatus } | { message: string } {
  const parsed = answerInputSchema.safeParse(input)
  if (!parsed.success) return { message: zodMessage(parsed.error) }
  const checked = answerOf(item, parsed.data)
  // his note, typed in the card's last box, goes with whatever he answers
  const { note } = parsed.data
  return note && "answer" in checked ? { ...checked, answer: { ...checked.answer, note } } : checked
}

function answerOf(
  item: Shape<"kind" | "preview" | "status">,
  { action, option, options, text }: AnswerInput,
): { answer: Omit<InboxAnswer, "at">; status: InboxStatus } | { message: string } {
  if (item.kind === "update") return { message: "An update is read, not answered" }
  if (item.status !== "open") return { message: "This item is already answered" }
  if (option !== undefined && !(item.kind === "decision" && action === "approve")) {
    return { message: "Only a decision's go picks an option" }
  }
  if (
    option !== undefined &&
    item.kind === "decision" &&
    item.preview.type === "ask" &&
    !!item.preview.questions
  ) {
    return {
      message: "A multi-question ask's approve names a pick for each question, not a single option",
    }
  }
  if (
    options !== undefined &&
    !(
      item.kind === "decision" &&
      action === "approve" &&
      item.preview.type === "ask" &&
      !!item.preview.questions
    )
  ) {
    return { message: "Only a multi-question ask's approve names a pick for each question" }
  }
  // Dismiss on what still waits sets it aside as the old `clear` did, its poster told so, and sends it to Done; a secret ask takes it too, since no value travels
  if (action === "dismiss") return { answer: { choice: "clear" }, status: "cleared" }
  if (item.kind === "decision") {
    if (item.preview.type === "secret") {
      return { message: "A secret ask takes its value through its Submit alone" }
    }
    // a multi-question ask is approved with one pick for each of its questions, each within that question's options, and denied or set aside as a whole
    if (item.preview.type === "ask" && item.preview.questions) {
      const questions = item.preview.questions
      if (action === "clear") return { answer: { choice: "clear" }, status: "cleared" }
      if (action === "deny") return { answer: { choice: "deny" }, status: "denied" }
      if (
        action !== "approve" ||
        options === undefined ||
        options.length !== questions.length ||
        options.some((pick, at) => pick >= questions[at]!.options.length)
      ) {
        return { message: `Pick one of each of its ${questions.length} questions` }
      }
      return { answer: { choice: "approve", options }, status: "approved" }
    }
    // a lettered decision's go names which of its go rows the owner picked, and takes no Edit, which names none; a yes or no has one
    const go = choicesOf(item.preview)?.rows.filter((row) => row.go).length ?? 1
    if (
      (action === "approve" && (option !== undefined || go > 1)) ||
      (action === "edit" && go > 1)
    ) {
      return action === "approve" && option !== undefined && option < go
        ? { answer: { choice: action, option }, status: "approved" }
        : {
            message:
              go > 1
                ? `Pick one of its ${go} options, 0 to ${go - 1}`
                : "A yes or no has one option, 0",
          }
    }
    if (item.preview.type === "accept" && action === "edit") {
      return { message: "An accept is approved or denied as its proposal reads" }
    }
    if (
      (item.preview.type === "apps" ||
        item.preview.type === "grant" ||
        item.preview.type === "guard" ||
        item.preview.type === "own" ||
        item.preview.type === "reveal") &&
      action === "edit"
    ) {
      return { message: "This decision is approved or denied as it reads" }
    }
    // Clear: neither a yes nor a no; he has set the talk aside and will pick it up later, while whatever is already moving keeps moving
    if (action === "clear") return { answer: { choice: action }, status: "cleared" }
    if (action === "approve") return { answer: { choice: action }, status: "approved" }
    if (action === "deny") return { answer: { choice: action }, status: "denied" }
    if (action === "edit") {
      return text
        ? { answer: { choice: action, editedText: text }, status: "approved" }
        : { message: "Edit takes the words to change it with" }
    }
    return { message: "A decision is approved, denied, edited or cleared" }
  }
  if (action === "clear") return { answer: { choice: action }, status: "cleared" }
  if (action === "discard") return { answer: { choice: action }, status: "discarded" }
  if (action === "draft" && !savesDraft(item.preview)) {
    return { message: "Linear has no draft API, so this draft is sent or discarded" }
  }
  if (action === "send" || action === "draft") {
    if (text === "") return { message: "A draft cannot be empty" }
    const changed = text !== undefined && text !== item.preview.text
    return {
      answer: changed ? { choice: action, editedText: text } : { choice: action },
      status: action === "send" ? "sent" : "drafted",
    }
  }
  return { message: "A draft is sent, saved as a draft, discarded or cleared" }
}

// The option the owner picked, as the card lettered and labelled it (rowOfAnswer, which the result line reads too).
function optionOf(item: InboxItem, answer: { choice: string; option?: number }) {
  const row = item.kind === "decision" ? rowOfAnswer(item.preview, answer) : null
  return row ? { index: row.index, label: row.label, letter: row.letter } : undefined
}

// The pick the owner made in each question of a multi-question ask, as the card lettered and labelled them (picksOf), for the poster's payload.
function picksFor(item: InboxItem, options: number[]) {
  return item.kind === "decision" ? (picksOf(item.preview, options) ?? undefined) : undefined
}

// Pure: the option an approved or denied decision's answer picked, as its letter and label, for bun run ask get; null for any other item or answer.
export function pickOf(item: InboxItem): { index: number; label: string; letter: string } | null {
  if (item.kind !== "decision" || !item.answer || !("choice" in item.answer)) return null
  const { choice } = item.answer
  if (choice !== "approve" && choice !== "deny") return null
  return optionOf(item, item.answer) ?? null
}

// Pure: the pick line bun run ask get prints on stderr: a multi-question answer's pick for each question (picksOf), joined; else a single approve or deny's one letter and label (pickOf); null when the answer names no pick.
export function getPickLine(item: InboxItem): string | null {
  if (
    item.kind === "decision" &&
    item.answer &&
    "choice" in item.answer &&
    item.answer.choice === "approve" &&
    "options" in item.answer &&
    item.answer.options
  ) {
    const picks = picksOf(item.preview, item.answer.options)
    return picks?.length ? picks.map((p) => `${p.letter}: ${p.label}`).join(" · ") : null
  }
  const single = pickOf(item)
  return single ? `${single.letter}: ${single.label}` : null
}

// The ask CLI a close line names: a live-reads test stack's own checkout's, since its test items sit in its own database and a probe must never close the live Inbox's item of that number; else playground ask, which runs in the Dashboard's checkout from any folder.
export const askCli = (
  source: DashboardSource = currentSource(),
  root: string | null = checkoutRoot(),
): string =>
  source.kind === "live" && source.rule === "live-reads" && root
    ? `bun run --cwd ${root} ask`
    : "playground ask"

// Pure: what an answer tells its poster, as data: the verb, whether to carry it out, the next step and the exact command that closes the item; the owner's comment in his words, a changed draft's text, a step's or a secret sink's results, never a secret's value; an update takes no answer.
export function answerPayload(
  item: InboxItem,
  answer: InboxAnswer | InboxProvided,
  ask = "playground ask",
): AnswerPayload {
  if (item.kind === "update") throw new Error("An update takes no answer")
  const tag = itemTag(item.ref)
  const ack = `${ask} ack ${tag} --link <https url>`
  const ackOrWhy = `${ack}, or --no-link "<why>" when it leaves no page`
  const read = `${ask} get ${tag} --ack`
  const head = {
    at: answer.at,
    id: item.id,
    kind: item.kind,
    ref: tag,
    title: item.title,
    ...(item.kind === "decision" && { type: item.preview.type }),
    v: 1 as const,
  }
  if (answer.choice === "provided") {
    return {
      ...head,
      close: read,
      go: true,
      next: "close",
      results: answer.results ?? [],
      verb: "submit",
    }
  }
  const comment = answer.note ? { comment: answer.note } : {}
  const text = answer.editedText ? { text: answer.editedText } : {}
  switch (answer.choice) {
    case "approve":
    case "edit":
      // a step the dashboard ran on Approve leaves only its close, and a grant's recheck once its pane opened (asks.md)
      if (answer.accepted || answer.listed || answer.opened || answer.owned || answer.set) {
        const ran = answer.accepted
          ? { accepted: answer.accepted }
          : answer.listed
            ? { listed: answer.listed }
            : answer.owned
              ? { owned: answer.owned }
              : answer.set
                ? { set: answer.set }
                : { opened: answer.opened! }
        return {
          ...head,
          ...comment,
          ...ran,
          close: `${ask} ack ${tag} --no-link "<why>"`,
          go: true,
          next: answer.opened?.exitCode === 0 ? "carry-out" : "nothing",
          option: optionOf(item, answer),
          verb: "pick",
        }
      }
      return {
        ...head,
        ...comment,
        ...text,
        close: "link" in item.preview ? ack : ackOrWhy,
        go: true,
        next: "carry-out",
        ...(answer.options
          ? { picks: picksFor(item, answer.options) }
          : { option: optionOf(item, answer) }),
        verb: "pick",
      }
    case "deny":
      return {
        ...head,
        ...comment,
        close: read,
        go: false,
        next: "close",
        option: optionOf(item, answer),
        verb: "pick",
      }
    case "clear":
      return { ...head, ...comment, close: read, go: false, next: "close", verb: "set-aside" }
    case "discard":
      return { ...head, ...comment, close: read, go: false, next: "close", verb: "discard" }
    case "send":
      return { ...head, ...comment, ...text, close: ack, go: true, next: "carry-out", verb: "send" }
    case "draft": {
      const converter = slack("slack.linkConverter")
      return {
        ...head,
        ...comment,
        ...text,
        close: ackOrWhy,
        go: true,
        ...(converter && { linkConverter: converter }),
        next: "carry-out",
        verb: "draft",
      }
    }
  }
}

// Pure: what the owner's Dismiss on an answered card, or Done or Dismiss on an update, tells its poster: drop it. A card its poster has not closed names how to close it (a go with why it has no link, a reply by its ack, anything else by reading it), and an update, which the owner closed, takes no more edits.
export function closedPayload(
  item: InboxItem,
  verb: "dismiss" | "done",
  at: string,
  ask = "playground ask",
): AnswerPayload {
  const tag = itemTag(item.ref)
  const head = {
    at,
    go: false,
    id: item.id,
    kind: item.kind,
    ref: tag,
    title: item.title,
    ...(item.kind === "decision" && { type: item.preview.type }),
    v: 1 as const,
    verb,
  }
  const answer = item.answer
  if (
    item.kind === "update" ||
    !answer ||
    !("choice" in answer) ||
    ("ackedAt" in answer && answer.ackedAt)
  ) {
    return { ...head, next: "nothing" }
  }
  const close = isGo(answer.choice)
    ? `${ask} ack ${tag} --no-link "<why>"`
    : answer.choice === "replied"
      ? `${ask} ack ${tag}`
      : `${ask} get ${tag} --ack`
  return { ...head, close, next: "close" }
}

// Tells a poster the owner closed its card (closedPayload), recording how that went as an answer's delivery is; an update's poster that has ended is told nothing, since nothing waits on it, and a card its poster already closed or the owner already sent to Done types nothing again.
async function tellClosed(
  db: Database,
  item: InboxItem,
  verb: "dismiss" | "done",
  before: InboxItem,
  telling?: Telling,
): Promise<InboxItem> {
  if (!telling) return item
  const answer = before.answer
  if (answer && "ackedAt" in answer && answer.ackedAt) return item
  if (before.kind === "update" && answer && "dismissedAt" in answer && answer.dismissedAt)
    return item
  if (
    answer &&
    "choice" in answer &&
    (answer.choice === "resolved" || answer.choice === "settled")
  ) {
    return item
  }
  const payload = closedPayload(item, verb, telling.now.toISOString(), askCli())
  return send(
    db,
    item,
    {
      relay: answerLine({ ...payload, relay: { for: item.from, why: "poster-ended" } }),
      text: answerLine(payload),
    },
    { ...telling, dispatcher: item.kind === "update" ? undefined : telling.dispatcher },
  )
}

type Telling = Omit<Sending, "upload">

// Pure: the one line typed into a session for an answer: ANSWER_LEAD, then the payload as JSON, whose escaped line ends keep it one line.
export const answerLine = (payload: AnswerPayload): string =>
  `${ANSWER_LEAD} ${JSON.stringify(answerPayloadSchema.parse(payload))}`

// Pure: the line for the poster and, once it has ended, the same line for the dispatcher with relay set, which reads the item's preview with playground ask get.
const textsOf = (
  item: InboxItem,
  answer: InboxAnswer | InboxProvided,
): { relay: string; text: string } => {
  const payload = answerPayload(item, answer, askCli())
  return {
    relay: answerLine({ ...payload, relay: { for: item.from, why: "poster-ended" } }),
    text: answerLine(payload),
  }
}

// Pure: an answer that did not reach its poster, which asks him to retry it or dismiss it.
export const deliveryFailed = (item: InboxItem): boolean =>
  item.kind !== "update" &&
  item.delivery?.status === "failed" &&
  !(item.answer && "dismissedAt" in item.answer && item.answer.dismissedAt)

// The delivery failures that come before anything is typed (deliver.ts's DELIVERY_FAILURES says which, and UPLOAD_FAILED, a Slack send's files refused before its words), and LOST, an answer Claude Code held that neither its screen nor its transcript shows QUEUED_MS on, so Retry cannot type the answer twice; after any other (INTERRUPTED, or ERROR when the adapter threw) the answer may be in the session already, so its card offers Check it for me.
export const RETRY_CODES = [
  "INPUT_NOT_EMPTY",
  "LOST",
  "NOT_FOUND",
  "ON_PICKER",
  "SESSIONS_FAILED",
  "UPLOAD_FAILED",
] as const

// How long an answer reads queued before its card offers Retry: deliver.ts's QUEUED_MS, by which its follow-up reads it delivered or lost, and a minute more, so a card still queued then lost its follow-up to an API restart (a test holds the two apart by that minute).
export const STUCK_QUEUED_MS = 11 * 60_000

// Pure: an answer still reading queued STUCK_QUEUED_MS after it was queued, whose follow-up has gone.
export const stuckQueued = (item: InboxItem, now: Date): boolean =>
  item.delivery?.status === "queued" &&
  now.getTime() - Date.parse(item.delivery.at) >= STUCK_QUEUED_MS

// Pure: a failed answer he has not dismissed whose failure Retry can safely follow, or a stuck queued one, whose Retry reads it again under its own id and types nothing while Claude Code still holds it.
export const retryable = (item: InboxItem, now = new Date()): boolean =>
  (deliveryFailed(item) &&
    item.delivery?.status === "failed" &&
    (RETRY_CODES as readonly string[]).includes(item.delivery.code)) ||
  stuckQueued(item, now)

// Where a Slack send's files go: the conversation, and the thread's parent message when it replies in one.
export type UploadPlace = { channel: string; thread?: string }

// Shares an answered item's files into the place its link names (dm upload, run where the Slack token lives, given the item's id alone) and says how many it shared, throwing why when Slack refuses any step; slack-upload.ts holds the real one, a test passes its own.
export type Upload = (item: InboxItem) => Promise<number>

const CONVERSATION = /^[CDG][A-Z0-9]+$/

// Pure: the place a Slack link in its app form names (https://app.slack.com/client/<team>/<conversation>, then /thread/<conversation>-<ts> for a thread), its query and hash aside; null for no link, a link outside Slack, one naming no conversation, or a path past the conversation that is not one parsed thread, so a file never lands outside the thread its reply goes to.
export function slackPlace(link: string | undefined): UploadPlace | null {
  if (!link || !URL.canParse(link)) return null
  const url = new URL(link)
  if (url.protocol !== "https:" || url.hostname !== "app.slack.com") return null
  const [, client, team, channel, ...rest] = url.pathname.replace(/\/$/, "").split("/")
  if (client !== "client" || !team || !channel || !CONVERSATION.test(channel)) return null
  if (rest.length === 0) return { channel }
  const [word, parent, ...more] = rest
  const thread = new RegExp(`^${channel}-(\\d+\\.\\d+)$`).exec(parent ?? "")?.[1]
  return word === "thread" && thread && more.length === 0 ? { channel, thread } : null
}

// Pure: the files a go shares into Slack before its words reach the poster: a Slack draft's on Send, or a slack decision's on Approve or Edit, when its link names a Slack place and it has shared none yet; null for anything else, whose files stay on the card.
export function filesToUpload(
  item: InboxItem,
): { files: InboxAttachment[]; place: UploadPlace } | null {
  const answer = item.answer
  if (!answer || !("choice" in answer) || ("uploaded" in answer && answer.uploaded !== undefined))
    return null
  const preview = item.preview
  const go =
    item.kind === "draft"
      ? answer.choice === "send"
      : item.kind === "decision" &&
        "type" in preview &&
        preview.type === "slack" &&
        (answer.choice === "approve" || answer.choice === "edit")
  if (!go || !("attachments" in preview) || !preview.attachments?.length) return null
  const place = slackPlace("link" in preview ? preview.link : undefined)
  return place && { files: preview.attachments, place }
}

// Pure: when an open item or an update is scheduled to ask again, while that time is still ahead; null once it is awake, and on anything not scheduled.
export const snoozedUntil = (item: InboxItem, now: Date): string | null => {
  if (item.kind !== "update" && item.status !== "open") return null
  if (!item.answer || !("snoozedUntil" in item.answer)) return null
  return new Date(item.answer.snoozedUntil) > now ? item.answer.snoozedUntil : null
}

// Pure: when he archived an item he has not dismissed since; null on anything not archived.
export const archivedAt = (item: InboxItem): string | null =>
  item.answer && "archivedAt" in item.answer && !("dismissedAt" in item.answer)
    ? item.answer.archivedAt
    : null

// Pure: whether an item asks of him now rather than at a scheduled later time, or once he moves it back from Archive.
export const awake = (item: InboxItem, now: Date): boolean =>
  snoozedUntil(item, now) === null && archivedAt(item) === null

// Pure: the item's choice once its answer holds one; null before that, a Schedule put-away included, which is awake or asleep by its time alone.
const choiceOf = (item: InboxItem): string | null =>
  item.kind !== "update" && item.answer && "choice" in item.answer ? item.answer.choice : null

const NEEDS_YOU = (item: InboxItem, now: Date): boolean =>
  awake(item, now) &&
  ((item.status === "open" && item.kind !== "update" && choiceOf(item) !== "replied") ||
    deliveryFailed(item))
const UNREAD = (item: InboxItem, now: Date): boolean =>
  item.kind === "update" && item.readAt === null && awake(item, now)

// Pure: the count on the Inbox tab, the open decisions and drafts and the answers that did not reach their poster, plus the unread updates; a scheduled item counts once its time arrives.
export const inboxCount = (items: InboxItem[], now = new Date()): number =>
  items.filter((item) => NEEDS_YOU(item, now) || UNREAD(item, now)).length

// Pure: the ids of the items that came in since focus began, while it stands, which the Inbox holds quiet; an alert update stays loud, since the 5% battery alert or a failed ship cannot wait for focus to end.
export const quietIds = (items: InboxItem[], focus: { since: string } | null): string[] =>
  focus === null
    ? []
    : items
        .filter((item) => Date.parse(item.createdAt) >= Date.parse(focus.since))
        .filter((item) => item.kind !== "update" || item.preview.outcome !== "alert")
        .map((item) => item.id)

// Pure: the list in priority order: what needs him, then unread updates, then everything else, each newest first by when it was posted (#i545); a scheduled item sleeps in with the rest until its time.
export function inboxOrder(items: InboxItem[], now = new Date()): InboxItem[] {
  const rank = (item: InboxItem) => (NEEDS_YOU(item, now) ? 0 : UNREAD(item, now) ? 1 : 2)
  return [...items].sort((a, b) => rank(a) - rank(b) || b.ref - a.ref || a.id.localeCompare(b.id))
}

type Row = typeof inboxItem.$inferSelect

const toItem = (row: Row): InboxItem =>
  ({
    answer:
      (row.answer as
        | InboxAnswer
        | InboxArchived
        | InboxDismissed
        | InboxProvided
        | InboxReplied
        | InboxResolved
        | InboxScheduled
        | InboxSettled
        | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    delivery: (row.delivery as InboxDelivery | null) ?? null,
    from: row.from,
    id: row.id,
    kind: row.kind,
    preview: row.preview,
    readAt: row.readAt?.toISOString() ?? null,
    ref: row.ref,
    status: row.status,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  }) as InboxItem

// Answered and read items stay in the list this long, so an answer is seen landing and then leaves.
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SHOWN = 200

// threadId files the item under a thread (bun run ask new --thread), refused when no thread has it. now stamps createdAt and updatedAt, from the clock every later write stamps with.
export async function postItem(
  db: Database,
  input: unknown,
  threadId?: string,
  now = new Date(),
  settingsData?: string,
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const parsed = inboxInputSchema.safeParse(input)
  if (!parsed.success) {
    return { code: "VALIDATION_ERROR", message: zodMessage(parsed.error), ok: false }
  }
  const unowned = ownRefused(parsed.data, settingsData)
  if (unowned) return unowned
  if (threadId !== undefined) {
    const [found] = await db.select({ id: thread.id }).from(thread).where(eq(thread.id, threadId))
    if (!found) return { code: "NOT_FOUND", message: `no thread ${threadId}`, ok: false }
  }
  const [row] = await db
    .insert(inboxItem)
    .values({
      ...parsed.data,
      createdAt: now,
      status: parsed.data.kind === "update" ? "done" : "open",
      threadId,
      updatedAt: now,
    })
    .returning()
  return { item: toItem(row as Row), ok: true }
}

// An own card refused as it is posted or edited, so the card never offers an Approve that cannot write: no data folder to read, or no Claude row of usage.accounts at its scope with its email (a GLM row's label is never one).
const ownRefused = (
  input: z.infer<typeof inboxInputSchema>,
  data?: string,
): Refused | undefined => {
  if (input.kind !== "decision" || input.preview.type !== "own") return
  const { key, scope } = input.preview
  const message = !data
    ? "This dashboard cannot read usage.accounts, so an own card is refused"
    : claudeRow(accountsAt(data, scope), key)
      ? undefined
      : `${key} is no Claude account in ${ACCOUNTS} at ${scope}`
  return message ? { code: "VALIDATION_ERROR", message, ok: false } : undefined
}

// Pure: an item its poster can no longer edit: done or dismissed by the owner, settled, resolved, or closed by its poster's ack.
const closed = (item: InboxItem): boolean => {
  const answer = item.answer
  if (answer === null) return false
  if ("dismissedAt" in answer && answer.dismissedAt) return true
  if ("ackedAt" in answer && answer.ackedAt) return true
  return "choice" in answer && (answer.choice === "resolved" || answer.choice === "settled")
}

// The poster replaces its own item's title and preview in place (`bun run ask edit`), checked as postItem checks a new one, so one card carries a progress to its end: an update until the owner presses Done or Dismiss or its poster resolves it, and an ask until it closes, answered, archived, put away with Later or replied to alike, an edit to one he replied to taking the reply off so it waits on him again. Another session's item, a change of kind and a closed item are refused.
export async function editItem(
  db: Database,
  key: string,
  input: unknown,
  now = new Date(),
  settingsData?: string,
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const parsed = inboxInputSchema.safeParse(input)
  if (!parsed.success) {
    return { code: "VALIDATION_ERROR", message: zodMessage(parsed.error), ok: false }
  }
  const unowned = ownRefused(parsed.data, settingsData)
  if (unowned) return unowned
  const item = await getItem(db, key)
  if (!item) return NOT_FOUND
  if (parsed.data.from !== item.from) {
    return { code: "CONFLICT", message: `This item was posted by ${item.from}`, ok: false }
  }
  if (parsed.data.kind !== item.kind) {
    return { code: "VALIDATION_ERROR", message: `This item is a ${item.kind}`, ok: false }
  }
  if (closed(item)) {
    return {
      code: "CONFLICT",
      message: "This item is closed: done, dismissed, settled, resolved or closed by its poster",
      ok: false,
    }
  }
  const [row] = await db
    .update(inboxItem)
    .set({
      // an edit answers his reply, so the card waits on him again
      ...(choiceOf(item) === "replied" && { answer: null }),
      preview: parsed.data.preview,
      title: parsed.data.title,
      // past the stamp he read, even inside its millisecond, so an answer whose seen names the old words is refused (answerItem)
      updatedAt: sql`greatest(${now.toISOString()}::timestamptz, ${inboxItem.updatedAt} + interval '1 millisecond')`,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(and(eq(inboxItem.id, item.id), eq(inboxItem.version, item.version)))
    .returning()
  if (!row) {
    return { code: "CONFLICT", message: "This item changed while editing it; try again", ok: false }
  }
  return { item: toItem(row), ok: true }
}

// By its id, or by its tag (#i41, i41), as a person or an agent would name it.
export async function getItem(db: Database, key: string): Promise<InboxItem | null> {
  const ref = REF_RE.exec(key)?.[1]
  const [row] = await db
    .select()
    .from(inboxItem)
    .where(ref ? eq(inboxItem.ref, Number(ref)) : eq(inboxItem.id, key))
  return row ? toItem(row) : null
}

// The name a kept file downloads under: the title of the newest item that carries it, with the file's own name after it when the item carries several, then the stored file's extension; "attachment" in place of the title when no item carries it.
export async function attachmentDownloadName(db: Database, id: string): Promise<string> {
  const [row] = await db
    .select({ preview: inboxItem.preview, title: inboxItem.title })
    .from(inboxItem)
    .where(sql`${inboxItem.preview} -> 'attachments' @> ${JSON.stringify([{ id }])}::text::jsonb`)
    .orderBy(desc(inboxItem.updatedAt))
    .limit(1)
  const files = (row?.preview as { attachments?: InboxAttachment[] } | undefined)?.attachments ?? []
  const own = files.length > 1 ? files.find((file) => file.id === id)?.name : undefined
  const title = own ? `${row?.title}, ${own.replace(/\.[^.]*$/, "")}` : (row?.title ?? "attachment")
  return fileNameOf(title, extname(id).slice(1))
}

// Everything still waiting on him or on a verb, and whatever else moved in the last week; focus, the one standing now (focus.ts), holds what came in since it began quiet.
export async function listItems(
  db: Database,
  now = new Date(),
  focus: { since: string } | null = null,
): Promise<InboxList> {
  const since = new Date(now.getTime() - KEEP_MS)
  // a scheduled item is out of the list and the count until its time, and an archived one until he moves it back or dismisses it
  const awakeSql = sql`((${inboxItem.answer} ->> 'snoozedUntil' is null or (${inboxItem.answer} ->> 'snoozedUntil')::timestamptz <= ${now.toISOString()}::timestamptz) and (${inboxItem.answer} ->> 'archivedAt' is null or ${inboxItem.answer} ->> 'dismissedAt' is not null))`
  const needsYou = or(
    and(
      eq(inboxItem.status, "open"),
      sql`${inboxItem.kind} <> 'update'`,
      // a reply took it off his hands: it waits on its poster closing it
      sql`coalesce(${inboxItem.answer} ->> 'choice', '') <> 'replied'`,
      awakeSql,
    ),
    // coalesced, since a null here would make the rest's not (...) null too and drop every row with no delivery
    sql`coalesce(${inboxItem.delivery} ->> 'status', '') = 'failed' and ${inboxItem.answer} ->> 'dismissedAt' is null`,
  )
  const stopped = CLOCKS_STOPPED_AT
  // since the clocks stopped, a card moves by a verb alone: one answered that its poster has not closed (a go it carries out, a comment it reads) and an update he read and has not sent to Done or dismissed, awake, stay at any age, where one from before keeps the week
  const pending = and(
    sql`not (${needsYou})`,
    sql`${inboxItem.status} <> 'cleared'`,
    or(
      and(
        sql`${inboxItem.kind} <> 'update'`,
        sql`(${inboxItem.answer} ->> 'at')::timestamptz >= ${stopped}::timestamptz`,
        sql`${inboxItem.answer} ->> 'choice' <> 'settled'`,
        sql`${inboxItem.answer} ->> 'ackedAt' is null`,
        sql`${inboxItem.answer} ->> 'dismissedAt' is null`,
      ),
      and(
        eq(inboxItem.kind, "update"),
        sql`${inboxItem.answer} ->> 'dismissedAt' is null`,
        sql`${inboxItem.answer} ->> 'choice' is null`,
        awakeSql,
        sql`${inboxItem.readAt} >= ${stopped}::timestamptz`,
      ),
    ),
  )
  // what needs him and what waits on a verb are never capped, so a pile of unread updates cannot push a decision or a card in hand out of the list or the count; what is put away with Later, the archived and every set-aside (cleared) item not dismissed, however old, come too, for the Inbox's shelves
  const [open, waiting, rest, shelved] = await Promise.all([
    db.select().from(inboxItem).where(needsYou),
    db.select().from(inboxItem).where(pending),
    db
      .select()
      .from(inboxItem)
      .where(
        and(
          sql`not (${needsYou})`,
          awakeSql,
          or(isNull(inboxItem.readAt), gt(inboxItem.updatedAt, since)),
        ),
      )
      .orderBy(desc(inboxItem.ref))
      .limit(MAX_SHOWN),
    db
      .select()
      .from(inboxItem)
      .where(
        or(
          and(or(eq(inboxItem.status, "open"), eq(inboxItem.kind, "update")), sql`not ${awakeSql}`),
          // a set-aside item he dismissed has gone to Done, which keeps a week as every settled item does
          and(eq(inboxItem.status, "cleared"), sql`${inboxItem.answer} ->> 'dismissedAt' is null`),
        ),
      )
      .orderBy(desc(inboxItem.ref))
      .limit(MAX_SHOWN),
  ])
  const seen = new Set([...open, ...waiting].map((row) => row.id))
  const recent = rest.filter((row) => !seen.has(row.id))
  for (const row of recent) seen.add(row.id)
  const cleared = shelved.filter((row) => row.status === "cleared" && !seen.has(row.id))
  const items = inboxOrder([...open, ...waiting, ...recent, ...cleared].map(toItem), now)
  const asleep = shelved.filter((row) => row.status !== "cleared").map(toItem)
  const archived = asleep.filter((item) => archivedAt(item) !== null)
  const snoozed = asleep.filter((item) => archivedAt(item) === null)
  const quiet = quietIds(items, focus)
  const loud = items.filter((item) => !quiet.includes(item.id))
  return { items, archived, count: inboxCount(loud, now), quiet, snoozed }
}

const NOT_FOUND: Refused = { code: "NOT_FOUND", message: "No inbox item with that id", ok: false }

// Records the answer, delivery pending, in one write that holds only while the item is open at the version read, so a double click or a second tab cannot answer it twice; then types it into the posting session and records how that went. With no deliver given (a test) the delivery stays pending, which the poster's `bun run ask get --ack` clears.
export async function answerItem(
  db: Database,
  id: string,
  input: AnswerInput,
  {
    accept,
    actor,
    apps,
    deliver,
    dispatcher,
    grant,
    now = new Date(),
    reveal,
    settingsData,
    upload,
    via,
    wait,
  }: {
    accept?: ExtRun
    actor: ActivityActor
    apps?: OwnerApps
    deliver?: Deliver
    dispatcher?: string
    grant?: ArgvRun
    now?: Date
    reveal?: KeychainRead
    settingsData?: string
    via?: InboxAnswer["via"]
  } & Pick<Sending, "upload" | "wait">,
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const current = await getItem(db, id)
  if (!current || current.id !== id) return NOT_FOUND
  if (input.seen !== undefined && input.seen !== current.updatedAt) {
    return {
      code: "CONFLICT",
      message: "This item changed since you read it; read it again",
      ok: false,
    }
  }
  // a guard setting or an own flag is written as the card he read shows it, so its Approve names that reading
  if (
    input.action === "approve" &&
    input.seen === undefined &&
    current.kind === "decision" &&
    (current.preview.type === "guard" || current.preview.type === "own")
  ) {
    return {
      code: "VALIDATION_ERROR",
      message: "A guard setting or an own card is approved from the card that shows it, with seen",
      ok: false,
    }
  }
  if (await holdsRevealed(current, [input.note, input.text], reveal)) return REVEALED
  if (input.action === "archive") return archive(db, current, now)
  if (input.action === "unarchive") return unarchive(db, current, now)
  if (input.action === "dismiss" && !waits(current)) {
    return dismissAnswered(db, current, now, deliver && { actor, deliver, dispatcher, now, wait })
  }
  const checked = checkAnswer(current, input)
  if ("message" in checked) {
    // an answered decision or draft conflicts with this answer; an update never takes one
    const code =
      current.kind !== "update" && current.status !== "open" ? "CONFLICT" : "VALIDATION_ERROR"
    return { code, message: checked.message, ok: false }
  }
  const at = now.toISOString()
  const answer: InboxAnswer =
    input.action === "dismiss"
      ? { ...checked.answer, at, dismissed: true, dismissedAt: at }
      : { ...checked.answer, at, ...(via && { via }) }
  // an accept's, an apps change's, a grant's, a guard setting's or an own account change's Approve runs its step, so one with nothing to run it is refused before it is recorded
  const step =
    current.kind === "decision" && answer.choice === "approve"
      ? stepOf(current.preview, current.ref, {
          accept,
          actor: "id" in actor ? actor.id : actor.label,
          apps,
          grant,
          settingsData,
        })
      : undefined
  if (step && "refusal" in step)
    return { code: "VALIDATION_ERROR", message: step.refusal, ok: false }
  const [row] = await db
    .update(inboxItem)
    .set({
      answer,
      delivery: { status: "pending" },
      readAt: sql`coalesce(${inboxItem.readAt}, ${now})`,
      status: checked.status,
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(
      and(
        eq(inboxItem.id, id),
        eq(inboxItem.status, "open"),
        eq(inboxItem.version, current.version),
      ),
    )
    .returning()
  if (!row) return { code: "CONFLICT", message: "This item is already answered", ok: false }
  let answered = toItem(row)
  let given: Omit<InboxAnswer, "at"> = checked.answer
  // run once, after the claim above, so a double click or a second tab runs it once
  if (step) {
    const result = await step.run().catch((error: unknown) => ({
      exitCode: 1,
      line: runResult({
        code: 1,
        err: error instanceof Error ? error.message : String(error),
        out: "",
      }).line,
    }))
    given = { ...given, [step.key]: result }
    // merged key by key, so a poster's read that landed while it ran keeps its close
    const [recorded] = await db
      .update(inboxItem)
      .set({
        answer: sql`${inboxItem.answer} || (${JSON.stringify({ [step.key]: result })}::text)::jsonb`,
        version: sql`${inboxItem.version} + 1`,
      })
      .where(eq(inboxItem.id, id))
      .returning()
    if (recorded) answered = toItem(recorded)
  }
  if (!deliver) return { item: answered, ok: true }
  return {
    item: await send(db, answered, textsOf(answered, { ...given, at: answer.at }), {
      actor,
      deliver,
      dispatcher,
      now,
      upload,
      wait,
    }),
    ok: true,
  }
}

// Pure: whether an item still waits on his answer: an open decision or draft he has not replied to, archived or put off included.
const waits = (item: InboxItem): boolean =>
  item.kind !== "update" && item.status === "open" && choiceOf(item) !== "replied"

// the change a write is made against, so a double click or a second tab cannot write it twice
const unchanged = (current: InboxItem) =>
  and(
    eq(inboxItem.id, current.id),
    eq(inboxItem.status, current.status),
    eq(inboxItem.version, current.version),
  )

const CHANGED: Refused = {
  code: "CONFLICT",
  message: "This item changed since you read it",
  ok: false,
}

// Archive: what still waits on him, or an update in his list, leaves the list and its count, unanswered, and its poster is told nothing, so it keeps waiting; Move back, Later or Dismiss takes it off the Archive shelf.
async function archive(
  db: Database,
  current: InboxItem,
  now: Date,
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const dismissed = current.answer !== null && "dismissedAt" in current.answer
  if ((!waits(current) && current.kind !== "update") || dismissed || archivedAt(current)) {
    return {
      code: "CONFLICT",
      message: "Only an item that waits on you, or an update in your list, is archived",
      ok: false,
    }
  }
  const [row] = await db
    .update(inboxItem)
    .set({
      answer: sql`(coalesce(${inboxItem.answer}, '{}'::jsonb) - 'snoozedUntil') || jsonb_build_object('archivedAt', ${now.toISOString()}::text)`,
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(unchanged(current))
    .returning()
  return row ? { item: toItem(row), ok: true } : CHANGED
}

// The step an Approve runs, by the decision's kind, and the answer key its result is kept under: an accept's `ext accept`, an apps change's write of the owner's list, a grant's System Settings pane, a guard setting's write at its scope, an own account change's write of usage.accounts; undefined for a decision whose poster carries it out, and a refusal when this dashboard has nothing to run it with.
function stepOf(
  preview: InboxPreview,
  ref: number,
  {
    accept,
    actor,
    apps,
    grant,
    settingsData,
  }: {
    accept?: ExtRun
    actor: string
    apps?: OwnerApps
    grant?: ArgvRun
    settingsData?: string
  },
):
  | { key: "accepted" | "listed" | "opened" | "owned" | "set"; run: () => Promise<RunResult> }
  | { refusal: string }
  | undefined {
  if (preview.type === "accept") {
    if (!accept) return { refusal: "This dashboard cannot run an accept" }
    return { key: "accepted", run: () => acceptAll(accept, preview, ref) }
  }
  if (preview.type === "apps") {
    if (!apps)
      return { refusal: "This dashboard cannot change your apps: its extensions have no login" }
    return {
      key: "listed",
      run: () =>
        oneAppsChange(async () => {
          const list = apps.read()
          if (!list)
            return {
              exitCode: 1,
              line: `your ${OWNER_APPS} list is not a list of names, so nothing changed`,
            }
          const changed = appsChange(list, preview)
          if (!("list" in changed)) return changed
          const ran = runResult(
            await apps.run(appsArgs(apps.login, ref), JSON.stringify(changed.list)),
          )
          if (ran.exitCode !== 0) return ran
          const verb = preview.change === "add" ? "added" : "removed"
          return {
            exitCode: 0,
            line: `${verb} ${preview.app}; your apps are ${changed.list.join(", ") || "none"}`,
          }
        }),
    }
  }
  if (preview.type === "grant") {
    if (!grant) return { refusal: "This dashboard opens no System Settings: it shows test data" }
    return {
      key: "opened",
      run: async () => {
        const ran = runResult(await grant(grantArgv(preview)))
        const pane = preview.permission === "accessibility" ? "Accessibility" : "Screen Recording"
        return ran.exitCode === 0
          ? { exitCode: 0, line: `opened System Settings at Privacy & Security > ${pane}` }
          : ran
      },
    }
  }
  if (preview.type === "guard") {
    if (!settingsData) return { refusal: "This dashboard cannot write a guard setting" }
    return { key: "set", run: async () => guardWrite(settingsData, preview, ref, actor) }
  }
  if (preview.type === "own") {
    if (!settingsData) return { refusal: "This dashboard cannot write usage.accounts" }
    return { key: "owned", run: async () => ownWrite(settingsData, preview, ref, actor) }
  }
  return undefined
}

// Writes an own card's flag on its one row of usage.accounts at its scope as the owner's act, the list read whole and every other row put back as it was; a value that is not a list, or a row gone since the post, writes nothing.
function ownWrite(data: string, preview: InboxOwn, ref: number, actor: string): RunResult {
  const { key, own, scope } = preview
  const value = accountsAt(data, scope)
  if (!Array.isArray(value))
    return { exitCode: 1, line: `${ACCOUNTS} at ${scope} is not a list, so nothing changed` }
  const row = claudeRow(value, key)
  if (!row)
    return {
      exitCode: 1,
      line: `${key} is no longer in ${ACCOUNTS} at ${scope}, so nothing changed`,
    }
  if ((row.own === true) === own)
    return { exitCode: 0, line: `${key} ${own ? "is" : "is not"} your own account already` }
  const who = {
    actor,
    author: "owner",
    inboxRef: ref,
    reason: `the owner approved it in the Inbox (${itemTag(ref)})`,
  }
  const set = setSetting(data, { key: ACCOUNTS, scope, value: withOwn(value, key, own) }, who)
  return set.ok
    ? {
        exitCode: 0,
        line: `${key} ${own ? "is now" : "is no longer"} your own account at ${scope}`,
      }
    : { exitCode: 1, line: set.message }
}

// Writes a guard decision's setting into the data folder's extensions as the owner's act, the item named in its commit: its value at its scope, or no value there, which takes the key back to its default.
function guardWrite(data: string, preview: InboxGuard, ref: number, actor: string): RunResult {
  const who = {
    actor,
    author: "owner",
    inboxRef: ref,
    reason: `the owner approved it in the Inbox (${itemTag(ref)})`,
  }
  const { key, scope, value } = preview
  if (value === undefined) {
    const reset = resetSetting(data, { key, scope }, who)
    return reset.ok
      ? { exitCode: 0, line: `took ${key} at ${scope} back to its default` }
      : { exitCode: 1, line: reset.message }
  }
  // a job's enabled field or config goes over the row its scope holds, never the registry's fields, so the rest still follow the registry; an org's own job is no setting readSetting knows, so its row is read from its scope's settings directly
  const held = (
    orgJobKey(key)
      ? settingRows(data).filter((row) => row.key === key)
      : (readSetting(data, key)?.rows ?? [])
  ).find((row) => row.scope === scope)?.value
  const part = (JOB_KEYS.includes(key) || orgJobKey(key)) && jobPart.safeParse(value).success
  if (part && orgJobKey(key) && held === undefined)
    return { exitCode: 1, line: `${key} has no row at ${scope} to change` }
  const next = part ? { ...(held as object | undefined), ...(value as object) } : value
  if (held !== undefined && isDeepStrictEqual(held, next))
    return {
      exitCode: 0,
      line: `${key} at ${scope} is already ${JSON.stringify(held)}, so nothing changed`,
    }
  const set = setSetting(data, { key, scope, value: next }, who)
  return set.ok
    ? { exitCode: 0, line: `set ${key} at ${scope} to ${JSON.stringify(set.value)}` }
    : { exitCode: 1, line: set.message }
}

// Move back: an archived item returns to the list as it was; a set-aside one (the old `clear`, or a Dismiss while it waited) goes back to open with no answer, so it can be answered again. Nothing is typed into its poster, since nothing was decided.
async function unarchive(
  db: Database,
  current: InboxItem,
  now: Date,
): Promise<{ item: InboxItem; ok: true } | Refused> {
  if (archivedAt(current)) {
    const [row] = await db
      .update(inboxItem)
      .set({
        answer: sql`nullif(${inboxItem.answer} - 'archivedAt', '{}'::jsonb)`,
        updatedAt: now,
        version: sql`${inboxItem.version} + 1`,
      })
      .where(unchanged(current))
      .returning()
    return row ? { item: toItem(row), ok: true } : CHANGED
  }
  if (current.status !== "cleared") {
    return {
      code: "CONFLICT",
      message: "Only an archived or set-aside item moves back",
      ok: false,
    }
  }
  const [row] = await db
    .update(inboxItem)
    .set({
      answer: null,
      delivery: null,
      status: "open",
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(unchanged(current))
    .returning()
  return row ? { item: toItem(row), ok: true } : CHANGED
}

// Dismiss on what no longer waits on him (an answered item, a reply, an update, or one on Done he has not dismissed): it goes to Done marked dismissed, keeping when it first went there, and an update is read.
async function dismissAnswered(
  db: Database,
  current: InboxItem,
  now: Date,
  telling?: Telling,
): Promise<{ item: InboxItem; ok: true } | Refused> {
  if (current.answer && "dismissed" in current.answer && current.answer.dismissed) {
    return { code: "CONFLICT", message: "This item is already dismissed", ok: false }
  }
  const [row] = await db
    .update(inboxItem)
    .set({
      answer: sql`(coalesce(${inboxItem.answer}, '{}'::jsonb) - 'archivedAt' - 'snoozedUntil') || jsonb_build_object('dismissed', true, 'dismissedAt', coalesce(${inboxItem.answer} ->> 'dismissedAt', ${now.toISOString()}::text))`,
      readAt: sql`coalesce(${inboxItem.readAt}, ${now})`,
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(unchanged(current))
    .returning()
  if (!row) return CHANGED
  return { item: await tellClosed(db, toItem(row), "dismiss", current, telling), ok: true }
}

// How often a queued answer is read again: deliver() types nothing for it, and reads it delivered once its transcript shows it, or lost QUEUED_MS on.
export const QUEUED_POLL_MS = 5000

type Sending = {
  actor: ActivityActor
  deliver: Deliver
  dispatcher?: string
  now: Date
  upload?: Upload
  wait?: (ms: number) => Promise<void>
}

// Types the answer into the posting session and records how that went; a poster that has ended hands it to the dispatcher instead. Each try goes under its own id, so one Claude Code holds (queued) is read again under it until it settles: this process's own reads, so a restart leaves it reading queued until its card offers Retry (stuckQueued).
async function send(
  db: Database,
  item: InboxItem,
  { relay, text }: { relay: string; text: string },
  { actor, deliver, dispatcher, now, upload, wait = (ms) => Bun.sleep(ms) }: Sending,
  held?: Extract<InboxDelivery, { status: "queued" }>,
): Promise<InboxItem> {
  // the files go first, so an upload Slack refuses fails the send with nothing typed, and Retry shares them again
  const shared = upload && filesToUpload(item)
  if (shared) {
    let count: number
    try {
      count = await upload(item)
    } catch (error) {
      const reason = `The files did not upload to Slack: ${(error as Error).message}`
      const failed: InboxDelivery = { code: "UPLOAD_FAILED", reason, status: "failed" }
      return (await recordDelivery(db, item.id, failed, now)) ?? item
    }
    item = (await recordUploaded(db, item.id, count)) ?? item
  }
  const one = (to: string, words: string) => ({ actor, id: crypto.randomUUID(), text: words, to })
  // a stuck queued answer is read again under its own id and queued time, so this try types nothing: it reads queued, delivered, lost or unconfirmed, and only a Retry after lost types it
  let sent: Delivery & { id: string } = held
    ? {
        actor,
        id: held.id,
        queuedAt: held.at,
        text: held.to === item.from ? text : relay,
        to: held.to,
      }
    : one(item.from, text)
  let delivery = await attempt(deliver, sent, now)
  if (dispatcher && item.from !== dispatcher && posterGone(delivery)) {
    sent = one(dispatcher, relay)
    delivery = await attempt(deliver, sent, now)
  }
  const recorded = (await recordDelivery(db, item.id, delivery, now)) ?? item
  if (delivery.status === "queued") {
    // a write that fails while it follows (the database restarting) leaves the card queued, which offers Retry once stuck, rather than ending the API
    void follow(
      db,
      item.id,
      { ...sent, queuedAt: sent.queuedAt ?? delivery.at },
      { deliver, wait },
    ).catch((error: unknown) => {
      console.warn(`Could not follow the queued answer on ${item.id}:`, error)
    })
  }
  return recorded
}

// Reads a queued answer again until Claude Code lets it go, then records what became of it in place of queued, while the item still reads queued under this delivery's id.
async function follow(
  db: Database,
  id: string,
  sent: Delivery & { id: string },
  { deliver, wait }: { deliver: Deliver; wait: (ms: number) => Promise<void> },
): Promise<void> {
  for (;;) {
    await wait(QUEUED_POLL_MS)
    const now = new Date()
    const delivery = await attempt(deliver, sent, now)
    if (delivery.status === "queued") continue
    await db
      .update(inboxItem)
      .set({ delivery, updatedAt: now, version: sql`${inboxItem.version} + 1` })
      .where(
        and(
          eq(inboxItem.id, id),
          sql`${inboxItem.delivery} ->> 'status' = 'queued'`,
          sql`${inboxItem.delivery} ->> 'id' = ${sent.id}`,
        ),
      )
    return
  }
}

// deliver.ts reports a poster that has ended as NOT_FOUND with one of these two reasons; its other NOT_FOUNDs ("now names another session", "has no terminal") come from a live session, which a relay would leave to carry the go out beside the dispatcher.
const GONE_REASONS = [
  /^No live session is named /,
  /'s Claude is not running in its pane any more\.$/,
]

const posterGone = (delivery: InboxDelivery): boolean =>
  delivery.status === "failed" &&
  delivery.code === "NOT_FOUND" &&
  GONE_REASONS.some((reason) => reason.test(delivery.reason))

async function attempt(
  deliver: Deliver,
  delivery: Delivery & { id: string },
  now: Date,
): Promise<InboxDelivery> {
  try {
    const result = await deliver(delivery)
    if (result.ok) return { at: result.at, status: "delivered", to: delivery.to, via: "session" }
    return result.code === "QUEUED"
      ? {
          at: result.queuedAt ?? now.toISOString(),
          id: delivery.id,
          status: "queued",
          to: delivery.to,
        }
      : { code: result.code, reason: result.reason, status: "failed" }
  } catch (error) {
    // ERROR, not one of the adapter's codes, since the answer may have reached the session after all.
    return { code: "ERROR", reason: (error as Error).message, status: "failed" }
  }
}

// Retry on an answer whose delivery failed, or that is stuck queued: marks it pending in one write that holds only while it still reads failed at the version read, so a double click types it once, then delivers it again and records the new result.
export async function retryDelivery(
  db: Database,
  id: string,
  {
    actor,
    deliver,
    dispatcher,
    now = new Date(),
    upload,
    wait,
  }: Omit<Sending, "now"> & { now?: Date },
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const current = await getItem(db, id)
  if (!current || current.id !== id) return NOT_FOUND
  if (
    current.kind === "update" ||
    !retryable(current, now) ||
    !current.answer ||
    !("choice" in current.answer) ||
    current.answer.choice === "settled" ||
    current.answer.choice === "replied"
  ) {
    return {
      code: "CONFLICT",
      message:
        "Only an answer that failed before anything was typed, or one stuck queued, is retried",
      ok: false,
    }
  }
  const [row] = await db
    .update(inboxItem)
    .set({
      delivery: { status: "pending" },
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(
      and(
        eq(inboxItem.id, id),
        sql`${inboxItem.delivery} ->> 'status' in ('failed', 'queued')`,
        sql`${inboxItem.answer} ->> 'dismissedAt' is null`,
        eq(inboxItem.version, current.version),
      ),
    )
    .returning()
  if (!row) return { code: "CONFLICT", message: "This item changed; try again", ok: false }
  const item = toItem(row)
  return {
    item: await send(
      db,
      item,
      textsOf(item, current.answer),
      { actor, deliver, dispatcher, now, upload, wait },
      current.delivery?.status === "queued" ? current.delivery : undefined,
    ),
    ok: true,
  }
}

// What the card posts for a secret ask: the value, and seen, the updatedAt of the card he answered. The value is held in memory for the sink's run alone.
const SECRET_MAX_CHARS = 64 * 1024
export const secretInputSchema = z.strictObject({
  seen: z.iso.datetime().optional(),
  value: z.string().trim().min(1).max(SECRET_MAX_CHARS),
})

// Hands his value for a secret ask to its sink, once an environment on stdin, and records only when and each exit status: in one write that holds only while the item is open at the version read, so a double click or a second tab runs the sink once, then the results, then a delivery to its poster as an answer's. The value is in no row, delivery, refusal or return.
export async function provideSecret(
  db: Database,
  id: string,
  { seen, value }: z.output<typeof secretInputSchema>,
  {
    actor,
    deliver,
    dispatcher,
    keychain,
    now = new Date(),
    run,
  }: {
    actor: ActivityActor
    deliver?: Deliver
    dispatcher?: string
    keychain?: KeychainSave
    now?: Date
    run: SinkRun
  },
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const current = await getItem(db, id)
  if (!current || current.id !== id) return NOT_FOUND
  if (current.kind !== "decision" || current.preview.type !== "secret") {
    return { code: "VALIDATION_ERROR", message: "Only a secret ask takes a value", ok: false }
  }
  const { key, sink } = current.preview
  // a paste off the item's shape is refused before the claim, so the card stays open for the right one
  const spec = sink.type === "keychain" ? keychainSpec(sink.item) : null
  if (spec && !spec.valid.test(value))
    return { code: "VALIDATION_ERROR", message: spec.invalid, ok: false }
  if (seen !== undefined && seen !== current.updatedAt) {
    return {
      code: "CONFLICT",
      message: "This item changed since you read it; read it again",
      ok: false,
    }
  }
  const at = now.toISOString()
  const [claimed] = await db
    .update(inboxItem)
    .set({
      answer: { at, choice: "provided" } satisfies InboxProvided,
      delivery: { status: "pending" },
      readAt: sql`coalesce(${inboxItem.readAt}, ${now})`,
      status: "provided",
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(
      and(
        eq(inboxItem.id, id),
        eq(inboxItem.status, "open"),
        eq(inboxItem.version, current.version),
      ),
    )
    .returning()
  if (!claimed) return { code: "CONFLICT", message: "This item is already answered", ok: false }
  const results: SinkResult[] = []
  if (sink.type === "keychain") results.push(await saveKeychain(sink.item, value, keychain))
  else
    for (const environment of sink.environments) {
      results.push({ environment, exitCode: await run(sinkArgv(key, sink, environment), value) })
    }
  const answer: InboxProvided = { at, choice: "provided", results }
  // merged key by key, so a poster's read that landed while the sink ran keeps its close
  const [row] = await db
    .update(inboxItem)
    .set({
      answer: sql`${inboxItem.answer} || jsonb_build_object('results', (${JSON.stringify(results)}::text)::jsonb)`,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(eq(inboxItem.id, id))
    .returning()
  const item = toItem(row ?? claimed)
  if (!deliver) return { item, ok: true }
  return {
    item: await send(db, item, textsOf(item, answer), { actor, deliver, dispatcher, now }),
    ok: true,
  }
}

// A keychain sink's one result: saved, or the writer's first line, which names the refusal and never the value.
async function saveKeychain(
  item: string,
  value: string,
  keychain: KeychainSave | undefined,
): Promise<SinkResult> {
  if (!keychain)
    return { environment: "Keychain", exitCode: 1, line: "no Keychain writer on this stack" }
  try {
    await keychain(item, value)
    return { environment: "Keychain", exitCode: 0, line: "saved" }
  } catch (error) {
    const line = (error instanceof Error ? error.message : "the save failed").split("\n")[0] ?? ""
    return { environment: "Keychain", exitCode: 1, line: line.split(value).join("…") }
  }
}

// Reads a reveal card's Keychain item for the owner's Show or Copy, and only while the card is open and not archived, so an old card is no standing read handle. It writes nothing: the value is in no row, delivery, log or refusal, only in what it returns.
export async function revealSecret(
  db: Database,
  id: string,
  read: KeychainRead,
): Promise<{ ok: true; value: string } | Refused> {
  const item = await getItem(db, id)
  if (!item || item.id !== id) return NOT_FOUND
  if (item.kind !== "decision" || item.preview.type !== "reveal") {
    return { code: "VALIDATION_ERROR", message: "Only a reveal card shows a value", ok: false }
  }
  if (item.status !== "open" || archivedAt(item) !== null) {
    return { code: "CONFLICT", message: "This card is closed, so it shows nothing", ok: false }
  }
  const value = await read(item.preview.service)
  if (value === null) {
    return { code: "NOT_FOUND", message: "That Keychain item holds no value", ok: false }
  }
  return { ok: true, value }
}

const REVEALED: Refused = {
  code: "VALIDATION_ERROR",
  message: "That is the card's value: it stays out of a comment",
  ok: false,
}

// A playground- item may hold a value as short as 1 character (keychainSpec), which a substring match would find in most comments, so a shorter value is no match.
const REVEAL_MATCH_MIN = 8

// Whether his words hold a reveal card's value, read again from the Keychain, so a Copy pasted into the card's own comment never reaches its poster; false on any other card, with no words, with no reader or for a value shorter than REVEAL_MATCH_MIN.
async function holdsRevealed(
  item: InboxItem,
  words: (string | undefined)[],
  read: KeychainRead | undefined,
): Promise<boolean> {
  if (!read || item.kind !== "decision" || item.preview.type !== "reveal") return false
  const said = words.filter((word): word is string => Boolean(word?.trim()))
  if (said.length === 0) return false
  const value = await read(item.preview.service)
  return (
    value !== null && value.length >= REVEAL_MATCH_MIN && said.some((word) => word.includes(value))
  )
}

// Keeps how many files a send shared in its answer, 0 on a stack that shares none, so a Retry after the words failed to type shares none twice.
async function recordUploaded(db: Database, id: string, count: number): Promise<InboxItem | null> {
  const [row] = await db
    .update(inboxItem)
    .set({ answer: sql`${inboxItem.answer} || jsonb_build_object('uploaded', ${count}::int)` })
    .where(eq(inboxItem.id, id))
    .returning()
  return row ? toItem(row) : null
}

// The first delivery recorded stands: a poster that read its answer through bun run ask while the adapter typed keeps that record.
async function recordDelivery(
  db: Database,
  id: string,
  delivery: InboxDelivery,
  now: Date,
): Promise<InboxItem | null> {
  const [row] = await db
    .update(inboxItem)
    .set({ delivery, updatedAt: now, version: sql`${inboxItem.version} + 1` })
    .where(
      and(eq(inboxItem.id, id), sql`coalesce(${inboxItem.delivery}->>'status', '') <> 'delivered'`),
    )
    .returning()
  return row ? toItem(row) : getItem(db, id)
}

// Later: pushes an open decision or draft, or an update in his list, out of it until a time, recorded in its answer's snoozedUntil, which answering or a reply replaces at once; the poster waits as before, and an archived one leaves the Archive shelf for it. A reply its poster has not closed is replaced in turn, since he puts away an item he opened again from its card.
export async function scheduleItem(
  db: Database,
  id: string,
  at: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const current = await getItem(db, id)
  if (!current || current.id !== id) return NOT_FOUND
  const answer = current.answer
  if (
    (current.kind !== "update" && current.status !== "open") ||
    (answer !== null && "dismissedAt" in answer)
  ) {
    return {
      code: "CONFLICT",
      message: "Only an open decision or draft, or an update in your list, can be scheduled",
      ok: false,
    }
  }
  const replied = current.kind !== "update" && answer !== null && "choice" in answer
  if (replied && (answer.choice !== "replied" || ("ackedAt" in answer && answer.ackedAt))) {
    return { code: "CONFLICT", message: "This item already has your answer", ok: false }
  }
  if (new Date(at).getTime() <= now.getTime()) {
    return { code: "VALIDATION_ERROR", message: "Pick a time in the future", ok: false }
  }
  const [row] = await db
    .update(inboxItem)
    .set({
      answer: replied
        ? { snoozedUntil: at }
        : sql`(coalesce(${inboxItem.answer}, '{}'::jsonb) - 'archivedAt') || jsonb_build_object('snoozedUntil', ${at}::text)`,
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(unchanged(current))
    .returning()
  if (!row) return { code: "CONFLICT", message: "This item is already answered", ok: false }
  return { item: toItem(row), ok: true }
}

// A reply he sent naming the item (`re #iN`, recorded once it is out, by routers/dashboard.ts for a chat message and by replyItem for a card's Reply): the time and his words (saidOf). Nothing else changes: the item waits on its poster closing it, which the sweep keeps chasing.
export async function recordReply(
  db: Database,
  ref: number,
  now = new Date(),
  text = "",
): Promise<InboxItem | null> {
  const said = saidOf(text)
  const [row] = await db
    .update(inboxItem)
    .set({
      answer: { at: now.toISOString(), choice: "replied", ...(said && { said }) },
      readAt: sql`coalesce(${inboxItem.readAt}, ${now})`,
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(
      and(
        eq(inboxItem.ref, ref),
        eq(inboxItem.status, "open"),
        sql`${inboxItem.kind} <> 'update'`,
        sql`${inboxItem.answer} ->> 'choice' is null`,
      ),
    )
    .returning()
  return row ? toItem(row) : null
}

// What a card's Reply posts: his comment alone.
export const replyInputSchema = z.strictObject({ text: words })

export type ReplyInput = z.input<typeof replyInputSchema>

// Reply on a card: his comment alone, typed as `re #iN: <words>` into its poster, or into the dispatcher once the poster has ended, and kept as a reply is (recordReply) on an open decision or draft with no answer yet, so it waits on its poster's edit or close; any other card keeps its answer and delivery as they were. One that reached no session is refused with why, recording nothing.
export async function replyItem(
  db: Database,
  id: string,
  input: ReplyInput,
  {
    actor,
    deliver,
    dispatcher,
    now = new Date(),
    reveal,
  }: Omit<Telling, "now" | "wait"> & { now?: Date; reveal?: KeychainRead },
): Promise<
  { item: InboxItem; ok: true } | Refused | { code: "UNDELIVERED"; message: string; ok: false }
> {
  const parsed = replyInputSchema.safeParse(input)
  if (!parsed.success) {
    return { code: "VALIDATION_ERROR", message: zodMessage(parsed.error), ok: false }
  }
  const current = await getItem(db, id)
  if (!current || current.id !== id) return NOT_FOUND
  if (await holdsRevealed(current, [parsed.data.text], reveal)) return REVEALED
  const text = `re ${itemTag(current.ref)}: ${parsed.data.text}`
  const one = (to: string) => ({ actor, id: crypto.randomUUID(), text, to })
  let delivery = await attempt(deliver, one(current.from), now)
  if (dispatcher && current.from !== dispatcher && posterGone(delivery)) {
    delivery = await attempt(deliver, one(dispatcher), now)
  }
  if (delivery.status === "failed") {
    return {
      code: "UNDELIVERED",
      message: `Your comment did not send: ${delivery.reason}`,
      ok: false,
    }
  }
  const recorded = await recordReply(db, current.ref, now, text)
  return { item: recorded ?? current, ok: true }
}

// The poster closes its answer (`bun run ask ack`): a go with where it landed (`link`) or why there is none (`noLink`), anything else as it is; its delivery is done by the CLI.
export async function ackItem(
  db: Database,
  key: string,
  {
    label,
    link,
    noLink,
    now = new Date(),
  }: { label?: string; link?: string; noLink?: string; now?: Date } = {},
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const refused = checkLink(link, label)
  if (refused) return refused
  if (link !== undefined && noLink !== undefined) {
    return { code: "VALIDATION_ERROR", message: "Give --link or --no-link, not both", ok: false }
  }
  const why = noLink === undefined ? null : oneLine(LIMITS.line).safeParse(noLink)
  if (why && !why.success) {
    return {
      code: "VALIDATION_ERROR",
      message: `--no-link takes why there is no link: one line, not empty, of at most ${LIMITS.line} characters`,
      ok: false,
    }
  }
  const item = await getItem(db, key)
  if (!item) return NOT_FOUND
  if (item.kind === "update" || !item.answer || !("choice" in item.answer)) {
    return { code: "CONFLICT", message: "This item has no answer yet", ok: false }
  }
  if (isGo(item.answer.choice) && link === undefined && !why) {
    return {
      code: "VALIDATION_ERROR",
      message:
        'A go closes with where it landed: --link <https url> (the Slack message, PR, issue or Linear ticket), or --no-link "<why>"',
      ok: false,
    }
  }
  if (why && !isGo(item.answer.choice)) {
    return { code: "VALIDATION_ERROR", message: "--no-link closes a go alone", ok: false }
  }
  // a go closes one way: a link and a reason there is none would contradict each other
  if (why && item.answer.link) {
    return { code: "CONFLICT", message: "This answer already links where it landed", ok: false }
  }
  if (link !== undefined && "noLink" in item.answer && item.answer.noLink) {
    return { code: "CONFLICT", message: "This answer already closed with no link", ok: false }
  }
  return {
    item: await recordAck(db, item, now, true, link, label, why?.success ? why.data : undefined),
    ok: true,
  }
}

// The poster read its answer (`bun run ask get --ack`): its delivery is done by the CLI, and an answer that is neither a go nor a reply, which it carries out by reading, is closed too. A reply waits on its poster like a go, closed only by `bun run ask ack`.
export async function readAnswer(
  db: Database,
  item: InboxItem,
  now = new Date(),
): Promise<InboxItem> {
  if (item.kind === "update" || !item.answer || !("choice" in item.answer)) return item
  const { choice } = item.answer
  return recordAck(db, item, now, !isGo(choice) && choice !== "replied")
}

// Records the CLI's read as the delivery, and when close, the ack's stamp and any link.
async function recordAck(
  db: Database,
  item: InboxItem,
  now: Date,
  close: boolean,
  link?: string,
  label?: string,
  noLink?: string,
): Promise<InboxItem> {
  if (close) await stamp(db, item.id, now, noLink)
  const acked = await recordDelivery(
    db,
    item.id,
    { at: now.toISOString(), status: "delivered", via: "cli" },
    now,
  )
  const linked = link === undefined ? null : await recordLink(db, item.id, link, label, now)
  return linked ?? acked ?? item
}

// The ack's stamp, the first close's time, and with it why a go has no link, in one write; a closed answer moves to Done at once, as his Dismiss moves it, keeping an earlier Dismiss's time, but for one he set aside, which stays on the Archive shelf until he dismisses it.
async function stamp(db: Database, id: string, now: Date, noLink?: string): Promise<void> {
  const at = sql`${now.toISOString()}::text`
  const dismissal = sql`case when ${inboxItem.answer} ->> 'choice' = 'clear' then '{}'::jsonb else jsonb_build_object('dismissedAt', coalesce(${inboxItem.answer} ->> 'dismissedAt', ${at})) end`
  await db
    .update(inboxItem)
    .set({
      answer: sql`${inboxItem.answer} || jsonb_build_object('ackedAt', coalesce(${inboxItem.answer} ->> 'ackedAt', ${at})) || ${dismissal} || ${noLink === undefined ? sql`'{}'::jsonb` : sql`jsonb_build_object('noLink', ${noLink}::text)`}`,
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(eq(inboxItem.id, id))
}

// When the dashboard started stamping acks: an answer delivered before then, read through bun run ask or typed into its session, may have been acked with no stamp, so it is not chased; one never delivered still is.
export const ACKS_STAMPED_FROM = new Date("2026-10-12T08:05:50Z")

// Answers he gave since `since` that their poster has not closed through bun run ask within `minutes` (a go with its link or why there is none, anything else by reading it), delivery pending, failed or typed into its session alike, oldest first: what ops-sweep chases (`bun run ask stale`).
export async function staleItems(
  db: Database,
  { minutes, now = new Date(), since }: { minutes: number; now?: Date; since: Date },
): Promise<InboxItem[]> {
  const cutoff = new Date(now.getTime() - minutes * 60_000)
  const rows = await db
    .select()
    .from(inboxItem)
    .where(
      and(
        sql`${inboxItem.kind} <> 'update'`,
        sql`${inboxItem.answer} ->> 'choice' <> 'settled'`,
        sql`${inboxItem.answer} ->> 'ackedAt' is null`,
        // a failed answer he dismissed, which he chose not to send
        sql`not (coalesce(${inboxItem.delivery} ->> 'status', '') = 'failed' and ${inboxItem.answer} ->> 'dismissedAt' is not null)`,
        sql`(${inboxItem.answer} ->> 'at')::timestamptz between ${since.toISOString()}::timestamptz and ${cutoff.toISOString()}::timestamptz`,
        sql`(coalesce(${inboxItem.delivery} ->> 'status', '') <> 'delivered' or (${inboxItem.answer} ->> 'at')::timestamptz >= ${ACKS_STAMPED_FROM.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(inboxItem.ref)
  return rows.map(toItem)
}

// Every item still open (a decision or draft not yet answered, one put away with Later and one answered in chat included, until it moves to Done), oldest first, one sender's alone when from is given and those posted from since and before until alone when given: what a session reads before it posts, so it names an open item on the same thing rather than posting it twice (`bun run ask open`), and what ops-tick reads to resolve the focus card.
export async function openItems(
  db: Database,
  { from, since, until }: { from?: string; since?: Date; until?: Date } = {},
): Promise<InboxItem[]> {
  const rows = await db
    .select()
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.status, "open"),
        sql`${inboxItem.answer} ->> 'dismissedAt' is null`,
        from === undefined ? undefined : eq(inboxItem.from, from),
        since === undefined ? undefined : gte(inboxItem.createdAt, since),
        until === undefined ? undefined : lt(inboxItem.createdAt, until),
      ),
    )
    .orderBy(inboxItem.ref)
  return rows.map(toItem)
}

// Done: moves the answered decisions and drafts, those he replied to included, and the updates named to Done at once, recording when inside their answer, so no column is added, waking any he put off or archived, and marks an update read, keeping when it was read; an open decision or draft asks something of him and is left.
export async function dismissItems(
  db: Database,
  ids: string[],
  now = new Date(),
  telling?: Omit<Telling, "now">,
): Promise<number> {
  if (ids.length === 0) return 0
  const before = new Map(
    (await db.select().from(inboxItem).where(inArray(inboxItem.id, ids))).map((row) => [
      row.id,
      toItem(row),
    ]),
  )
  const rows = await db
    .update(inboxItem)
    .set({
      answer: sql`(coalesce(${inboxItem.answer}, '{}'::jsonb) - 'archivedAt' - 'snoozedUntil') || jsonb_build_object('dismissedAt', ${now.toISOString()}::text)`,
      readAt: sql`coalesce(${inboxItem.readAt}, ${now})`,
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(
      and(
        or(
          eq(inboxItem.kind, "update"),
          and(sql`${inboxItem.status} <> 'open'`, isNotNull(inboxItem.answer)),
          sql`${inboxItem.answer} ->> 'choice' = 'replied'`,
        ),
        sql`${inboxItem.answer} ->> 'dismissedAt' is null`,
        inArray(inboxItem.id, ids),
      ),
    )
    .returning()
  // Done tells an update's poster done, so it posts a new card rather than editing this one; an answered card's poster hears nothing
  for (const row of rows) {
    const item = toItem(row)
    const was = before.get(row.id)
    if (telling && was && item.kind === "update") {
      await tellClosed(db, item, "done", was, { ...telling, now })
    }
  }
  return rows.length
}

const settleNoteSchema = oneLine(LIMITS.line)

// Where the poster carried the answer out (a Slack message's permalink, a ticket, a pull request), which the card links to; https alone, since the dashboard opens it.
const linkSchema = z.url({ protocol: /^https$/ }).max(LIMITS.text)

// What the link is, as the card names it ("Filed ABC-123"); one line.
const linkLabelSchema = oneLine(LIMITS.line)

// Pure: the link and its label as given on the command line, or why they are refused: an https URL, and a label only beside a link.
const checkLink = (link?: string, label?: string): Refused | null => {
  if (label !== undefined && link === undefined) {
    return {
      code: "VALIDATION_ERROR",
      message: "--label names a --link, so it needs one",
      ok: false,
    }
  }
  if (link !== undefined && !linkSchema.safeParse(link).success) return BAD_LINK
  if ([link, label].some((text) => text !== undefined && ARCHIVES.test(text))) return notApp()
  if (label !== undefined && !linkLabelSchema.safeParse(label).success) {
    return {
      code: "VALIDATION_ERROR",
      message: `--label is one line of at most ${LIMITS.line} characters`,
      ok: false,
    }
  }
  return null
}

const notApp = (): Refused => ({ code: "VALIDATION_ERROR", message: archivesMessage(), ok: false })

const BAD_LINK: Refused = {
  code: "VALIDATION_ERROR",
  message: "--link takes an https URL",
  ok: false,
}

// Records the link inside the answer, beside what it already holds.
async function recordLink(
  db: Database,
  id: string,
  link: string,
  label: string | undefined,
  now: Date,
): Promise<InboxItem | null> {
  const [row] = await db
    .update(inboxItem)
    .set({
      // a new link replaces the old one's label too, so a re-ack with no label names the new link from itself
      answer: sql`(${inboxItem.answer} - 'linkLabel') || jsonb_build_object('link', ${link}::text) || ${label === undefined ? sql`'{}'::jsonb` : sql`jsonb_build_object('linkLabel', ${label.trim()}::text)`}`,
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(and(eq(inboxItem.id, id), isNotNull(inboxItem.answer)))
    .returning()
  return row ? toItem(row) : null
}

// The poster closes its own open decision or draft (`bun run ask settle`), when it was decided another way: it reads Decided by the poster, with the note, and goes to Done at once, as a closed answer does. One the owner has answered is refused, as is a reply its poster has acked (a settle would replace its answer) and an update, which asks nothing.
export async function settleItem(
  db: Database,
  key: string,
  {
    label,
    link,
    note,
    now = new Date(),
  }: { label?: string; link?: string; note?: string; now?: Date } = {},
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const refused = checkLink(link, label)
  if (refused) return refused
  const checked = note === undefined ? null : settleNoteSchema.safeParse(note)
  if (checked && !checked.success) {
    return {
      code: "VALIDATION_ERROR",
      message: `--note is one line of at most ${LIMITS.line} characters`,
      ok: false,
    }
  }
  if (note !== undefined && ARCHIVES.test(note)) return notApp()
  const item = await getItem(db, key)
  if (!item) return NOT_FOUND
  if (item.kind === "update") {
    return {
      code: "VALIDATION_ERROR",
      message: "An update asks nothing, so it has nothing to settle",
      ok: false,
    }
  }
  if (item.status !== "open" || (item.answer && "ackedAt" in item.answer && item.answer.ackedAt)) {
    return { code: "CONFLICT", message: "This item is already answered", ok: false }
  }
  const answer: InboxSettled = {
    at: now.toISOString(),
    by: item.from,
    choice: "settled",
    dismissedAt: now.toISOString(),
    ...(link === undefined ? {} : { link }),
    ...(label === undefined ? {} : { linkLabel: label.trim() }),
    ...(checked?.success ? { note: checked.data } : {}),
  }
  const [row] = await db
    .update(inboxItem)
    .set({
      answer,
      readAt: sql`coalesce(${inboxItem.readAt}, ${now})`,
      status: "done",
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(
      and(
        eq(inboxItem.id, item.id),
        eq(inboxItem.status, "open"),
        eq(inboxItem.version, item.version),
      ),
    )
    .returning()
  if (!row) {
    return {
      code: "CONFLICT",
      message: "This item changed while settling it; try again",
      ok: false,
    }
  }
  return { item: toItem(row), ok: true }
}

// The poster clears its own update (`bun run ask resolve`) once it has settled: an alert whose cause cleared, a progress card whose last step is done, the focus card once what it pointed at is answered. It marks the update read, records the resolution inside its answer and leaves it closed, so the owner never presses Done on it by hand. Another session's update, a decision or draft and an unknown id are refused.
export async function resolveItem(
  db: Database,
  key: string,
  { by, note, now = new Date() }: { by: string; note?: string; now?: Date },
): Promise<{ item: InboxItem; ok: true } | Refused> {
  const checked = note === undefined ? null : settleNoteSchema.safeParse(note)
  if (checked && !checked.success) {
    return {
      code: "VALIDATION_ERROR",
      message: `--note is one line of at most ${LIMITS.line} characters`,
      ok: false,
    }
  }
  if (note !== undefined && ARCHIVES.test(note)) return notApp()
  const item = await getItem(db, key)
  if (!item) return NOT_FOUND
  if (item.kind !== "update") {
    return {
      code: "VALIDATION_ERROR",
      message: "Only an update resolves; a decision or draft settles",
      ok: false,
    }
  }
  if (by !== item.from) {
    return {
      code: "CONFLICT",
      message: `Only ${item.from}, which posted it, resolves this update`,
      ok: false,
    }
  }
  const answer: InboxResolved = {
    at: now.toISOString(),
    by,
    choice: "resolved",
    ...(checked?.success ? { note: checked.data } : {}),
  }
  const [row] = await db
    .update(inboxItem)
    .set({
      // merged key by key, as dismissItems writes, so a dismissed alert keeps its dismissedAt and stays in Done
      answer: sql`coalesce(${inboxItem.answer}, '{}'::jsonb) || jsonb_build_object('at', ${answer.at}::text, 'by', ${answer.by}::text, 'choice', 'resolved'${checked?.success ? sql`, 'note', ${answer.note}::text` : sql``})`,
      readAt: sql`coalesce(${inboxItem.readAt}, ${now})`,
      updatedAt: now,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(
      and(
        eq(inboxItem.id, item.id),
        eq(inboxItem.kind, "update"),
        sql`${inboxItem.answer} ->> 'choice' is distinct from 'resolved'`,
      ),
    )
    .returning()
  if (!row) {
    return { code: "CONFLICT", message: "This update is already resolved", ok: false }
  }
  return { item: toItem(row), ok: true }
}

// Marks the items named read: one he clicked, or Mark all as read. An open decision or draft stays open and answerable, only seen, its updatedAt untouched so its card reads as posted, not updated; an update's moves, which keeps it in the list's history window.
export async function markRead(db: Database, ids: string[], now = new Date()): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db
    .update(inboxItem)
    .set({
      readAt: now,
      updatedAt: sql`case when ${inboxItem.kind} = 'update' then ${now.toISOString()}::timestamptz else ${inboxItem.updatedAt} end`,
      version: sql`${inboxItem.version} + 1`,
    })
    .where(and(isNull(inboxItem.readAt), inArray(inboxItem.id, ids)))
    .returning({ id: inboxItem.id })
  return rows.length
}
