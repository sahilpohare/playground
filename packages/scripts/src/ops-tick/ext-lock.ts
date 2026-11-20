import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { extensionsDir, relockRoot } from "@packages/settings"

import type { Context } from "./tick"

// The extensions root's file lock kept on: a root that stands unlocked (a new one, one a move of the data folder made, one playground ext unlock left, or a scope folder a write killed mid-way left lifted) is locked again, one line in ops/log/ext-lock.log.
export const extLock =
  (relock: (data: string) => boolean = relockRoot) =>
  async (ctx: Context) => {
    const data = dirname(ctx.ops)
    if (!relock(data)) return
    await mkdir(join(ctx.ops, "log"), { recursive: true })
    const at = ctx.now.toISOString().replace(/\.\d{3}Z$/, "Z")
    await appendFile(join(ctx.ops, "log", "ext-lock.log"), `${at} locked ${extensionsDir(data)}\n`)
  }
