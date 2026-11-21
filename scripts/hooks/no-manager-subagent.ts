// PreToolUse hook: refuses the Agent and Workflow tools to a manager (PLAYGROUND_ROLE lead, dispatcher or manager, else the roster's kind for the session's registry name, else that name, role.ts), since a manager hands every build, read or research to a worker session with a roster row. Workers, checkers and the owner's own sessions keep both tools, a reviewer's code-review sub-agents among them. Input it cannot read lets the call run.
import "../../packages/env/src/aliases"
import { input } from "./input"
import { MANAGER_ROLES, sessionRole } from "./role"

const TOOLS = new Set(["Agent", "Workflow"])

export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof input !== "object" || input === null) return
  const { session_id: sessionId, tool_name: tool } = input as Record<string, unknown>
  if (typeof tool !== "string" || !TOOLS.has(tool)) return
  if (!MANAGER_ROLES.has(await sessionRole(environment, sessionId))) return
  return `no-manager-subagent hook refuses the ${tool} tool to a manager: a manager hands every build, read or research to a worker session the owner can see. Start one through scripts/spawn.sh, which writes its roster row, and brief it with the task instead.`
}

if (import.meta.main) {
  const reason = await check(await input("no-manager-subagent", "guard"))
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}
