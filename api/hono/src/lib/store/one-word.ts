import { join } from "node:path"

import { checkoutRoot } from "@/lib/dashboard/fixture"
import { dataDir } from "@/lib/sessions/paths"

export type OneWord = { files: string[]; name: string }

// owner.names' one-word entries, each with the tracked files trace-count's ownerName kind counts it in, from trace-count's own matcher run in this checkout; none when it fails or runs past its bound, since the warning refuses nothing and a hung read must not hold the save.
export const oneWords = async (
  names: string[],
  cli = join(checkoutRoot() ?? process.cwd(), "packages/scripts/src/trace-count/one-word.ts"),
  timeout = 5_000,
): Promise<OneWord[]> => {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...names], {
    env: { HOME: process.env.HOME, PATH: process.env.PATH, PLAYGROUND_DATA_DIR: dataDir() },
    stderr: "ignore",
    stdin: "ignore",
    stdout: "pipe",
    timeout,
  })
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return code === 0 ? (JSON.parse(out) as OneWord[]) : []
}
