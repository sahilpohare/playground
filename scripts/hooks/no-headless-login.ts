// PreToolUse hook, acting for a factory session alone (role.ts): refuses a headless `claude -p` or `claude --print` unless the same command sets CLAUDE_CODE_OAUTH_TOKEN for it, since the session's Bash shell lacks the token spawn.sh gave its claude and the run falls back to this machine's own login (21 eval runs billed an account paused at 98%), and unless it sets PLAYGROUND_ROLE when the session's role is not in its environment, so every role-gated hook acts on the run too.
import "../../packages/env/src/aliases"
import { join } from "node:path"

import { dataDir } from "../../packages/env/src/data-dir"
import { readPolicy } from "../../packages/settings/src/rendered"
import { input } from "./input"
import { registryName, sessionOf, sessionRole } from "./role"
import { lex, run, type Env, type Parsed, type Visit } from "./shell"

const TOKEN = "CLAUDE_CODE_OAUTH_TOKEN"
const ROLE = "PLAYGROUND_ROLE"
// usage.keychainService's default, which the fix names when the policy sets none or cannot be read; a test holds it to the setting's.
export const KEYCHAIN_SERVICE = "playground-claude-oauth"

// The Keychain service the fix reads the token from, as the policy sets usage.keychainService.
const keychainOf = async (environment: Environment): Promise<string> => {
  const read = await readPolicy(dataDir(environment))
  const service = read.settings?.values["usage.keychainService"]
  return typeof service === "string" && service ? service : KEYCHAIN_SERVICE
}

type Environment = Record<string, string | undefined>

// The account the session's resume record names, which spawn.sh writes at every herdr start and resume: its account line, a login the usage gate picked included, else its --account.
async function accountOf(id: unknown, environment: Environment): Promise<string | undefined> {
  if (typeof id !== "string") return
  try {
    const name = await registryName(id, environment)
    if (!name) return
    const record = await Bun.file(join(dataDir(environment), "resume", `${name}.sh`)).text()
    return /^# account: (\S+)/m.exec(record)?.[1] ?? /--account (\S+)/.exec(record)?.[1]
  } catch {
    return
  }
}

// Whether a claude call runs headless: --print, or -p alone or in a cluster of short options
export const headless = ({ args }: Parsed) =>
  args.some((a) => a.value === "--print" || /^-[A-Za-z]*p[A-Za-z]*$/.test(a.value))

const sets = (key: string, { local }: Parsed, env: Env) => {
  const value = local.get(key) ?? env.vars.get(key)
  return value !== undefined && value.value !== ""
}

export async function check(
  raw: string,
  environment: Environment = process.env,
): Promise<string | undefined> {
  try {
    const { tool_input: toolInput, tool_name: tool } = JSON.parse(raw) as {
      tool_input?: { command?: unknown }
      tool_name?: unknown
    }
    if (tool !== "Bash" || typeof toolInput?.command !== "string") return
    if (!/claude/.test(toolInput.command.replace(/["'\\]/g, ""))) return
    const id = sessionOf(raw)
    const role = await sessionRole(environment, id)
    if (!role) return
    const missing: string[] = []
    const visit: Visit = async (_cmd, parsed, shell) => {
      if (parsed.name !== "claude" || !headless(parsed)) return
      if (!sets(TOKEN, parsed, shell)) missing.push(TOKEN)
      if (!environment[ROLE] && !sets(ROLE, parsed, shell)) missing.push(ROLE)
      return missing.length ? "refuse" : undefined
    }
    const env = { files: new Map(), known: {}, process: {}, vars: new Map() }
    if (!(await run(lex(toolInput.command), env, visit))) return
    const account = (await accountOf(id, environment)) ?? "<your --account>"
    return `no-headless-login hook refuses a headless claude that does not set ${missing.join(" or ")}: without the token it bills this machine's own login, not your account, and without the role the factory's hooks pass it. Run it as: tk="$(security find-generic-password -s ${await keychainOf(environment)} -a ${account} -w)"; ${TOKEN}="$tk" ${ROLE}=${role} env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_API_KEY claude -p ...`
  } catch {
    // Fails open: a call the hook cannot read runs, so a parser bug never blocks a Bash command.
    return undefined
  }
}

if (import.meta.main) {
  const reason = await check(await input("no-headless-login", "guard"))
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
