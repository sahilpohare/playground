#!/usr/bin/env -S bun --no-env-file
// claude-trust.ts [folder]: records the owner's yes to Claude Code's folder trust question for folder (the main checkout by default) in ~/.claude.json, as projects[<folder>].hasTrustDialogAccepted, which Claude Code's own question writes, so a session in it or any worktree under it starts with no question. install.sh runs it on the checkout it cloned, before the dispatcher starts, and first run's Trust this folder on the owner's click; a config that does not read as a JSON object is left as it is.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { mainCheckout } from "../main-checkout"

// Pure: the config's text with folder trusted, every other key kept; null when the text does not read as a JSON object.
export const withTrust = (text: string | null, folder: string): string | null => {
  let config: Record<string, unknown> = {}
  if (text !== null) {
    try {
      config = JSON.parse(text)
    } catch {
      return null
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) return null
  }
  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>
  return `${JSON.stringify(
    {
      ...config,
      projects: {
        ...projects,
        [folder]: { ...projects[folder], hasTrustDialogAccepted: true },
      },
    },
    null,
    2,
  )}\n`
}

// Writes the trust into home's .claude.json beside it first, then over it, keeping its mode (600 for a new one), so Claude Code never reads half a file; answers the line to print and the exit code.
export const trust = (home: string, folder: string): { code: number; line: string } => {
  const path = join(home, ".claude.json")
  const held = existsSync(path)
  const text = held ? readFileSync(path, "utf8") : null
  const next = withTrust(text, folder)
  if (next === null)
    return {
      code: 1,
      line: `${path} does not read as Claude Code's config, so it is left as it is`,
    }
  // a config that already holds the yes stays the same file, so a second install changes nothing
  if (text !== null && JSON.parse(text).projects?.[folder]?.hasTrustDialogAccepted === true)
    return { code: 0, line: `Claude Code already trusts ${folder}` }
  const tmp = `${path}.playground-${process.pid}`
  writeFileSync(tmp, next, { mode: 0o600 })
  chmodSync(tmp, held ? statSync(path).mode & 0o777 : 0o600)
  renameSync(tmp, path)
  return { code: 0, line: `Claude Code trusts ${folder}` }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length > 1) {
    console.error("claude-trust.ts: takes one folder at most, the main checkout by default")
    process.exit(2)
  }
  const done = trust(process.env.HOME || homedir(), resolve(args[0] ?? mainCheckout()))
  console[done.code === 0 ? "log" : "error"](done.line)
  process.exit(done.code)
}
