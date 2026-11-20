// SessionStart hook, matcher "compact": after a compaction it puts what to reread in front of a factory session (playbook's **context** rule), since Claude Code re-attaches a skill after a compaction cut short or not at all; the rules hook puts the standing rules beside it.

import { input } from "./input"
import { fromFactory, MANAGER_ROLES, sessionOf, sessionRole } from "./role"

export const REREAD =
  "Your context was just compacted. Invoke the playbook skill again with the Skill tool, since a compaction cuts it or drops it. Before you act, reread your roster entry (~/.playground/roster.json: task, pr, branch, eta, asks), the Inbox items its asks names that are still open, and each of your PRs' head, review and CI state, plus the decisions register (.agents/decisions.md in Playground's own repo), then carry on from what those say."

// A manager's added line: with its waiter down, a stuck session's alert reached its lead 5m50s late on 7 Nov, past a built-in prompt's 120s timeout.
export const WAITER =
  "As a manager, check that your `playground alerts-wait <your name>` task still runs, and start it again if it does not (playbook SESSIONS.md, Keep the sweep running), so a stuck session reaches you in seconds."

// The hook's output, or nothing for a session outside the factory: the owner's own sessions load this hook too, from the project settings, and need no instruction. Fails open, so a compaction never waits on this hook.
export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  try {
    if (!(await fromFactory(raw, environment))) return undefined
    const manager = MANAGER_ROLES.has(await sessionRole(environment, sessionOf(raw)))
    return JSON.stringify({
      hookSpecificOutput: {
        additionalContext: manager ? `${REREAD} ${WAITER}` : REREAD,
        hookEventName: "SessionStart",
      },
    })
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  const out = await check(await input("after-compact", "recorder"))
  if (out) console.log(out)
}
