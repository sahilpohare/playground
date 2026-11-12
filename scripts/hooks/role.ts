// A session's factory role, which the hooks read: PLAYGROUND_ROLE, else the role its name in Claude Code's registry, or a Codex thread's name, gives, through the roster's kind for that name first and the name itself second, since a session resumed without its settings (playbook's SPAWN.md, Role and settings) lacks the env var, else "" for a session outside the factory.
import "../../packages/env/src/aliases"
import { homedir } from "node:os"
import { join } from "node:path"

// By relative source path, never through @packages/config: every guard imports this file from the main checkout, so a dist a failed build left stale or missing would make each PreToolUse guard refuse every call it guards.
import {
  FACTORY_ROLE_OF_KIND,
  isRosterKind,
  roleOfName,
  type RosterKind,
  setSessionNames,
} from "../../packages/config/src/kinds"
import { dataDirOf } from "../../packages/env/src/data-dir"

export { roleOfName }

// The roles a manager runs under: the dispatcher's and the leads'.
export const MANAGER_ROLES = new Set(["dispatcher", "lead", "manager"])

type Environment = Record<string, string | undefined>

let names: Promise<void> | undefined

// The machine's managers' names, which roleOfName places a name by, read once a process through setting.ts, since a hook cannot load @packages/settings; a read that fails keeps a fresh install's.
export function loadNames(environment: Environment = process.env): Promise<void> {
  names ??= (async () => {
    try {
      const setting = join(import.meta.dir, "../../packages/scripts/src/playground/setting.ts")
      const read = Bun.spawn(["bun", setting, "sessions.names", "sessions.aliases"], {
        env: { ...process.env, ...environment },
        stderr: "ignore",
        stdout: "pipe",
      })
      const [names, aliases] = (await new Response(read.stdout).text()).trim().split("\n")
      if ((await read.exited) === 0)
        setSessionNames({ aliases: JSON.parse(aliases!), names: JSON.parse(names!) })
    } catch {}
  })()
  return names
}

// The session's name from Claude Code's registry, the file whose sessionId is this session's.
export async function registryName(
  sessionId: string,
  environment: Environment = process.env,
): Promise<string | undefined> {
  const dir = join(environment.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions")
  for await (const file of new Bun.Glob("*.json").scan(dir)) {
    try {
      const entry = (await Bun.file(join(dir, file)).json()) as {
        name?: unknown
        sessionId?: unknown
      }
      if (entry.sessionId === sessionId && typeof entry.name === "string") return entry.name
    } catch {}
  }
}

// A Codex thread's name, the last one Codex's session index holds for its id, or undefined when CODEX_HOME is unset or the index cannot be read.
export async function codexName(
  sessionId: string,
  environment: Environment = process.env,
): Promise<string | undefined> {
  if (!environment.CODEX_HOME) return
  let name: string | undefined
  try {
    const index = await Bun.file(join(environment.CODEX_HOME, "session_index.jsonl")).text()
    for (const line of index.split("\n")) {
      try {
        const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
        if (entry.id === sessionId && typeof entry.thread_name === "string")
          name = entry.thread_name
      } catch {}
    }
  } catch {}
  return name
}

// The roster's kind for a name, or undefined when the roster has no entry of that name with a kind on the list, or cannot be read.
export async function rosterKind(
  name: string,
  environment: Environment = process.env,
): Promise<RosterKind | undefined> {
  const path = join(dataDirOf(environment), "roster.json")
  try {
    const roster = (await Bun.file(path).json()) as {
      agents?: { kind?: unknown; name?: unknown }[]
    }
    const kind = roster.agents?.find((agent) => agent?.name === name)?.kind
    return isRosterKind(kind) ? kind : undefined
  } catch {
    return
  }
}

// The role the roster's kind for a name gives, or "" when the roster has no entry of that name with a kind on the list, or cannot be read.
export async function rosterRole(
  name: string,
  environment: Environment = process.env,
): Promise<string> {
  const kind = await rosterKind(name, environment)
  return kind ? FACTORY_ROLE_OF_KIND[kind] : ""
}

// The names of the roster's live rows (`live` in scripts/roster-statuses.json, read here rather than imported, so role.ts loads from a bare checkout), or none when either cannot be read; an ended row's name (probe-dashboard) is an everyday word again.
export async function rosterNames(environment: Environment = process.env): Promise<string[]> {
  const path = join(dataDirOf(environment), "roster.json")
  try {
    const { live } = (await Bun.file(
      join(import.meta.dir, "..", "roster-statuses.json"),
    ).json()) as {
      live: string[]
    }
    const roster = (await Bun.file(path).json()) as {
      agents?: { name?: unknown; status?: unknown }[]
    }
    return (roster.agents ?? []).flatMap((agent) =>
      typeof agent?.name === "string" && live.includes(String(agent.status)) ? [agent.name] : [],
    )
  } catch {
    return []
  }
}

// "" when none tells: a registry that cannot be read places no session in the factory.
export async function sessionRole(environment: Environment, sessionId: unknown): Promise<string> {
  if (environment.PLAYGROUND_ROLE) return environment.PLAYGROUND_ROLE
  if (typeof sessionId !== "string") return ""
  try {
    const name =
      (await registryName(sessionId, environment)) ??
      (await codexName(sessionId, environment)) ??
      ""
    const role = name && (await rosterRole(name, environment))
    if (role) return role
    await loadNames(environment)
    return roleOfName(name)
  } catch {
    return ""
  }
}

// Whether a hook's input comes from a factory session: the hooks that guard the factory alone pass the owner's own sessions untouched, which load them too from the project settings.
export async function fromFactory(
  raw: string,
  environment: Environment = process.env,
): Promise<boolean> {
  return (await sessionRole(environment, sessionOf(raw))) !== ""
}

// The hook input's session_id, or undefined when the input does not read.
export function sessionOf(raw: string): unknown {
  try {
    return (JSON.parse(raw) as { session_id?: unknown }).session_id
  } catch {
    return undefined
  }
}
