import { LOCAL_SERVED, LOCAL_URL, MAKER_NAME } from "@packages/config/console"

import { readFixtureMachine, readsLive } from "@/lib/dashboard/fixture"

// How long the server has to list its models, so a board never waits on a server that is down.
const READ_MS = 1_000

// How long a read stands, since a model swap takes minutes and every board asks.
const KEEP_MS = 60_000

const REPO_ID = new RegExp(`^${MAKER_NAME}/[A-Za-z0-9][A-Za-z0-9._-]*$`)

// Pure: the repo id the server gives as the root of the model it serves as local (vLLM's /v1/models), else null.
export const servedRoot = (body: unknown): string | null => {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return null
  const root = (
    data.find((m) => (m as { id?: unknown })?.id === LOCAL_SERVED) as { root?: unknown }
  )?.root
  return typeof root === "string" && REPO_ID.test(root) ? root : null
}

let kept: { at: number; root: string | null } | null = null

// The repo id the local server serves as local, which a local session's row names and draws the maker of: read from the server on a live stack, at most once a minute, null when it does not answer in time; a fixture or test stack's made-up machine names its own.
export const localModel = async (
  fetcher: typeof fetch = fetch,
  live = readsLive(),
  now = Date.now(),
): Promise<string | null> => {
  if (!live) return readFixtureMachine().localModel ?? null
  if (kept && now - kept.at < KEEP_MS) return kept.root
  const root = await fetcher(`${LOCAL_URL}/v1/models`, { signal: AbortSignal.timeout(READ_MS) })
    .then((answer) => (answer.ok ? answer.json() : null))
    .then(servedRoot)
    .catch(() => null)
  kept = { at: now, root }
  return root
}

// Pure: each session on the local model given the repo the server serves, so its row can name it; every row as it was while none is known.
export const withLocalModel = <
  W extends { localModel?: string; model: string | null },
  L extends { workers: W[] },
>(
  live: L,
  root: string | null,
): L =>
  root
    ? {
        ...live,
        workers: live.workers.map((w) =>
          w.model === LOCAL_SERVED ? { ...w, localModel: root } : w,
        ),
      }
    : live

// Pure: the local models whose makers' icons the dashboard serves (makersOf): config's, then the repo the local server serves, so a local session's row draws its maker's logo though config names none.
export const iconModels = (
  models: readonly { id: string }[],
  served: string | null,
): { id: string }[] => [...models, ...(served ? [{ id: served }] : [])]
