import { join } from "node:path"

import type { Peer } from "@packages/config/org"

import { dashboardCheckout } from "../playground/probe"

export type Cluster = { key: string; peers: Peer[] } | { why: string }

// The peers ops-tick's beats reach and the key they reach them with (PLAYGROUND_PEERS, PLAYGROUND_PEER_KEY), from the live Dashboard checkout's .env as playground update's peer sync reads them, since ops-tick runs from the main checkout, which keeps none; checkout is a test's seam.
export async function peersOf(
  repo: string,
  home: string,
  checkout: (repo: string) => string | null = dashboardCheckout,
): Promise<Cluster> {
  // loaded here, since the relay imports tick.ts, which builds these beats as it loads
  const { clusterOf, envKeysOf } = await import("../ops-peer-relay/relay")
  const env = Bun.file(join(checkout(repo) ?? repo, ".env"))
  return clusterOf(envKeysOf((await env.exists()) ? await env.text() : ""), home)
}
