// A factory session's kind, what it does: spawn.sh writes it to the roster at every start, and every reader takes it before the session's name, so a name need not carry its role. A builder, ops, planner or optimizer holds a manager's seat, the assistant runs the owner's errands and the dispatcher's tracker, an orchestrator is a lead the sidebar's plus starts, any number at once and holding no seat, and the dispatcher routes the owner's asks. It imports nothing, so the hooks and scripts read it from source.
export const ROSTER_KINDS = [
  "assistant",
  "builder",
  "dispatcher",
  "ops",
  "optimizer",
  "orchestrator",
  "planner",
  "probe",
  "researcher",
  "reviewer",
  "runner",
  "tester",
  "worker",
] as const

export type RosterKind = (typeof ROSTER_KINDS)[number]

export const isRosterKind = (value: unknown): value is RosterKind =>
  (ROSTER_KINDS as readonly unknown[]).includes(value)

// The roster's role for each kind, which roster.ts writes beside it.
export const ROSTER_ROLE_OF_KIND: Record<RosterKind, "manager" | "runner" | "worker"> = {
  assistant: "manager",
  builder: "manager",
  dispatcher: "manager",
  ops: "manager",
  optimizer: "manager",
  orchestrator: "manager",
  planner: "manager",
  probe: "worker",
  researcher: "worker",
  reviewer: "worker",
  runner: "runner",
  tester: "worker",
  worker: "worker",
}

// Pure: whether a kind holds the roster's manager role, which isManagerKind's four seats narrow.
export const hasManagerRole = (kind: RosterKind): boolean => ROSTER_ROLE_OF_KIND[kind] === "manager"

// Pure: whether a roster row's status ends its session for good, done or ended, so the row no longer counts as listed (an ended second dispatcher draws no sidebar row); a parked or paused row still does.
export const isEndedStatus = (status: string | null | undefined): boolean =>
  status === "done" || status === "ended"

// The PLAYGROUND_ROLE a session of each kind runs under, as spawn.sh sets it and the hooks read it.
export const FACTORY_ROLE_OF_KIND: Record<RosterKind, string> = {
  assistant: "lead",
  builder: "lead",
  dispatcher: "dispatcher",
  ops: "lead",
  optimizer: "lead",
  orchestrator: "lead",
  planner: "lead",
  probe: "probe",
  researcher: "worker",
  reviewer: "reviewer",
  runner: "runner",
  tester: "tester",
  worker: "worker",
}

// The letters of a session's id, the 6 of an `<id>-<kind>` name, which leave out vowels, so an id never spells a word, and the look-alike 0, 1, l and o.
export const ID_ALPHABET = "23456789bcdfghjkmnpqrstvwxyz"

// An `<id>-<kind>` name as a pattern with no anchors or groups, for a reader that finds one inside text.
export const ID_NAME_SOURCE = `[${ID_ALPHABET}]{6}-(?:${ROSTER_KINDS.join("|")})`

const PREFIXED = /^(probe|reviewer|runner|tester|worker)-./
const ID_NAME = new RegExp(`^[${ID_ALPHABET}]{6}-(${ROSTER_KINDS.join("|")})$`)

// Pure: the kind a name gives, the fallback for a roster entry with no kind and the one reader of a name's kind the API and the web share: an `<id>-<kind>` name's last word (b7k2mq-reviewer is a reviewer), else an old name's prefix (worker-greed is a worker, reviewer-greed-97 a reviewer); null for any other name.
export const kindOfName = (name: string): RosterKind | null =>
  ((ID_NAME.exec(name) ?? PREFIXED.exec(name))?.[1] as RosterKind | undefined) ?? null

// Pure: a session's kind, its roster entry's first, else its name's (kindOfName).
export const kindOf = (name: string, kind: unknown): RosterKind | null =>
  isRosterKind(kind) ? kind : kindOfName(name)

// The manager kinds, one live session each, in the chain's order of work: the planner, the builder, ops, then the optimizer.
export const MANAGER_KINDS = ["planner", "builder", "ops", "optimizer"] as const

export type ManagerKind = (typeof MANAGER_KINDS)[number]

export const isManagerKind = (value: unknown): value is ManagerKind =>
  (MANAGER_KINDS as readonly unknown[]).includes(value)

// The kinds a manager's session name is set for, in sessions.names (packages/settings/src/sessions.ts).
export type NamedKind = "builder" | "dispatcher" | "ops" | "planner"

// The managers' session names: sessions.names, each kind's name, and sessions.aliases, an old name mapped to its kind.
export type SessionNames = {
  aliases: Readonly<Record<string, NamedKind>>
  names: Readonly<Record<NamedKind, string>>
}

// A fresh install's names, the role words, with no aliases, until a process sets the machine's own (setSessionNames).
export const DEFAULT_SESSION_NAMES: SessionNames = {
  aliases: {},
  names: { builder: "builder", dispatcher: "dispatcher", ops: "ops", planner: "planner" },
}

// On globalThis, so the source and the built copy of this file, which one process can load both of, read the same names.
const NAMES = Symbol.for("playground.sessionNames")
const held = globalThis as { [NAMES]?: SessionNames }

// Set once by a process that reads settings, before it places a name; the web sets the names the dashboard's frame gives.
export const setSessionNames = (next: SessionNames): void => {
  held[NAMES] = next
}

export const getSessionNames = (): SessionNames => held[NAMES] ?? DEFAULT_SESSION_NAMES

