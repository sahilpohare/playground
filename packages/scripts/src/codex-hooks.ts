// The hooks.json a Codex launch loads (spawn.sh's --harness codex), rendered from the factory's settings and printed as JSON: `bun packages/scripts/src/codex-hooks.ts <factory-settings.json>`.
type Hook = { command: string; onFailure?: string; timeout?: number; type: string }
type Group = { hooks: Hook[]; matcher?: string }
export type Hooks = Record<string, Group[]>

// The events Codex's hooks.json takes (codex-rs/protocol/src/hooks.rs, rust-v0.167.1) that the factory registers; Codex has no Notification, PermissionDenied, PostToolUseFailure or StopFailure.
export const CODEX_EVENTS = [
  "PermissionRequest",
  "PostToolUse",
  "PreToolUse",
  "SessionEnd",
  "SessionStart",
  "Stop",
  "UserPromptSubmit",
]
// The hooks a Codex session loads none of: session-state, whose record Codex's events cannot keep true, so a Codex session writes no state record.
export const LEFT_OUT = new Set(["session-state"])
// The PreToolUse matcher a hook takes in place of its own: writing-first matches Bash, where Codex reads a skill and may run apply_patch, and drops Skill, a tool Codex lacks.
export const CODEX_MATCHERS: Record<string, string> = {
  "writing-first": "^(Bash|Edit|MultiEdit|Write)$",
}

// Pure: the hook a handler's command runs, by its script's name (no-raw-wa), or undefined when it names none.
export const hookOf = (command: string): string | undefined =>
  command.match(/scripts\/hooks\/(?:bundled\/)?([\w-]+)\.(?:js|ts)\b/)?.[1]

// Pure: every handler on each event Codex has, in its group with its matcher and with no onFailure, a key Codex's handler lacks, but the hooks left out, and a group that keeps none goes too.
export function codexHooks(hooks: Hooks): Hooks {
  const rendered: Hooks = {}
  for (const event of CODEX_EVENTS) {
    const groups = (hooks[event] ?? []).flatMap((group) => {
      const kept = group.hooks
        .filter((hook) => !LEFT_OUT.has(hookOf(hook.command) ?? ""))
        .map(({ onFailure: _, ...hook }) => hook)
      if (kept.length === 0) return []
      const matcher =
        event === "PreToolUse"
          ? kept.map((hook) => CODEX_MATCHERS[hookOf(hook.command) ?? ""]).find(Boolean)
          : undefined
      return [{ ...group, hooks: kept, ...(matcher ? { matcher } : {}) }]
    })
    if (groups.length > 0) rendered[event] = groups
  }
  return rendered
}

if (import.meta.main) {
  const settings = (await Bun.file(process.argv[2] ?? "").json()) as { hooks: Hooks }
  console.log(JSON.stringify(codexHooks(settings.hooks)))
}
