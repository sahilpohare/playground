import "@/bin/ask-from-clone"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { ASK_CODE_COLUMNS } from "@packages/config/inbox"
import { createDatabase } from "@packages/db"
import { env } from "@packages/env/db"
import { factorySettings, readPolicyOrDefaults, ruleSettings } from "@packages/settings"

import { fillNow, futureNowTimes, NOW, ownerTime } from "@/lib/dashboard/ask-clock"
import { ASK_EXAMPLES, isAskExampleKind, shapeHints } from "@/lib/dashboard/ask-shape"
import { deleteRefusal } from "@/lib/dashboard/delete-targets"
import { branchOf, checkoutRoot, readsLive } from "@/lib/dashboard/fixture"
import {
  ackItem,
  editItem,
  getItem,
  getPickLine,
  itemTag,
  openItems,
  postItem,
  readAnswer,
  resolveItem,
  settleItem,
  staleItems,
} from "@/lib/dashboard/inbox"
import { keepAttachments } from "@/lib/dashboard/inbox-attachments"
import { publicDraftRefusal } from "@/lib/dashboard/public-draft"
import { linkShipPrs, repoOfRemote } from "@/lib/dashboard/ship-links"
import { whatsappAnswer } from "@/lib/dashboard/whatsapp-answer"
import { livePair, mainCheckoutOf, othersLiveDashboard } from "@/lib/dev/launch"
import { checkoutMismatch, locate, prove } from "@/lib/sessions/guard"
import { dataDir } from "@/lib/sessions/paths"