// The kind each set name places as: sessions.names, the second dispatcher's (the dispatcher's with -2), sessions.aliases, then the optimizer's own; the first a kind lists is its fallback name.
const namedKinds = (): ReadonlyMap<string, RosterKind> => {
  const { aliases, names } = getSessionNames()
  return new Map<string, RosterKind>([
    ...Object.entries(names).map(([kind, name]) => [name, kind as RosterKind] as const),
    [`${names.dispatcher}-2`, "dispatcher"],
    ...Object.entries(aliases),
    ["optimizer", "optimizer"],
  ])
}

// Pure: the kind a name places as, its `<id>-<kind>` suffix or an old prefix (kindOfName), else a set name's (namedKinds).
const placedKindOfName = (name: string): RosterKind | null =>
  kindOfName(name) ?? namedKinds().get(name) ?? null

// Pure: the kind a session places as, its roster entry's first, else its name's (placedKindOfName), so a manager under a set name places too.
export const placedKindOf = (name: string, kind: unknown): RosterKind | null =>
  isRosterKind(kind) ? kind : placedKindOfName(name)

// Pure: a manager kind's fallback name while the roster holds no live entry of it, its sessions.names name.
const aliasOf = (kind: RosterKind): string => getSessionNames().names[kind as NamedKind] ?? kind

// Pure: the manager kind a name gives with no roster row, an `<id>-<kind>` name's or a set name's; null for any other name, an ops job's (`ops-dashboard`) included.
export const managerKindOfName = (name: string): ManagerKind | null => {
  const kind = placedKindOfName(name)
  return isManagerKind(kind) ? kind : null
}

// Each dispatcher slot's label, the primary's then the second's.
export const DISPATCHER_SLOT_LABELS = ["Alpha", "Bravo"] as const

// Pure: the slot a set dispatcher name holds, 2 for a dispatcher's name with -2, else 1; null for any other name, an `<id>-dispatcher` included, whose roster entry names its slot.
export const slotOfName = (name: string): 1 | 2 | null => {
  const kinds = namedKinds()
  if (name.endsWith("-2") && kinds.get(name.slice(0, -2)) === "dispatcher") return 2
  return kinds.get(name) === "dispatcher" ? 1 : null
}

// Pure: a set dispatcher name's label by its slot, so the app reads a dispatcher by its slot, never its name; undefined for any other name.
export const dispatcherLabelOfName = (name: string): string | undefined => {
  const slot = slotOfName(name)
  return slot ? DISPATCHER_SLOT_LABELS[slot - 1] : undefined
}

// Pure: the factory role a session's name alone gives, as the hooks read it (scripts/hooks/role.ts), or "" for a name outside the factory.
export function roleOfName(name: string): string {
  const kind = placedKindOfName(name)
  return kind ? FACTORY_ROLE_OF_KIND[kind] : ""
}

// Pure: the factory role of a session by its name, the roster's kind for that name first, as the hooks place one resumed without PLAYGROUND_ROLE; "" for a session of the owner's own.
export const factoryRoleOf = (name: string, kind: unknown): string =>
  (isRosterKind(kind) ? FACTORY_ROLE_OF_KIND[kind] : "") || roleOfName(name)

const SEATLESS = new Set(["ended", "parked"])

type Seated = { name: string; slot: unknown; starting: boolean }

// Pure: the roster's live entries of a kind (its `kind`, else the kind its name places as), in roster order; an ended or parked one holds no seat.
const seatedOf = (agents: unknown, kind: RosterKind): Seated[] =>
  (Array.isArray(agents) ? agents : []).flatMap((agent: unknown) => {
    if (typeof agent !== "object" || agent === null) return []
    const {
      kind: given,
      name,
      slot,
      status,
    } = agent as { kind?: unknown; name?: unknown; slot?: unknown; status?: unknown }
    if (typeof name !== "string" || (isRosterKind(given) ? given : placedKindOfName(name)) !== kind)
      return []
    return SEATLESS.has(String(status)) ? [] : [{ name, slot, starting: status === "starting" }]
  })

// Pure: the newest seated entry (the last, since roster.ts appends) that is not starting, else the newest starting one, since a respawned session's entry exists before it answers.
const newestOf = (held: Seated[]): string | undefined =>
  held.findLast((entry) => !entry.starting)?.name ?? held.at(-1)?.name

// Pure: the session that holds a kind's seat, the newest live entry of that kind; undefined while none does, and always for an orchestrator, which holds none.
export const seatOf = (agents: unknown, kind: RosterKind): string | undefined =>
  kind === "orchestrator" ? undefined : newestOf(seatedOf(agents, kind))

// Pure: the session that holds a manager kind's seat (seatOf), else its sessions.names name.
export const managerOf = (agents: unknown, kind: ManagerKind): string =>
  seatOf(agents, kind) ?? aliasOf(kind)

// Pure: the dispatcher seated in a slot (1 the primary, Alpha; 2 the second, Bravo): the newest live dispatcher whose entry's `slot`, else its name's (slotOfName), else the first, is that one; none while no live entry holds it.
export const dispatcherSeatOf = (agents: unknown, slot: 1 | 2): string | undefined =>
  newestOf(
    seatedOf(agents, "dispatcher").filter(
      (entry) => Number(entry.slot ?? slotOfName(entry.name) ?? 1) === slot,
    ),
  )

// Pure: the dispatcher holding a slot (dispatcherSeatOf), else the slot's sessions.names name.
export const dispatcherOf = (agents: unknown, slot: 1 | 2): string =>
  dispatcherSeatOf(agents, slot) ?? `${getSessionNames().names.dispatcher}${slot === 1 ? "" : "-2"}`
