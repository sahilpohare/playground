import "@packages/env/aliases"
import { homedir } from "node:os"
import { join } from "node:path"

import { envValue } from "@packages/config/org"
import { dataDirOf } from "@packages/env/data-dir"

// Relative, not @/: the web's tests type-check this file under web/next's own @/ paths.
import { configDir, readsLive } from "../dashboard/fixture"

// Claude Code keeps its state under CLAUDE_CONFIG_DIR when it is set, else ~/.claude: transcripts in projects/, one registry file per running session in sessions/. Only the live dashboard reads that folder; any other stack reads its fixture's (fixture.ts), so every reader that starts here stays off live data.
export const claudeDir = (): string => configDir()

// The dashboard's data folder, every file it keeps outside the database (data-dir.ts): this machine's on a stack that reads it, PLAYGROUND_DATA_DIR included, else the fixture's own beside its config folder, so a fixture stack never reaches this machine's whatever is set.
export const dataDir = (): string =>
  readsLive() ? dataDirOf(process.env) : join(claudeDir(), "playground")

// The first of these env names holding a value, read only on a stack that reads this machine: a live-reads test stack's scratch path, the new name first and its old one after, which still reads.
export const livePath = (...names: string[]): string | undefined =>
  readsLive() ? envValue(process.env, ...names) : undefined

export const projectsDir = (): string => join(claudeDir(), "projects")

// Codex keeps its rollouts under CODEX_HOME when it is set, else ~/.codex, in sessions/YYYY/MM/DD. Only a stack that reads this machine reads that folder; any other reads its fixture's, a codex folder inside the fixture's config folder.
export const codexSessionsDir = (): string =>
  join(
    readsLive() ? process.env.CODEX_HOME || join(homedir(), ".codex") : join(claudeDir(), "codex"),
    "sessions",
  )

// Pure: where Claude Code writes a session's transcript under a config folder: its projects folder, under the working folder with every character but a letter or a digit turned into a dash.
export const transcriptPath = (config: string, cwd: string, sessionId: string): string =>
  join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`)
