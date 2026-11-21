import { expect, test } from "bun:test"

import type { Machine, Unused } from "../../../../../packages/scripts/src/ops-tick/unused"
import {
  approvedOf,
  CARD_MAX,
  type CardDeps,
  type CardItem,
  cardNight,
  cardOf,
  keptAfter,
  offered,
  peerCommand,
  questionOf,
  readCard,
  savedPicks,
} from "../../../../../packages/scripts/src/ops-tick/unused-card"

const MB = 1024 ** 2
const GB = 1024 ** 3
const HOME = "/home/me"
const ID = "11111111-2222-3333-4444-555555555555"
// When nightly-clean's last post or edit landed, and an answer after it.
const WROTE = "2026-11-17T03:00:00.000Z"
const LATER = "2026-11-17T09:00:00.000Z"

const weights: Unused = {
  bytes: 2 * GB,
  kind: "weights",
  path: `${HOME}/models/hf/hub/models--nvidia--Qwen-27B`,
  recorded: false,
}
const image: Unused = {
  bytes: 300 * MB,
  id: "sha256:aaa",
  kind: "image",
  path: "docker image old:1",
  recorded: false,
}
const rehearsal: Unused = {
  bytes: Math.round(1.7 * GB),
  kind: "rehearsal",
  path: `${HOME}/.playground/scratchpad/ops/rehearse142`,
  recorded: true,
}
const running: Unused = { ...rehearsal, path: `${HOME}/.playground/scratchpad/ops/rehearse149` }
const run: Unused = {
  bytes: GB,
  kind: "run",
  path: `${HOME}/models/kit/runs/MB-old/pr0001`,
  recorded: false,
}
const small: Unused = { ...image, bytes: 50 * MB, id: "sha256:bbb", path: "docker image tiny:1" }
const peerImage: Unused = { ...image, id: "sha256:ccc", path: "docker image peer:1" }

const here = (...items: Unused[]): Machine => ({ items, machine: "here" })
const out = (path: string) => path.endsWith("rehearse142")

test("the card offers each item but the trial record's, a rehearsal whose tag is not out, a small one and one kept at its size; a recorded one is marked", () => {
  const found = [
    here(weights, image, rehearsal, running, run, small),
    { items: [peerImage], machine: "peer" },
  ]
  expect(
    offered(found, HOME, out, { "here docker image old:1": 300 * MB }).map((i) => i.path),
  ).toEqual([weights.path, rehearsal.path, peerImage.path])
  expect(offered(found, HOME, out, {}).find((i) => i.path === rehearsal.path)?.recorded).toBe(true)
  expect(
    offered(found, HOME, out, { "here docker image old:1": 299 * MB }).map((i) => i.path),
  ).toContain(image.path)
})

test("a single item's card is one yes or no with Keep; more are one question each, weights with no recommended badge and the words that they are deleted outright", () => {
  const items = offered([here(weights, image)], HOME, out, {})
  const one = cardOf(items.slice(1))
  expect(one.preview).toMatchObject({ deny: "Keep", options: [{ label: "Remove" }], type: "ask" })
  expect((one.preview as { text: string }).text.split("\n")[0]).toBe(questionOf(items[1]!))
  const many = cardOf(items).preview as {
    questions: { options: { description?: string }[]; recommended?: number }[]
  }
  expect(many.questions.map((q) => q.recommended)).toEqual([undefined, 0])
  expect(many.questions[0]!.options[0]!.description).toBe(
    "Deleted outright, cannot be restored; it downloads again.",
  )
  const recorded = (kind: CardItem["kind"]) =>
    (
      cardOf([{ ...items[1]!, kind, recorded: true }]).preview as {
        options: { description: string }[]
      }
    ).options[0]!.description
  expect(recorded("rehearsal")).toContain("its entry there goes too")
  expect(recorded("image")).not.toContain("its entry there goes too")
  expect(questionOf(items[0]!)).toBe(
    `Remove \`${weights.path}\` on here, ${2 * GB} bytes (2.0 GB)?`,
  )
})

test("an approval reads back each Remove pick from the card's own words, and none for a denied card or one another session posted", () => {
  const items = offered([here(weights, image)], HOME, out, {})
  const many = {
    ...cardOf(items),
    answer: { choice: "approve", options: [1, 0] },
    from: "ops",
    status: "approved",
  }
  expect(approvedOf(many, "ops")).toEqual([
    { bytes: image.bytes, machine: "here", path: image.path },
  ])
  expect(approvedOf(many, "builder")).toEqual([])
  const one = {
    ...cardOf(items.slice(0, 1)),
    answer: { choice: "approve" },
    from: "ops",
    status: "approved",
  }
  expect(approvedOf(one, "ops")).toEqual([
    { bytes: weights.bytes, machine: "here", path: weights.path },
  ])
  expect(approvedOf({ ...one, answer: { choice: "deny" }, status: "denied" }, "ops")).toEqual([])
})

