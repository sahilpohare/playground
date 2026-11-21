import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { root, spawn } from "./spawn-fake"

// Every case runs spawn.sh, which starts fake processes and waits on them; one took 19.9s on the loaded runner box, so each gets twice that.
setDefaultTimeout(40_000)

describe("spawn.sh reads the factory's settings from its own checkout (#1438)", () => {
  test("a data folder whose link points at a scratch file still starts the session on the checkout's settings", async () => {
    const r = await spawn(
      ["worker", "worker-brave-otter", "b.md"],
      [],
      {},
      undefined,
      undefined,
      (home) => {
        const link = join(home, ".playground", "factory-settings.json")
        const own = join(home, "own-settings.json")
        writeFileSync(own, JSON.stringify({ hooks: {}, permissions: { allow: ["Bash"] } }))
        rmSync(link, { force: true })
        symlinkSync(own, link)
      },
    )
    expect(r.code).toBe(0)
    const source = JSON.parse(readFileSync(join(root, "scripts", "factory-settings.json"), "utf8"))
    const built = JSON.parse(
      readFileSync(join(r.home, ".playground", "factory-settings-400k.json"), "utf8"),
    )
    expect(built).toEqual({
      ...source,
      autoCompactWindow: 400000,
      enabledPlugins: { ...source.enabledPlugins, "ws-home@ws": false },
    })
  })
})
