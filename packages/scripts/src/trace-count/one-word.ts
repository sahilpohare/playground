// owner.names' one-word entries, each with the tracked files the ownerName kind counts it in, since one word also matches a made-up name or a common word: `playground settings set owner.names` prints them, and PUT /api/v1/settings/owner.names runs this file to answer with them.
import { join } from "node:path"

import { readPolicyOrDefaults } from "@packages/settings"

import { dataDir } from "../../../env/src/data-dir"
import { holding, tree } from "./count"
import { reposOf } from "./kinds"

export type OneWord = { files: string[]; name: string }

const CHECKOUT = join(import.meta.dir, "..", "..", "..", "..")

export async function oneWords(names: string[], data: string, root = CHECKOUT): Promise<OneWord[]> {
  const words = names.filter((name) => /^[a-z0-9]+$/.test(name))
  if (!words.length) return []
  const files = await tree(root)
  const repos = reposOf(
    readPolicyOrDefaults(data).settings ?? { schemaVersion: 1, values: {} },
    root,
  )
  return words.map((name) => ({ files: holding(files, name, repos), name }))
}

// The warning's lines for each entry, as settings set prints them.
export const warning = ({ files, name }: OneWord): string[] => [
  `owner.names holds ${name}, one word, which trace-count's ownerName kind counts in ${files.length} tracked ${files.length === 1 ? "file" : "files"}${files.length ? ":" : ""}`,
  ...files.map((file) => `  ${file}`),
]

if (import.meta.main) console.log(JSON.stringify(await oneWords(process.argv.slice(2), dataDir())))