type Questions = {
  questions: { options: { description?: string; label: string }[]; question: string }[]
  text: string
  type: string
}

test("an answer counts only on the card as nightly-clean last wrote it, answered at or after that write", () => {
  const items = offered([here(weights, image)], HOME, out, {})
  const saved = { at: WROTE, id: ID, items }
  const answered = {
    ...cardOf(items),
    answer: { at: LATER, choice: "approve", options: [0, 1] },
    from: "ops",
    status: "approved",
  }
  expect(savedPicks(answered, "ops", saved, ID)).toEqual([
    { bytes: weights.bytes, machine: "here", path: weights.path },
  ])
  const other = { ...weights, bytes: 9 * GB, path: `${HOME}/models/hf/hub/models--other--Model` }
  const changed = `card ${ID} no longer reads as nightly-clean wrote it`
  const words = cardOf(offered([here(other, image)], HOME, out, {})).preview
  expect(savedPicks({ ...answered, preview: words }, "ops", saved, ID)).toBe(changed)
  const reordered = cardOf([...items].reverse()).preview
  expect(savedPicks({ ...answered, preview: reordered }, "ops", saved, ID)).toBe(changed)
  const swapped = {
    ...(answered.preview as Questions),
    questions: (answered.preview as Questions).questions.map((q) => ({
      ...q,
      options: [...q.options].reverse(),
    })),
  }
  expect(savedPicks({ ...answered, preview: swapped }, "ops", saved, ID)).toBe(changed)
  const before = `card ${ID} was answered before nightly-clean's last write`
  const early = { ...answered, answer: { ...answered.answer, at: "2026-11-17T02:00:00.000Z" } }
  expect(savedPicks(early, "ops", saved, ID)).toBe(before)
  expect(savedPicks(answered, "ops", { id: ID, items }, ID)).toBe(
    `card ${ID} has no write time and no created time to check the answer against`,
  )
  expect(savedPicks(answered, "ops", { ...saved, id: "another" }, ID)).toBe(
    `card ${ID} is not the card nightly-clean saved`,
  )
  expect(savedPicks(answered, "ops", undefined, ID)).toBeString()
})

// When the saved write time is missing, the guard falls back to the card's own createdAt (as ask get reads it): an answer at or after that time counts. Both missing refuses with a reason that names the case. These two rows are red at canary, which the fall back fixes.
test("a saved card with no write time falls back to the card's createdAt, and both missing refuses", () => {
  const items = offered([here(weights, image)], HOME, out, {})
  const noAt = { id: ID, items }
  // A missing saved at, with an answer after the card's createdAt, returns the picks.
  const afterCreated = {
    ...cardOf(items),
    createdAt: "2026-11-17T02:00:00.000Z",
    answer: { at: LATER, choice: "approve", options: [0, 1] },
    from: "ops",
    status: "approved",
  }
  expect(savedPicks(afterCreated, "ops", noAt, ID)).toEqual([
    { bytes: weights.bytes, machine: "here", path: weights.path },
  ])
  // A missing saved at and a missing createdAt refuses, with the new reason.
  const noCreated = {
    ...cardOf(items),
    answer: { at: LATER, choice: "approve", options: [0, 1] },
    from: "ops",
    status: "approved",
  }
  expect(savedPicks(noCreated, "ops", noAt, ID)).toBe(
    `card ${ID} has no write time and no created time to check the answer against`,
  )
})

