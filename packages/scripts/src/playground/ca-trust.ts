#!/usr/bin/env -S bun --no-env-file
// ca-trust.ts: on Linux, imports portless's CA into each Firefox profile that does not trust it yet, with certutil as the signed-in user, then says to restart Firefox, since a running browser keeps its old store, and names a Chromium-family browser's own import, which no file reaches, for each one the chromium-ca policy does not cover. First run's Trust it in Firefox runs it on the owner's click; it installs nothing and asks for no password.
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  CA_NAME,
  type CaProbe,
  chromiumSteps,
  readCaTrust,
} from "../../../../api/hono/src/lib/dev/ca-trust"
import { portlessDir } from "../../../../api/hono/src/lib/dev/proxy"

export const probe: CaProbe = {
  has: (cmd) => Bun.which(cmd) !== null,
  run: async (argv) => {
    const done = Bun.spawnSync(argv, { stderr: "pipe", stdout: "pipe" })
    return { code: done.exitCode, stdout: done.stdout.toString() }
  },
}

// Trusts ca in each Firefox profile under home that does not yet, an older entry under CA_NAME dropped first; answers the lines to print and the exit code.
export const trustCa = async (
  ca: string,
  home: string,
  run: CaProbe = probe,
): Promise<{ code: number; lines: string[] }> => {
  if (!existsSync(ca))
    return {
      code: 1,
      lines: [`${ca} is not there yet: start the Dashboard once, then run this again`],
    }
  const read = await readCaTrust(ca, home, run)
  const lines: string[] = []
  if (read.untrusted.length > 0 && !read.certutil)
    return {
      code: 1,
      lines: [
        "certutil is not installed: install your distro's NSS tools (libnss3-tools on Debian and Ubuntu, nss-tools on Fedora), then run this again",
      ],
    }
  for (const profile of read.untrusted) {
    const db = `sql:${profile}`
    await run.run(["certutil", "-D", "-n", CA_NAME, "-d", db])
    const added = await run.run(["certutil", "-A", "-n", CA_NAME, "-t", "C,,", "-i", ca, "-d", db])
    if (added.code !== 0)
      return { code: 1, lines: [...lines, `certutil could not add it to ${profile}`] }
    lines.push(`Firefox trusts portless's CA in ${profile}`)
  }
  if (read.firefox.length > 0)
    lines.push(
      read.untrusted.length > 0
        ? "Restart Firefox if it is open, since a running browser keeps its old store."
        : "Firefox already trusts portless's CA in every profile.",
    )
  if (read.policy.length > 0)
    lines.push(`${read.policy.join(", ")} trusts portless's CA through the browser policy.`)
  if (read.chromium.length > 0) lines.push(chromiumSteps(read.chromium, ca))
  if (lines.length === 0) lines.push("No Firefox profile or Chromium-family browser was found.")
  return { code: 0, lines }
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.error(
      "ca-trust.ts: takes no arguments; it trusts portless's CA in each Firefox profile",
    )
    process.exit(2)
  }
  const done = await trustCa(join(portlessDir(), "ca.pem"), process.env.HOME || homedir())
  for (const line of done.lines) console[done.code === 0 ? "log" : "error"](line)
  process.exit(done.code)
}
