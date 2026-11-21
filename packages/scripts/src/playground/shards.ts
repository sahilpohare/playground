import { lstatSync, readdirSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import {
  bytesOf,
  deleteWeights,
  isProtected,
  isWeights,
  type Approved,
  type Refusal,
  type Roots,
} from "@packages/safe-delete"

import { SHARD } from "../ops-tick/unused"

// The shard set one sharded path names: every real file in the same folder with the same stem, total and extension, A to Z, a symlink left out, or null for any other path.
export const shardSet = (path: string): string[] | null => {
  const m = SHARD.exec(basename(path))
  if (!m) return null
  const folder = dirname(path)
  const [, stem, , total, ext] = m
  let set: string[] = []
  try {
    for (const name of readdirSync(folder).sort()) {
      if (lstatSync(join(folder, name)).isSymbolicLink()) continue
      const mm = SHARD.exec(name)
      if (!mm) continue
      const [, stemOf, , totalOf, extOf] = mm
      if (stemOf === stem && totalOf === total && extOf === ext) set.push(join(folder, name))
    }
  } catch {
    return null
  }
  return set.length > 0 ? set : null
}

// The shard set removed whole, each shard checked before any delete: the sizes summed, a mismatch refused, each shard a real file, not protected and model weights, and only then each at its own size, so one shard that is refused leaves the rest.
export const removeSet = (
  set: string[],
  approved: Approved,
  opts: { folders: string[]; reason: string; session: string },
  roots: Roots,
): { paths: string[]; size: number } | Refusal => {
  const sizes = set.map((p) => bytesOf(p))
  let total = 0
  for (const size of sizes) total += size
  if (total !== approved.bytes)
    return {
      kind: "refused",
      refused: `the shard set holds ${set.length} shards at ${total} bytes, and card ${approved.card} approved it at ${approved.bytes}: its size changed, so it stays`,
    }
  // check every shard before any delete, so a shard that is refused leaves the others
  for (let i = 0; i < set.length; i++) {
    const p = set[i]!
    let st
    try {
      st = lstatSync(p)
    } catch {
      return { kind: "refused", refused: `the shard set holds ${p} but it is gone` }
    }
    if (st.isSymbolicLink() || realpathSync(p) !== p)
      return { kind: "refused", refused: `${p} is not a real file the shard set holds` }
    const why = isProtected(p, roots)
    if (why) return { kind: "protected", refused: why }
    if (!isWeights(p, roots.home, opts.folders))
      return { kind: "refused", refused: `${p} is not model weights the shard set holds` }
  }
  for (let i = 0; i < set.length; i++) {
    const done = deleteWeights(
      set[i]!,
      {
        approved: { bytes: sizes[i]!, card: approved.card },
        folders: opts.folders,
        reason: opts.reason,
        session: opts.session,
      },
      roots,
    )
    if ("refused" in done) return done
  }
  return { paths: set, size: total }
}
