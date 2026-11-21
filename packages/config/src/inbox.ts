import { z } from "zod"

// The widest line, in characters, a drawing in an Inbox ask runs before bun run ask warns its author: the owner's chosen drawing width, wider than the narrowest card, which shrinks, then scrolls, any line wider than itself.
export const ASK_CODE_COLUMNS = 72

// The fenced block's language an Inbox card draws as progress bars at its own width, one item a line, so no width limit binds it.
export const PROGRESS_LANGUAGE = "progress"

// A progress row's state: active rows draw in the palette's blue and the rest muted.
export const PROGRESS_STATES = ["active", "done", "held", "waiting"] as const
export type ProgressState = (typeof PROGRESS_STATES)[number]

export type ProgressItem = {
  eta: string
  name: string
  percent: number
  state?: ProgressState
  text: string
}

// Why a progress block's line does not read: no line at all, too few or too many fields (`count` of them), a percent outside 0 to 100, or a state none of PROGRESS_STATES; `line` counts from 1 inside the block.
export type ProgressFault =
  | { kind: "empty"; line: 0; text: "" }
  | { count: number; kind: "fields"; line: number; text: string }
  | { kind: "percent"; line: number; text: string }
  | { kind: "state"; line: number; state: string; text: string }

const PERCENT = /^(\d{1,3}(?:\.\d+)?)%?$/

const isProgressState = (state: string): state is ProgressState =>
  PROGRESS_STATES.some((known) => known === state)

// Pure: a progress block's items, one a non-blank line of `name | percent | what's going on | ETA | state`, the percent 0 to 100 with an optional %, the state optional (an empty or missing one is none, and a row at 100 with none reads as done), or the first line that does not read.
export function progressItems(
  block: string,
): { items: ProgressItem[]; ok: true } | { fault: ProgressFault; ok: false } {
  const items: ProgressItem[] = []
  const lines = block.split("\n")
  for (const [index, text] of lines.entries()) {
    if (text.trim() === "") continue
    const fields = text.split("|").map((field) => field.trim())
    const line = index + 1
    if (fields.length !== 4 && fields.length !== 5)
      return { fault: { count: fields.length, kind: "fields", line, text }, ok: false }
    const [name, percent, said, eta, state = ""] = fields as [string, string, string, string]
    const value = Number(PERCENT.exec(percent)?.[1] ?? Number.NaN)
    if (!(value >= 0 && value <= 100)) return { fault: { kind: "percent", line, text }, ok: false }
    if (state !== "" && !isProgressState(state))
      return { fault: { kind: "state", line, state, text }, ok: false }
    const shown = state || (value === 100 ? "done" : null)
    items.push({ eta, name, percent: value, ...(shown && { state: shown }), text: said })
  }
  return items.length > 0
    ? { items, ok: true }
    : { fault: { kind: "empty", line: 0, text: "" }, ok: false }
}

// What an Inbox answer tells its poster: one JSON line after this lead, typed through deliver(), so the poster parses it rather than reading prose.
export const ANSWER_LEAD = "[inbox-answer]"

// The verbs that reach a poster: a pick of an option, a draft sent, saved as a draft or discarded, an item set aside, a card dismissed, an update done, a secret submitted; a verb that changes only the owner's view (Seen, Later, Archive) sends nothing.
export const ANSWER_VERBS = [
  "discard",
  "dismiss",
  "done",
  "draft",
  "pick",
  "send",
  "set-aside",
  "submit",
] as const

// What a step the dashboard ran on Approve gave: its exit code and its first line.
const ranSchema = z.strictObject({ exitCode: z.number().int(), line: z.string() })

