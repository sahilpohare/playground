import { basename } from "node:path"

import { picksOf } from "@packages/config/inbox"

import { MIN_LIST_BYTES, type Machine, SHARD, type Unused } from "./unused"

// The owner's one Inbox card for each machine's unused space: nightly-clean posts it, edits it in place while it stands open, and once answered removes each Remove pick by its own handle; `playground rm --card` reads the same card to check its approval itself.

// The Planner's trial record: a model test's replay worktrees and logs stay off the card, listed only.
export const KIT_RECORD = ["models/kit/logs", "models/kit/runs"]
// The most questions one card holds, its Inbox limit; the rest wait for the next card.
export const CARD_MAX = 20

export type CardItem = {
  bytes: number
  id?: string
  kind: Unused["kind"]
  machine: string
  path: string
  recorded?: true
  shards?: string[]
}
// One Remove the owner picked, as its question names it.
export type CardPick = { bytes: number; machine: string; path: string }
// The open card nightly-clean keeps in its state file: its Inbox id, the items it asks about, and at, the card's updatedAt read back right after nightly-clean's own last post or edit.
export type CardState = { at?: string; id: string; items: CardItem[] }
// Each item the owner kept, by `<machine> <path>`, at the bytes it was kept at: it stays off later cards until its size changes.
export type Kept = Record<string, number>

// An Inbox item as `bun run ask get` prints it: the fields an approval reads, and createdAt the guard falls back to when the saved write time is missing.
export type CardAnswer = {
  answer?: { at?: string; choice?: string; options?: number[] }
  createdAt?: string
  from?: string
  preview?: {
    deny?: string
    options?: { description?: string; label: string }[]
    questions?: {
      options: { description?: string; label: string }[]
      question: string
      recommended?: number
    }[]
    text?: string
    type?: string
  }
  status?: string
  updatedAt?: string
}

const GB = 1024 ** 3
const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)

// Pure: one item's question, whose words an approval is read back from, so the path, the machine and the exact size the owner saw are the ones a removal checks.
export const questionOf = (item: CardItem): string =>
  `Remove \`${item.path}\` on ${item.machine}, ${item.bytes} bytes (${(item.bytes / GB).toFixed(1)} GB)?`

const QUESTION = /^Remove `(.+)` on ([A-Za-z0-9._-]+), (\d+) bytes \([\d.]+ GB\)\?$/

// A sharded set's note, read through SHARD: a whole set reads "all N of N shards", and a set missing a shard names each shard that is present.
const shardedNote = (shards: string[]): string => {
  const [, stem, , total] = SHARD.exec(basename(shards[0]!))!
  const present = shards.map((p) => Number(SHARD.exec(basename(p))![2]))
  const complete = present.length === Number(total) && present.every((n, i) => n === i + 1)
  return complete
    ? ` It is ${stem}, all ${present.length} of ${Number(total)} shards.`
    : ` It is ${stem}, with only shards ${present.join(", ")} of ${Number(total)} here.`
}

const removeRow = (item: CardItem) => ({
  description: `${
    item.kind === "weights"
      ? "Deleted outright, cannot be restored; it downloads again."
      : item.kind === "image"
        ? "docker image rm removes it; a pull brings it back."
        : "Moved to the trash; playground rm --restore brings it back for 7 days."
  }${item.recorded && item.kind !== "image" ? " The machine record holds it, and its entry there goes too." : ""}${
    item.shards ? shardedNote(item.shards) : ""
  }`,
  label: "Remove",
})

const keyOf = (item: { machine: string; path: string }) => `${item.machine} ${item.path}`

