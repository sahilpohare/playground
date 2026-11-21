import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { boxEnv } from "../../../../../packages/scripts/src/box-env"
import { CA } from "../../../../api/hono/src/lib/dev/fixtures/ca"

const SCRIPT = join(import.meta.dir, "../../../../../packages/scripts/src/playground/ca-trust.ts")

const SNAP = "snap/firefox/common/.mozilla/firefox/abc.default"
const DEB = ".mozilla/firefox/xyz.default-release"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

// A stand-in certutil: it logs its argv, keeps an added CA as held.pem in the profile, lists it as C,, and prints it for -a, so no real store is read or written.
const CERTUTIL = `#!/bin/sh
export PATH="$PATH:/usr/bin:/bin"
echo "certutil $*" >> "$CALLS"
db=""; ca=""; prev=""
for a in "$@"; do
  [ "$prev" = "-d" ] && db="\${a#sql:}"
  [ "$prev" = "-i" ] && ca="$a"
  prev="$a"
done
case " $* " in
  *" -D "*) exit 0 ;;
  *" -A "*) cp "$ca" "$db/held.pem"; exit 0 ;;
  *" -a "*) [ -f "$db/held.pem" ] && cat "$db/held.pem"; exit 0 ;;
  *) [ -f "$db/held.pem" ] && echo "portless Local CA      C,,"; exit 0 ;;
esac
`

// A scratch HOME with Firefox profiles, portless's state folder holding the made-up CA, and a PATH of the named stubs alone.
const box = (stubs: string[], profiles = [SNAP, DEB], { ca = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "ca-trust-script-"))
  roots.push(root)
  const home = join(root, "home")
  const bin = join(root, "bin")
  const state = join(root, "portless")
  for (const dir of [home, bin, state]) mkdirSync(dir)
  for (const profile of profiles) {
    mkdirSync(join(home, profile), { recursive: true })
    writeFileSync(join(home, profile, "cert9.db"), "")
  }
  if (ca) writeFileSync(join(state, "ca.pem"), CA)
  for (const stub of stubs)
    writeFileSync(join(bin, stub), stub === "certutil" ? CERTUTIL : "#!/bin/sh\n", { mode: 0o755 })
  const calls = join(root, "calls.log")
  const run = () => {
    const done = Bun.spawnSync([process.execPath, "--no-env-file", SCRIPT], {
      env: boxEnv(home, { CALLS: calls, PATH: bin, PORTLESS_STATE_DIR: state }),
      stderr: "pipe",
      stdout: "pipe",
    })
    return { code: done.exitCode, err: done.stderr.toString(), out: done.stdout.toString() }
  }
  const ran = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [])
  return { home, ran, run, state }
}

describe("ca-trust.ts", () => {
  test("imports the CA into each Firefox profile that lacks it, then says to restart Firefox", () => {
    const { home, ran, run, state } = box(["certutil"])
    const first = run()
    expect(first.code).toBe(0)
    expect(first.out).toContain(`Firefox trusts portless's CA in ${join(home, SNAP)}`)
    expect(first.out).toContain(`Firefox trusts portless's CA in ${join(home, DEB)}`)
    expect(first.out).toContain("Restart Firefox if it is open")
    const ca = join(state, "ca.pem")
    for (const profile of [SNAP, DEB])
      expect(ran()).toContain(
        `certutil -A -n portless Local CA -t C,, -i ${ca} -d sql:${join(home, profile)}`,
      )
    const added = ran().length
    const again = run()
    expect(again.out).toContain("Firefox already trusts portless's CA in every profile.")
    expect(
      ran()
        .slice(added)
        .filter((line) => / -A /.test(line)),
    ).toEqual([])
  })

  test("names a Chromium-family browser's own import, since no file reaches it", () => {
    const { run, state } = box(["certutil", "helium"], [])
    const done = run()
    expect(done.code).toBe(0)
    expect(done.out).toContain(`In helium, open chrome://certificate-manager`)
    expect(done.out).toContain(`Import ${join(state, "ca.pem")}`)
  })

  test("with no certutil it names the NSS tools, installs nothing and changes nothing", () => {
    const { home, run } = box([])
    const done = run()
    expect(done.code).toBe(1)
    expect(done.err).toContain("libnss3-tools")
    expect(existsSync(join(home, SNAP, "held.pem"))).toBe(false)
  })

  test("before portless has made its CA it says so and reads nothing", () => {
    const { ran, run } = box(["certutil"], [SNAP], { ca: false })
    const done = run()
    expect(done.code).toBe(1)
    expect(done.err).toContain("start the Dashboard once")
    expect(ran()).toEqual([])
  })
})
