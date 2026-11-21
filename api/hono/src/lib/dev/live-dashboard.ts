import { dataDir } from "@packages/env/data-dir"
import { liveSettings, readPolicyOrDefaults } from "@packages/settings"

export type LiveDashboard = { branch: string; database: string }

// The live dashboard's database belongs to its own checkout: a .env copied from there carries it, and a stack elsewhere would write test rows into the board the owner reads. The pair is live.branch and live.container, their defaults until a first setting writes policy.json; a policy.json that does not parse throws, so no guard judges by a guessed pair.
export const livePair = (
  environment: Record<string, string | undefined> = process.env,
): LiveDashboard => {
  const read = readPolicyOrDefaults(dataDir(environment))
  if (read.refusal !== undefined) throw new Error(read.refusal)
  return {
    branch: liveSettings.get(read.settings, "live.branch"),
    database: liveSettings.get(read.settings, "live.container"),
  }
}

// The live dashboard's database: the live.container name, or the one first run's startLocal starts under it on the live checkout, which adds a dash and 4 letters or digits.
export const isLiveDatabase = (container: string, liveDashboard: LiveDashboard): boolean =>
  container === liveDashboard.database ||
  (container.startsWith(`${liveDashboard.database}-`) &&
    /^[0-9a-zA-Z]{4}$/.test(container.slice(liveDashboard.database.length + 1)))

export type Container = { name: string; state: string }

// `docker ps -a` as name and state, every container in any state.
export const CONTAINER_LIST = ["ps", "-a", "--format", "{{.Names}}\t{{.State}}"]

export const containersOf = (listed: string): Container[] =>
  listed
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [name = "", state = ""] = line.split("\t")
      return { name: name.trim(), state: state.trim() }
    })

// The live dashboard's database where setup cannot reuse it: startLocal reuses only a running container it named, so the unsuffixed live.container, or a suffixed one not running, would sit beside a new empty one; a running suffixed one is the container Try again reuses.
export const unreusedLiveDatabase = (
  containers: Container[],
  liveDashboard: LiveDashboard,
): string | undefined =>
  containers.find(
    ({ name, state }) =>
      isLiveDatabase(name, liveDashboard) &&
      (name === liveDashboard.database || state !== "running"),
  )?.name

// Why setup refuses on the live checkout while its database exists: startLocal reuses only a running container it named, so a new one would sit empty beside it.
export const liveDatabaseHeld = (container: string): string =>
  `${container} holds the live dashboard's database, so setup would start an empty one beside it; point POSTGRES_URL at it: \`docker start ${container}\`, then \`docker port ${container} 5432\` for its port`