// The line's JSON: what the owner chose, what to do next and the exact command that closes the item, which an update's done or dismiss and a card its poster already closed leave out, since nothing is left to close; a relay to the dispatcher sets relay, and a step the dashboard ran on Approve (an accept, a clone, an apps change, a grant's pane, an own flag, a root step, a guard setting) rides as accepted, cloned, listed, opened, owned, rooted or set, and a secret's results carry each sink's status, never its value.
export const answerPayloadSchema = z.strictObject({
  accepted: ranSchema.optional(),
  at: z.iso.datetime(),
  close: z.string().min(1).optional(),
  cloned: ranSchema.optional(),
  comment: z.string().optional(),
  go: z.boolean(),
  id: z.string().min(1),
  kind: z.enum(["decision", "draft", "update"]),
  linkConverter: z.string().optional(),
  listed: ranSchema.optional(),
  next: z.enum(["carry-out", "close", "nothing"]),
  opened: ranSchema.optional(),
  option: z
    .strictObject({
      index: z.number().int().min(0).max(5),
      label: z.string().min(1),
      letter: z.string().length(1),
    })
    .optional(),
  owned: ranSchema.optional(),
  picks: z
    .array(
      z.strictObject({
        index: z.number().int().min(0).max(5),
        label: z.string().min(1),
        letter: z.string().length(1),
        question: z.string().min(1),
      }),
    )
    .optional(),
  ref: z.string().regex(/^#i\d+$/),
  relay: z.strictObject({ for: z.string().min(1), why: z.literal("poster-ended") }).optional(),
  results: z
    .array(
      z.strictObject({
        environment: z.string(),
        exitCode: z.number().int().nullable(),
        line: z.string().optional(),
      }),
    )
    .optional(),
  rooted: ranSchema.optional(),
  set: ranSchema.optional(),
  text: z.string().optional(),
  title: z.string(),
  type: z.string().optional(),
  v: z.literal(1),
  verb: z.enum(ANSWER_VERBS),
})

export type AnswerPayload = z.infer<typeof answerPayloadSchema>

// Pure: the payload a line carries after ANSWER_LEAD, or null when the line is no answer or does not parse.
export const payloadOf = (line: string): AnswerPayload | null => {
  const at = line.indexOf(ANSWER_LEAD)
  if (at === -1) return null
  try {
    const parsed = answerPayloadSchema.safeParse(JSON.parse(line.slice(at + ANSWER_LEAD.length)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// A decision's options as its card shows them and its answer names them: a go row carries the decision out, the no-go row (always last) declines it.
export type ChoiceRow = {
  description?: string
  go: boolean
  index: number
  label: string
  letter: string
}

// yes-no: one go row and its no, Approve and Deny with their own labels; letters: two or more go rows, A to E, then None of these.
export type Choices = { rows: ChoiceRow[]; shape: "letters" | "yes-no" }

// The scope a poster gives an ask or an update about the factory's own work, the one scope whose card may leave the Mac, on WhatsApp (ADR 0024); an org's work names its org, and a card with none stays in the Inbox.
export const FACTORY_SCOPE = "factory"

// Pure: the one decision WhatsApp may carry and answer (ADR 0024), checked by ops-wa before a card goes and by ask whatsapp before an answer lands: an ask with one question, on the factory's own work.
export const factoryAsk = (item: { kind: string; preview: Record<string, unknown> }): boolean =>
  item.kind === "decision" &&
  item.preview.type === "ask" &&
  !item.preview.questions &&
  item.preview.scope === FACTORY_SCOPE

// The most go rows a decision offers, A to E.
export const MAX_OPTIONS = 5

// What choicesOf reads of a decision's preview: an ask's own options or labels, and the fields a typed decision's default labels name.
export type ChoicePreview =
  | {
      approve?: string
      deny?: string
      options?: { description?: string; label: string }[]
      questions?: {
        options: { description?: string; label: string }[]
        question: string
        recommended?: number
      }[]
      type: "ask"
    }
  | { key: string; kind: string; more?: unknown[]; type: "accept" }
  | { app: string; change: "add" | "remove"; type: "apps" }
  | { amount: string; type: "budget" }
  | { repos: { repo: string }[]; type: "clone" }
  | { type: "delete" }
  | { permission: string; type: "grant" }
  | { key: string; type: "guard"; value?: unknown }
  | { key: string; own: boolean; type: "own" }
  | { type: "reveal" }
  | { step: string; type: "root" }
  | { type: "schema" }
  | { type: "secret" }
  | { sha: string; type: "ship" }
  | { to: string; type: "slack" }
  | { team: string; type: "ticket" }

// Pure: a typed decision's default go and no-go labels, one map for every type a poster labels no options on.
const defaultLabels = (
  preview: Exclude<ChoicePreview, { type: "ask" } | { type: "secret" }>,
): [string, string] => {
  switch (preview.type) {
    case "accept":
      return [
        `Accept the ${preview.kind} ${preview.key}${preview.more?.length ? ` and ${preview.more.length} more` : ""}`,
        preview.more?.length ? "Leave them unaccepted" : "Leave it unaccepted",
      ]
    case "apps":
      return [
        `${preview.change === "add" ? "Add" : "Remove"} ${preview.app}`,
        "Keep the list as it is",
      ]
    case "budget":
      return [`Spend ${preview.amount}`, "Do not spend it"]
    case "clone":
      return [
        preview.repos.length > 1
          ? `Clone the ${preview.repos.length} repos`
          : `Clone ${preview.repos[0]?.repo}`,
        "Do not clone",
      ]
    case "delete":
      return ["Delete it", "Keep it"]
    case "grant":
      return [`Open the ${preview.permission} settings`, "Not now"]
    case "guard":
      return preview.value === undefined
        ? [`Take ${preview.key} back to its default`, "Keep it as it is"]
        : [`Set ${preview.key}`, "Keep it as it is"]
    case "own":
      return preview.own
        ? [`Mark ${preview.key} as your own account`, "Keep it as it is"]
        : [`Unmark ${preview.key} as your own account`, "Keep it as it is"]
    case "reveal":
      return ["Done, I have it", "I do not need it"]
    case "root":
      return preview.step === "install"
        ? ["Install the root steps", "Do not install them"]
        : [`Run ${preview.step} as root`, "Do not run it"]
    case "schema":
      return ["Apply this schema", "Do not apply it"]
    case "ship":
      return [`Ship ${preview.sha.slice(0, 7)} to main`, "Hold the ship"]
    case "slack":
      return [`Send it to ${preview.to}`, "Do not send it"]
    case "ticket":
      return [`File it in ${preview.team}`, "Do not file it"]
  }
}

// Pure: an option's letter, A for the first row.
export const optionLetter = (index: number): string => String.fromCharCode(65 + index)

// Pure: a decision's rows, its go rows then its no-go row, each lettered by place; null for a secret, which takes a value instead.
export function choicesOf(preview: ChoicePreview): Choices | null {
  if (preview.type === "secret") return null
  if (preview.type !== "ask") {
    const [go, no] = defaultLabels(preview)
    return {
      rows: lettered([
        { go: true, label: go },
        { go: false, label: no },
      ]),
      shape: "yes-no",
    }
  }
  const go = preview.options ?? [{ label: preview.approve ?? "Approve" }]
  const shape = go.length > 1 ? "letters" : "yes-no"
  const no = preview.deny ?? (shape === "letters" ? "None of these" : "Deny")
  return {
    rows: lettered([...go.map((row) => ({ ...row, go: true })), { go: false, label: no }]),
    shape,
  }
}

const lettered = (rows: Omit<ChoiceRow, "index" | "letter">[]): ChoiceRow[] =>
  rows.map((row, index) => ({ ...row, index, letter: optionLetter(index) }))

// Pure: the row an answer picked, for the poster's payload and the owner's result line alike: a deny's no-go row, else the go row its option names, the first when it names none; null for a secret or an option past the rows.
export function rowOfAnswer(
  preview: ChoicePreview,
  answer: { choice: string; option?: number },
): ChoiceRow | null {
  const rows = choicesOf(preview)?.rows ?? []
  const row =
    answer.choice === "deny"
      ? rows.find((r) => !r.go)
      : rows.filter((r) => r.go)[answer.option ?? 0]
  return row ?? null
}

// A multi-question ask's one question, as the card shows it: its prompt, its options lettered A on, and the index of the one it recommends.
export type AskQuestion = { options: ChoiceRow[]; question: string; recommended?: number }

// Pure: each question of a multi-question ask, its options lettered as go rows with no no-go row, since one is picked for every question; empty for an ask with no questions or any other preview.
export function questionsOf(preview: ChoicePreview): AskQuestion[] {
  if (preview.type !== "ask" || !preview.questions) return []
  return preview.questions.map((q) => ({
    options: lettered(q.options.map((option) => ({ ...option, go: true }))),
    question: q.question,
    recommended: q.recommended,
  }))
}

// Pure: the option the owner picked in each question of a multi-question ask, by its letter and label, for the poster's payload and the result line; null for an ask with no questions, a wrong count of picks, or a pick past a question's options.
export function picksOf(
  preview: ChoicePreview,
  options: number[],
): { index: number; label: string; letter: string; question: string }[] | null {
  const questions = questionsOf(preview)
  if (questions.length === 0 || options.length !== questions.length) return null
  const picks: { index: number; label: string; letter: string; question: string }[] = []
  for (const [at, question] of questions.entries()) {
    const row = question.options[options[at]!]
    if (!row) return null
    picks.push({
      index: row.index,
      label: row.label,
      letter: row.letter,
      question: question.question,
    })
  }
  return picks
}

// The two fields a card's place reads: pinned when pinnedAt is set, placed by hand when rank is.
export type InboxPlace = {
  pinnedAt: string | null
  rank: string | null
}

// Pure: the cards, pinned first, each group's unranked first in the order given (today's order, since the sort is stable), then its ranked by rank; a rank compares by code point here, never in ORDER BY, whose collation can read the same keys differently.
export function orderInboxItems<T extends InboxPlace>(items: T[]): T[] {
  const byRank = (a: T, b: T): number =>
    a.rank === b.rank ? 0 : a.rank === null ? -1 : b.rank === null ? 1 : a.rank < b.rank ? -1 : 1
  return [...items].sort(
    (a, b) => Number(a.pinnedAt === null) - Number(b.pinnedAt === null) || byRank(a, b),
  )
}

const RANK_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// Pure: a key strictly between two neighbour ranks, null at a tab's end, from base-62 digits alone, so Postgres text stores it and no key ends in "0", which keeps room below every key (fractional-indexing's midpoint).
export function rankBetween(prev: string | null, next: string | null): string {
  return rankMidpoint(prev ?? "", next)
}

function rankMidpoint(low: string, high: string | null): string {
  if (high !== null) {
    let n = 0
    while ((low[n] ?? "0") === high[n]) n++
    if (n > 0) return high.slice(0, n) + rankMidpoint(low.slice(n), high.slice(n))
  }
  const a = low === "" ? 0 : RANK_DIGITS.indexOf(low[0]!)
  const b = high === null ? RANK_DIGITS.length : RANK_DIGITS.indexOf(high[0]!)
  if (b - a > 1) return RANK_DIGITS[Math.round((a + b) / 2)]!
  if (high !== null && high.length > 1) return high.slice(0, 1)
  return RANK_DIGITS[a]! + rankMidpoint(low.slice(1), null)
}

// When the Inbox stopped moving cards by the clock, set at this change's last code commit before the live dashboard took it: the old clock had already moved every card answered or read before then to Done, so those keep the list's week, while each one since stays in the Inbox until a verb moves it (inboxView in the web, listItems in the API).
export const CLOCKS_STOPPED_AT = "2026-11-05T03:44:00.000Z"

// The root steps an Inbox card can run, each a fixed script in api/hono/src/lib/system/root that the install card puts under ROOT_DIR, owned by root: one per kind, by its name, with the paths it writes (which the machine record takes once it runs), what it does and how to undo it in plain words. Nothing a card holds reaches its argv, as probe.ts's COMMANDS holds the System panel's reads.
export const ROOT_STEPS = {
  "bwrap-userns": {
    adds: ["/etc/apparmor.d/bwrap"],
    undo: "remove /etc/apparmor.d/bwrap and unload its AppArmor profile",
    what: "Lets Claude Code's sandbox start: an AppArmor profile that lets bwrap make a user namespace",
  },
  "chromium-ca": {
    adds: [
      "/etc/chromium/policies/managed/portless-ca.json",
      "/etc/opt/chrome_for_testing/policies/managed/portless-ca.json",
    ],
    undo: "remove /etc/chromium/policies/managed/portless-ca.json and /etc/opt/chrome_for_testing/policies/managed/portless-ca.json",
    what: "Lets Helium and Chrome for Testing trust the Dashboard's certificate for .localhost addresses alone, through a browser policy; Helium may then show Managed by your organization in its menu, and needs one restart",
  },
} as const

export type RootStep = keyof typeof ROOT_STEPS

export const ROOT_NAMES = Object.keys(ROOT_STEPS) as [RootStep, ...RootStep[]]

export const ROOT_BASE = "/usr/local/lib/playground"
export const ROOT_DIR = `${ROOT_BASE}/root`

// The Dashboard's CA as the install kept it, root's own: DER, checked against the approved card's hash, the one file chromium-ca reads.
export const ROOT_CA = `${ROOT_BASE}/data/portless-ca.der`

// The most of a CA file the install reads, so a file that is not a CA never fills root's staging folder.
export const CA_MAX_BYTES = 16_384

export const HEX64 = /^[0-9a-f]{64}$/

const REFUSE_HASH = 'echo "refused: a hash is not 64 lowercase hex" >&2; exit 1'

const refuse = (why: string) => `{ echo "refused: ${why}" >&2; exit 1; }`

// The install, run by /bin/sh as root before any root-owned script exists, so the card shows this very text: it refuses any hash that is not 64 lowercase hex, copies each script into a root-owned staging folder, checks each copy against the hash the approved card passed, and moves them into place, or refuses with nothing moved. With the CA's path and hash after the scripts' hashes, it reads at most CA_MAX_BYTES of the CA once, refuses a file over that or holding other than one certificate, turns that copy into DER and keeps it at ROOT_CA only if the DER matches the card's hash.
export const INSTALL_TEXT = [
  "set -eu",
  "umask 022",
  `base=${ROOT_BASE}`,
  "src=$1",
  "shift",
  'case $src in /*) ;; *) echo "refused: the scripts folder is not an absolute path" >&2; exit 1 ;; esac',
  `[ $# -eq ${ROOT_NAMES.length} ] || [ $# -eq ${ROOT_NAMES.length + 2} ] || ${refuse(`${ROOT_NAMES.length} hashes are needed, one for each script, then the CA's path and hash or neither`)}`,
  "n=0",
  'for h in "$@"; do',
  "  n=$((n + 1))",
  `  [ $n -le ${ROOT_NAMES.length} ] || break`,
  `  case $h in *[!0123456789abcdef]*) ${REFUSE_HASH} ;; esac`,
  `  [ \${#h} -eq 64 ] || { ${REFUSE_HASH}; }`,
  "done",
  'mkdir -p "$base/root" "$base/data"',
  'chown root:root "$base" "$base/root" "$base/data"',
  'chmod 0755 "$base" "$base/root" "$base/data"',
  'stage=$(mktemp -d "$base/.stage.XXXXXX")',
  `trap 'rm -f "$stage"/*; rmdir "$stage"' EXIT`,
  `for name in ${ROOT_NAMES.join(" ")}; do`,
  '  cp "$src/$name" "$stage/$name"',
  '  sum=$(sha256sum "$stage/$name")',
  '  [ "${sum%% *}" = "$1" ] || { echo "refused: $name changed since you approved it" >&2; exit 1; }',
  "  shift",
  "done",
  "if [ $# -eq 2 ]; then",
  `  case $1 in /*) ;; *) ${refuse("the CA's path is not absolute")} ;; esac`,
  `  case $2 in *[!0123456789abcdef]*) ${REFUSE_HASH} ;; esac`,
  `  [ \${#2} -eq 64 ] || { ${REFUSE_HASH}; }`,
  `  head -c ${CA_MAX_BYTES + 1} "$1" > "$stage/ca.pem"`,
  `  [ "$(wc -c < "$stage/ca.pem")" -le ${CA_MAX_BYTES} ] || ${refuse(`the CA file is over ${CA_MAX_BYTES / 1024} KB`)}`,
  `  [ "$(grep -c -- "-----BEGIN CERTIFICATE-----" "$stage/ca.pem")" -eq 1 ] || ${refuse("the CA file holds other than one certificate")}`,
  '  openssl x509 -in "$stage/ca.pem" -outform DER -out "$stage/ca.der"',
  '  sum=$(sha256sum "$stage/ca.der")',
  `  [ "\${sum%% *}" = "$2" ] || ${refuse("the Dashboard's CA changed since you approved it")}`,
  "fi",
  `for name in ${ROOT_NAMES.join(" ")}; do`,
  '  chown root:root "$stage/$name"',
  '  chmod 0755 "$stage/$name"',
  '  mv -f "$stage/$name" "$base/root/$name"',
  "done",
  `echo "installed ${ROOT_NAMES.join(", ")} in $base/root"`,
  'if [ -f "$stage/ca.der" ]; then',
  '  chown root:root "$stage/ca.der"',
  '  chmod 0644 "$stage/ca.der"',
  '  mv -f "$stage/ca.der" "$base/data/portless-ca.der"',
  `  echo "kept the Dashboard's CA in $base/data/portless-ca.der"`,
  "fi",
].join("\n")

// A peer machine's polkit setup, which its install writes beside the scripts: one action per listed step, pinned to its installed script, and one rule that answers yes to those actions alone, for the user whose sudo ran the install, so each later step there runs with no password.
export const PEER_ACTION = "org.playground.root"
export const PEER_POLICY = `/usr/share/polkit-1/actions/${PEER_ACTION}.policy`
export const PEER_RULE = "/etc/polkit-1/rules.d/49-playground-root.rules"

const PEER_POLICY_LINES = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN" "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">',
  "<policyconfig>",
  ...ROOT_NAMES.flatMap((name) => [
    `  <action id="${PEER_ACTION}.${name}">`,
    `    <description>Run the Playground root step ${name}</description>`,
    `    <message>The Playground root step ${name} needs an administrator</message>`,
    "    <defaults><allow_any>auth_admin</allow_any><allow_inactive>auth_admin</allow_inactive><allow_active>auth_admin</allow_active></defaults>",
    `    <annotate key="org.freedesktop.policykit.exec.path">${ROOT_DIR}/${name}</annotate>`,
    "  </action>",
  ]),
  "</policyconfig>",
]

const PEER_IDS = ROOT_NAMES.map((name) => `"${PEER_ACTION}.${name}"`).join(", ")

// The install on a peer, run by sudo's /bin/sh with the password on sudo's stdin alone: it reads no stdin of its own, refuses when sudo named no user but root, then runs INSTALL_TEXT, then writes the polkit action file and the rule, each root's own and world-readable, or refuses with the rule unwritten.
export const PEER_INSTALL_TEXT = [
  "set -eu",
  "user=${SUDO_USER:-}",
  `case $user in ""|root|*[!abcdefghijklmnopqrstuvwxyz0123456789_-]*) ${refuse("sudo named no user other than root, so the rule names no one")} ;; esac`,
  `[ -d ${PEER_POLICY.slice(0, PEER_POLICY.lastIndexOf("/"))} ] || ${refuse("this machine has no polkit actions folder")}`,
  `[ -d ${PEER_RULE.slice(0, PEER_RULE.lastIndexOf("/"))} ] || ${refuse("this machine has no polkit rules folder")}`,
  INSTALL_TEXT,
  `printf '%s\\n' ${PEER_POLICY_LINES.map((line) => `'${line}'`).join(" ")} > "$stage/policy"`,
  `printf '%s\\n' '// Playground root steps: these actions alone, for this user alone, with no password' 'polkit.addRule(function (action, subject) {' > "$stage/rule"`,
  `printf '  if (subject.user === "%s" && [%s].indexOf(action.id) >= 0) return polkit.Result.YES;\\n' "$user" '${PEER_IDS}' >> "$stage/rule"`,
  `printf '%s\\n' '});' >> "$stage/rule"`,
  'chown root:root "$stage/policy" "$stage/rule"',
  'chmod 0644 "$stage/policy" "$stage/rule"',
  `mv -f "$stage/policy" ${PEER_POLICY}`,
  `mv -f "$stage/rule" ${PEER_RULE}`,
  `echo "let $user run ${ROOT_NAMES.join(", ")} as root with no password, through ${PEER_RULE}"`,
].join("\n")