// Pure: every item the card may ask about tonight, the largest first: each machine's items at MIN_LIST_BYTES or over, a recorded one marked, since the record guards it from every removal but the owner's own, but the trial record's, each rehearsal whose tag is not out yet (out reads it), and each the owner kept at the same size.
export const offered = (
  found: Machine[],
  home: string,
  out: (rehearsal: string) => boolean,
  kept: Kept,
): CardItem[] =>
  found
    .flatMap((m) =>
      "why" in m
        ? []
        : m.items
            .filter((i) => i.bytes >= MIN_LIST_BYTES)
            .filter((i) => !KIT_RECORD.some((rel) => inside(i.path, `${home}/${rel}`)))
            .filter((i) => i.kind !== "rehearsal" || out(i.path))
            .filter((i) => kept[keyOf({ machine: m.machine, path: i.path })] !== i.bytes)
            .map(({ bytes, id, kind, path, recorded, shards }) => ({
              bytes,
              ...(id ? { id } : {}),
              kind,
              machine: m.machine,
              path,
              ...(recorded ? { recorded: true as const } : {}),
              ...(shards ? { shards } : {}),
            })),
    )
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))

// Pure: kept as it stands after tonight: each key still listed tonight at its kept size, and each of a machine not read; an item gone or at a new size drops out, so it comes back on a card.
export const keptAfter = (found: Machine[], kept: Kept): Kept => {
  const next: Kept = {}
  for (const m of found)
    for (const [key, bytes] of Object.entries(kept))
      if (
        key.startsWith(`${m.machine} `) &&
        ("why" in m ||
          m.items.some(
            (i) => keyOf({ machine: m.machine, path: i.path }) === key && i.bytes === bytes,
          ))
      )
        next[key] = bytes
  return next
}

// Pure: the card's Inbox item: one yes or no for a single item, else one question each; weights carry no recommended badge, every other kind recommends Remove.
export const cardOf = (items: CardItem[]) => {
  const text = `Unused space nightly-clean found, {now}. Each Remove is done on the next night, only while the item is still unused at the same size; Keep leaves it.`
  const title = `Remove ${items.length} unused item${items.length === 1 ? "" : "s"}?`
  if (items.length === 1)
    return {
      kind: "decision",
      preview: {
        deny: "Keep",
        options: [removeRow(items[0]!)],
        text: `${questionOf(items[0]!)}\n\n${text}`,
        type: "ask",
      },
      title,
    }
  return {
    kind: "decision",
    preview: {
      questions: items.map((item) => ({
        options: [removeRow(item), { label: "Keep" }],
        question: questionOf(item),
        ...(item.kind === "weights" ? {} : { recommended: 0 }),
      })),
      text,
      type: "ask",
    },
    title,
  }
}

// Pure: each item the owner's answer picked Remove for, read back from the card's own words: a single question's Approve, or each question's Remove pick; none while the card is unanswered, denied, or from another poster than from.
export const approvedOf = (card: CardAnswer, from: string): CardPick[] => {
  if (card.from !== from || card.status !== "approved" || card.preview?.type !== "ask") return []
  const read = (question: string) => {
    const m = QUESTION.exec(question)
    return m ? [{ bytes: Number(m[3]), machine: m[2]!, path: m[1]! }] : []
  }
  const { questions, text } = card.preview
  if (!questions)
    return card.answer?.choice === "approve" ? read((text ?? "").split("\n")[0] ?? "") : []
  const picks = picksOf(card.preview as Parameters<typeof picksOf>[0], card.answer?.options ?? [])
  return (picks ?? []).flatMap((pick) => (pick.label === "Remove" ? read(pick.question) : []))
}

// Pure: what an answer is read against: each question with its options in order, or a single item's question, options and deny; the text's {now} the Inbox fills is left out.
const shapeOf = (preview: CardAnswer["preview"]) =>
  JSON.stringify({
    deny: preview?.deny,
    options: preview?.options?.map((o) => [o.label, o.description]),
    question: preview?.questions ? undefined : (preview?.text ?? "").split("\n")[0],
    questions: preview?.questions?.map((q) => [
      q.question,
      q.options.map((o) => [o.label, o.description]),
      q.recommended,
    ]),
  })