// These three rows hold at canary and after the fix: the old reason still stands for a stale answer, the shape check is the only guard against an edit, and an answer before createdAt refuses.
test("a saved card with no write time still refuses a stale answer, an edited card, or one answered before createdAt", () => {
  const items = offered([here(weights, image)], HOME, out, {})
  const noAt = { id: ID, items }
  // An answer given before the saved at (a later write) still refuses, with the old reason.
  const withAt = { at: "2026-11-17T10:00:00.000Z", id: ID, items }
  const earlyAnswer = {
    ...cardOf(items),
    createdAt: "2026-11-17T02:00:00.000Z",
    answer: { at: WROTE, choice: "approve", options: [0, 1] },
    from: "ops",
    status: "approved",
  }
  expect(savedPicks(earlyAnswer, "ops", withAt, ID)).toBe(
    `card ${ID} was answered before nightly-clean's last write`,
  )
  // A card edited after its answer, with no saved at, is still refused by the shape check, since that check is then the only guard against an edit after the answer.
  const editedPreview = {
    ...(cardOf(items).preview as Questions),
    questions: (cardOf(items).preview as Questions).questions.map((q) => ({
      ...q,
      options: [...q.options].reverse(),
    })),
  }
  const editedAfter = {
    ...cardOf(items),
    createdAt: "2026-11-17T02:00:00.000Z",
    answer: { at: LATER, choice: "approve", options: [0, 1] },
    from: "ops",
    status: "approved",
    preview: editedPreview,
  }
  expect(savedPicks(editedAfter, "ops", noAt, ID)).toBe(
    `card ${ID} no longer reads as nightly-clean wrote it`,
  )
  // An answer timed before the card's createdAt, with no saved at, refuses.
  const beforeCreated = {
    ...cardOf(items),
    createdAt: "2026-11-17T12:00:00.000Z",
    answer: { at: LATER, choice: "approve", options: [0, 1] },
    from: "ops",
    status: "approved",
  }
  expect(savedPicks(beforeCreated, "ops", noAt, ID)).toBeString()
})