// The one way into Playground's Inbox: `bun run ask new < item.json` posts a decision, a draft or an update and prints its id (its #iN tag on stderr); `edit <id|#iN> < item.json` replaces the poster's own item's title and preview in place until it closes, checked as new checks it; both fill `{now}` with the time they post at and refuse a measured or now time ahead of the clock, and a draft with no link, a public post's, whose text holds a work figure or an internal name (the public rule); `open [--from <session>] [--since <iso time>] [--until <iso time>] [--json]` lists the open items, oldest first, those posted in that window alone when given, each whole as one JSON line with --json, so a poster names one on the same thing rather than posting it twice; `get <id|#iN>` prints the item, the owner's answer included once given, and the option the owner picked on stderr, and `--ack` marks that answer read, so the Dashboard shows it reached the poster, closing a deny, a clear, a discard or a provided secret; `ack <id>` closes it once carried out, a go with `--link` (where it landed) or `--no-link "<why>"`; `settle <id>` closes the poster's own open item once it is decided another way; `resolve <id> --by <you>` closes the poster's own update once it has settled; `stale` lists the answers no poster has closed, for ops-sweep; `whatsapp <file>` records the owner's answer from WhatsApp, a file ops-wa wrote in its own folder (whatsapp-answer.ts); `example <kind>` prints an ask to start from, and `new` hints at that shape when an ask is one block of prose, labels no options, names a PR, a tracker ID or a commit with no link on its line, or holds a code line too wide for the card. See `.agents/dashboard/asks.md` for the fields.
const USAGE = `usage: bun run ask new [--thread <id>] < item.json
                                                posts an inbox item from JSON on stdin, prints its id
                                                options and approve/deny labels go in plain words (the plain-words skill)
                                                an ask's, a draft's or a slack decision's attachments name files on
                                                this Mac by absolute path; a draft's or a slack decision's go into
                                                its Slack link's thread on Send or Approve, before its words
                                                an update with text and attachments is a read-only card: it shows
                                                them as an ask does, with no Approve or Deny
                                                a secret ask names a key and a sink (a Vercel project, or a Keychain
                                                item such as yard); the owner's value goes to the sink, and get shows
                                                only when and each exit status, or saved
                                                an own decision names one Claude account's email in usage.accounts
                                                at a scope and the own flag Approve leaves it with; a key that names
                                                no Claude row there (a GLM label included) is refused
                                                an accept decision names one proposal (scope, kind, key, rev), and
                                                more lists up to 20 further ones, accepted after it in that order;
                                                Approve stops at the first that fails
                                                a guard decision names a key a guard reads, or an ops job's
                                                jobs.<name>, or an org's own job's jobs.<camelName>, whose value is
                                                {"enabled": true|false} alone or {"config": {...}} alone, any
                                                object, or an org's own job's whole row; Approve writes it at its
                                                scope, a part over the row there, and Settings > Jobs toggles a job
                                                and edits its config too
                                                --thread files it under that thread (bun run thread)
                                                write {now} for a now-time, which new and edit fill with the time
                                                they post at; a "measured" or "now" time ahead of the clock is refused
                                                a draft with no link is a public post's: one whose text holds a work
                                                figure or an internal name is refused (playground rules public)
       bun run ask edit <id|#iN> < item.json
                                                replaces your own item's title, preview and attachments
                                                in place, checked as new checks it, so one card carries a
                                                progress to its end: an update until it is Done or dismissed,
                                                an ask, answered or not, until it closes; one put away with Later stays put away
       bun run ask example <code|decision|delete|questions|slack|ui>
                                                prints an item to start from: an ask's picture and its note, bullets,
                                                then what Approve does (.agents/dashboard/asks.md, The ask's shape),
                                                a delete decision naming its worktree by its full path,
                                                or a Slack message led by its thread so far
       bun run ask open [--from <session>] [--since <iso time>] [--until <iso time>] [--json]
                                                lists each open item, oldest first: its #iN, kind, sender and title;
                                                run it before new, and name an open item on the same thing
                                                rather than posting it again; --from keeps one sender's,
                                                --since and --until those posted in that window,
                                                --json each item whole, one JSON line each, as ops-wa reads them
       bun run ask get <id|#iN> [--ack]    prints the item, answer included; --ack marks an answer read
                                                a picked option's letter and label print on stderr, each question's pick for a multi-question answer
                                                (and closes a deny, a clear, a discard or a provided secret, which reading carries out)
       bun run ask ack <id|#iN> [--link <https url> [--label "Filed ABC-123"] | --no-link "<why>"]
                                                closes the answer once carried out; a go (approve, draft, edit, send)
                                                needs --link, where it landed (the Slack message, PR, issue or
                                                Linear ticket), which its card links to, named by --label, else
                                                by the link itself, or --no-link with why there is none
       bun run ask settle <id|#iN> [--note "<one line>"] [--link <https url> [--label "<one line>"]]
                                                closes your own open item, decided another way
       bun run ask resolve <id|#iN> --by <your session name> [--note "<one line>"]
                                                closes your own update once it has settled: an alert whose
                                                cause cleared, a progress card whose last step is done
       bun run ask stale [--minutes 15] [--since <iso time>]
                                                lists each answer given since --since (default 24h ago)
                                                that its poster has not acked within --minutes
       bun run ask whatsapp <file>         ops-wa's alone: records the owner's answer from WhatsApp, read from
                                                a file ops-wa wrote in <data>/whatsapp/answers/, and types it into
                                                the poster as the card's own answer would`

// An agent's shell hands a command a stdin that never closes, so waiting on it unbounded would hang the call that forgot the redirect.
const STDIN_TIMEOUT_MS = 5000

const DAY_MS = 24 * 60 * 60 * 1000

const fail = (message: string, code = 1): never => {
  console.error(`ask: ${message}`)
  process.exit(code)
}

const [command, key, ...rest] = process.argv.slice(2)

// A template needs no database, so it prints before the checkout's database is proved.
if (command === "example") {
  if (key === undefined || rest.length > 0 || !isAskExampleKind(key)) fail(USAGE, 2)
  else console.log(JSON.stringify(ASK_EXAMPLES[key], null, 2))
  process.exit(0)
}

// A checkout that does not read the live machine (a factory checkout or session, a test run) has its own database, so say so on stderr, where it leaves the id on stdout clean: an item posted here never reaches the owner.
if (!readsLive()) {
  console.error(
    "ask: this checkout reads the fixture, and the owner's Dashboard (the live dashboard) never shows its inbox; for a real item, run bun run --cwd <the live dashboard's checkout> ask",
  )
}

