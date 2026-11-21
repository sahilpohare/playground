// SessionStart hook, every source: puts a factory session's standing rules in front of it, the core extension's, then each extension ext.links reads in its repo, then the signed-in login's, each `{key}` slot filled with the setting's value (playbook's **context** rule). Claude Code re-attaches a skill after a compaction cut short or not at all, and injected context arrives either way.

import "../../packages/env/src/aliases"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import { dataDir } from "../../packages/env/src/data-dir"
import { orgFolderOf } from "../../packages/settings/src/ext"
// The rules' own keys register on import, so their defaults fill a slot the extensions do not set.
import "../../packages/settings/src/rules"
import {
  CORE,
  coreDir,
  extensionsDir,
  loginOf,
  readPolicy,
  readRendered,
} from "../../packages/settings/src/rendered"
import { extChain, settingFields } from "../../packages/settings/src/settings"
import { input } from "./input"
import { fromFactory } from "./role"

// The core extension's rules, in the checkout's extensions/core.
export const CORE_RULES = join(coreDir(), "rules")

// SessionStart's additionalContext holds up to 10,000 characters.
export const LIMIT = 10_000

// A setting's key in braces; a key always has a dot, so a JSON or shell brace in a rule stays text.
export const SLOT = /\{([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+)\}/g

export type Rule = { decisions: string[]; glance: string; name: string; text: string }
type Section = { rules: Rule[]; title: string }
type Values = (key: string) => unknown

const HEAD =
  "Your standing rules, each by its glance line with this machine's values; `playground rules <name>` prints one whole, its what and why, with the values filled in. Cite a rule by its name, in bold."

// A rule file: optional frontmatter whose `decisions` lists the Inbox ids behind it, then its what and why, one sentence a line, the first line its glance.
export const parseRule = (name: string, text: string): Rule => {
  const front = text.match(/^---\n([\s\S]*?)\n---\n/)
  const decisions =
    front?.[1]
      ?.match(/^decisions: \[(.*)\]$/m)?.[1]
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? []
  const body = text.slice(front ? front[0].length : 0).trim()
  return { decisions, glance: body.split("\n")[0]!.trim(), name, text: body }
}

// A rule's name is its file's, a hyphen read as a space (local-page.md holds **local page**).
export const ruleName = (file: string): string => basename(file, ".md").replaceAll("-", " ")

export const readRules = (dir: string): Rule[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => parseRule(ruleName(file), readFileSync(join(dir, file), "utf8")))

export const fill = (text: string, value: Values): string =>
  text.replace(SLOT, (slot, key: string) => {
    const v = value(key)
    return v === undefined ? slot : typeof v === "string" ? v : JSON.stringify(v)
  })

// Each section's glances, in the order given; past SessionStart's limit, as many whole rules as fit, naming how many were left out.
export const render = (sections: Section[], value: Values, lead = ""): string => {
  const lines = [
    lead ? `${lead}\n\n${HEAD}` : HEAD,
    ...sections.flatMap(({ rules, title }) =>
      rules.length
        ? ["", title, "", ...rules.map((r) => `- **${r.name}**: ${fill(r.glance, value)}`)]
        : [],
    ),
  ]
  let left = 0
  const tail = () => (left ? `\n\n${left} more rules were left out: read them in their files.` : "")
  while (lines.join("\n").length + tail().length > LIMIT)
    if (lines.pop()?.startsWith("- **")) left++
  return `${lines.join("\n").trimEnd()}${tail()}`
}

// The GitHub owner of the repo the session runs in, read from its origin, or "" when it has none.
const repoOwner = (cwd: unknown): string => {
  if (typeof cwd !== "string") return ""
  const run = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], { stderr: "ignore" })
  return run.stdout.toString().match(/github\.com[:/]([^/]+)\//)?.[1] ?? ""
}

// A scope's rules, `<scope>/rules/*.md`: core's from the checkout, any other's through the extensions' reader.
const scopeRules = async (data: string, scope: string): Promise<Rule[]> => {
  if (scope === CORE) {
    return existsSync(CORE_RULES) ? readRules(CORE_RULES) : []
  }
  const dir = join(extensionsDir(data), scope, "rules")
  if (!existsSync(dir)) return []
  const rules: Rule[] = []
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    const read = await readRendered(data, `${scope}/rules/${file}`)
    if (read.path) rules.push(parseRule(ruleName(file), readFileSync(read.path, "utf8")))
  }
  return rules
}

const login = (data: string, environment: Record<string, string | undefined>): string => {
  try {
    return loginOf(data, environment)
  } catch {
    return ""
  }
}

// Every scope's rules a session takes, in the order they render, and the value each slot takes.
export async function load(cwd: unknown, environment: Record<string, string | undefined>) {
  const data = dataDir(environment)
  const defaults = new Map(settingFields().map(({ field, key }) => [key, field.default]))
  const sections: Section[] = [
    { rules: await scopeRules(data, CORE), title: "Playground's rules:" },
  ]
  const policy = await readPolicy(data)
  const base = policy.settings?.values ?? {}
  const owner =
    repoOwner(cwd) ||
    (typeof cwd === "string" && orgFolderOf(environment.HOME || homedir(), cwd, base)) ||
    ""
  const user = login(data, environment)
  for (const org of extChain(base, user, owner)
    .filter((name) => name !== user && name !== CORE)
    .reverse())
    sections.push({ rules: await scopeRules(data, org), title: `The ${org} org's rules:` })
  if (user) sections.push({ rules: await scopeRules(data, user), title: "Your own rules:" })
  const values = (owner && (await readPolicy(data, owner)).settings?.values) || base
  const value = (key: string) => (key in values ? values[key] : defaults.get(key))
  const lead = policy.refusal
    ? `The extensions' values could not be read, so these rules show the defaults: ${policy.refusal}. Tell your manager.`
    : ""
  return { lead, sections, value }
}

export async function context(cwd: unknown, environment: Record<string, string | undefined>) {
  const { lead, sections, value } = await load(cwd, environment)
  return render(sections, value, lead)
}

// One rule whole, its slots filled, the login's over an org's over core's, or undefined when no scope holds it.
export async function ruleText(
  name: string,
  cwd: unknown,
  environment: Record<string, string | undefined>,
): Promise<string | undefined> {
  const { lead, sections, value } = await load(cwd, environment)
  const rule = sections
    .toReversed()
    .flatMap((s) => s.rules)
    .find((r) => r.name === name)
  return rule && [lead, `**${rule.name}**`, fill(rule.text, value)].filter(Boolean).join("\n\n")
}

// The hook's output, or nothing for a session outside the factory or input that does not read; fails open, so no start waits on it.
export async function check(
  raw: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  try {
    if (!(await fromFactory(raw, environment))) return undefined
    const { cwd } = JSON.parse(raw) as { cwd?: unknown }
    return JSON.stringify({
      hookSpecificOutput: {
        additionalContext: await context(cwd, environment),
        hookEventName: "SessionStart",
      },
    })
  } catch {
    return undefined
  }
}

if (import.meta.main) {
  const out = await check(await input("rules", "recorder"))
  if (out) console.log(out)
}