// What the card's night reads and runs: ask runs `bun run ask <args>` with stdin, remove takes one of this machine's picks away (docker image rm by its id, else playground rm --card), from is the ops manager's name the card posts under, here this machine's name, and out whether a rehearsal's tag is out.
export type CardDeps = {
  ask: (args: string[], stdin?: string) => Promise<{ code: number; out: string }>
  from: string
  here: string
  out: (rehearsal: string) => boolean
  remove: (item: CardItem, card: string) => Promise<{ code: number; out: string }>
}

const lastLine = (out: string) => out.trim().split("\n").at(-1) ?? ""

// An Inbox id as ask new prints it, the one form a card id takes.
export const CARD_ID = /^[0-9a-f-]{36}$/

// The card's JSON alone: ask get puts its `ask: picked` line on stderr, which a run joining both streams (ops-job's) leaves after it.
const cardJson = (out: string) => out.slice(out.indexOf("{")).replace(/(?:\n+ask: [^\n]*)+\s*$/, "")

// One card read by `bun run ask get <id>`, or ask's last line when it did not read.
export const readCard = async (ask: CardDeps["ask"], id: string): Promise<CardAnswer | string> => {
  const read = await ask(["get", id])
  try {
    if (read.code === 0) return JSON.parse(cardJson(read.out)) as CardAnswer
  } catch {}
  return lastLine(read.out) || `exit ${read.code}`
}

// Pure: card id's Remove picks, counted only when the card reads as nightly-clean last wrote it, cardOf of the items it saved, questions, order and options alike, and the answer came at or after that write (the saved write time, else the card's createdAt when none was saved, else no time to check against); else why it does not count, so no edit or race after the owner's answer approves what the owner did not pick.
export const savedPicks = (
  card: CardAnswer,
  from: string,
  saved: CardState | undefined,
  id: string,
): CardPick[] | string => {
  if (saved?.id !== id) return `card ${id} is not the card nightly-clean saved`
  if (shapeOf(card.preview) !== shapeOf(cardOf(saved.items).preview))
    return `card ${id} no longer reads as nightly-clean wrote it`
  const at = card.answer?.at
  // A saved write time is the card's own updatedAt from that write; none was saved, so fall back to the card's createdAt, the time ask get reads, and check the answer against it.
  const against = saved.at ?? card.createdAt
  if (!against || !at || at < against)
    return against
      ? `card ${id} was answered before nightly-clean's last write`
      : `card ${id} has no write time and no created time to check the answer against`
  return approvedOf(card, from)
}

// The card's updatedAt right after nightly-clean's own write, read back with ask get; none when it does not read, so no answer counts.
const writtenAt = async (ask: CardDeps["ask"], id: string) => {
  const read = await readCard(ask, id)
  return typeof read === "string" || !read.updatedAt ? {} : { at: read.updatedAt }
}

