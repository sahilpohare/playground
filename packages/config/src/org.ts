import { z } from "zod"

type Env = Record<string, string | undefined>

// One other machine the System panel reads over ssh: its name on the page and the user@host ssh reaches it at, neither able to become a flag.
export const peerSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  target: z.string().regex(/^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/),
})

export type Peer = z.infer<typeof peerSchema>

// One model a local server serves (vLLM's /v1/messages): its words in the composer's model menu and the id the server serves it under, neither able to become a flag.
export const localModelSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/),
})

export type LocalModel = z.infer<typeof localModelSchema>

// The loopback port the ops tunnel forwards to the machine that serves the local model.
export const LOCAL_MODEL_URL = "http://127.0.0.1:18000"

// a path a remote shell reads as itself: no space, quote, $, ; or glob
const PLAIN_PATH = /^[A-Za-z0-9._/-]+$/

// Pure: where a peer's clone sits, the same place under its home as this checkout under this one's, as a ~ path; null when this checkout is outside home or its path holds a character a remote shell would read.
export const cloneOf = (repo: string, home: string): string | null => {
  const base = `${home.replace(/\/+$/, "")}/`
  const rel = repo.startsWith(base) ? repo.slice(base.length).replace(/\/+$/, "") : ""
  return rel &&
    PLAIN_PATH.test(rel) &&
    rel.split("/").every((part) => part && part !== "." && part !== "..")
    ? `~/${rel}`
    : null
}

// The one place an organisation's own values come from: who owns the dashboard and whose work queue it reads, each read from env with a generic default, so a copy for anyone else names no person, team or workspace. Pure: it reads only the env it is given. The data folder is data-dir.ts's, in packages/env, since it reads the disk.
export const orgSchema = z.object({
  // The other machines the System panel sums with this one (none by default, so one machine shows alone) and the ssh key it reaches them with (none, ssh's own default).
  cluster: z.object({
    key: z.string().startsWith("/").optional(),
    // each name once in any case, since a peer's password item takes its name lowercased (peerSecret), so two names equal but for case would share one
    peers: z
      .array(peerSchema)
      .default([])
      .refine(
        (peers) => new Set(peers.map((peer) => peer.name.toLowerCase())).size === peers.length,
        "each peer name is listed once, in any case",
      ),
  }),
  // The daily ledger card's title prefix: a dispatcher card titled with it, alone or followed by ": " and a day, posts beside the dispatcher's one progress card.
  ledger: z.object({ title: z.string().default("Firefighting") }),
  // The local models the hosted session can switch to (none by default, so a copy names no model) and the one server that serves them, the tunnel's loopback port by default.
  local: z.object({
    models: z.array(localModelSchema).default([]),
    url: z.url({ protocol: /^https?$/ }).default(LOCAL_MODEL_URL),
  }),
  owner: z.object({ name: z.string().default("Owner") }),
  // The owner's day-job pull requests, which the Pull requests tab shows beside the dashboard's own queue: the GitHub org they are read from (unset, no work queue) and what the queue is called.
  work: z.object({
    label: z.string().default("Work"),
    org: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/)
      .optional(),
  }),
})

export type Org = z.infer<typeof orgSchema>

// Pure: the first of these env names holding a value, an empty one read as unset; a renamed key lists its new name first and its old one after, which still reads.
export const envValue = (env: Env, ...names: string[]): string | undefined =>
  names.map((name) => env[name]).find(Boolean)

// Pure: a comma list of key=value pairs, each split at its first =, for the schema to check; an entry with no = has an empty key.
const pairsOf = (value: string | undefined): [string, string][] | undefined =>
  value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("=")
      return at < 0 ? ["", entry] : [entry.slice(0, at), entry.slice(at + 1)]
    })

// Pure: PLAYGROUND_PEERS's comma list of name=user@host.
const peersOf = (value: string | undefined) =>
  pairsOf(value)?.map(([name, target]) => ({ name, target }))

// Pure: PLAYGROUND_LOCAL_MODELS's comma list of label=model-id.
const localModelsOf = (value: string | undefined) =>
  pairsOf(value)?.map(([label, id]) => ({ id, label }))

// Pure: the organisation's config from env; throws on a value its schema refuses.
export const orgOf = (env: Env): Org =>
  orgSchema.parse({
    cluster: {
      key: envValue(env, "PLAYGROUND_PEER_KEY"),
      peers: peersOf(envValue(env, "PLAYGROUND_PEERS")),
    },
    ledger: { title: envValue(env, "PLAYGROUND_LEDGER_TITLE") },
    local: {
      models: localModelsOf(envValue(env, "PLAYGROUND_LOCAL_MODELS")),
      url: envValue(env, "PLAYGROUND_LOCAL_MODEL_URL"),
    },
    owner: { name: envValue(env, "PLAYGROUND_OWNER_NAME") },
    work: { label: envValue(env, "WORK_LABEL"), org: envValue(env, "WORK_GITHUB_ORG") },
  })
