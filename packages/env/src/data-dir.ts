import "./aliases"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

type Env = Record<string, string | undefined>

// Claude Code's config folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. It holds Claude's own state and the skills links, never the data folder.
export const configDirOf = (env: Env = process.env): string =>
  env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")

// The folder the dashboard and the factory keep their files in outside the database: PLAYGROUND_DATA_DIR when the env given names it, else .playground in the home folder. The env is required, `{}` for a folder that never follows PLAYGROUND_DATA_DIR, so no caller drops it by leaving it out. A relative value is refused with why: each process would read it against its own folder (spawn.sh after its cd /, the API from api/hono), so two would keep two data folders.
export const dataDirOf = (env: Env, home = env.HOME || homedir()): string => {
  const named = env.PLAYGROUND_DATA_DIR
  if (!named) return join(home, ".playground")
  if (!isAbsolute(named))
    throw new Error(
      `PLAYGROUND_DATA_DIR is relative (${named}), so each process would read it from its own folder: set it to an absolute path`,
    )
  return resolve(named)
}

// The data folder the env names, PLAYGROUND_DATA_DIR included: the factory's scripts read it so, as the dashboard does on a stack that reads this machine.
export const dataDir = (env: Env = process.env): string => dataDirOf(env)

// The herdr folder, which holds each server's socket and restore log: PLAYGROUND_HERDR_DIR when set, else herdr under the home folder's data folder. It follows HOME, as herdr's own state folder does, never CLAUDE_CONFIG_DIR or PLAYGROUND_DATA_DIR, so a session on another Claude login reaches the same servers rather than starting a second factory on one state. It lives here, not in ops-herdr, so a reader of the folder alone (the idle-session backstop) loads no herdr code.
export const herdrDir = (env: Env): string =>
  env.PLAYGROUND_HERDR_DIR || join(dataDirOf({}, env.HOME || homedir()), "herdr")