// Pure: the command each peer runs for one approved item, since a card's approved weights reach a peer only as a narrow `playground rm --peer` that re-checks there before deleteWeights, while an image is `docker image rm` and a replay a `playground rm` with a reason.
export const peerCommand = (item: CardItem, card: string): string =>
  item.kind === "image"
    ? `docker image rm ${item.id ?? item.path.replace(/^docker image /, "")}`
    : item.kind === "weights"
      ? `playground rm --card ${card} --peer ${item.machine} '${item.path.replaceAll("'", `'\\''`)}'`
      : `playground rm ${item.path} --reason "nightly-clean card ${card}"`

// One night of the card: an answered card's Remove picks still listed tonight at the same size are removed here (deps.remove) or sent to Ops for a peer, every other item kept at its size, and the card closed; an open card is edited in place to tonight's items, or settled with none; then a new card is posted for what is left, from the ops manager's name. Returns the card and kept to save, the log's words (none on a night with no card), and each line for Ops.
export async function cardNight(
  found: Machine[],
  home: string,
  saved: { card?: CardState; kept?: Kept },
  deps: CardDeps,
): Promise<{ card?: CardState; kept: Kept; ops: string[]; said: string }> {
  const kept = keptAfter(found, saved.kept ?? {})
  const ops: string[] = []
  const said: string[] = []
  let card = saved.card
  if (card) {
    const item = await readCard(deps.ask, card.id)
    if (typeof item === "string") {
      if (/no inbox item/.test(item)) card = undefined
      return {
        ...(card ? { card } : {}),
        kept,
        ops,
        said: card ? `card ${card.id} unread: ${item}` : "card gone",
      }
    }
    if (item.status === "open") {
      const tonight = offered(found, home, deps.out, kept).slice(0, CARD_MAX)
      if (!tonight.length) {
        await deps.ask(["settle", card.id, "--note", "Nothing unused is left to ask about."])
        return { kept, ops, said: `card ${card.id} settled: nothing unused left` }
      }
      const edited = await deps.ask(
        ["edit", card.id],
        JSON.stringify({ from: deps.from, ...cardOf(tonight) }),
      )
      if (edited.code !== 0)
        return { card, kept, ops, said: `card ${card.id} not edited: ${lastLine(edited.out)}` }
      return {
        card: { ...(await writtenAt(deps.ask, card.id)), id: card.id, items: tonight },
        kept,
        ops,
        said: `card ${card.id} open, ${tonight.length} items`,
      }
    }
    const counted = item.status === "approved" ? savedPicks(item, deps.from, card, card.id) : []
    // a clear sets the card aside, and an answer that does not count picks nothing: either keeps no item, so each comes back on a later card
    const keeps = item.status !== "cleared" && Array.isArray(counted)
    const picks = Array.isArray(counted) ? counted : []
    if (typeof counted === "string") said.push(counted)
    const listed = new Map(
      found.flatMap((m) =>
        "why" in m
          ? []
          : m.items.map((i) => [keyOf({ machine: m.machine, path: i.path }), i.bytes] as const),
      ),
    )
    let removed = 0
    for (const asked of card.items) {
      const key = keyOf(asked)
      const picked = picks.some((p) => keyOf(p) === key && p.bytes === asked.bytes)
      if (!picked) {
        if (keeps) kept[key] = asked.bytes
        continue
      }
      if (listed.get(key) !== asked.bytes) {
        said.push(`left ${asked.path} on ${asked.machine}: no longer listed at the card's size`)
        continue
      }
      if (asked.machine !== deps.here) {
        ops.push(`card ${card.id} approved on ${asked.machine}: ${peerCommand(asked, card.id)}`)
        continue
      }
      const done = await deps.remove(asked, card.id)
      if (done.code === 0) removed++
      said.push(
        done.code === 0
          ? `removed ${asked.path}: ${lastLine(done.out)}`
          : `kept ${asked.path}: ${lastLine(done.out)}`,
      )
    }
    // a deny, a clear or an answer that does not count reads as read with --ack, which closes it; a counted approval closes once carried out
    if (item.status === "approved" && Array.isArray(counted))
      await deps.ask([
        "ack",
        card.id,
        "--no-link",
        `nightly-clean removed ${removed} and sent ${ops.length} to Ops`,
      ])
    else await deps.ask(["get", card.id, "--ack"])
    said.unshift(`card ${card.id} ${item.status}: removed ${removed}, ${ops.length} to Ops`)
    card = undefined
  }
  const tonight = offered(found, home, deps.out, kept)
    .filter((i) => !saved.card?.items.some((a) => keyOf(a) === keyOf(i)))
    .slice(0, CARD_MAX)
  if (tonight.length) {
    const posted = await deps.ask(["new"], JSON.stringify({ from: deps.from, ...cardOf(tonight) }))
    const id = posted.out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => CARD_ID.test(l))
    if (posted.code === 0 && id) {
      card = { ...(await writtenAt(deps.ask, id)), id, items: tonight }
      said.push(`card ${id} posted, ${tonight.length} items`)
    } else said.push(`card not posted: ${lastLine(posted.out)}`)
  }
  return { ...(card ? { card } : {}), kept, ops, said: said.join("; ") }
}