const acking = rest.length === 1 && rest[0] === "--ack"
// --json, open's one flag that takes no value, read apart from the paired flags
const json = command === "open" && [key, ...rest].includes("--json")
const openArgs = [key, ...rest].filter(
  (arg): arg is string => arg !== undefined && arg !== "--json",
)

// Pure: `--name value` pairs, each named at most once and only from allowed; null for anything else.
const flagsOf = (args: string[], allowed: string[]): Record<string, string> | null => {
  if (args.length % 2 !== 0) return null
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, "") ?? ""
    if (!args[i]?.startsWith("--") || !allowed.includes(name) || name in flags) return null
    flags[name] = args[i + 1] ?? ""
  }
  return flags
}

const flags =
  command === "ack"
    ? flagsOf(rest, ["label", "link", "no-link"])
    : command === "resolve"
      ? flagsOf(rest, ["by", "note"])
      : command === "settle"
        ? flagsOf(rest, ["label", "link", "note"])
        : command === "open"
          ? flagsOf(openArgs, ["from", "since", "until"])
          : command === "stale" || command === "new"
            ? flagsOf(
                key === undefined ? [] : [key, ...rest],
                command === "new" ? ["thread"] : ["minutes", "since"],
              )
            : {}
const valid =
  (command === "get" && key && (rest.length === 0 || acking)) ||
  ((command === "ack" || command === "settle") && key && flags !== null) ||
  (command === "resolve" && key && flags !== null && !!flags.by) ||
  (command === "stale" && flags !== null) ||
  (command === "open" && flags !== null && flags.from !== "") ||
  (command === "new" && flags !== null && flags.thread !== "" && !process.stdin.isTTY) ||
  (command === "edit" && key && rest.length === 0 && !process.stdin.isTTY) ||
  (command === "whatsapp" && key && rest.length === 0)
if (!valid) fail(USAGE, 2)

// The database, proved this machine's own container before the first read or write, as bun run ingest does; the live dashboard's is refused off its own checkout, as the launcher refuses it, so a worktree's item never lands in the owner's inbox.
try {
  // a run by path from another checkout, or a POSTGRES_URL exported over the .env, reaches a database this checkout never shows; a test run passes its own container's URL on purpose
  const root = checkoutRoot()
  const dotenv =
    root === null
      ? null
      : await Bun.file(join(root, ".env"))
          .text()
          .catch(() => null)
  const stray = process.env.NODE_ENV === "test" ? null : checkoutMismatch(env.POSTGRES_URL, dotenv)
  if (stray) fail(stray)
  const located = locate(env.POSTGRES_URL)
  if (othersLiveDashboard(located.owner.name, branchOf(root))) {
    fail(
      `refusing ${livePair().database}, the live dashboard's database, off its own checkout (branch ${livePair().branch}); run bun run --cwd <the live dashboard's checkout> ask`,
    )
  }
  await prove(env.POSTGRES_URL, located)
} catch (error) {
  fail(`refusing to use the database: ${(error as Error).message}`)
}
const db = createDatabase(env.POSTGRES_URL)