test("a peer's image runs `docker image rm`, a rehearsal a `playground rm` with a reason, and weights a `playground rm` naming the peer's card", () => {
  const item = ({ recorded: _, ...u }: Unused): CardItem => ({ ...u, machine: "peer" })
  expect(peerCommand(item(peerImage), ID)).toBe("docker image rm sha256:ccc")
  expect(peerCommand(item(rehearsal), ID)).toBe(
    `playground rm ${rehearsal.path} --reason "nightly-clean card ${ID}"`,
  )
  expect(peerCommand(item(weights), ID)).toBe(
    `playground rm --card ${ID} --peer peer '${weights.path.replaceAll("'", `'\\''`)}'`,
  )
  const spaced = { ...weights, path: `${HOME}/models/a b/gguf` }
  expect(peerCommand(item(spaced), ID)).toBe(
    `playground rm --card ${ID} --peer peer '/home/me/models/a b/gguf'`,
  )
  const quoted = { ...weights, path: `${HOME}/models/it's/gguf` }
  expect(peerCommand(item(quoted), ID)).toBe(
    `playground rm --card ${ID} --peer peer '/home/me/models/it'\\''s/gguf'`,
  )
})

// A fake Inbox holding one card: each ask call kept, get answering with the card as it stands.
const inbox = (answer?: {
  answer: { at?: string; choice: string; options?: number[] }
  status: string
}) => {
  const calls: { args: string[]; stdin?: string }[] = []
  const removed: string[] = []
  let posted: Record<string, unknown> | undefined
  const deps: CardDeps = {
    ask: async (args, stdin) => {
      calls.push({ args, ...(stdin ? { stdin } : {}) })
      if (args[0] === "new") {
        posted = JSON.parse(stdin!)
        return { code: 0, out: `${ID}\n` }
      }
      if (args[0] === "edit") posted = JSON.parse(stdin!)
      if (args[0] === "get" && args.length === 2)
        return posted
          ? {
              code: 0,
              out: JSON.stringify({
                ...posted,
                updatedAt: WROTE,
                ...(answer ?? { status: "open" }),
              }),
            }
          : { code: 1, out: `ask: no inbox item ${args[1]}` }
      return { code: 0, out: "" }
    },
    from: "ops",
    here: "here",
    out,
    remove: async (item) => {
      removed.push(item.path)
      return { code: 0, out: "Moved to the trash as 20261118T030000Z-shell/1 (2 files)" }
    },
  }
  return { calls, deps, removed, setPosted: (p: Record<string, unknown>) => (posted = p) }
}

test("a night with no card posts one from the ops manager's name and keeps its id", async () => {
  const { calls, deps } = inbox()
  const night = await cardNight([here(weights, image)], HOME, {}, deps)
  expect(night.card).toEqual({
    at: WROTE,
    id: ID,
    items: offered([here(weights, image)], HOME, out, {}),
  })
  expect(calls.map((c) => c.args)).toEqual([["new"], ["get", ID]])
  expect(JSON.parse(calls[0]!.stdin!)).toMatchObject({ from: "ops", kind: "decision" })
})

test("an open card is edited in place to tonight's items, and settled once none is left", async () => {
  const { calls, deps } = inbox()
  const first = await cardNight([here(weights, image)], HOME, {}, deps)
  const second = await cardNight([here(image)], HOME, { card: first.card }, deps)
  expect(calls.map((c) => c.args[0])).toEqual(["new", "get", "get", "edit", "get"])
  expect(second.card).toEqual({ at: WROTE, id: ID, items: offered([here(image)], HOME, out, {}) })
  const third = await cardNight([here()], HOME, { card: second.card }, deps)
  expect(calls.at(-1)!.args.slice(0, 2)).toEqual(["settle", ID])
  expect(third.card).toBeUndefined()
})

test("an answered card removes each Remove still listed at its size here, sends a peer's to Ops, leaves one whose size changed, keeps each Keep, and closes", async () => {
  const items = offered(
    [here(weights, image, rehearsal), { items: [peerImage], machine: "peer" }],
    HOME,
    out,
    {},
  )
  expect(items.map((i) => i.path)).toEqual([
    weights.path,
    rehearsal.path,
    image.path,
    peerImage.path,
  ])
  const { calls, deps, removed, setPosted } = inbox({
    answer: { at: LATER, choice: "approve", options: [0, 0, 1, 0] },
    status: "approved",
  })
  setPosted({ from: "ops", ...cardOf(items) })
  const tonight = [
    here(weights, image, { ...rehearsal, bytes: rehearsal.bytes + 1 }),
    { items: [peerImage], machine: "peer" },
  ]
  const night = await cardNight(tonight, HOME, { card: { at: WROTE, id: ID, items } }, deps)
  expect(removed).toEqual([weights.path])
  expect(night.ops).toEqual([`card ${ID} approved on peer: docker image rm sha256:ccc`])
  expect(night.said).toContain(
    `left ${rehearsal.path} on here: no longer listed at the card's size`,
  )
  expect(night.kept).toEqual({ "here docker image old:1": image.bytes })
  expect(calls.at(-1)!.args.slice(0, 3)).toEqual(["ack", ID, "--no-link"])
  expect(night.card).toBeUndefined()
})

test("a kept item stays off the next card, and comes back on one once its size changes", async () => {
  const { deps } = inbox({ answer: { choice: "deny" }, status: "denied" })
  const items = offered([here(image)], HOME, out, {})
  const night = await cardNight(
    [here(image)],
    HOME,
    { card: { id: ID, items } },
    {
      ...deps,
      ask: async (args, stdin) => {
        if (args[0] === "get" && args.length === 2)
          return {
            code: 0,
            out: JSON.stringify({
              from: "ops",
              ...cardOf(items),
              answer: { choice: "deny" },
              status: "denied",
            }),
          }
        return deps.ask(args, stdin)
      },
    },
  )
  expect(night.kept).toEqual({ "here docker image old:1": image.bytes })
  expect(night.card).toBeUndefined()
  const fresh = inbox()
  const same = await cardNight([here(image)], HOME, { kept: night.kept }, fresh.deps)
  expect(same.card).toBeUndefined()
  expect(fresh.calls).toEqual([])
  const grown = await cardNight(
    [here({ ...image, bytes: image.bytes + MB })],
    HOME,
    { kept: night.kept },
    fresh.deps,
  )
  expect(grown.card?.items.map((i) => i.bytes)).toEqual([image.bytes + MB])
  expect(grown.kept).toEqual({})
})

// One night on a card nightly-clean saved at WROTE for weights and image, the Inbox showing preview with answer.
const answeredNight = async (
  preview: unknown,
  answer: { at?: string; choice: string; options?: number[] },
  status = "approved",
) => {
  const items = offered([here(weights, image)], HOME, out, {})
  const fake = inbox({ answer, status })
  fake.setPosted({ from: "ops", kind: "decision", preview, title: "Remove 2 unused items?" })
  const done = await cardNight(
    [here(weights, image)],
    HOME,
    { card: { at: WROTE, id: ID, items } },
    fake.deps,
  )
  return { ...done, removed: fake.removed }
}
const savedPreview = () =>
  cardOf(offered([here(weights, image)], HOME, out, {})).preview as Questions

test("an answer to a card whose questions or options an edit changed after it removes nothing and keeps nothing", async () => {
  const preview = savedPreview()
  const swapped = {
    ...preview,
    questions: preview.questions.map((q) => ({ ...q, options: [...q.options].reverse() })),
  }
  const swap = await answeredNight(swapped, { at: LATER, choice: "approve", options: [1, 1] })
  expect(swap.removed).toEqual([])
  expect(swap.said).toContain("no longer reads as nightly-clean wrote it")
  const reordered = await answeredNight(
    { ...preview, questions: [...preview.questions].reverse() },
    { at: LATER, choice: "approve", options: [0, 1] },
  )
  expect(reordered.removed).toEqual([])
  for (const n of [swap, reordered]) expect(n.kept).toEqual({})
})

test("an answer older than the night's last edit removes nothing and keeps nothing, and a clear keeps nothing", async () => {
  const raced = await answeredNight(savedPreview(), {
    at: "2026-11-17T02:00:00.000Z",
    choice: "approve",
    options: [0, 0],
  })
  expect(raced.removed).toEqual([])
  expect(raced.said).toContain("answered before nightly-clean's last write")
  expect(raced.kept).toEqual({})
  const cleared = await answeredNight(savedPreview(), { at: LATER, choice: "clear" }, "cleared")
  expect(cleared.removed).toEqual([])
  expect(cleared.kept).toEqual({})
})

test("kept stays for a machine not read, and drops an item gone from tonight's list", () => {
  const kept = { "here docker image gone:1": MB, "peer docker image x:1": MB }
  expect(keptAfter([here(image), { machine: "peer", why: "exit 255" }], kept)).toEqual({
    "peer docker image x:1": MB,
  })
})

// nightly-clean asks through ops-job's run, whose out is stdout then stderr (job.ts's `out + err`), so ask get's picked line follows the card (PG-2707).
test("a card reads when ask's picked line on stderr follows its JSON in the joined output", async () => {
  const card = { status: "approved", updatedAt: WROTE }
  for (const json of [JSON.stringify(card, null, 2), JSON.stringify(card)])
    expect(
      await readCard(async () => ({ code: 0, out: `${json}\nask: picked A: Remove\n` }), ID),
    ).toEqual(card)
})

test("a card that does not read stays for the next night, and one the Inbox no longer holds is let go", async () => {
  const items = offered([here(image)], HOME, out, {})
  const unread = await cardNight(
    [here(image)],
    HOME,
    { card: { id: ID, items } },
    {
      ...inbox().deps,
      ask: async () => ({ code: 1, out: "ERR_POSTGRES_CONNECTION_REFUSED" }),
    },
  )
  expect(unread.card).toEqual({ id: ID, items })
  const gone = await cardNight([here()], HOME, { card: { id: ID, items } }, inbox().deps)
  expect(gone.card).toBeUndefined()
})

test("a card holds CARD_MAX questions at most, the largest first", () => {
  const many = Array.from({ length: CARD_MAX + 3 }, (_, i) => ({
    ...image,
    bytes: (200 + i) * MB,
    path: `docker image i${i}:1`,
  }))
  const items = offered([here(...many)], HOME, out, {}).slice(0, CARD_MAX)
  expect((cardOf(items).preview as { questions: unknown[] }).questions).toHaveLength(CARD_MAX)
  expect(items[0]!.bytes).toBe((200 + CARD_MAX + 2) * MB)
})

test("a sharded set is one item, listed once at its total, its line naming the model stem and the shard count", () => {
  const stem = "models--nvidia--Qwen"
  const shards = ["00001", "00002", "00003", "00004"].map(
    (n) => `${HOME}/models/loose/${stem}-${n}-of-00004.gguf`,
  )
  const bytes = 13 * GB
  const item: CardItem = {
    bytes,
    kind: "weights",
    machine: "here",
    path: shards[0]!,
    shards,
  }
  const card = cardOf([item])
  expect(card.title).toBe("Remove 1 unused item?")
  expect((card.preview as { text: string }).text.split("\n")[0]).toBe(
    `Remove \`${shards[0]!}\` on here, ${bytes} bytes (${(bytes / GB).toFixed(1)} GB)?`,
  )
  const line = (card.preview as { options: { description: string }[] }).options[0]!.description
  expect(line).toContain(stem)
  expect(line).toContain("all 4 of 4 shards.")
})

test("a sharded set missing a shard is still one item, its line naming the shards that are there and the set's total", () => {
  const stem = "models--nvidia--Qwen"
  const shards = ["00002"].map((n) => `${HOME}/models/loose/${stem}-${n}-of-00004.gguf`)
  const bytes = 13 * GB
  const item: CardItem = {
    bytes,
    kind: "weights",
    machine: "here",
    path: shards[0]!,
    shards,
  }
  const line = (cardOf([item]).preview as { options: { description: string }[] }).options[0]!
    .description
  expect(line).toContain(stem)
  expect(line).toContain("with only shards 2 of 4 here.")
})