if (command === "new" || command === "edit") {
  const timer = setTimeout(
    () => fail("no JSON arrived on stdin; redirect a file or pipe one in"),
    STDIN_TIMEOUT_MS,
  )
  const text = await Bun.stdin.text()
  clearTimeout(timer)
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    fail("stdin is not JSON")
  }
  // a "now" in an item is the clock's: a measured or now time ahead of it is refused, and {now} is filled with the time it posts at, in the owner's zone (clock.md)
  const policy = readPolicyOrDefaults(dataDir())
  const zone = ruleSettings.get(
    policy.refusal === undefined ? policy.settings : { schemaVersion: 1, values: {} },
    "clock.ownerZone",
  )
  const now = new Date()
  const ahead = futureNowTimes(input, now, zone)
  if (ahead.length > 0)
    fail(
      `a "measured" or "now" time runs ahead of the clock, ${ownerTime(now, zone)}: ${ahead.join("; ")}; write ${NOW}, which ask fills with the time it posts at`,
    )
  input = fillNow(input, now, zone)
  // a ship decision's PRs link into the factory's repo (factory.repo, else this checkout's origin), so the owner opens each from the card
  const factory = factorySettings.get(
    policy.refusal === undefined ? policy.settings : { schemaVersion: 1, values: {} },
    "factory.repo",
  )
  input = linkShipPrs(
    input,
    factory ||
      repoOfRemote(
        Bun.spawnSync(["git", "remote", "get-url", "origin"], {
          stderr: "ignore",
        }).stdout.toString(),
      ),
  )
  // a delete names its targets by full path, the one playground rm --decision matches, so the owner approves it once
  const main = mainCheckoutOf(process.cwd())
  const shortDelete = deleteRefusal(input, {
    cwd: process.cwd(),
    exists: existsSync,
    home: homedir(),
    worktrees: main === null ? null : join(main, ".claude", "worktrees"),
  })
  if (shortDelete) fail(shortDelete)
  // a draft with no link is a public post's, which goes out in the owner's own words alone (the public rule): scripts/hooks/public-draft.ts reads it with the leak guards' own finders, as a child
  const publicLeak = await publicDraftRefusal(input)
  if (publicLeak) fail(publicLeak)
  for (const hint of shapeHints(input)) {
    console.error(
      hint.kind === "prose"
        ? "ask: this ask is one block of prose; lead with a picture of the point (an ASCII flow or a diff in a code block) and a one-sentence note under it, then short bullets, then its options, in its `options` and `deny` labels. playground ask example code|decision|ui prints a template (.agents/dashboard/asks.md, The ask's shape)"
        : hint.kind === "unlabelled"
          ? 'ask: this ask labels no options, so its card shows a bare Approve and Deny; for a yes or no, label one option, "options": [{"label": "..."}], with "deny"; for real alternatives, label 2 to 5 (.agents/dashboard/asks.md, The ask\'s shape)'
          : hint.kind === "unlinked"
            ? `ask: ${hint.refs.join(", ")} named with no link on its line; link each so the owner can open it: a PR as [#N](https://github.com/<owner>/<repo>/pull/N), a commit as [sha](https://github.com/<owner>/<repo>/commit/<sha>), a ticket at its tracker's URL (to-inbox, Links; .agents/dashboard/asks.md, The ask's shape)`
            : `ask: a code or ASCII line runs ${hint.longest} characters, past the ${ASK_CODE_COLUMNS} the narrowest Inbox card shows on one line; break or shorten it (.agents/dashboard/asks.md, The ask's shape)`,
    )
  }
  // the files an ask names are copied in first, so the item keeps their ids, never a path on this Mac
  const kept = await keepAttachments(input)
  if (!kept.ok) fail(kept.message)
  const result =
    command === "edit"
      ? await editItem(db, key as string, kept.ok ? kept.input : input, undefined, dataDir())
      : await postItem(db, kept.ok ? kept.input : input, flags?.thread, undefined, dataDir())
  if (!result.ok)
    fail(
      command === "edit" && result.code === "NOT_FOUND" ? `no inbox item ${key}` : result.message,
    )
  else {
    // the id alone on stdout, as a poster's `id=$(bun run ask new < f)` takes it; the tag the owner sees beside it on stderr
    if (command === "new") console.log(result.item.id)
    console.error(`ask: ${command === "edit" ? "edited" : "posted"} ${itemTag(result.item.ref)}`)
    // a draft whose link is a Slack message replies to it, so the poster checks it is still unanswered
    const link = (result.item.preview as { link?: string }).link ?? ""
    if (result.item.kind === "draft" && link.includes("/thread/")) {
      console.error(
        "ask: this draft replies to a message: read that conversation from it on, thread and top level, and settle this draft if the owner has already answered",
      )
    }
  }
} else if (command === "get") {
  let item = await getItem(db, key as string)
  if (!item) fail(`no inbox item ${key}`)
  // An open item is printed as it is, so a poll with --ack only marks the answer once there is one; an update takes none, though a dismissed one records when in its answer.
  if (acking && item) item = await readAnswer(db, item)
  console.log(JSON.stringify(item, null, 2))
  const picked = item && getPickLine(item)
  if (picked) console.error(`ask: picked ${picked}`)
} else if (command === "open") {
  const at = (flag: "since" | "until") => {
    const value = flags?.[flag]
    if (value === undefined) return undefined
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) fail(`--${flag} takes an ISO time`)
    return date
  }
  for (const item of await openItems(db, {
    from: flags?.from,
    since: at("since"),
    until: at("until"),
  }))
    console.log(
      json
        ? JSON.stringify(item)
        : `${itemTag(item.ref)} ${item.kind} from ${item.from} · ${item.title}`,
    )
} else if (command === "whatsapp") {
  // deliver() types the answer into its poster as the Inbox's own Approve does; imported here alone, since no other verb types into a session
  const { deliver } = await import("@/lib/dashboard/deliver")
  const { DISPATCHER } = await import("@/lib/dashboard/workers")
  const answered = await whatsappAnswer(db, key as string, {
    data: dataDir(),
    deliver,
    dispatcher: DISPATCHER,
  })
  if (!answered.ok) fail(answered.message)
  else console.log(answered.line)
} else if (command === "stale") {
  const minutes = Number(flags?.minutes ?? 15)
  const since = flags?.since === undefined ? new Date(Date.now() - DAY_MS) : new Date(flags.since)
  if (!Number.isInteger(minutes) || minutes < 0) fail("--minutes takes a whole number")
  if (Number.isNaN(since.getTime())) fail("--since takes an ISO time")
  const now = Date.now()
  // one line an answer: its tag and id, its poster, how its delivery stands and how long ago the owner answered
  for (const item of await staleItems(db, { minutes, since })) {
    const delivery = item.delivery
    const state =
      delivery?.status === "failed"
        ? `failed (${delivery.code}: ${delivery.reason})`
        : (delivery?.status ?? "pending")
    const at = item.answer && "at" in item.answer ? item.answer.at : item.updatedAt
    const ago = Math.round((now - Date.parse(at)) / 60_000)
    console.log(
      `${itemTag(item.ref)} ${item.id} from ${item.from}: ${state}, answered ${ago}m ago, not acked · ${item.title}`,
    )
  }
} else if (command === "settle") {
  const settled = await settleItem(db, key as string, {
    label: flags?.label,
    link: flags?.link,
    note: flags?.note,
  })
  if (!settled.ok) fail(settled.code === "NOT_FOUND" ? `no inbox item ${key}` : settled.message)
  else console.log(`${settled.item.id} settled by ${settled.item.from}`)
} else if (command === "resolve") {
  const resolved = await resolveItem(db, key as string, { by: flags?.by ?? "", note: flags?.note })
  if (!resolved.ok) fail(resolved.code === "NOT_FOUND" ? `no inbox item ${key}` : resolved.message)
  else console.log(`${resolved.item.id} resolved by ${resolved.item.from}`)
} else {
  const acked = await ackItem(db, key as string, {
    label: flags?.label,
    link: flags?.link,
    noLink: flags?.["no-link"],
  })
  if (!acked.ok) fail(acked.code === "NOT_FOUND" ? `no inbox item ${key}` : acked.message)
  else {
    // The same line for a repeated ack with the same flags, since it states what is recorded rather than what this call did.
    const { delivery, from, id } = acked.item
    if (delivery?.status === "delivered") {
      console.log(
        delivery.via === "cli"
          ? `${id} read by ${from} at ${delivery.at}`
          : `${id} delivered to ${delivery.to ?? from}'s session at ${delivery.at}`,
      )
    }
  }
}
process.exit(0)
